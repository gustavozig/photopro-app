const express = require('express');

const orderStore = require('../services/orderStore');
const mercadoPagoService = require('../services/mercadoPagoService');
const openaiService = require('../services/openaiService');
const metaCapiService = require('../services/metaCapiService');

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
    const orderId = payment.external_reference;
    const order = orderStore.getOrder(orderId);

    if (!order) {
      console.warn(`Webhook: pedido ${orderId} não encontrado (talvez expirado).`);
      return res.status(200).end();
    }

    if (payment.status === 'approved') {
      // Responde já para o Mercado Pago não re-tentar por timeout, e só
      // depois consome a API da OpenAI (pode levar alguns segundos).
      if (order.status === 'pending_payment') {
        orderStore.updateOrder(order.id, { status: 'generating', paymentId });
        res.status(200).end();
        runGenerationInBackground(order.id);
        // Evento Purchase pro Meta CAPI — fire-and-forget, nunca bloqueia a
        // resposta do webhook nem a geração da foto (ver metaCapiService.js).
        // event_id usa o mesmo formato disparado pelo pixel no navegador
        // (index.html, dentro de pollUntilPaid) pra o Meta deduplicar.
        const publicUrl = req.app.get('publicUrl');
        metaCapiService.sendPurchaseEvent({
          orderId: order.id,
          value: mercadoPagoService.PRICE_BRL,
          email: payment.payer?.email || null,
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

    if (payment.status === 'rejected') {
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
      selfieBuffer: null, // não precisamos mais guardar a selfie original
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
  }
}

module.exports = router;
