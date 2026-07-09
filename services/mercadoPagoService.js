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
 * Cria um pagamento DIRETO via API de Payments (usado pelo Payment Brick
 * embutido no modal — cartão ou Pix, sem redirecionar o cliente para fora
 * do site). O status final de aprovação continua sendo confirmado só pelo
 * webhook (ver routes/webhooks.js) — a resposta aqui é só o que a MP retorna
 * na hora (para cartão, muitas vezes já vem "approved"; para Pix, vem
 * "pending" com o QR code, até o cliente efetivamente pagar).
 *
 * @param {{id: string, style: string}} order
 * @param {object} formData - dados devolvidos pelo callback onSubmit do Brick
 * @param {string} publicUrl
 */
async function createDirectPayment(order, formData, publicUrl) {
  const payment = new Payment(getClient());

  // Pix (e qualquer meio via "bank_transfer") exige CPF do pagador — sem
  // isso a API da MP rejeita a criação do pagamento. O Brick normalmente já
  // coleta isso sozinho quando o cliente escolhe Pix, mas garantimos aqui
  // que o campo chegou preenchido antes de gastar uma chamada com a MP.
  if (formData.payment_method_id === 'pix' && !formData.payer?.identification?.number) {
    const err = new Error('CPF do pagador não informado — obrigatório para pagamento via Pix.');
    err.friendly = true;
    throw err;
  }

  const body = {
    transaction_amount: PRICE_BRL,
    description: `PhotoPRO — Foto profissional (${order.style})`,
    payment_method_id: formData.payment_method_id,
    payer: formData.payer,
    external_reference: order.id,
    notification_url: `${publicUrl}/api/webhooks/mercadopago`,
    statement_descriptor: 'PHOTOPRO',
  };
  if (formData.token) body.token = formData.token;
  if (formData.installments) body.installments = formData.installments;
  if (formData.issuer_id) body.issuer_id = formData.issuer_id;

  let result;
  try {
    result = await payment.create({
      body,
      requestOptions: { idempotencyKey: `${order.id}-${Date.now()}` },
    });
  } catch (mpErr) {
    // O SDK da MP joga um erro cuja causa real (o motivo da recusa/erro de
    // validação) vem em `cause` (array de {code, description}) ou em
    // `message`/`error.message` da resposta da API — nunca só um "erro
    // genérico". Extraímos essa causa aqui pra logar (e devolver pro
    // front-end) algo útil o suficiente pra diagnosticar sem precisar
    // acessar o painel da MP toda vez.
    const causeList = mpErr?.cause;
    const causeDetail = Array.isArray(causeList) && causeList.length
      ? causeList.map((c) => c.description || c.code).filter(Boolean).join('; ')
      : null;
    const detail = causeDetail || mpErr?.message || 'Erro desconhecido na API do Mercado Pago.';
    console.error(`[order ${order.id}] Mercado Pago rejeitou o pagamento direto:`, {
      status: mpErr?.status,
      cause: causeList,
      message: mpErr?.message,
    });
    const err = new Error(detail);
    err.friendly = true;
    throw err;
  }

  const out = {
    id: result.id,
    status: result.status,
    statusDetail: result.status_detail,
    paymentMethodId: result.payment_method_id,
  };

  const txData = result.point_of_interaction?.transaction_data;
  if (txData) {
    out.pix = {
      qrCode: txData.qr_code,
      qrCodeBase64: txData.qr_code_base64,
      ticketUrl: txData.ticket_url,
    };
  }

  return out;
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

module.exports = {
  createCheckoutPreference,
  createDirectPayment,
  getPayment,
  verifyWebhookSignature,
  PRICE_BRL,
};
