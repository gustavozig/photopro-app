const fs = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------------------
// Registro de contatos (WhatsApp) informados na tela de loading.
//
// Para que serve: o pedido em si vive 2h em memória, mas o telefone precisa
// sobreviver — é ele que permite (a) o suporte achar o pedido de um cliente
// que perdeu a foto e (b) chamar manualmente quem abriu o checkout e não
// pagou. Sem isso, um abandono some pra sempre (aconteceu: cliente gerou Pix
// em 16/07 e nunca mais foi recuperável).
//
// Formato: um JSON por linha (JSONL) — append é atômico o bastante pro nosso
// volume e o arquivo continua legível/recuperável mesmo se o processo cair no
// meio de uma escrita. Fica no mesmo volume persistente das fotos.
// ---------------------------------------------------------------------------

const DATA_ROOT =
  process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.PHOTO_ARCHIVE_DIR || path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_ROOT, 'leads.jsonl');

/** Grava/atualiza o contato de um pedido. Nunca lança — nunca pode quebrar o fluxo do cliente. */
async function saveLead({ orderId, whatsapp, style, status }) {
  try {
    await fs.mkdir(DATA_ROOT, { recursive: true });
    const line = JSON.stringify({
      orderId,
      whatsapp,
      style: style || null,
      status: status || null,
      at: new Date().toISOString(),
    });
    await fs.appendFile(LEADS_FILE, line + '\n', 'utf8');
  } catch (err) {
    console.error('[leadStore] falha ao gravar lead:', err.message || err);
  }
}

/**
 * Lê todos os contatos, mantendo só o registro mais recente de cada pedido
 * (o mesmo pedido pode ser gravado de novo se o status mudar).
 */
async function listLeads() {
  try {
    const raw = await fs.readFile(LEADS_FILE, 'utf8');
    const byOrder = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        byOrder.set(entry.orderId, entry);
      } catch (_) { /* linha corrompida: ignora e segue */ }
    }
    return Array.from(byOrder.values()).sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('[leadStore] falha ao ler leads:', err.message || err);
    return [];
  }
}

module.exports = { saveLead, listLeads };
