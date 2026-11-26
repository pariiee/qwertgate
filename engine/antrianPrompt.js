'use strict';

/**
 * engine/antrianPrompt.js
 *
 * Daftar "pertanyaan menunggu" milik plugin, dicek engine SEBELUM dispatch plugin.
 *
 * Kenapa ada: plugin dijalankan urut nama file, dan `00-game.js` jalan sebelum
 * `04-audiosticker.js`. Selagi ada game aktif di grup, plugin game menganggap
 * SEMUA teks non-perintah sebagai jawaban game (bahkan dikasih reaksi ❌) lalu
 * berhenti di situ — jadi balasan `1`/`0` untuk `.sa` tidak pernah sampai ke
 * plugin yang menunggunya. Engine mengecek daftar ini lebih dulu, supaya
 * pertanyaan yang benar-benar sedang menunggu jawaban menang atas plugin yang
 * lebih rakus.
 *
 * Kontrak (upsert per chat, jadi plugin aman memanggilnya berulang):
 *   pasang({ botId, jid, ttlMs, jawab })  // jawab(ctx) -> true kalau pesan ini
 *                                         // memang jawabannya (dispatch stop)
 *   lepas({ botId, jid })                 // opsional; entri kedaluwarsa sendiri
 *   jalankan(ctx)                         // -> true = sudah ditangani
 *   jumlah()                              // buat diagnosa/uji
 *
 * `jawab(ctx)` WAJIB mengembalikan false untuk pesan yang bukan jawabannya
 * (mis. chat biasa atau command lain) — engine meneruskan dispatch normal kalau
 * semua handler bilang false.
 */

// kunci -> { botId, jid, sampai, jawab }
const daftar = new Map();

const kunciAntrian = (botId, jid) => `${botId ?? '?'}:${jid ?? '?'}`;

function pasang({ botId, jid, ttlMs = 5 * 60 * 1000, jawab } = {}) {
  if (typeof jawab !== 'function') throw new Error('antrianPrompt.pasang: butuh fungsi jawab()');
  if (botId === undefined || botId === null || !jid) {
    throw new Error('antrianPrompt.pasang: butuh botId dan jid');
  }
  daftar.set(kunciAntrian(botId, jid), {
    botId,
    jid,
    sampai: Date.now() + ttlMs,
    jawab,
  });
}

function lepas({ botId, jid } = {}) {
  return daftar.delete(kunciAntrian(botId, jid));
}

function bersihkan() {
  const now = Date.now();
  for (const [kunci, entri] of daftar) {
    if (entri.sampai <= now) daftar.delete(kunci);
  }
}

async function jalankan(ctx) {
  if (!ctx || daftar.size === 0) return false;
  bersihkan();
  if (daftar.size === 0) return false;

  const entri = daftar.get(kunciAntrian(ctx.botData?.id, ctx.jid));
  if (!entri) return false;

  let ditangani = false;
  try {
    ditangani = await entri.jawab(ctx);
  } catch (e) {
    // Jangan sampai bug di handler menahan pesan user: laporkan lalu lewatkan.
    console.error('[ANTRIPROMPT] handler gagal:', e?.stack || e?.message || e);
    return false;
  }
  return ditangani === true;
}

module.exports = {
  pasang,
  lepas,
  jalankan,
  bersihkan,
  jumlah: () => daftar.size,
};
