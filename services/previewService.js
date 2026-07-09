const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Recebe a imagem "crua" gerada por openaiService.generatePreviewPhoto
// (mesmo que gerada com quality:'low' na OpenAI) e devolve uma versão
// reduzida, com blur forte (dá pra reconhecer que é a foto real do cliente
// — a roupa, o fundo, a silhueta — mas NÃO dá pra avaliar qualidade nem
// detalhes do rosto) e uma marca d'água grande "PREVIEW" gravada na
// imagem. Isso é aplicado AQUI, no servidor, e nunca é removido no
// front-end — a versão nítida só existe depois do pagamento (ver
// routes/webhooks.js + generateProfessionalPhoto).
// ---------------------------------------------------------------------------

const PREVIEW_WIDTH = 480; // reduz banda, custo e detalhe — só o suficiente pra reconhecer a pessoa
const BLUR_SIGMA = 18; // blur forte: dá pra ver que é a pessoa/traje, não dá pra avaliar qualidade

// Marca d'água única, grande, centralizada e na diagonal — mesmo visual da
// marca d'água em CSS usada no placeholder genérico (.watermark span), só
// que aqui "gravada" nos pixels da prévia real (não pode ser removida via
// CSS/inspecionar elemento).
function buildWatermarkSvg(width, height) {
  const fontSize = Math.round(width * 0.15);
  const letterSpacing = Math.round(fontSize * 0.14);
  const text = 'PREVIEW';
  // largura aproximada do texto em negrito (heurística: ~0.62em por caractere + letter-spacing)
  const approxTextWidth = text.length * fontSize * 0.62 + (text.length - 1) * letterSpacing;
  const boxPaddingX = Math.round(fontSize * 0.55);
  const boxPaddingY = Math.round(fontSize * 0.4);
  const boxWidth = Math.round(approxTextWidth + boxPaddingX * 2);
  const boxHeight = Math.round(fontSize * 1.5 + boxPaddingY);
  const cx = width / 2;
  const cy = height / 2;

  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="wmShadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.6"/>
        </filter>
      </defs>
      <g transform="rotate(-28 ${cx} ${cy})">
        <rect x="${cx - boxWidth / 2}" y="${cy - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}"
              fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="3" rx="8" filter="url(#wmShadow)"/>
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
              font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="${fontSize}"
              letter-spacing="${letterSpacing}" fill="rgba(255,255,255,0.92)" filter="url(#wmShadow)">${text}</text>
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
