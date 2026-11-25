'use strict';

/**
 * engine/sekaliLihat.js
 * Penyimpanan media pesan sekali-lihat (view once).
 *
 * Kenapa perlu: WhatsApp mengosongkan salinan quote pesan sekali-lihat
 * (`contextInfo.quotedMessage` cuma berisi `viewOnce`, `scanLengths`, `annotations` —
 * tanpa `url`/`mediaKey`/`directPath`), dan blob medianya dihapus begitu pesannya
 * dibuka. Jadi media harus diselamatkan SAAT PESANNYA MASUK, bukan nanti saat user
 * mengetik `.rvo`.
 *
 * Dipakai dua sisi supaya konsisten:
 *   - engine (whatsappEngine.js) — untuk pesan dari DIRI SENDIRI, karena engine
 *     melewati pesan fromMe dan tidak meneruskannya ke plugin;
 *   - plugin `.rvo` (plugins/whatsapp/04-tools.js) — untuk pesan dari orang lain
 *     yang lewat gerbang non-perintah.
 *
 * Batasnya sengaja ketat: RAM bot tidak boleh digemukkan video besar.
 */

const CACHE = new Map();             // <id pesan> -> { buffer, mimetype, tipe }
const MAKS_ENTRI = 10;
const MAKS_BYTE = 6 * 1024 * 1024;

const TIPE_MEDIA = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
const BUNGKUS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'ephemeralMessage', 'documentWithCaptionMessage'];

/** Buka bungkus view-once/ephemeral berlapis pada konten pesan. */
function buka(c) {
  let isi = c;
  for (let i = 0; i < 5 && isi; i++) {
    const k = Object.keys(isi).find((x) => BUNGKUS.includes(x));
    if (!k || !isi[k]?.message) break;
    isi = isi[k].message;
  }
  return isi;
}

/** Node media di dalam konten pesan (setelah bungkusnya dibuka), atau null. */
function nodeMedia(konten) {
  const isi = buka(konten);
  const tipe = TIPE_MEDIA.find((t) => isi?.[t]);
  return tipe ? { tipe, node: isi[tipe] } : null;
}

/**
 * Unduh + simpan media sekali-lihat. `pesan` = objek bergaya pesan masuk
 * (`{ key: { id }, message }`). Aman dipanggil untuk pesan apa pun: pesan biasa
 * langsung diabaikan. Tidak pernah melempar.
 *
 * @returns {Promise<boolean>} true kalau medianya berhasil disimpan.
 */
async function tangkap(adapter, pesan, log = console) {
  try {
    const id = pesan?.key?.id;
    if (!id || CACHE.has(id)) return false;

    const media = nodeMedia(pesan?.message);
    if (!media || !media.node?.viewOnce) return false;
    // fileLength boleh kosong di sebagian kiriman; kalau ada dan jelas kegedean, skip.
    if (Number(media.node.fileLength || 0) > MAKS_BYTE) return false;

    const buf = await adapter.message.downloadBytes(pesan);
    if (!buf?.length || buf.length > MAKS_BYTE) return false;

    CACHE.set(id, { buffer: buf, mimetype: media.node.mimetype || '', tipe: media.tipe });
    while (CACHE.size > MAKS_ENTRI) CACHE.delete(CACHE.keys().next().value);
    log.log?.(`[rvo] media sekali-lihat diselamatkan (${media.tipe}, ${(buf.length / 1024).toFixed(0)}KB, id ${String(id).slice(-6)})`);
    return true;
  } catch (e) {
    log.warn?.('[rvo] gagal menyelamatkan media sekali-lihat:', e?.message || e);
    return false;
  }
}

/** Media tersimpan untuk id pesan tertentu, atau null. */
function ambil(id) {
  return (id && CACHE.get(id)) || null;
}

module.exports = { tangkap, ambil, buka, nodeMedia, CACHE, TIPE_MEDIA };