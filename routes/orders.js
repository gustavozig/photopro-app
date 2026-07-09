const express = require('express');
const multer = require('multer');

const orderStore = require('../services/orderStore');
const mercadoPagoService = require('../services/mercadoPagoService');
const openaiService = require('../services/openaiService');
const previewService = require('../services/previewService');
const { validateSelfie } = require('../validators/selfieValidator');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

function serializeOrder(order) {
  const out = {
    id: order.id,
    status: order.status,
    style: order.style,
    previewStatus: order.previewStatus,
  };
  if (order.error) out.error = order.error;
  if (order.previewStatus === 'ready' && order.previewImageBuffer) {
    out.previewImage = `data:image/png;base64,${order.previewImageBuffer.toString('base64')}`;
  }
  if (order.status === 'paid' && order.fullImageBuffer) {
    out.fullImage = `data:image/png;base64,${order.fullImageBuffer.toString('base64')}`;
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
router.get('/orders/:id', (req, res) => {
  const order = orderStore.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json(serializeOrder(order));
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
    res.json(result);
  } catch (err) {
    console.error(`[order ${order.id}] erro ao criar pagamento direto (Brick):`, err);
    res.status(500).json({ error: 'Não foi possível processar o pagamento. Tente novamente.' });
  }
});

module.exports = router;
