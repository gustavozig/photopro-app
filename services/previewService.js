const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

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
const BLUR_SIGMA = 12; // blur mais leve que a versão anterior, mas ainda esconde detalhes do rosto

// ---------------------------------------------------------------------------
// A marca d'água é desenhada como SVG e "rasterizada" pelo sharp (libvips ->
// librsvg) direto no servidor. O texto sumiu em produção na primeira versão
// porque usávamos font-family:"Arial" — fonte que praticamente não existe em
// containers Linux (Railway/Docker não vêm com Arial instalada), então só o
// retângulo (forma vetorial, não depende de fonte) aparecia. A correção é
// EMBUTIR a fonte direto no SVG via @font-face + base64 (arquivo em
// services/fonts/roboto-bold.woff2) — assim o texto renderiza igual em
// qualquer ambiente, sem depender de nenhuma fonte já instalada no sistema.
// ---------------------------------------------------------------------------
const FONT_PATH = path.join(__dirname, 'fonts', 'roboto-bold.woff2');
let _fontBase64 = null;
function getFontBase64() {
  if (!_fontBase64) {
    _fontBase64 = fs.readFileSync(FONT_PATH).toString('base64');
  }
  return _fontBase64;
}

// Marca d'água: só a palavra "PREVIEW", grande, centralizada, na diagonal —
// sem caixa/moldura ao redor (removida a pedido, ficava estranha sem o texto
// dentro).
function buildWatermarkSvg(width, height) {
  const fontSize = Math.round(width * 0.16);
  const letterSpacing = Math.round(fontSize * 0.1);
  const text = 'PREVIEW';
  const cx = width / 2;
  const cy = height / 2;
  const fontBase64 = getFontBase64();

  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style type="text/css">
          @font-face {
            font-family: 'PreviewWatermarkFont';
            src: url(data:font/woff2;charset=utf-8;base64,${fontBase64}) format('woff2');
            font-weight: 700;
          }
        </style>
        <filter id="wmShadow" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.65"/>
        </filter>
      </defs>
      <g transform="rotate(-28 ${cx} ${cy})">
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
              font-family="PreviewWatermarkFont" font-weight="700" font-size="${fontSize}"
              letter-spacing="${letterSpacing}" fill="rgba(255,255,255,0.94)" filter="url(#wmShadow)">${text}</text>
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
