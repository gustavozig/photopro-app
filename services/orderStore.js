const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Camada de armazenamento de pedidos.
//
// Hoje isto é um Map em memória — suficiente para o volume inicial do MVP,
// mas a interface (createOrder / getOrder / updateOrder) foi desenhada de
// propósito para não vazar esse detalhe para o resto da aplicação. Quando o
// projeto crescer (ou precisar sobreviver a reinícios do servidor), trocar
// isto por um banco de verdade (Postgres, Redis, etc.) não deve exigir
// mudanças em routes/ nem em services/openaiService.js — só reimplementar
// as funções deste arquivo.
//
// Também é aqui que, no futuro, entram conceitos como "usuário dono do
// pedido", histórico, créditos, etc. quando o login for implementado.
// ---------------------------------------------------------------------------

const ORDER_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

/** @type {Map<string, Order>} */
const orders = new Map();

/**
 * @typedef {Object} Order
 * @property {string} id
 * @property {string} style
 * @property {Buffer} selfieBuffer - guardado só até a geração pós-pagamento acontecer
 * @property {string} selfieMimeType
 * @property {'pending_payment'|'generating'|'paid'|'generation_failed'|'payment_rejected'|'error'} status
 * @property {Buffer|null} fullImageBuffer
 * @property {'pending'|'generating'|'ready'|'failed'} previewStatus - prévia barata (quality:'low'), gerada antes do pagamento
 * @property {Buffer|null} previewImageBuffer - já vem com blur + marca d'água aplicados (services/previewService.js)
 * @property {string|null} error
 * @property {string|null} paymentId
 * @property {number} createdAt
 * @property {string|null} fbp - cookie _fbp do Meta Pixel, capturado na criação do pedido (usado no Meta CAPI)
 * @property {string|null} fbc - cookie _fbc do Meta Pixel (só existe se o clique veio de um anúncio)
 * @property {string|null} clientIp - IP do cliente no momento do pedido (Meta CAPI)
 * @property {string|null} userAgent - User-Agent do navegador no momento do pedido (Meta CAPI)
 * @property {string|null} whatsapp - telefone opcional pra vincular o pedido (suporte + Advanced Matching do CAPI)
 * @property {boolean} bumpPurchased - true se o cliente comprou o order bump "Pacote Premium" (4 estilos extras)
 * @property {'pending'|'generating'|'ready'|'failed'|null} bumpStatus - status da geração dos 4 estilos extras (só relevante se bumpPurchased)
 * @property {Array<{style: string, imageBuffer: Buffer}>|null} bumpImages - as 4 fotos extras já geradas (prontas quando bumpStatus === 'ready')
 */

function createOrder({ style, selfieBuffer, selfieMimeType, fbp, fbc, clientIp, userAgent }) {
  const order = {
    id: uuidv4(),
    style,
    selfieBuffer,
    selfieMimeType,
    status: 'pending_payment',
    fullImageBuffer: null,
    previewStatus: 'pending',
    previewImageBuffer: null,
    error: null,
    paymentId: null,
    createdAt: Date.now(),
    fbp: fbp || null,
    fbc: fbc || null,
    clientIp: clientIp || null,
    userAgent: userAgent || null,
    whatsapp: null, // telefone opcional informado na tela de loading (ver POST /orders/:id/contact)
    bumpPurchased: false,
    bumpStatus: null,
    bumpImages: null,
  };
  orders.set(order.id, order);
  return order;
}

function getOrder(orderId) {
  return orders.get(orderId) || null;
}

function updateOrder(orderId, patch) {
  const order = orders.get(orderId);
  if (!order) return null;
  Object.assign(order, patch);
  return order;
}

function deleteOrder(orderId) {
  orders.delete(orderId);
}

function purgeExpiredOrders() {
  const now = Date.now();
  for (const [id, order] of orders) {
    if (now - order.createdAt > ORDER_TTL_MS) orders.delete(id);
  }
}

module.exports = { createOrder, getOrder, updateOrder, deleteOrder, purgeExpiredOrders };
