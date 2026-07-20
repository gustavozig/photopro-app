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
const BLUR_SIGMA = 5; // reduzido de 12: um cliente relatou "o preview não me dá noção nenhuma" — com
                      // blur forte a pessoa não consegue julgar a QUALIDADE e por isso não compra.
                      // A proteção contra uso sem pagar continua vindo da marca d'água + resolução
                      // baixa (PREVIEW_WIDTH), não do borrão.

// ---------------------------------------------------------------------------
// A marca d'água NÃO é mais desenhada como texto SVG em tempo de requisição.
// Isso foi tentado antes (com @font-face embutido em base64 no próprio SVG)
// e funcionava nos testes locais, mas em produção (Railway) o texto saía
// como uma fileira de retângulos/"tofu boxes" (glifo de fallback) — a versão
// do librsvg empacotada com o sharp ali não aplicava a fonte embutida do
// jeito esperado, mesmo com o .woff2 correto.
//
// Solução mais simples e à prova de ambiente: a palavra "PREVIEW" é
// pré-renderizada UMA VEZ (aqui neste repo, como um PNG transparente já
// pronto — services/assets/watermark-preview.png) e, em tempo de
// requisição, o servidor só usa o sharp pra redimensionar e posicionar essa
// imagem estática sobre a prévia. Nenhuma fonte precisa ser carregada ou
// interpretada em produção — só operações de imagem (resize/composite), que
// não dependem de fontconfig nem de nenhuma fonte instalada no container.
// ---------------------------------------------------------------------------
const WATERMARK_PATH = path.join(__dirname, 'assets', 'watermark-preview.png');
let _watermarkBuffer = null;
function getWatermarkBuffer() {
  if (!_watermarkBuffer) {
    _watermarkBuffer = fs.readFileSync(WATERMARK_PATH);
  }
  return _watermarkBuffer;
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

  // A marca d'água é um PNG quadrado — redimensionamos ela pra largura da
  // prévia (mantendo a proporção quadrada) e centralizamos sobre a imagem
  // (que normalmente é mais alta que larga, tipo retrato). Reproduz o mesmo
  // efeito visual de antes (faixa diagonal centralizada) sem depender de
  // nenhuma fonte do sistema em tempo de requisição.
  const watermarkResized = await sharp(getWatermarkBuffer())
    .resize({ width: info.width })
    .toBuffer();

  return sharp(data)
    .composite([{ input: watermarkResized, gravity: 'center' }])
    .png({ quality: 72, compressionLevel: 8 })
    .toBuffer();
}

module.exports = { buildLockedPreview };
