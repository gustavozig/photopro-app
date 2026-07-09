const OpenAI = require('openai');
const { toFile } = require('openai');
const { getPromptForStyle } = require('../prompts');

// ---------------------------------------------------------------------------
// REGRA DE NEGÓCIO CRÍTICA: esta função só deve ser chamada DEPOIS que um
// pagamento for confirmado pelo webhook do Mercado Pago. Nenhuma outra parte
// do sistema deve importar/chamar este serviço antes disso — a geração tem
// custo real, e o produto é anunciado via mídia paga, então gerar imagens
// para quem ainda não pagou é dinheiro jogado fora.
//
// Se no futuro alguém for adicionar um "preview com IA antes do pagamento",
// pare e reconsidere: é exatamente o que este arquivo existe para evitar.
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

module.exports = { generateProfessionalPhoto };
