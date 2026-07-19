const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Meta Conversions API (CAPI) — envia o evento Purchase direto do servidor
// pro Meta, no exato momento em que o webhook do Mercado Pago confirma um
// pagamento aprovado (ver routes/webhooks.js). Isso existe porque:
//
//   1) Rastreamento só pelo pixel do navegador perde uma fatia relevante das
//      conversões (bloqueador de anúncio, Safari/iOS, cookies de terceiros).
//   2) O webhook é a fonte de verdade do pagamento — mais confiável que
//      confiar só no que acontece no navegador do cliente.
//
// O mesmo evento também é disparado pelo pixel no navegador (ver index.html,
// dentro de pollUntilPaid) com o MESMO event_id — assim o Meta deduplica e
// não conta a venda duas vezes; cada lado só contribui os dados que tem
// (o navegador: fbp/fbc/cookies; o servidor: IP real, user-agent, e-mail).
//
// Se META_PIXEL_ID ou META_CAPI_ACCESS_TOKEN não estiverem configurados,
// esta função não faz nada (só loga um aviso) — nunca deve derrubar o fluxo
// de pagamento/geração por causa de rastreamento de anúncio.
// ---------------------------------------------------------------------------

const GRAPH_API_VERSION = 'v21.0';

function sha256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

/**
 * @param {Object} params
 * @param {string} params.orderId - usado para montar o event_id (dedupe com o pixel do navegador)
 * @param {number} params.value - valor da venda (ex: 9.90)
 * @param {string} [params.email] - e-mail do pagador (vem do payment.payer.email da Mercado Pago)
 * @param {string} [params.phone] - telefone informado pelo cliente (só dígitos, com DDI 55) — sobe a qualidade da correspondência
 * @param {string} [params.clientIp] - IP do cliente, capturado na criação do pedido
 * @param {string} [params.userAgent] - User-Agent do navegador, capturado na criação do pedido
 * @param {string} [params.fbp] - cookie _fbp (setado pelo próprio pixel no navegador)
 * @param {string} [params.fbc] - cookie _fbc (só existe se o clique veio de um anúncio do Meta)
 * @param {string} [params.sourceUrl] - URL da página onde a compra aconteceu
 */
async function sendPurchaseEvent({ orderId, value, email, phone, clientIp, userAgent, fbp, fbc, sourceUrl }) {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn(`[metaCapiService] META_PIXEL_ID/META_CAPI_ACCESS_TOKEN não configurados — evento Purchase do pedido ${orderId} não foi enviado ao Meta.`);
    return;
  }

  const userData = {};
  if (email) userData.em = [sha256(email)];
  // Telefone precisa ir só com dígitos e DDI (padrão E.164 sem "+"), senão o
  // Meta não casa o hash com o cadastro do usuário.
  if (phone) {
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length >= 10) userData.ph = [sha256(digits.startsWith('55') ? digits : `55${digits}`)];
  }
  if (clientIp) userData.client_ip_address = clientIp;
  if (userAgent) userData.client_user_agent = userAgent;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const eventPayload = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: `purchase_${orderId}`, // precisa bater exatamente com o eventID usado no fbq('track','Purchase',...) do front-end
    action_source: 'website',
    event_source_url: sourceUrl,
    user_data: userData,
    custom_data: {
      value,
      currency: 'BRL',
      content_name: 'PhotoPRO — Foto profissional gerada por IA',
    },
  };

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [eventPayload] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[metaCapiService] Meta rejeitou o evento Purchase do pedido ${orderId}:`, body);
      return;
    }
    console.log(`[metaCapiService] Purchase enviado ao Meta CAPI (pedido ${orderId}).`);
  } catch (err) {
    // Nunca deixa um erro de rede/CAPI quebrar o fluxo de pagamento — isto é
    // só instrumentação de anúncio, não é uma etapa crítica do pedido.
    console.error(`[metaCapiService] falha ao enviar evento Purchase do pedido ${orderId}:`, err.message || err);
  }
}

module.exports = { sendPurchaseEvent };
