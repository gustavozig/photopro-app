const express = require('express');
const multer = require('multer');

const orderStore = require('../services/orderStore');
const photoArchive = require('../services/photoArchive');
const sharp = require('sharp');
const { buildZip } = require('../services/zipBuilder');
const leadStore = require('../services/leadStore');
const mercadoPagoService = require('../services/mercadoPagoService');
const openaiService = require('../services/openaiService');
const previewService = require('../services/previewService');
const { validateSelfie } = require('../validators/selfieValidator');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ---------------------------------------------------------------------------
// Extrai _fbp/_fbc (cookies do Meta Pixel) do header Cookie cru — sem
// dependência de cookie-parser só por causa disso. _fbp é setado pelo pixel
// em qualquer visita; _fbc só existe se o clique veio de um anúncio do Meta
// (tem o fbclid embutido). Usados no Meta CAPI (ver services/metaCapiService.js)
// pra melhorar a qualidade de correspondência do evento Purchase.
// ---------------------------------------------------------------------------
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

function serializeOrder(order) {
  const out = {
    id: order.id,
    status: order.status,
    style: order.style,
    previewStatus: order.previewStatus,
    // legado (pedidos arquivados antes dos pacotes): bumpPurchased sem
    // package definido significa o antigo "Pacote Premium" completo
    package: order.package || (order.bumpPurchased ? 'premium' : 'inicial'),
    hqPurchased: !!order.hqPurchased,
    bumpPurchased: !!order.bumpPurchased,
  };
  if (order.error) out.error = order.error;
  if (order.previewStatus === 'ready' && order.previewImageBuffer) {
    out.previewImage = `data:image/png;base64,${order.previewImageBuffer.toString('base64')}`;
  }
  if (order.status === 'paid' && order.fullImageBuffer) {
    out.fullImage = `data:image/png;base64,${order.fullImageBuffer.toString('base64')}`;
  }
  // Pacote Premium: enquanto as 4 fotos extras ainda estão sendo geradas,
  // o front-end já pode revelar a foto principal (acima) e mostrar um
  // estado de "gerando o resto do pacote" — só manda o array completo
  // quando bumpStatus vira 'ready'.
  if (order.bumpPurchased) {
    out.bumpStatus = order.bumpStatus;
    if (order.bumpStatus === 'ready' && Array.isArray(order.bumpImages)) {
      out.bumpImages = order.bumpImages.map((img) => ({
        style: img.style,
        image: `data:image/png;base64,${img.imageBuffer.toString('base64')}`,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispara em segundo plano a prévia barata (quality:'low') da foto REAL do
// cliente. Nunca bloqueia a resposta de POST /orders — se falhar, o
// front-end simplesmente mantém a ilustração genérica (não é uma etapa
// crítica do fluxo de pagamento). Ver REGRA DE NEGÓCIO em openaiService.js.
// ---------------------------------------------------------------------------
async function generatePreviewInBackground(orderId) {
  const order = orderStore.getOrder(orderId);
  if (!order) return;

  orderStore.updateOrder(orderId, { previewStatus: 'generating' });
  try {
    const rawBuffer = await openaiService.generatePreviewPhoto(
      order.selfieBuffer,
      order.selfieMimeType,
      order.style
    );
    const lockedBuffer = await previewService.buildLockedPreview(rawBuffer);
    orderStore.updateOrder(orderId, { previewStatus: 'ready', previewImageBuffer: lockedBuffer });
  } catch (err) {
    console.error(`[order ${orderId}] prévia de baixo custo falhou:`, err.message || err);
    orderStore.updateOrder(orderId, { previewStatus: 'failed' });
  }
}

// ---------------------------------------------------------------------------
// ETAPA 1 + 2 do fluxo: recebe a selfie e o estilo escolhido.
// Faz validações locais (formato, tamanho, resolução) e dispara em segundo
// plano a prévia barata (quality:'low', ver acima). A geração em qualidade
// completa continua só acontecendo depois da confirmação do pagamento
// (ver routes/webhooks.js) — o pedido fica "pending_payment" até lá.
// ---------------------------------------------------------------------------
router.post('/orders', upload.single('selfie'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Envie uma selfie no campo "selfie".' });
    }

    const validation = await validateSelfie(req.file);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.reason });
    }

    const style = req.body.style || 'Corporativo neutro';
    const order = orderStore.createOrder({
      style,
      selfieBuffer: req.file.buffer,
      selfieMimeType: req.file.mimetype,
      fbp: readCookie(req, '_fbp'),
      fbc: readCookie(req, '_fbc'),
      clientIp: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    });

    res.json({ orderId: order.id, status: order.status });

    generatePreviewInBackground(order.id);
  } catch (err) {
    console.error('Erro em POST /api/orders:', err);
    res.status(500).json({ error: 'Erro interno ao criar o pedido.' });
  }
});

// ---------------------------------------------------------------------------
// Consulta de status — usado pelo front-end tanto para o polling curto da
// "etapa 3" (preparação) quanto para o polling real pós-pagamento (geração).
// ---------------------------------------------------------------------------
router.get('/orders/:id', async (req, res) => {
  // memória primeiro; se o pedido já expirou/reiniciou, tenta o arquivo em
  // disco (só existe para pedidos pagos — ver services/photoArchive.js)
  const order = orderStore.getOrder(req.params.id) || (await photoArchive.loadOrder(req.params.id));
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json(serializeOrder(order));
});

// ---------------------------------------------------------------------------
// Download direto das fotos como arquivo real (Content-Disposition).
// Motivo: os navegadores embutidos do Instagram/Facebook (por onde chega a
// maior parte do tráfego pago) não conseguem "baixar" data: URLs gigantes —
// o clique termina em "A página não pode ser carregada". Servir o PNG por
// uma URL http normal com attachment resolve em qualquer navegador.
// ---------------------------------------------------------------------------
// Converte pro formato de entrega conforme o bump HQ do pedido:
// - com HQ (R$2,90): PNG original, sem compressão — exatamente o buffer gerado
// - sem HQ: JPEG qualidade 88 — visualmente excelente (é o formato que
//   WhatsApp/LinkedIn usam de qualquer jeito) e ~4x menor pra baixar no 4G.
// A diferença é real: é isso que torna honesta a frase do checkout.
async function deliverableImage(order, buffer) {
  if (order.hqPurchased) return { data: buffer, ext: 'png', mime: 'image/png' };
  const jpeg = await sharp(buffer).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  return { data: jpeg, ext: 'jpg', mime: 'image/jpeg' };
}

router.get('/orders/:id/download', async (req, res) => {
  const order = orderStore.getOrder(req.params.id) || (await photoArchive.loadOrder(req.params.id));
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'paid' || !order.fullImageBuffer) {
    return res.status(403).json({ error: 'Foto disponível somente após o pagamento.' });
  }
  const img = await deliverableImage(order, order.fullImageBuffer);
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Content-Disposition', `attachment; filename="photopro-foto-profissional.${img.ext}"`);
  res.send(img.data);
});

// ---------------------------------------------------------------------------
// Contato opcional (WhatsApp) informado durante a tela de loading. Serve pra
// (a) o suporte localizar o pedido de quem perdeu a foto e (b) recuperar
// manualmente quem abre o checkout e não paga. Também melhora a qualidade da
// correspondência dos eventos do Meta (telefone hasheado no CAPI).
// ---------------------------------------------------------------------------
router.post('/orders/:id/contact', async (req, res) => {
  const order = orderStore.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

  const digits = String(req.body?.whatsapp || '').replace(/\D/g, '');
  // celular BR: 10 (fixo/antigo) a 11 dígitos com DDD; aceita com DDI 55 na frente
  const local = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
  if (local.length < 10 || local.length > 11) {
    return res.status(400).json({ error: 'Informe um número com DDD, ex: (11) 98765-4321.' });
  }

  orderStore.updateOrder(order.id, { whatsapp: local });
  await leadStore.saveLead({ orderId: order.id, whatsapp: local, style: order.style, status: order.status });
  res.json({ ok: true });
});

// Lista de contatos para atendimento/recuperação manual. Protegida por chave
// simples (ADMIN_KEY) — sem login, mas suficiente pra não ficar aberta.
router.get('/admin/leads', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.query.key !== adminKey) return res.status(403).json({ error: 'Acesso negado.' });

  // O status precisa olhar TAMBEM o arquivo em disco, nao so a memoria.
  // Antes so consultava o orderStore (TTL de 2h) e por isso TODO lead com
  // mais de 2 horas aparecia como "expirado_da_memoria" — inclusive quem
  // tinha comprado. O relatorio dava a entender que ninguem converteu.
  const leads = await leadStore.listLeads();
  const enriched = await Promise.all(
    leads.map(async (lead) => {
      const live = orderStore.getOrder(lead.orderId) || (await photoArchive.loadOrder(lead.orderId));
      let statusAtual;
      if (!live) statusAtual = 'sem_registro';           // saiu da memoria e nao foi pago
      else if (live.status === 'paid') statusAtual = 'pago';
      else statusAtual = 'aguardando_pagamento';

      // Pra quem pagou, ja devolve o link pronto — e o que o suporte precisa
      // colar no WhatsApp quando o cliente diz que perdeu as fotos.
      const base = `${req.protocol}://${req.get('host')}`;
      return {
        ...lead,
        statusAtual,
        linkDasFotos: statusAtual === 'pago' ? `${base}/?pedido=${lead.orderId}` : null,
      };
    })
  );

  const pagos = enriched.filter((l) => l.statusAtual === 'pago').length;
  res.json({
    total: enriched.length,
    pagos,
    naoConverteram: enriched.length - pagos,
    leads: enriched,
  });
});

// Baixa TODAS as fotos do pedido num único ZIP — a ação principal da tela de
// resultado pra quem comprou o Pacote Premium (antes eram 5 downloads
// separados, com alvos de toque pequenos no celular).
router.get('/orders/:id/download/all', async (req, res) => {
  const order = orderStore.getOrder(req.params.id) || (await photoArchive.loadOrder(req.params.id));
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'paid' || !order.fullImageBuffer) {
    return res.status(403).json({ error: 'Fotos disponíveis somente após o pagamento.' });
  }

  const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const main = await deliverableImage(order, order.fullImageBuffer);
  const files = [{ name: `photopro-1-${slug(order.style)}.${main.ext}`, data: main.data }];
  if (Array.isArray(order.bumpImages)) {
    for (let i = 0; i < order.bumpImages.length; i++) {
      const img = order.bumpImages[i];
      const out = await deliverableImage(order, img.imageBuffer);
      files.push({ name: `photopro-${i + 2}-${slug(img.style)}.${out.ext}`, data: out.data });
    }
  }

  try {
    const zip = buildZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="photopro-minhas-fotos.zip"');
    res.setHeader('Content-Length', zip.length);
    res.send(zip);
  } catch (err) {
    console.error(`[order ${order.id}] falha ao montar ZIP:`, err.message || err);
    res.status(500).json({ error: 'Não foi possível montar o pacote. Baixe as fotos individualmente.' });
  }
});

router.get('/orders/:id/download/bump/:index', async (req, res) => {
  const order = orderStore.getOrder(req.params.id) || (await photoArchive.loadOrder(req.params.id));
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const idx = parseInt(req.params.index, 10);
  if (
    order.status !== 'paid' || !order.bumpPurchased || order.bumpStatus !== 'ready' ||
    !Array.isArray(order.bumpImages) || Number.isNaN(idx) || idx < 0 || idx >= order.bumpImages.length
  ) {
    return res.status(403).json({ error: 'Foto não disponível.' });
  }
  const img = order.bumpImages[idx];
  const safeName = img.style.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');
  const out = await deliverableImage(order, img.imageBuffer);
  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="photopro-${safeName}.${out.ext}"`);
  res.send(out.data);
});

// ---------------------------------------------------------------------------
// ETAPA 4 -> pagamento (FALLBACK): cria a preferência do Checkout Pro
// (redireciona o cliente para fora do site). Só é usado pelo front-end se o
// checkout embutido (Payment Brick, rota abaixo) não puder ser carregado —
// por exemplo, se MP_PUBLIC_KEY ainda não tiver sido configurada. Continua
// sem nenhuma chamada à OpenAI — só cria a cobrança.
// ---------------------------------------------------------------------------
router.post('/orders/:id/pay', async (req, res) => {
  const order = orderStore.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'pending_payment') {
    return res.status(400).json({ error: 'Este pedido não está mais disponível para pagamento.' });
  }

  try {
    const publicUrl = req.app.get('publicUrl');
    const initPoint = await mercadoPagoService.createCheckoutPreference(order, publicUrl);
    res.json({ initPoint });
  } catch (err) {
    console.error(`[order ${order.id}] erro ao criar preferência MP:`, err);
    res.status(500).json({ error: 'Não foi possível iniciar o pagamento.' });
  }
});

// ---------------------------------------------------------------------------
// ETAPA 4 -> pagamento (EMBUTIDO): recebe os dados do Payment Brick
// (cartão ou Pix) direto no nosso próprio site, sem redirecionar o cliente
// para o domínio do Mercado Pago. Para Pix, a resposta traz o QR code —
// o front-end mostra ele mesmo e faz polling em GET /orders/:id até o
// webhook confirmar a aprovação (mesmo mecanismo já usado pós-redirect).
// ---------------------------------------------------------------------------
router.post('/orders/:id/payments', async (req, res) => {
  const order = orderStore.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'pending_payment') {
    return res.status(400).json({ error: 'Este pedido não está mais disponível para pagamento.' });
  }

  try {
    const publicUrl = req.app.get('publicUrl');
    const result = await mercadoPagoService.createDirectPayment(order, req.body || {}, publicUrl);
    // Persistimos pacote/HQ só depois que a MP aceitou criar o pagamento com
    // esse valor exato (result.* reflete o que foi efetivamente cobrado —
    // nunca o que o front-end pediu). A geração das fotos extras só acontece
    // quando o webhook confirmar a aprovação (ver routes/webhooks.js).
    orderStore.updateOrder(order.id, {
      package: result.package,
      hqPurchased: result.hqPurchased,
      bumpPurchased: result.package !== 'inicial',
    });
    res.json(result);
  } catch (err) {
    console.error(`[order ${order.id}] erro ao criar pagamento direto (Brick):`, err);
    // err.friendly (setado em mercadoPagoService) traz o motivo real (CPF
    // faltando, meio de pagamento não habilitado na conta, etc.) — mostrar
    // isso pro cliente/no console do navegador ajuda a diagnosticar rápido
    // em vez de só um "tente novamente" genérico e opaco.
    const detail = err && err.friendly ? err.message : 'Tente novamente.';
    res.status(500).json({ error: detail });
  }
});

// ---------------------------------------------------------------------------
// Upsell pós-compra "Pacote Premium": só aparece pro cliente que comprou a
// foto única (sem o order bump no checkout) e já viu o resultado. Cobra
// SÓ o valor do bump — nunca marca bumpPurchased aqui (isso só acontece
// quando o webhook confirmar o pagamento aprovado, ver routes/webhooks.js),
// pra não travar um Pix ainda pendente como se já tivesse sido pago.
// ---------------------------------------------------------------------------
router.post('/orders/:id/upsell-payments', async (req, res) => {
  const order = orderStore.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status !== 'paid') {
    return res.status(400).json({ error: 'Este pedido ainda não foi confirmado.' });
  }
  if (order.bumpPurchased) {
    return res.status(400).json({ error: 'Você já tem o Pacote Premium neste pedido.' });
  }
  if (!order.selfieBuffer) {
    // Selfie já expirou (janela de retenção de até 2h, ver orderStore.js) —
    // sem ela não dá pra gerar os outros 4 estilos.
    return res.status(400).json({ error: 'O prazo para adicionar o Pacote Premium a este pedido expirou.' });
  }

  try {
    const publicUrl = req.app.get('publicUrl');
    const result = await mercadoPagoService.createUpsellPayment(order, req.body || {}, publicUrl);
    res.json(result);
  } catch (err) {
    console.error(`[order ${order.id}] erro ao criar pagamento do upsell:`, err);
    const detail = err && err.friendly ? err.message : 'Tente novamente.';
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
