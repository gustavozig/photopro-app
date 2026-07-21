const crypto = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const PRICE_BRL = Number(process.env.PRICE_BRL || 9.9);

// ---------------------------------------------------------------------------
// Pacotes — a escolha principal do cliente na tela de resultado.
// O valor cobrado é SEMPRE resolvido aqui a partir do ID do pacote vindo do
// front-end — nunca confiamos num preço enviado pelo cliente, pra não abrir
// brecha de manipulação do total pago.
//   inicial: 1 foto (o estilo escolhido)
//   premium: 4 fotos (escolhido + 3 do catálogo) — "mais escolhido"
//   deluxe:  10 fotos (premium + Blazer premium + 5 fotos de sessão de
//            estúdio exclusivas) — ver getExtraStylesForPackage em prompts.js
// ---------------------------------------------------------------------------
const PACKAGES = {
  inicial: { price: Number(process.env.PRICE_INICIAL_BRL || 9.9),  title: 'PhotoPRO — Pacote Inicial (1 foto profissional)' },
  premium: { price: Number(process.env.PRICE_PREMIUM_BRL || 24.9), title: 'PhotoPRO — Pacote Premium (4 fotos profissionais)' },
  deluxe:  { price: Number(process.env.PRICE_DELUXE_BRL || 79.9),  title: 'PhotoPRO — Deluxe Estúdio™ (sessão com 10 fotos)' },
};
function resolvePackage(id) {
  return PACKAGES[id] ? id : 'inicial';
}

// Upgrade pós-compra: quem levou o Inicial pode completar o Premium pagando
// só a diferença (24,90 − 9,90). Nunca cobra a foto base de novo.
const UPGRADE_PRICE_BRL = Number((PACKAGES.premium.price - PACKAGES.inicial.price).toFixed(2));

// Bump do checkout: download em qualidade máxima (PNG sem compressão).
// Sem ele, os downloads saem em JPEG otimizado — diferença REAL, ver as
// rotas de download em routes/orders.js.
const HQ_PRICE_BRL = Number(process.env.HQ_PRICE_BRL || 2.9);

// Mantido só para compatibilidade de leitura em código antigo.
const BUMP_PRICE_BRL = UPGRADE_PRICE_BRL;

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

  // Pacote + bump HQ: o total é calculado 100% aqui a partir de IDs/booleanos
  // (`formData.package` e `formData.hq`) — nunca de um valor em R$ vindo do
  // cliente. Um `package` desconhecido/ausente vira 'inicial' (o mais barato):
  // errar pra baixo nunca cobra a mais de ninguém.
  const packageId = resolvePackage(formData.package);
  const hqSelected = formData.hq === true;
  const pkg = PACKAGES[packageId];
  const transactionAmount = Number((pkg.price + (hqSelected ? HQ_PRICE_BRL : 0)).toFixed(2));

  const items = [
    {
      id: `${order.id}-${packageId}`,
      title: pkg.title,
      description: `Estilo principal: ${order.style}`,
      category_id: 'services',
      quantity: 1,
      unit_price: pkg.price,
    },
  ];
  if (hqSelected) {
    items.push({
      id: `${order.id}-hq`,
      title: 'PhotoPRO — Download em qualidade máxima (PNG)',
      description: 'Arquivos PNG originais sem compressão',
      category_id: 'services',
      quantity: 1,
      unit_price: HQ_PRICE_BRL,
    });
  }

  const body = {
    transaction_amount: transactionAmount,
    description: `${pkg.title} — estilo ${order.style}${hqSelected ? ' + download HQ' : ''}`,
    payment_method_id: formData.payment_method_id,
    payer: formData.payer,
    external_reference: order.id,
    notification_url: `${publicUrl}/api/webhooks/mercadopago`,
    statement_descriptor: 'PHOTOPRO',
    // additional_info: enriquece o pagamento com dados do item e do
    // comprador — o antifraude da MP usa isso pra reduzir recusas
    // indevidas de pagamentos legítimos, e é um dos fatores avaliados em
    // "Qualidade da integração" (painel MP > seção "Aprovação dos
    // pagamentos"). Ver:
    // https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/improve-payment-approval/recommendations
    additional_info: {
      items,
      payer: {
        first_name: formData.payer?.first_name || undefined,
        last_name: formData.payer?.last_name || undefined,
      },
    },
  };
  if (formData.token) body.token = formData.token;
  if (formData.installments) body.installments = formData.installments;
  if (formData.issuer_id) body.issuer_id = formData.issuer_id;

  let result;
  try {
    result = await payment.create({
      body,
      requestOptions: {
        idempotencyKey: `${order.id}-${Date.now()}`,
        // Device ID coletado no front-end via script de segurança da MP
        // (window.MP_DEVICE_SESSION_ID, ver public/index.html) — enviado
        // como header X-Meli-Session-Id. Também conta pra qualidade da
        // integração ("Obter e enviar o Device ID" nas recomendações
        // oficiais de aprovação de pagamentos da MP).
        ...(formData.deviceId ? { meliSessionId: formData.deviceId } : {}),
      },
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
    // devolvidos pro caller (routes/orders.js) persistir no pedido só depois
    // que a MP aceitou criar o pagamento com esse valor exato.
    package: packageId,
    hqPurchased: hqSelected,
    amount: transactionAmount,
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
 * Upgrade pós-compra Inicial → Premium — cobrado separadamente, DEPOIS que
 * o pedido base já foi pago e entregue (cliente viu a foto, decidiu voltar
 * e completar o pacote). Cobra SÓ a diferença de preço entre os pacotes
 * (UPGRADE_PRICE_BRL) — nunca a foto base de novo.
 *
 * external_reference recebe o sufixo ":upsell" pra o webhook (ver
 * routes/webhooks.js) saber diferenciar isto de um pagamento do pedido
 * base com o mesmo order.id, e rotear pra runBumpGenerationInBackground
 * em vez do fluxo normal de geração + entrega.
 *
 * @param {{id: string, style: string}} order
 * @param {object} formData - mesmo formato de createDirectPayment
 * @param {string} publicUrl
 */
async function createUpsellPayment(order, formData, publicUrl) {
  const payment = new Payment(getClient());

  if (formData.payment_method_id === 'pix' && !formData.payer?.identification?.number) {
    const err = new Error('CPF do pagador não informado — obrigatório para pagamento via Pix.');
    err.friendly = true;
    throw err;
  }

  const body = {
    transaction_amount: UPGRADE_PRICE_BRL,
    description: `PhotoPRO — Upgrade para Pacote Premium (pedido ${order.id})`,
    payment_method_id: formData.payment_method_id,
    payer: formData.payer,
    external_reference: `${order.id}:upsell`,
    notification_url: `${publicUrl}/api/webhooks/mercadopago`,
    statement_descriptor: 'PHOTOPRO',
    additional_info: {
      items: [
        {
          id: `${order.id}-upsell`,
          title: 'PhotoPRO — Upgrade para Pacote Premium (3 fotos adicionais)',
          description: 'Completa o Pacote Premium pagando so a diferenca entre os pacotes',
          category_id: 'services',
          quantity: 1,
          unit_price: UPGRADE_PRICE_BRL,
        },
      ],
      payer: {
        first_name: formData.payer?.first_name || undefined,
        last_name: formData.payer?.last_name || undefined,
      },
    },
  };
  if (formData.token) body.token = formData.token;
  if (formData.installments) body.installments = formData.installments;
  if (formData.issuer_id) body.issuer_id = formData.issuer_id;

  let result;
  try {
    result = await payment.create({
      body,
      requestOptions: {
        idempotencyKey: `${order.id}-upsell-${Date.now()}`,
        ...(formData.deviceId ? { meliSessionId: formData.deviceId } : {}),
      },
    });
  } catch (mpErr) {
    const causeList = mpErr?.cause;
    const causeDetail = Array.isArray(causeList) && causeList.length
      ? causeList.map((c) => c.description || c.code).filter(Boolean).join('; ')
      : null;
    const detail = causeDetail || mpErr?.message || 'Erro desconhecido na API do Mercado Pago.';
    console.error(`[order ${order.id}] Mercado Pago rejeitou o pagamento do upsell:`, {
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
    amount: UPGRADE_PRICE_BRL,
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
  createUpsellPayment,
  getPayment,
  verifyWebhookSignature,
  PRICE_BRL,
  BUMP_PRICE_BRL,
  PACKAGES,
  resolvePackage,
  UPGRADE_PRICE_BRL,
  HQ_PRICE_BRL,
};
