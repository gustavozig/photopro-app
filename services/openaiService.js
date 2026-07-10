const OpenAI = require('openai');
const { toFile } = require('openai');
const { getPromptForStyle } = require('../prompts');

// ---------------------------------------------------------------------------
// REGRA DE NEGÓCIO: existem DOIS níveis de geração, com custos bem
// diferentes, e cada um só pode ser chamado do lugar certo:
//
//   1) generatePreviewPhoto — quality:'low'. É a ÚNICA chamada à OpenAI
//      permitida ANTES do pagamento. É disparada uma vez por pedido (logo
//      após a selfie ser validada, em routes/orders.js) para gerar uma
//      prévia real e barata, que o front-end mostra borrada + com marca
//      d'água (o blur e a marca d'água são aplicados aqui no servidor, via
//      services/previewService.js, e ficam "gravados" na imagem — nunca
//      expomos a versão limpa antes do pagamento). O objetivo é aumentar a
//      conversão (o cliente vê que é a foto dele de verdade) mantendo o
//      custo baixo mesmo se ele desistir de pagar.
//
//   2) generateProfessionalPhoto — quality:'medium'. Só deve ser chamada
//      DEPOIS que um pagamento for confirmado pelo webhook do Mercado Pago
//      (ver routes/webhooks.js). É a versão final, em qualidade completa,
//      entregue ao cliente.
//
// Nenhuma outra parte do sistema deve chamar generateProfessionalPhoto antes
// da confirmação de pagamento — a geração em qualidade completa tem custo
// real e o produto é anunciado via mídia paga.
// ---------------------------------------------------------------------------

let _client = null;
function getClient() {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

const MAX_ATTEMPTS = 2; // 1 tentativa original + 1 retry automático em caso de falha transitória

/**
 * Gera a foto profissional a partir da selfie e do estilo escolhido.
 * @param {Buffer} selfieBuffer
 * @param {string} selfieMimeType
 * @param {string} styleName
 * @returns {Promise<Buffer>} imagem final (PNG) em alta resolução
 */
async function generateProfessionalPhoto(selfieBuffer, selfieMimeType, styleName) {
  const prompt = getPromptForStyle(styleName);
  const client = getClient();

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const imageFile = await toFile(selfieBuffer, 'selfie.png', { type: selfieMimeType });
      const result = await client.images.edit({
        model: 'gpt-image-1.5',
        image: imageFile,
        prompt,
        size: '1024x1024',
        quality: 'medium',
        // input_fidelity:'high' é o parâmetro oficial da OpenAI pra preservação
        // de identidade em edição de imagem (rostos, logos) — sem ele, o
        // modelo roda no modo padrão, que prioriza seguir o prompt em vez de
        // manter fielmente as feições da pessoa na selfie original. Custa
        // mais tokens de imagem de entrada (~+$0,03 por foto no tier medium),
        // mas só é aplicado aqui — na geração final PAGA — nunca na prévia
        // gratuita, pra não dobrar o custo de quem ainda não converteu.
        input_fidelity: 'high',
      });
      const b64 = result.data[0].b64_json;
      return Buffer.from(b64, 'base64');
    } catch (err) {
      lastError = err;
      console.error(`[openaiService] tentativa ${attempt} falhou:`, err.message || err);
    }
  }
  throw lastError;
}

/**
 * Gera uma prévia BARATA (quality:'low', uma única tentativa, sem retry) da
 * foto profissional. É intencionalmente mais simples/tolerante a falha que
 * generateProfessionalPhoto: se falhar, o front-end simplesmente cai de volta
 * na ilustração genérica — não é uma etapa crítica do fluxo de pagamento.
 * @param {Buffer} selfieBuffer
 * @param {string} selfieMimeType
 * @param {string} styleName
 * @returns {Promise<Buffer>} imagem de prévia (PNG), ainda sem blur/marca d'água
 */
async function generatePreviewPhoto(selfieBuffer, selfieMimeType, styleName) {
  const prompt = getPromptForStyle(styleName);
  const client = getClient();

  const imageFile = await toFile(selfieBuffer, 'selfie.png', { type: selfieMimeType });
  const result = await client.images.edit({
    model: 'gpt-image-1.5',
    image: imageFile,
    prompt,
    size: '1024x1024',
    quality: 'low',
  });
  const b64 = result.data[0].b64_json;
  return Buffer.from(b64, 'base64');
}

module.exports = { generateProfessionalPhoto, generatePreviewPhoto };
