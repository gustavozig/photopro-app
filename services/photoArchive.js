const fs = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------------------
// Arquivo persistente das fotos PAGAS.
//
// Por que existe: os pedidos vivem num Map em memória (services/orderStore.js)
// com TTL de 2h — o que é ótimo pra selfies e pedidos abandonados (LGPD,
// memória), mas perigoso pra quem PAGOU: um redeploy ou o TTL apagavam as
// fotos do cliente pra sempre (aconteceu de verdade — pedido recuperado
// manualmente minutos antes de expirar). Este módulo grava as fotos pagas em
// disco assim que ficam prontas e serve de fallback quando o pedido já saiu
// da memória.
//
// Onde grava: RAILWAY_VOLUME_MOUNT_PATH (volume persistente do Railway, se
// anexado — sobrevive a redeploys) > PHOTO_ARCHIVE_DIR > ./data (sobrevive a
// restarts do processo, mas não a redeploys — melhor que nada).
//
// Retenção: ARCHIVE_TTL_DIAS (padrão 7). Só fotos GERADAS (nunca a selfie
// original do cliente) — a promessa de privacidade sobre a selfie continua
// valendo (apagada em até 2h junto com o pedido em memória).
// ---------------------------------------------------------------------------

const ARCHIVE_ROOT = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.PHOTO_ARCHIVE_DIR || path.join(__dirname, '..', 'data'),
  'orders'
);

const ARCHIVE_TTL_MS = (parseInt(process.env.ARCHIVE_TTL_DIAS, 10) || 7) * 24 * 60 * 60 * 1000;

function orderDir(orderId) {
  // uuid v4 só tem [0-9a-f-]; o replace é cinto de segurança contra path traversal
  return path.join(ARCHIVE_ROOT, String(orderId).replace(/[^0-9a-zA-Z-]/g, ''));
}

/**
 * Grava (ou regrava) as fotos pagas de um pedido. Chamado quando a foto
 * principal fica pronta e de novo quando o Pacote Premium fica pronto.
 * Nunca lança — falha de arquivamento não pode quebrar o fluxo de entrega.
 */
async function saveOrder(order) {
  if (!order || order.status !== 'paid' || !order.fullImageBuffer) return;
  try {
    const dir = orderDir(order.id);
    await fs.mkdir(dir, { recursive: true });

    const meta = {
      id: order.id,
      style: order.style,
      createdAt: order.createdAt,
      archivedAt: Date.now(),
      package: order.package || (order.bumpPurchased ? 'premium' : 'inicial'),
      hqPurchased: !!order.hqPurchased,
      bumpPurchased: !!order.bumpPurchased,
      bumpStyles: Array.isArray(order.bumpImages) ? order.bumpImages.map((b) => b.style) : [],
    };

    await fs.writeFile(path.join(dir, 'full.png'), order.fullImageBuffer);
    if (Array.isArray(order.bumpImages)) {
      for (let i = 0; i < order.bumpImages.length; i++) {
        await fs.writeFile(path.join(dir, `bump_${i}.png`), order.bumpImages[i].imageBuffer);
      }
    }
    // meta por último: se existir, o pedido está íntegro no disco
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    console.log(`[archive] pedido ${order.id} arquivado (${meta.bumpStyles.length} fotos premium).`);
  } catch (err) {
    console.error(`[archive] falha ao arquivar pedido ${order && order.id}:`, err.message || err);
  }
}

/**
 * Reconstrói um pedido "pago" a partir do disco, no mesmo formato que o
 * orderStore devolve — pra rotas de consulta/download funcionarem igual.
 * Retorna null se não existir arquivo.
 */
async function loadOrder(orderId) {
  try {
    const dir = orderDir(orderId);
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    const fullImageBuffer = await fs.readFile(path.join(dir, 'full.png'));
    const bumpImages = [];
    for (let i = 0; i < (meta.bumpStyles || []).length; i++) {
      try {
        bumpImages.push({ style: meta.bumpStyles[i], imageBuffer: await fs.readFile(path.join(dir, `bump_${i}.png`)) });
      } catch (_) { /* foto premium individual ausente — entrega as demais */ }
    }
    return {
      id: meta.id,
      style: meta.style,
      status: 'paid',
      createdAt: meta.createdAt,
      package: meta.package || (meta.bumpPurchased ? 'premium' : 'inicial'),
      // legado: quem comprou antes do bump HQ existir sempre baixou PNG —
      // meta antiga sem o campo mantém PNG (nunca rebaixar produto já vendido)
      hqPurchased: meta.hqPurchased === undefined ? true : !!meta.hqPurchased,
      previewStatus: 'ready',
      previewImageBuffer: null,
      fullImageBuffer,
      bumpPurchased: !!meta.bumpPurchased,
      bumpStatus: bumpImages.length > 0 ? 'ready' : (meta.bumpPurchased ? 'failed' : null),
      bumpImages: bumpImages.length > 0 ? bumpImages : null,
      error: null,
    };
  } catch (_) {
    return null;
  }
}

/** Remove do disco pedidos arquivados há mais de ARCHIVE_TTL_MS. */
async function purgeExpired() {
  try {
    const entries = await fs.readdir(ARCHIVE_ROOT, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(ARCHIVE_ROOT, entry.name);
      try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
        if (now - (meta.archivedAt || 0) > ARCHIVE_TTL_MS) {
          await fs.rm(dir, { recursive: true, force: true });
          console.log(`[archive] pedido ${entry.name} expirado e removido do arquivo.`);
        }
      } catch (_) {
        // sem meta.json legível = arquivamento incompleto/corrompido; limpa
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[archive] falha na limpeza:', err.message || err);
  }
}

module.exports = { saveOrder, loadOrder, purgeExpired };
