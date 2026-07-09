const express = require('express');
const multer = require('multer');

const orderStore = require('../services/orderStore');
const mercadoPagoService = require('../services/mercadoPagoService');
const { validateSelfie } = require('../validators/selfieValidator');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

function serializeOrder(order) {
  const out = { id: order.id, status: order.status, style: order.style };
  if (order.error) out.error = order.error;
  if (order.status === 'paid' && order.fullImageBuffer) {
    out.fullImage = `data:image/png;base64,${order.fullImageBuffer.toString('base64')}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ETAPA 1 + 2 do fluxo: recebe a selfie e o estilo escolhido.
// Faz SOMENTE validações locais (formato, tamanho, resolução). NENHUMA
// chamada à OpenAI acontece aqui — o pedido fica "pending_payment" até a
// confirmação do pagamento (ver routes/webhooks.js).
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
// ETAPA 4 -> pagamento: cria a preferência do Mercado Pago. Continua sem
// nenhuma chamada à OpenAI — só cria a cobrança.
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

module.exports = router;
