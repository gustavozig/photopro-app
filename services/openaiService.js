const OpenAI = require('openai');
const { toFile } = require('openai');
const sharp = require('sharp');
const { getPromptForStyle } = require('../prompts');

// ---------------------------------------------------------------------------
// Formato de entrega da foto FINAL (paga): retrato 4:5 (1080x1350), o padrão
// de foto de perfil profissional (LinkedIn, currículo, etc.) — não quadrado.
// A API do gpt-image-1.5 só aceita os tamanhos fixos 1024x1024, 1536x1024 ou
// 1024x1536 (não aceita 1080x1350 diretamente), então pedimos o retrato mais
// alto disponível (1024x1536, proporção 2:3) e recortamos no servidor pro
// 4:5 exato — ver cropTo4x5() abaixo. A prévia gratuita continua quadrada
// (1024x1024): não faz diferença pra prévia, que é só uma miniatura borrada
// pra provar que é a foto real do cliente, e simplifica o preview UI.
// ---------------------------------------------------------------------------
const FINAL_WIDTH = 1080;
const FINAL_HEIGHT = 1350; // 4:5

async function cropTo4x5(buffer) {
  const { width, height } = await sharp(buffer).metadata();
  const targetRatio = FINAL_WIDTH / FINAL_HEIGHT; // 0.8
  let cropHeight = Math.round(width / targetRatio);
  if (cropHeight > height) cropHeight = height; // salvaguarda se a API devolver algo mais baixo que o esperado
  // Corta ASSIMETRICAMENTE: só 20% do excesso sai do topo e 80% sai de
  // baixo. O rosto/cabeça ficam na metade superior do retrato 2:3, então o
  // corte simétrico (50/50) estava decapitando o topo da cabeça em boa
  // parte das fotos — reclamação real de cliente. Peito/torso aguentam
  // perder mais sem prejuízo nenhum ao enquadramento de retrato.
  const excess = height - cropHeight;
  const top = Math.round(excess * 0.2);
  return sharp(buffer)
    .extract({ left: 0, top, width, height: cropHeight })
    .resize(FINAL_WIDTH, FINAL_HEIGHT)
    .png()
    .toBuffer();
}

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
        size: '1024x1536', // retrato — ver comentário no topo do arquivo sobre o recorte pra 4:5
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
      const rawBuffer = Buffer.from(b64, 'base64');
      return await cropTo4x5(rawBuffer);
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
