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
 */

function createOrder({ style, selfieBuffer, selfieMimeType }) {
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
