// ---------------------------------------------------------------------------
// Empacotador ZIP mínimo (método "stored", sem compressão).
//
// Por que não usar uma lib (archiver/jszip): os arquivos aqui são PNGs, que já
// são comprimidos — deflate economizaria ~2% e adicionaria dependência,
// streaming e superfície de bug. O formato ZIP "stored" cabe em ~60 linhas e
// é lido por Windows, macOS, Android e iOS sem nenhum plugin.
//
// Referência do formato: PKWARE APPNOTE (local file header, central directory,
// end of central directory). Sem ZIP64: nossos pacotes têm 5 arquivos de
// poucos MB, muito abaixo dos limites de 4 GB / 65535 arquivos.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * @param {Array<{name: string, data: Buffer}>} files
 * @returns {Buffer} conteúdo completo do .zip
 */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // assinatura local file header
    local.writeUInt16LE(20, 4);          // versão necessária
    local.writeUInt16LE(0x0800, 6);      // flag: nome em UTF-8
    local.writeUInt16LE(0, 8);           // método 0 = stored
    local.writeUInt16LE(0, 10);          // hora
    local.writeUInt16LE(0, 12);          // data
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);       // tamanho comprimido
    local.writeUInt32LE(size, 22);       // tamanho original
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra field

    chunks.push(local, nameBuf, file.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);     // assinatura central directory
    cd.writeUInt16LE(20, 4);             // versão de criação
    cd.writeUInt16LE(20, 6);             // versão necessária
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);        // deslocamento do local header
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

module.exports = { buildZip };
