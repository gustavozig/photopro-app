const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Recebe a imagem "crua" gerada por openaiService.generatePreviewPhoto
// (ainda em qualidade total de pixel, mesmo que gerada com quality:'low' na
// OpenAI) e devolve uma versão reduzida, com um leve blur ("mini blur" —
// dá pra reconhecer que é a foto real do cliente, mas não dá pra usar) e uma
// marca d'água "gravada" na imagem. Isso é aplicado AQUI, no servidor, e
// nunca é removido no front-end — a versão limpa só existe depois do
// pagamento (ver routes/webhooks.js + generateProfessionalPhoto).
// ---------------------------------------------------------------------------

const PREVIEW_WIDTH = 640; // reduz banda e dificulta reaproveitamento
const BLUR_SIGMA = 4.2; // "mini blur": dá pra ver que é a pessoa, não dá pra usar

function buildWatermarkSvg(width, height) {
  const fontSize = Math.round(width * 0.09);
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .wm {
          fill: rgba(255,255,255,0.55);
          font-size: ${fontSize}px;
          font-weight: 800;
          font-family: Arial, Helvetica, sans-serif;
          letter-spacing: 4px;
        }
      </style>
      <g transform="rotate(-28 ${width / 2} ${height / 2})">
        <text x="50%" y="42%" text-anchor="middle" class="wm">PREVIEW</text>
        <text x="50%" y="60%" text-anchor="middle" class="wm">PHOTOPRO</text>
      </g>
    </svg>
  `);
}

/**
 * @param {Buffer} rawImageBuffer - imagem PNG crua vinda da OpenAI
 * @returns {Promise<Buffer>} imagem PNG final: reduzida, borrada e com marca d'água
 */
async function buildLockedPreview(rawImageBuffer) {
  const resized = await sharp(rawImageBuffer)
    .resize({ width: PREVIEW_WIDTH })
    .blur(BLUR_SIGMA)
    .toBuffer({ resolveWithObject: true });

  const { data, info } = resized;
  const watermarkSvg = buildWatermarkSvg(info.width, info.height);

  return sharp(data)
    .composite([{ input: watermarkSvg, top: 0, left: 0 }])
    .png({ quality: 72, compressionLevel: 8 })
    .toBuffer();
}

module.exports = { buildLockedPreview };
