const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Validação 100% local da selfie enviada — NUNCA chama nenhuma API de IA aqui.
// Regra de negócio: nenhum custo de geração é incorrido antes do pagamento.
// Esta é uma pipeline de validadores independentes, para permitir adicionar
// checagens novas (ex: detector de rosto/quantidade de pessoas) no futuro
// sem reescrever a função inteira — basta acrescentar um validador à lista.
// ---------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MIN_DIMENSION_PX = 300;
const MAX_ASPECT_RATIO = 2.2; // evita fotos absurdamente "esticadas"

function validateMimeType(file) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return 'Formato de imagem não suportado. Envie um arquivo JPG, PNG ou WEBP.';
  }
  return null;
}

async function validateDimensions(file) {
  let metadata;
  try {
    metadata = await sharp(file.buffer).metadata();
  } catch (err) {
    return 'Não conseguimos ler essa imagem. Tente outro arquivo.';
  }

  const { width, height } = metadata;
  if (!width || !height) {
    return 'Não conseguimos identificar as dimensões da imagem.';
  }
  if (width < MIN_DIMENSION_PX || height < MIN_DIMENSION_PX) {
    return `A imagem precisa ter pelo menos ${MIN_DIMENSION_PX}x${MIN_DIMENSION_PX} pixels.`;
  }
  const ratio = Math.max(width / height, height / width);
  if (ratio > MAX_ASPECT_RATIO) {
    return 'As proporções dessa imagem não parecem ser de uma selfie. Envie uma foto de rosto/retrato.';
  }
  return null;
}

// Placeholder intencional: caso um detector de rosto/contagem de pessoas seja
// adicionado no futuro (ex: serviço externo leve, sem custo de geração de
// imagem), basta implementar a lógica aqui e adicioná-lo à lista VALIDATORS
// abaixo. Não implementado no MVP para manter o backend enxuto e sem
// dependências pesadas de visão computacional.
async function validateSinglePersonPlaceholder(_file) {
  return null;
}

const VALIDATORS = [
  { fn: validateMimeType, async: false },
  { fn: validateDimensions, async: true },
  { fn: validateSinglePersonPlaceholder, async: true },
];

/**
 * Roda a pipeline de validação local sobre o arquivo enviado.
 * @param {{buffer: Buffer, mimetype: string, size: number}} file
 * @returns {Promise<{valid: boolean, reason: string|null}>}
 */
async function validateSelfie(file) {
  if (!file) {
    return { valid: false, reason: 'Nenhuma imagem enviada.' };
  }
  for (const validator of VALIDATORS) {
    const reason = validator.async ? await validator.fn(file) : validator.fn(file);
    if (reason) return { valid: false, reason };
  }
  return { valid: true, reason: null };
}

module.exports = { validateSelfie, ALLOWED_MIME_TYPES, MIN_DIMENSION_PX };
