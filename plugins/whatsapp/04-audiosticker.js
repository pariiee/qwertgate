'use strict';

/**
 * plugins/whatsapp/04-audiosticker.js
 * Audio sticker (sound sticker) — gabungkan gambar/stiker + audio jadi SATU
 * pesan stickerMessage yang membawa StickerMessage.audioMessage.
 *
 * Command:
 *   .as  (alias: .audiosticker .asticker .stikeraudio .stickeraudio .saudio)
 *   .s -audio / .sticker -audio
 *
 * Bentuk payload yang dirender WA:
 *   Message.stickerMessage > StickerMessage.audioMessage (field 26)
 *   + ContextInfo.experienceIds [13001] + ContextInfo.mediaDomainInfo
 *
 * SYARAT: zapo-js >= 1.12.1. Encoder proto 1.12.0 membuang
 * `StickerMessage.audioMessage` dan `ContextInfo.experienceIds`, jadi stiker
 * terkirim tanpa audio. Probe di bawah cuma memberi peringatan — command tetap
 * jalan, tapi hasilnya stiker polos kalau syaratnya tidak terpenuhi.
 *
 * Alur pemakaian:
 *   1) Reply audio/voice note, kirim gambar/stiker + caption `.as`
 *   2) Reply gambar/stiker, kirim audio/voice note + caption `.as`
 *   3) Kirim video + caption `.as` -> bot tanya `1` (audio video) / `0` (audio custom)
 */

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const { spawn } = require('child_process');
const { randomBytes } = require('node:crypto');

const { proto } = require('zapo-js');

const mess             = require('../../config/mess');
const { rapikanError } = require('../../engine/pesanError');
const { addStickerExif } = require('../../engine/sticker');

const COMMANDS     = new Set(['as', 'audiosticker', 'asticker', 'stikeraudio', 'stickeraudio', 'saudio']);
const FLAG_AUDIO   = new Set(['-audio', '--audio', '-a']);
// documentMessage ikut: audio yang dikirim sebagai FILE (mp3/m4a/opus), bukan
// voice note, datang sebagai documentMessage. Dulu tidak masuk daftar ini, jadi
// `.as` dengan file mp3 diam saja (laporan 2026-11-25). Ditaruh paling belakang
// supaya tipe yang lebih spesifik tetap diprioritaskan.
const TIPE_MEDIA   = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
const SESSION_TTL  = 5 * 60 * 1000;

// Sesi per (bot, chat, pengirim) — proses ini melayani banyak bot sekaligus,
// jadi botData.id wajib ikut jadi kunci.
const sessions = new Map();

// ─── Probe proto: field sound sticker harus ada di encoder zapo-js ───────────
(function cekProto() {
  try {
    const buf = Buffer.from(proto.Message.StickerMessage.encode({
      url: 'x',
      audioMessage: { url: 'y' },
      contextInfo: {
        experienceIds: [13001],
        mediaDomainInfo: { mediaKeyDomain: 1, e2EeMediaKey: new Uint8Array(32) },
      },
    }).finish());
    if (!buf.includes(Buffer.from([0xd2, 0x01])) || !buf.includes(Buffer.from([0x92, 0x05]))) {
      throw new Error('field audioMessage/experienceIds dibuang encoder');
    }
  } catch (e) {
    console.warn(
      `[ASTICKER] proto zapo-js belum mendukung sound sticker (${e.message}). ` +
      'Upgrade zapo-js ke >= 1.12.1, kalau tidak stiker terkirim tanpa audio.'
    );
  }
})();

// ─── Sesi ────────────────────────────────────────────────────────────────────
const kunciSesi = (ctx) => `${ctx.botData?.id ?? '?'}:${ctx.jid}:${ctx.sender}`;

function setSesi(ctx, data, kunciPaksa = null) {
  const key = kunciPaksa || kunciSesi(ctx);
  const lama = sessions.get(key);
  if (lama?.timer) clearTimeout(lama.timer);
  const sesi = {
    ...data,
    kunci: key,
    pembuat: ctx.sender,          // hanya pembuat ini (plus owner/admin/dev) yang boleh menggerakkan sesi
    dibuatAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
    timer: null,
  };
  sesi.timer = setTimeout(() => {
    if (sessions.get(key) === sesi) sessions.delete(key);
  }, SESSION_TTL);
  sesi.timer.unref?.();
  sessions.set(key, sesi);
  return sesi;
}

function getSesi(ctx) {
  const key = kunciSesi(ctx);
  const sesi = sessions.get(key);
  if (!sesi) return null;
  if (Date.now() > sesi.expiresAt) {
    if (sesi.timer) clearTimeout(sesi.timer);
    sessions.delete(key);
    return null;
  }
  return sesi;
}

// Sesi terbaru di chat yang sama, apa pun pengirimnya. Dipakai owner/admin grup
// supaya masih bisa menjawab `1`/`0` kalau yang membuat sesi sedang tidak aktif.
// Orang lain tidak akan pernah sampai ke sini (lihat `istimewa` di handler).
function sesiTerbaruDiChat(ctx) {
  const awalan = `${ctx.botData?.id ?? '?'}:${ctx.jid}:`;
  const sekarang = Date.now();
  let terbaru = null;
  for (const [key, sesi] of sessions) {
    if (!key.startsWith(awalan)) continue;      // bot lain / chat lain
    if (sekarang > sesi.expiresAt) continue;    // sudah kedaluwarsa
    if (!terbaru || (sesi.dibuatAt || 0) > (terbaru.dibuatAt || 0)) terbaru = sesi;
  }
  return terbaru;
}

function hapusSesiObj(sesi) {
  if (!sesi) return;
  if (sesi.timer) clearTimeout(sesi.timer);
  if (sesi.kunci) sessions.delete(sesi.kunci);
}

function hapusSesi(ctx) {
  const key = kunciSesi(ctx);
  const sesi = sessions.get(key);
  if (sesi?.timer) clearTimeout(sesi.timer);
  sessions.delete(key);
}

// ─── Unduh media dari pesan (pola sama dengan 04-tools/02-group) ─────────────
function rapikanKey(content) {
  const fixed = Object.assign({}, content);
  for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
    if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
  }
  return fixed;
}

function jenisDari(type, content) {
  if (type === 'imageMessage' || type === 'stickerMessage') return 'image';
  if (type === 'audioMessage') return 'audio';
  if (type === 'videoMessage') return 'video';
  // File (documentMessage) bisa apa saja — tebak dari mimetype, kalau kosong dari
  // nama filenya. Selain audio/video/gambar (mis. PDF) diabaikan.
  if (type === 'documentMessage') {
    const mime = String(content?.mimetype || '').toLowerCase();
    const nama = String(content?.fileName || '').toLowerCase();
    if (mime.startsWith('audio/') || /\.(mp3|m4a|aac|opus|ogg|oga|wav|flac|amr|wma)$/.test(nama)) return 'audio';
    if (mime.startsWith('video/') || /\.(mp4|mkv|webm|mov|3gp)$/.test(nama)) return 'video';
    if (mime.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/.test(nama)) return 'image';
  }
  return null;
}

function contextInfo(rawMsg) {
  return rawMsg?.extendedTextMessage?.contextInfo
    || rawMsg?.imageMessage?.contextInfo
    || rawMsg?.videoMessage?.contextInfo
    || rawMsg?.audioMessage?.contextInfo
    || rawMsg?.stickerMessage?.contextInfo
    || rawMsg?.documentMessage?.contextInfo
    || null;
}

async function kumpulkanSumber(ctx) {
  const rawMsg = ctx.msg?.message || {};
  const quoted = contextInfo(rawMsg)?.quotedMessage || null;
  const out = [];

  const ambil = async (wadah) => {
    if (!wadah) return;
    for (const type of TIPE_MEDIA) {
      const content = wadah[type];
      if (!content) continue;
      const kind = jenisDari(type, content);
      if (!kind) continue;
      try {
        const buffer = Buffer.from(await ctx.client.message.downloadBytes({ [type]: rapikanKey(content) }));
        if (buffer?.length) {
          out.push({ buffer, kind, type, mime: content.mimetype || '' });
        }
      } catch (e) {
        console.warn(`[ASTICKER] gagal unduh ${type}: ${e.message}`);
      }
      return; // satu media per pesan sudah cukup
    }
  };

  await ambil(quoted);
  await ambil(rawMsg);
  return out;
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────
function ffmpegPipe(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.stdin.on('error', () => {});
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg gagal: ${err.slice(-200)}`));
      resolve({ buf: Buffer.concat(out), err });
    });
    p.stdin.end(input);
  });
}

const isWebp = (b) =>
  b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';

// Audio (atau audio dari video) -> Ogg/Opus murni
async function keOpus(input) {
  if (input.subarray(0, 4).toString('ascii') === 'OggS') {
    return { buf: input, mimetype: 'audio/ogg; codecs=opus', seconds: null };
  }
  const { buf, err } = await ffmpegPipe([
    '-v', 'info', '-i', 'pipe:0', '-vn', '-map_metadata', '-1',
    '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1',
    '-f', 'ogg', 'pipe:1',
  ], input);
  const t = [...err.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
  return {
    buf,
    mimetype: 'audio/ogg; codecs=opus',
    seconds: t ? Math.round(Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) : null,
  };
}

// Waveform 64 bar untuk voice note (dipakai klien WA untuk gambar gelombang)
function keWaveform(input) {
  return ffmpegPipe(['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], input)
    .then(({ buf }) => {
      const samples = Math.floor(buf.length / 2);
      if (!samples) return null;
      const n = 64;
      const step = Math.max(1, Math.floor(samples / n));
      const w = Buffer.alloc(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        let cnt = 0;
        const start = i * step;
        const end = Math.min((i + 1) * step, samples);
        for (let j = start; j < end; j++) { sum += Math.abs(buf.readInt16LE(j * 2)); cnt++; }
        w[i] = Math.min(100, Math.floor((sum / (cnt || 1)) / 327));
      }
      return w;
    })
    .catch(() => null);
}

// Dimensi + animasi dibaca dari chunk WebP bersih (scan chunk, bukan asumsi
// offset 12 — stiker ber-EXIF bisa mendahulukan chunk metadata).
function parseWebp(b) {
  if (!isWebp(b)) throw new Error('stiker harus berupa WebP');
  let off = 12;
  while (off + 8 <= b.length) {
    const c = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const d = off + 8;
    if (d + size > b.length) break;
    if (c === 'VP8 ') {
      if (size < 10) break;
      return { width: b.readUInt16LE(d + 6) & 0x3fff, height: b.readUInt16LE(d + 8) & 0x3fff, isAnimated: false };
    }
    if (c === 'VP8L') {
      if (size < 5) break;
      return {
        width: 1 + (b[d + 1] | ((b[d + 2] & 0x3f) << 8)),
        height: 1 + ((b[d + 2] >> 6) | (b[d + 3] << 2) | ((b[d + 4] & 0x0f) << 10)),
        isAnimated: false,
      };
    }
    if (c === 'VP8X') {
      if (size < 10) break;
      return {
        width: 1 + b.readUIntLE(d + 4, 3),
        height: 1 + b.readUIntLE(d + 7, 3),
        isAnimated: (b[d] & 2) !== 0,
      };
    }
    off = d + size + (size % 2);
  }
  throw new Error('chunk WebP tidak didukung');
}

// Video -> frame JPEG -> WebP 512px (dipakai kalau sumbernya video)
async function frameKeWebp(video) {
  const ambil = async (detik) => (await ffmpegPipe([
    '-v', 'error', '-i', 'pipe:0', '-ss', String(detik), '-frames:v', '1',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], video)).buf;

  let frame = await ambil(1);
  if (!frame.length) frame = await ambil(0);
  if (!frame.length) throw new Error('gagal mengambil frame dari video');

  const sharp = require('sharp');
  return sharp(frame)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toBuffer();
}

// Video -> WebP ANIMASI (bukan satu frame). Sound sticker di WA = stiker
// bergerak + audio. Kalau videonya diratakan jadi satu frame, member cuma dapat
// foto bersuara — itu yang dilaporkan 2026-11-25.
// Terukur: video 17 dtk 720x1280 → 512px fps15 q70 = ~316 KB. Jadi jalur normal
// (tahap pertama) hampir selalu cukup; tahap berikutnya cuma jaring pengaman
// untuk video panjang.
const BATAS_ANIMASI = 900 * 1024;
async function videoKeWebpAnimasi(video) {
  const tahap = [
    { detik: 0, fps: 15, q: 70 },
    { detik: 8, fps: 12, q: 60 },
    { detik: 5, fps: 10, q: 50 },
  ];
  for (const t of tahap) {
    const args = ['-v', 'error', '-i', 'pipe:0'];
    if (t.detik) args.push('-t', String(t.detik));
    args.push(
      '-vf', `scale=512:512:force_original_aspect_ratio=decrease,fps=${t.fps}`,
      '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', String(t.q),
      '-an', '-f', 'webp', 'pipe:1',
    );
    const { buf } = await ffmpegPipe(args, video);
    if (buf.length <= BATAS_ANIMASI) return buf;
    console.warn(`[ASTICKER] webp animasi ${(buf.length / 1048576).toFixed(1)} MB (fps ${t.fps}, q ${t.q}) — coba setting lebih kecil`);
  }
  // Masih kegedean (video panjang banget): turun ke satu frame supaya tetap kirim.
  console.warn('[ASTICKER] webp animasi tetap kegedean — turun ke satu frame');
  return frameKeWebp(video);
}

async function keWebp(src) {
  if (isWebp(src.buffer)) return src.buffer;
  if (src.kind === 'video') return videoKeWebpAnimasi(src.buffer);

  if (/gif/i.test(src.mime) || src.type === 'gif') {
    const { buf } = await ffmpegPipe([
      '-v', 'error', '-i', 'pipe:0',
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15',
      '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', '70', '-an', '-f', 'webp', 'pipe:1',
    ], src.buffer);
    return buf;
  }

  const sharp = require('sharp');
  return sharp(src.buffer)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();
}

// ─── Kirim audio sticker ─────────────────────────────────────────────────────
async function kirimAudioSticker(ctx, sumberGambar, sumberAudio) {
  const { client, jid } = ctx;

  const webpBersih = await keWebp(sumberGambar);
  const dim = parseWebp(webpBersih); // baca dulu dari WebP bersih, baru sisip EXIF
  const webpBuf = await addStickerExif(webpBersih, mess.packname, mess.author).catch(() => webpBersih);

  const opus = await keOpus(sumberAudio.buffer);
  const waveform = await keWaveform(opus.buf);

  // Upload lewat adapter engine (engine/zapo/client.js). Plugin TIDAK dapat
  // client zapo mentah — `client.message.upload` nggak ada di adapter, yang ada
  // `prepareMedia(buffer, { type, mimetype })` yang balikin proto siap pakai.
  const [upAudio, upSticker] = await Promise.all([
    client.message.prepareMedia(opus.buf, { type: 'ptt', mimetype: opus.mimetype }),
    client.message.prepareMedia(webpBuf, { type: 'sticker', mimetype: 'image/webp' }),
  ]);
  const a = upAudio?.audioMessage;
  const s = upSticker?.stickerMessage;
  if (!a?.directPath || !s?.directPath) throw new Error('upload media gagal (directPath kosong)');

  const sekarang = Math.floor(Date.now() / 1000);
  const domain = (key) => ({ mediaKeyDomain: 1, e2EeMediaKey: key });

  const audioMessage = {
    ...a,
    mimetype: a.mimetype || opus.mimetype,
    mediaKeyTimestamp: a.mediaKeyTimestamp || sekarang,
    ptt: true,
    ...(opus.seconds != null ? { seconds: opus.seconds } : {}),
    ...(waveform ? { waveform } : {}),
    contextInfo: { mediaDomainInfo: domain(a.mediaKey) },
  };

  const stickerMessage = {
    ...s,
    mimetype: 'image/webp',
    height: dim.height,
    width: dim.width,
    mediaKeyTimestamp: s.mediaKeyTimestamp || sekarang,
    isAnimated: dim.isAnimated,
    stickerSentTs: Date.now(),
    audioMessage,
    contextInfo: {
      mediaDomainInfo: domain(s.mediaKey),
      experienceIds: [13001],
    },
  };

  // stickerMessage paling depan supaya getContentType() melaporkan stickerMessage,
  // bukan messageContextInfo.
  await client.message.send(jid, {
    stickerMessage,
    messageContextInfo: { messageSecret: randomBytes(32) },
  });

  return { size: opus.buf.length, seconds: opus.seconds ?? null };
}

// ─── Teks bantuan ────────────────────────────────────────────────────────────
const caraPakai = (p) =>
  `*🔊 Audio Sticker*\n\n` +
  `Gabungkan *gambar/stiker* dengan *audio/voice note* jadi satu audio sticker.\n\n` +
  `> Reply audio/voice note, kirim gambar/stiker + caption \`${p}as\`\n` +
  `> Reply gambar/stiker, kirim audio/voice note + caption \`${p}as\`\n` +
  `> Kirim video + caption \`${p}as\`, lalu pilih:\n` +
  `> \`1\` = video langsung jadi audio sticker (stiker bergerak + audio video)\n` +
  `> \`0\` = stiker bergerak dari video + audio custom\n\n` +
  `Bisa juga lewat \`${p}s -audio\` atau \`${p}saudio\`.`;

const kabarSukses = (res) =>
  `✅ *Audio sticker terkirim*\n` +
  `🔊 ${(res.size / 1024).toFixed(0)} KB` +
  (res.seconds ? ` · ⏱ ${res.seconds} detik` : '');

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function audioStickerHandler(ctx) {
  const { isCmd, command, args, botData, reply, react, jid, client } = ctx;
  const p = botData?.prefix ?? '.';

  const lewatFlag = (command === 's' || command === 'sticker')
    && FLAG_AUDIO.has(String(args?.[0] || '').toLowerCase());
  const perintahUtama = isCmd && (COMMANDS.has(command) || lewatFlag);

  // Siapa yang boleh menggerakkan sesi: pembuat stiker itu sendiri, owner bot,
  // admin grup, atau dev. Orang asing di grup yang sama TIDAK bisa menunggangi
  // sesi orang lain — kunci sesi memang sudah per pengirim, ini pengaman kedua
  // sekaligus jalur akses buat owner/admin (mis. admin yang mengawasi grup).
  const istimewa = Boolean(ctx.isOwner || ctx.isAdmin || ctx.isDev);
  const sesiMilik = getSesi(ctx);
  const sesi = sesiMilik || (istimewa ? sesiTerbaruDiChat(ctx) : null);

  // ── Balasan sesi: `1`/`0` atau media susulan (bukan command) ───────────────
  if (!isCmd && sesi) {
    if (!istimewa && sesi.pembuat && ctx.sender !== sesi.pembuat) return false;

    const teks = String(ctx.body || '').trim().toLowerCase();

    if (sesi.stage === 'pilihVideo') {
      // Visual = VIDEONYA (nanti jadi webp animasi di keWebp), bukan satu frame.
      const ambilGambar = async () => ({
        buffer: sesi.video.buffer,
        kind: 'video',
        type: 'videoMessage',
        mime: sesi.video.mime || 'video/mp4',
      });

      if (teks === '1' || /^(ya|yes|iy(a|e))$/.test(teks)) {
        try {
          const gambar = sesi.image || await ambilGambar();
          const res = await kirimAudioSticker(ctx, gambar, sesi.video);
          hapusSesiObj(sesi);
          await react(mess.reactSuccess).catch(() => {});
          await reply(`${kabarSukses(res)}\n_Video jadi stiker audio._`);
        } catch (e) {
          hapusSesiObj(sesi);
          console.error('[ASTICKER] gagal (video jadi audio sticker):', e?.stack || e?.message || e);
          await reply(`❌ Gagal membuat audio sticker: ${rapikanError(e)}`);
        }
        return true;
      }

      if (teks === '0' || /^(no|tidak|nggak|gak)$/.test(teks)) {
        try {
          const gambar = sesi.image || await ambilGambar();
          setSesi(ctx, { stage: 'audio', image: gambar }, sesi.kunci);
          await reply('Oke, kirim *audio/voice note* custom yang mau dipakai.');
        } catch (e) {
          hapusSesiObj(sesi);
          console.error('[ASTICKER] gagal ambil frame video:', e?.stack || e?.message || e);
          await reply(`❌ Gagal mengambil frame video: ${rapikanError(e)}`);
        }
        return true;
      }

      await reply('Balas `1` (video jadi audio sticker) atau `0` (audio custom).');
      return true;
    }

    // stage 'audio' / 'image': tunggu media yang kurang
    const sumber = await kumpulkanSumber(ctx);
    if (!sumber.length) return false; // biarkan chat biasa jalan

    const gambar = sesi.image || sumber.find((s) => s.kind === 'image');
    const audio  = sesi.audio || sumber.find((s) => s.kind === 'audio');
    const video  = sesi.video || sumber.find((s) => s.kind === 'video');

    if (gambar && (audio || video)) {
      try {
        const res = await kirimAudioSticker(ctx, gambar, audio || video);
        hapusSesiObj(sesi);
        await react(mess.reactSuccess).catch(() => {});
        await reply(kabarSukses(res));
      } catch (e) {
        hapusSesiObj(sesi);
        console.error('[ASTICKER] gagal (media susulan):', e?.stack || e?.message || e);
        await reply(`❌ Gagal membuat audio sticker: ${rapikanError(e)}`);
      }
      return true;
    }

    if (video && !gambar) {
      setSesi(ctx, { stage: 'pilihVideo', video }, sesi.kunci);
      await reply('🎬 Sumbernya video. Ketik `1` (video jadi audio sticker) atau `0` (audio custom).');
      return true;
    }

    if (gambar) {
      setSesi(ctx, { stage: 'audio', image: gambar }, sesi.kunci);
      await reply('🖼️ Gambar/stiker tersimpan. Sekarang kirim *audio/voice note*-nya.');
      return true;
    }

    setSesi(ctx, { stage: 'image', ...(audio ? { audio } : {}), ...(video ? { video } : {}) }, sesi.kunci);
    await reply('🔊 Audio tersimpan. Sekarang kirim *gambar/stiker*-nya.');
    return true;
  }

  if (!perintahUtama) return false;

  // ── Command utama ─────────────────────────────────────────────────────────
  const sumber = await kumpulkanSumber(ctx);
  if (!sumber.length) {
    hapusSesi(ctx);
    await reply(caraPakai(p));
    return true;
  }

  const gambar = sumber.find((s) => s.kind === 'image');
  const audio  = sumber.find((s) => s.kind === 'audio');
  const video  = sumber.find((s) => s.kind === 'video');

  if (gambar && audio) {
    try {
      const res = await kirimAudioSticker(ctx, gambar, audio);
      hapusSesi(ctx);
      await react(mess.reactSuccess).catch(() => {});
      await reply(kabarSukses(res));
    } catch (e) {
      hapusSesi(ctx);
      console.error('[ASTICKER] gagal kirim:', e?.stack || e?.message || e);
      await reply(`❌ Gagal membuat audio sticker: ${rapikanError(e)}`);
    }
    return true;
  }

  if (gambar && video) {
    setSesi(ctx, { stage: 'pilihVideo', image: gambar, video });
    await reply('🎬 Sumbernya video. Ketik `1` (pakai audio video) atau `0` (pakai audio custom).');
    return true;
  }

  if (video) {
    setSesi(ctx, { stage: 'pilihVideo', video });
    await reply('🎬 Sumbernya video. Ketik `1` (pakai audio video) atau `0` (pakai audio custom).');
    return true;
  }

  if (gambar) {
    setSesi(ctx, { stage: 'audio', image: gambar });
    await reply('🖼️ Gambar/stiker tersimpan. Sekarang kirim *audio/voice note*-nya.');
    return true;
  }

  if (audio) {
    setSesi(ctx, { stage: 'image', audio });
    await reply('🔊 Audio tersimpan. Sekarang kirim *gambar/stiker*-nya.');
    return true;
  }

  await reply(caraPakai(p));
  return true;
};
