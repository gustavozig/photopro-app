const crypto = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const PRICE_BRL = Number(process.env.PRICE_BRL || 9.9);

let _client = null;
function getClient() {
  if (!_client) {
    _client = new MercadoPagoConfig({
      accessToken: process.env.MP_ACCESS_TOKEN,
      options: { timeout: 5000 },
    });
  }
  return _client;
}

/**
 * Cria uma preferência de pagamento (Checkout Pro) para um pedido.
 * @param {{id: string, style: string}} order
 * @param {string} publicUrl - URL pública do app (para back_urls e webhook)
 * @returns {Promise<string>} init_point (URL de checkout hospedada)
 */
async function createCheckoutPreference(order, publicUrl) {
  const preference = new Preference(getClient());
  const result = await preference.create({
    body: {
      items: [
        {
          id: order.id,
          title: 'PhotoPRO — Foto profissional gerada por IA',
          description: `Estilo: ${order.style}`,
          quantity: 1,
          unit_price: PRICE_BRL,
          currency_id: 'BRL',
        },
      ],
      external_reference: order.id,
      notification_url: `${publicUrl}/api/webhooks/mercadopago`,
      back_urls: {
        success: `${publicUrl}/?order=${order.id}&payment=success`,
        failure: `${publicUrl}/?order=${order.id}&payment=failure`,
        pending: `${publicUrl}/?order=${order.id}&payment=pending`,
      },
      auto_return: 'approved',
      statement_descriptor: 'PHOTOPRO',
    },
  });
  return result.init_point;
}

/**
 * Busca um pagamento pelo ID (usado dentro do handler de webhook, nunca
 * confiando apenas no corpo da notificação recebida).
 */
async function getPayment(paymentId) {
  const payment = new Payment(getClient());
  return payment.get({ id: paymentId });
}

/**
 * Valida a assinatura HMAC do webhook do Mercado Pago (header x-signature).
 * Ver: https://www.mercadopago.com.br/developers/en/docs/checkout-pro/payment-notifications
 */
function verifyWebhookSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('MP_WEBHOOK_SECRET não configurado — pulando validação de assinatura (ok só em teste).');
    return true;
  }

  const signatureHeader = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  const dataId = req.query['data.id'] || req.body?.data?.id;
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.trim().split('=').map((s) => s.trim()))
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return hmac === v1;
}

module.exports = { createCheckoutPreference, getPayment, verifyWebhookSignature, PRICE_BRL };
