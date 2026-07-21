const express = require('express');

const orderStore = require('../services/orderStore');
const photoArchive = require('../services/photoArchive');
const mercadoPagoService = require('../services/mercadoPagoService');
const openaiService = require('../services/openaiService');
const metaCapiService = require('../services/metaCapiService');
const { getExtraStylesForPackage } = require('../prompts');

const router = express.Router();

// ---------------------------------------------------------------------------
// ÚNICO ponto do sistema em que a geração de imagem por IA é disparada.
// Fluxo:
//   1) Mercado Pago notifica o webhook.
//   2) Validamos a assinatura e confirmamos o status real do pagamento
//      (nunca confiamos só no corpo da notificação).
//   3) Se aprovado: respondemos 200 IMEDIATAMENTE ao Mercado Pago (eles
//      esperam uma resposta rápida) e disparamos a geração em segundo
//      plano. O front-end acompanha o resultado via polling em
//      GET /api/orders/:id.
// ---------------------------------------------------------------------------
router.post('/webhooks/mercadopago', async (req, res) => {
  try {
    if (!mercadoPagoService.verifyWebhookSignature(req)) {
      console.warn('Webhook do Mercado Pago com assinatura inválida — ignorado.');
      return res.status(401).end();
    }

    const paymentId = req.body?.data?.id;
    const type = req.body?.type;
    if (type !== 'payment' || !paymentId) {
      return res.status(200).end(); // outros tipos de evento: apenas confirma recebimento
    }

    const payment = await mercadoPagoService.getPayment(paymentId);
    const rawRef = payment.external_reference;
    // Pagamentos do upsell pós-compra (ver POST /orders/:id/upsell-payments)
    // usam "<orderId>:upsell" como external_reference, pra diferenciar de um
    // pagamento do pedido base com o mesmo order.id.
    const isUpsell = typeof rawRef === 'string' && rawRef.endsWith(':upsell');
    const orderId = isUpsell ? rawRef.slice(0, -':upsell'.length) : rawRef;
    const order = orderStore.getOrder(orderId);

    if (!order) {
      console.warn(`Webhook: pedido ${orderId} não encontrado (talvez expirado).`);
      return res.status(200).end();
    }

    if (payment.status === 'approved') {
      // Responde já para o Mercado Pago não re-tentar por timeout, e só
      // depois consome a API da OpenAI (pode levar alguns segundos).
      if (isUpsell) {
        // Upsell pós-compra: o pedido base já está 'paid' — só confirmamos
        // o bump e disparamos a geração dos outros 4 estilos. Ignora se já
        // tiver sido processado antes (evita reprocessar em notificações
        // duplicadas da MP).
        if (!order.bumpPurchased) {
          // Upgrade Inicial → Premium: muda o pacote do pedido, e a geração
          // das extras passa a seguir a lista do premium (3 fotos).
          orderStore.updateOrder(order.id, { bumpPurchased: true, package: 'premium' });
          res.status(200).end();
          runBumpGenerationInBackground(order.id);
          const publicUrl = req.app.get('publicUrl');
          metaCapiService.sendPurchaseEvent({
            orderId: `${order.id}-upsell`,
            value: mercadoPagoService.UPGRADE_PRICE_BRL,
            email: payment.payer?.email || null,
            phone: order.whatsapp,
            clientIp: order.clientIp,
            userAgent: order.userAgent,
            fbp: order.fbp,
            fbc: order.fbc,
            sourceUrl: publicUrl,
          });
          return;
        }
        return res.status(200).end();
      }

      if (order.status === 'pending_payment') {
        orderStore.updateOrder(order.id, { status: 'generating', paymentId });
        res.status(200).end();
        runGenerationInBackground(order.id);
        // Evento Purchase pro Meta CAPI — fire-and-forget, nunca bloqueia a
        // resposta do webhook nem a geração da foto (ver metaCapiService.js).
        // event_id usa o mesmo formato disparado pelo pixel no navegador
        // (index.html, dentro de pollUntilPaid) pra o Meta deduplicar.
        const publicUrl = req.app.get('publicUrl');
        const pkg = mercadoPagoService.PACKAGES[mercadoPagoService.resolvePackage(order.package)];
        const purchaseValue = Number(
          (pkg.price + (order.hqPurchased ? mercadoPagoService.HQ_PRICE_BRL : 0)).toFixed(2)
        );
        metaCapiService.sendPurchaseEvent({
          orderId: order.id,
          value: purchaseValue,
          email: payment.payer?.email || null,
          phone: order.whatsapp,
          clientIp: order.clientIp,
          userAgent: order.userAgent,
          fbp: order.fbp,
          fbc: order.fbc,
          sourceUrl: publicUrl,
        });
        return;
      }
      return res.status(200).end();
    }

    // Um upsell recusado NÃO pode derrubar o status do pedido base (que já
    // está 'paid' e entregue) — só pagamentos recusados do pedido base
    // viram 'payment_rejected'.
    if (payment.status === 'rejected' && !isUpsell) {
      orderStore.updateOrder(order.id, { status: 'payment_rejected' });
    }

    res.status(200).end();
  } catch (err) {
    console.error('Erro ao processar webhook do Mercado Pago:', err);
    res.status(500).end();
  }
});

async function runGenerationInBackground(orderId) {
  const order = orderStore.getOrder(orderId);
  if (!order) return;

  try {
    const fullImageBuffer = await openaiService.generateProfessionalPhoto(
      order.selfieBuffer,
      order.selfieMimeType,
      order.style
    );
    orderStore.updateOrder(orderId, {
      status: 'paid',
      fullImageBuffer,
      // selfieBuffer é mantida — se o cliente comprou o Pacote Premium no
      // checkout, ela é usada agora (runBumpGenerationInBackground); se
      // não comprou, ela fica disponível ainda por até a janela de
      // retenção do pedido (2h, ver ORDER_TTL_MS em orderStore.js), caso
      // ele volte e aceite o upsell pós-compra (ver POST
      // /orders/:id/upsell-payments). purgeExpiredOrders() cuida de
      // apagar tudo (pedido inteiro, incluindo a selfie) quando o prazo
      // vence — não existe exclusão imediata pra quem compra só a foto.
    });
  } catch (err) {
    console.error(`[order ${orderId}] geração falhou após pagamento aprovado:`, err.message || err);
    // Importante: o pagamento já foi aprovado neste ponto. Isto precisa de
    // acompanhamento manual (reembolso ou nova tentativa) até que exista um
    // fluxo automático de notificação/reembolso — ver CHECKLIST-DEPLOY.md.
    orderStore.updateOrder(orderId, {
      status: 'generation_failed',
      error: 'Seu pagamento foi aprovado, mas tivemos um problema ao gerar sua foto. Nossa equipe foi notificada e vai resolver isso rapidamente — entre em contato pelo suporte informando o número do pedido.',
    });
    return; // sem foto principal, não faz sentido tentar o Pacote Premium
  }

  const freshOrder = orderStore.getOrder(orderId);
  // Arquiva a foto paga em disco imediatamente — proteção contra o TTL de 2h
  // da memória e contra restarts/redeploys (ver services/photoArchive.js).
  photoArchive.saveOrder(freshOrder);
  if (freshOrder && freshOrder.bumpPurchased) {
    runBumpGenerationInBackground(orderId);
  }
  // Se não comprou o bump no checkout, a selfie NÃO é apagada aqui — fica
  // disponível até a janela de retenção do pedido expirar (ver comentário
  // acima), pro caso do upsell pós-compra ser aceito depois.
}

// ---------------------------------------------------------------------------
// Fotos extras do pacote: premium = 3 estilos do catálogo, deluxe = 9 (os
// outros 4 do catálogo + 5 fotos de sessão de estúdio exclusivas) — a lista
// vem de getExtraStylesForPackage (prompts.js). Roda DEPOIS que a foto
// principal já está pronta (o cliente não espera o pacote inteiro pra ver o
// resultado base) — o front-end faz polling de `bumpStatus` separadamente.
//
// Pool de concorrência limitada (não Promise.all direto) pra não estourar
// rate limit nem memória — com 3 workers, o deluxe (9 fotos) fica pronto em
// ~3 levas em vez de 9 gerações em série. Falhas individuais não derrubam o
// pacote: entregamos o que conseguimos gerar.
// ---------------------------------------------------------------------------
const BUMP_CONCURRENCY = 3;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      try {
        results[current] = { ok: true, value: await fn(items[current]) };
      } catch (err) {
        results[current] = { ok: false, error: err };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runBumpGenerationInBackground(orderId) {
  const order = orderStore.getOrder(orderId);
  if (!order || !order.selfieBuffer) return;

  orderStore.updateOrder(orderId, { bumpStatus: 'generating' });

  const extraStyles = getExtraStylesForPackage(
    mercadoPagoService.resolvePackage(order.package),
    order.style
  );
  if (extraStyles.length === 0) return; // pacote inicial: nada a gerar
  const results = await mapWithConcurrency(extraStyles, BUMP_CONCURRENCY, async (styleName) => {
    const imageBuffer = await openaiService.generateProfessionalPhoto(
      order.selfieBuffer,
      order.selfieMimeType,
      styleName
    );
    return { style: styleName, imageBuffer };
  });

  const bumpImages = results.filter((r) => r.ok).map((r) => r.value);
  const failedCount = results.length - bumpImages.length;
  if (failedCount > 0) {
    console.error(`[order ${orderId}] ${failedCount}/${results.length} fotos extras do pacote ${order.package} falharam na geração.`);
  }

  orderStore.updateOrder(orderId, {
    bumpStatus: bumpImages.length > 0 ? 'ready' : 'failed',
    bumpImages,
    selfieBuffer: null, // agora sim, não precisamos mais dela
  });

  // Regrava o arquivo em disco, agora incluindo as fotos do Pacote Premium.
  photoArchive.saveOrder(orderStore.getOrder(orderId));
}

module.exports = router;
