'use strict';

/**
 * plugins/whatsapp/04-audiosticker.js
 * Audio sticker (sound sticker) — gabungkan gambar/stiker + audio jadi SATU
 * pesan stickerMessage yang membawa StickerMessage.audioMessage.
 *
 * Command:
 *   .sa  (alias: .audiosticker .asticker .stikeraudio .stickeraudio .saudio)
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
 *   1) Reply audio/voice note, kirim gambar/stiker + caption `.sa`
 *   2) Reply gambar/stiker, kirim audio/voice note + caption `.sa`
 *   3) Kirim video + caption `.sa` -> bot tanya `1` (audio video) / `0` (audio custom)
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
const antrianPrompt    = require('../../engine/antrianPrompt');

const COMMANDS     = new Set(['sa', 'audiosticker', 'asticker', 'stikeraudio', 'stickeraudio', 'saudio']);
const FLAG_AUDIO   = new Set(['-audio', '--audio', '-a']);
// documentMessage ikut: audio yang dikirim sebagai FILE (mp3/m4a/opus), bukan
// voice note, datang sebagai documentMessage. Dulu tidak masuk daftar ini, jadi
// `.sa` dengan file mp3 diam saja (laporan 2026-11-25). Ditaruh paling belakang
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

// Batas sesi aktif per (bot, chat) supaya di grup besar sesi setengah jadi
// tidak menumpuk tanpa batas (memory + noise prompt).
const MAKS_SESI_PER_CHAT = 10;

function setSesi(ctx, data, kunciPaksa = null) {
  const key = kunciPaksa || kunciSesi(ctx);
  const awalan = `${ctx.botData?.id ?? '?'}:${ctx.jid}:`;
  const kandidat = [];
  for (const [k, v] of sessions) {
    if (k === key) continue;
    if (!k.startsWith(awalan)) continue;
    kandidat.push([k, v]);
  }
  if (kandidat.length >= MAKS_SESI_PER_CHAT) {
    kandidat.sort((a, b) => (a[1].dibuatAt || 0) - (b[1].dibuatAt || 0));
    const hapus = kandidat.length - (MAKS_SESI_PER_CHAT - 1);
    for (let i = 0; i < hapus; i++) {
      const [k, v] = kandidat[i];
      if (v?.timer) clearTimeout(v.timer);
      sessions.delete(k);
    }
  }
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

  // Daftarkan ke engine supaya balasan `1`/`0` (dan media susulan) dicek LEBIH DULU,
  // sebelum plugin lain jalan — `00-game.js` menelan semua teks non-perintah
  // selama ada game aktif, jadi tanpa ini balasan `.sa` bisa ikut hilang.
  // Upsert per chat: aman dipanggil tiap setSesi, entri lama otomatis kedaluwarsa.
  antrianPrompt.pasang({
    botId: ctx.botData?.id,
    jid: ctx.jid,
    ttlMs: SESSION_TTL,
    jawab: (c) => prosesBalasanSesi(c),
  });

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

// Sesi lain yang masih menunggu di chat yang sama. Dipakai untuk memberi tahu
// admin kalau kiriman member lain belum dijawab `1`/`0` — `1` hanya memproses
// satu sesi (yang paling baru), jadi tanpa info ini terasa "cuma satu yang jadi".
function sesiLainDiChat(ctx, kecuali) {
  const awalan = `${ctx.botData?.id ?? '?'}:${ctx.jid}:`;
  const sekarang = Date.now();
  let jumlah = 0;
  for (const [key, sesi] of sessions) {
    if (kecuali?.kunci && key === kecuali.kunci) continue;
    if (!key.startsWith(awalan)) continue;
    if (sekarang > sesi.expiresAt) continue;
    jumlah++;
  }
  return jumlah;
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

// ─── Antrean konversi ────────────────────────────────────────────────────────
// `.sa` itu kerjaan berat (ffmpeg + WebP animasi). Di server ini (3 core) 4-5
// member barengan bikin SEMUA permintaan jadi lambat, jadi konversi dibatasi
// MAKS_BERSAMAAN sekaligus dan sisanya antre. Bisa diubah lewat env
// `SA_MAKS_BERSAMAAN` tanpa deploy.
const MAKS_BERSAMAAN = Math.max(1, Number(process.env.SA_MAKS_BERSAMAAN || 2));
let sedangJalan = 0;
const antrean = [];

function lewatAntrean(tugas, saatAntre) {
  return new Promise((resolve, reject) => {
    const jalankan = () => {
      sedangJalan += 1;
      Promise.resolve()
        .then(tugas)
        .then(resolve, reject)
        .finally(() => {
          sedangJalan -= 1;
          const lanjut = antrean.shift();
          if (lanjut) lanjut.jalankan();
        });
    };
    if (sedangJalan < MAKS_BERSAMAAN) jalankan();
    else {
      const posisi = antrean.length + 1;
      antrean.push({ jalankan });
      saatAntre?.(posisi);
    }
  });
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────
// Ambil bagian stderr yang berguna buat pesan error. `slice(-200)` mentah bikin
// pesan nyasar: di `-v info` baris terakhir bisa cuma progres ("size=… time=…"),
// jadi errornya malah ketutup (pernah kejadian: "ffmpeg gagal: d : [0][0][0][0]").
function pesanFfmpeg(err) {
  const baris = String(err || '').split('\n').map((b) => b.trim()).filter(Boolean);
  const penting = baris.filter((b) => /error|invalid|unable|no such|does not contain|failed|denied|not found/i.test(b));
  const pilih = (penting.length ? penting : baris).slice(-3);
  return pilih.join(' | ').slice(0, 300) || 'tanpa keterangan';
}

function ffmpegPipe(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    const out = [];
    let err = '';
    // Pengaman antrean: kalau ffmpeg menggantung, slot antrean tidak boleh
    // dipegang selamanya (dulu sebelum ada antrean, hang cuma bikin satu
    // permintaan nyangkut; sekarang efeknya lebih besar).
    const jam = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* sudah mati */ }
      reject(new Error('ffmpeg kelamaan (>90 detik), proses dihentikan'));
    }, 90 * 1000);
    jam.unref?.();
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(jam); reject(e); });
    p.stdin.on('error', () => {});
    p.on('close', (code) => {
      clearTimeout(jam);
      if (code !== 0) return reject(new Error(`ffmpeg gagal: ${pesanFfmpeg(err)}`));
      resolve({ buf: Buffer.concat(out), err });
    });
    p.stdin.end(input);
  });
}

// Ada jalur audio di dalam sumbernya? Dipakai sebelum konversi: video bisu bikin
// ffmpeg mati dengan "Output file does not contain any stream".
function punyaJalurAudio(input) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a',
        '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', 'pipe:0']);
    } catch { resolve(true); return; }
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(true));     // ffprobe hilang? jangan blokir user
    p.on('close', () => resolve(/audio/i.test(out)));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// Durasi (detik) sumber video. Dipakai buat memilih titik awal tangga encode.
// Gagal baca (mis. ffprobe tidak bisa men-seek) -> 0, artinya diperlakukan
// seperti video pendek (perilaku lama).
function durasiDetik(input) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'pipe:0']);
    } catch { resolve(0); return; }
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(0));
    p.on('close', () => resolve(Number(String(out).trim()) || 0));
    p.stdin.on('error', () => {});
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
  // Video bisu (atau file tanpa jalur audio) bikin ffmpeg gagal dengan pesan
  // teknis "Output file does not contain any stream" — kasih pesan yang jelas.
  if (!(await punyaJalurAudio(input))) {
    throw new Error('sumbernya tidak punya jalur audio (videonya bisu / tidak ada suara)');
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
// Ambang 5 detik: video agak panjang sering tidak cukup di fps15 q70 sehingga
// diulang-ulang (data produksi: 271 percobaan encode untuk 446 perintah `.sa`,
// CPU terbuang). Video >5 detik langsung mulai di fps12 q60 — satu kali encode,
// hasil tetap 512px dan <900 KB. Video pendek tetap fps15 q70 (paling halus).
const BATAS_ANIMASI = 900 * 1024;
const AMBANG_VIDEO_PANJANG = 5;
async function videoKeWebpAnimasi(video) {
  const tahap = [
    { detik: 0, fps: 15, q: 70 },
    { detik: 0, fps: 12, q: 60 },
    { detik: 8, fps: 12, q: 60 },
    { detik: 5, fps: 10, q: 50 },
  ];
  const durasi = await durasiDetik(video);
  const mulai = durasi > AMBANG_VIDEO_PANJANG ? 1 : 0;
  for (const t of tahap.slice(mulai)) {
    const args = ['-v', 'error', '-i', 'pipe:0'];
    if (t.detik) args.push('-t', String(t.detik));
    args.push(
      '-vf', `scale=512:512:force_original_aspect_ratio=decrease,fps=${t.fps}`,
      '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', String(t.q),
      '-an', '-f', 'webp', 'pipe:1',
    );
    const { buf } = await ffmpegPipe(args, video);
    if (buf.length <= BATAS_ANIMASI) return buf;
    console.warn(`[ASTICKER] webp animasi ${(buf.length / 1048576).toFixed(1)} MB (fps ${t.fps}, q ${t.q}, durasi ${durasi.toFixed(1)} dtk) — coba setting lebih kecil`);
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
// Pembungkus: batasi berapa konversi yang jalan barengan (lihat lewatAntrean).
// Nomor antrean dihitung SAAT masuk antrean (bukan sebelumnya) supaya dua
// permintaan yang datang nyaris bersamaan tidak dapat nomor yang sama.
async function kirimAudioSticker(ctx, sumberGambar, sumberAudio) {
  return lewatAntrean(
    () => bikinAudioSticker(ctx, sumberGambar, sumberAudio),
    (posisi) => ctx
      .reply(`⏳ Sedang ada proses lain — permintaanmu di antrean ke-${posisi}. Stikernya menyusul ya.`)
      .catch(() => {}),
  );
}

async function bikinAudioSticker(ctx, sumberGambar, sumberAudio) {
  const { client, jid } = ctx;

  const webpBersih = await keWebp(sumberGambar);
  const dim = parseWebp(webpBersih); // baca dulu dari WebP bersih, baru sisip EXIF
  const webpBuf = await addStickerExif(webpBersih, mess.packname, mess.author).catch(() => webpBersih);

  const opus = await keOpus(sumberAudio.buffer);
  const waveform = await keWaveform(opus.buf);

  // Upload lewat adapter engine (engine/zapo/client.js). Plugin TIDAK dapat
  // client zapo mentah — `client.message.upload` nggak ada di adapter, yang ada
  // `prepareMedia(buffer, { type, mimetype })` yang balikin proto siap pakai.
  // Audio di-upload sebagai AUDIO BIASA, bukan voice note (`ptt`).
  // Sound sticker di WA asli bawa AudioMessage biasa: `audio/ogg; codecs=opus`
  // dengan `ptt` TIDAK diset. Waktu kita kirim `ptt: true`, klien WA memperlakukan
  // lampiran itu sebagai voice note di dalam stiker dan muncul
  // "Couldn't play sticker sound".
  const [upAudio, upSticker] = await Promise.all([
    client.message.prepareMedia(opus.buf, { type: 'audio', mimetype: opus.mimetype }),
    client.message.prepareMedia(webpBuf, { type: 'sticker', mimetype: 'image/webp' }),
  ]);
  const a = upAudio?.audioMessage;
  const s = upSticker?.stickerMessage;
  if (!a?.directPath || !s?.directPath) throw new Error('upload media gagal (directPath kosong)');

  const sekarang = Math.floor(Date.now() / 1000);
  const domain = (key) => ({ mediaKeyDomain: 1, e2EeMediaKey: key });

  // Stiker dikirim sebagai BALASAN ke pesan permintaannya (kutipan asli, bukan
  // karangan) supaya di grup jelas siapa yang minta — permintaan pemilik 2026-11-26.
  const asal = ctx.msg?.key;
  const kutipan = asal?.id
    ? {
      stanzaId: asal.id,
      participant: ctx.sender,
      remoteJid: ctx.jid,
      ...(ctx.msg?.message ? { quotedMessage: ctx.msg.message } : {}),
    }
    : null;

  const audioMessage = {
    ...a,
    mimetype: a.mimetype || opus.mimetype,
    mediaKeyTimestamp: a.mediaKeyTimestamp || sekarang,
    // `ptt: false` = audio biasa, BUKAN voice note (lihat catatan upload di atas).
    ptt: false,
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
      ...(kutipan || {}),
    },
  };

  // Sound sticker WA asli dibungkus, bukan stickerMessage polos:
  //   Message.audioStickerMessage (field 134)
  //     > FutureProofMessage.message (field 1)
  //       > Message.stickerMessage (field 26)
  // Kalau stikernya dikirim polos di level atas, klien tetap menampilkan
  // stikernya tapi audionya dijawab "Couldn't play sticker sound" — jadi
  // wadah ini yang bikin suaranya mau diputar (sumber: riset lapangan
  // sound sticker, Nov 2026).
  const messageSecret = randomBytes(32);
  const bytes = Buffer.from(proto.Message.encode({
    messageContextInfo: { messageSecret },
    audioStickerMessage: { message: { stickerMessage } },
  }).finish());

  if (String(jid).endsWith('@g.us')) {
    // Di grup kita kirim mentah supaya `mediatype: 'sticker'` ikut terkirim:
    // zapo menyimpulkan mediatype dari isi pesan, dan wadah `audioStickerMessage`
    // belum dikenali di tabelnya.
    await client.message.kirimPesanGrupMentah(jid, bytes, { mediatype: 'sticker' });
  } else {
    // DM: jalur mentah belum ada (enkripsi Signal per perangkat), jadi pakai
    // kiriman biasa. Wadahnya sudah benar, hanya atribut mediatype yang lewat.
    await client.message.send(jid, {
      audioStickerMessage: { message: { stickerMessage } },
      messageContextInfo: { messageSecret },
    });
  }

  return { size: opus.buf.length, seconds: opus.seconds ?? null };
}

// ─── Teks bantuan ────────────────────────────────────────────────────────────
const caraPakai = (p) =>
  `*🔊 Audio Sticker*\n\n` +
  `Gabungkan *gambar/stiker* dengan *audio/voice note* jadi satu audio sticker.\n\n` +
  `> Kirim *video* + caption \`${p}sa\` — langsung jadi stiker bergerak + suara videonya\n` +
  `> Mau sound sendiri? Ketik \`${p}sa 0\`, lalu kirim *gambar/stiker/video* + *audio/voice note*\n` +
  `> Reply audio/voice note, kirim gambar/stiker + caption \`${p}sa\`\n\n` +
  `Bisa juga lewat \`${p}s -audio\` atau \`${p}saudio\`.`;

const kabarSukses = (res) =>
  `✅ *Audio sticker terkirim*\n` +
  `🔊 ${(res.size / 1024).toFixed(0)} KB` +
  (res.seconds ? ` · ⏱ ${res.seconds} detik` : '');

// ─── Alur kirim ──────────────────────────────────────────────────────────────
/**
 * Video tanpa jalur audio + tidak ada audio custom: ffmpeg pasti gagal dengan
 * "Output file does not contain any stream". Jadi jangan diteruskan ke error
 * teknis — tahan sesinya, minta audio custom (visualnya tetap video itu).
 * Balikin true kalau sesi ditahan.
 */
async function tahanKalauBisu(ctx, video, audio) {
  if (audio || !video) return false;
  if (await punyaJalurAudio(video.buffer)) return false;
  setSesi(ctx, {
    stage: 'audio',
    image: { buffer: video.buffer, kind: 'video', type: 'videoMessage', mime: video.mime || 'video/mp4' },
  });
  await ctx.reply('🎬 Videonya tidak ada suaranya. Kirim *audio/voice note* yang mau dipakai '
    + '(visualnya tetap dari video ini), atau kirim video lain yang ada suaranya.');
  return true;
}

/**
 * Kirim stiker + reaksi + laporan. Dipakai semua jalur (video langsung, media
 * susulan, sound custom) supaya perlakuannya sama.
 */
async function prosesKirim(ctx, gambar, audio, catatan = '') {
  const { reply, react } = ctx;
  const sesi = getSesi(ctx) || null;
  await react(mess.reactLoading).catch(() => {});
  try {
    const res = await kirimAudioSticker(ctx, gambar, audio);
    hapusSesi(ctx);
    await react(mess.reactSuccess).catch(() => {});
    const sisa = sesi ? sesiLainDiChat(ctx, sesi) : 0;
    await reply(`${kabarSukses(res)}${catatan}`
      + (sisa ? `\n\ni️ Masih ada *${sisa}* permintaan lain menunggu di chat ini — kirim lagi pakai \`${ctx.botData?.prefix ?? '.'}sa\`.` : ''));
  } catch (e) {
    hapusSesi(ctx);
    console.error('[ASTICKER] gagal:', e?.stack || e?.message || e);
    await react(mess.reactError).catch(() => {});
    await reply(`❌ Gagal membuat audio sticker: ${rapikanError(e)}`);
  }
  return true;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
/**
 * Proses pesan yang merupakan balasan sesi `.sa` (`1`/`0` atau media susulan).
 *
 * Dipakai dua jalur:
 *   (a) engine lewat `engine/antrianPrompt.js` — dicek SEBELUM dispatch plugin,
 *       supaya balasan `1`/`0` menang atas `00-game.js` (game aktif menelan
 *       semua teks non-perintah);
 *   (b) jalur lama di handler — fallback kalau entri antrian sudah hilang.
 *
 * Balikin true kalau pesannya memang dipakai sesi; false = biarkan chat biasa.
 */
async function prosesBalasanSesi(ctx) {
  if (ctx.isCmd) return false;

  const { reply, react } = ctx;
  const istimewa = Boolean(ctx.isOwner || ctx.isAdmin || ctx.isDev);
  const sesi = getSesi(ctx) || (istimewa ? sesiTerbaruDiChat(ctx) : null);
  if (!sesi) return false;
  if (!istimewa && sesi.pembuat && ctx.sender !== sesi.pembuat) return false;

  const teks = String(ctx.body || '').trim().toLowerCase();

  // stage 'audio' / 'image': tunggu media yang kurang
  const sumber = await kumpulkanSumber(ctx);
  if (!sumber.length) return false; // biarkan chat biasa jalan

  const video  = sesi.video || sumber.find((s) => s.kind === 'video');
  const audio  = sesi.audio || sumber.find((s) => s.kind === 'audio');
  // Video juga boleh jadi visual (nanti jadi webp animasi), sama seperti gambar.
  const gambar = sesi.image || sumber.find((s) => s.kind === 'image') || video;

  if (gambar && (audio || video)) {
    // Video bisu + tanpa audio custom: tahan sesi, minta audionya.
    if (await tahanKalauBisu(ctx, video, audio)) return true;
    return prosesKirim(ctx, gambar, audio || video);
  }

  if (gambar) {
    setSesi(ctx, { stage: 'audio', image: gambar }, sesi.kunci);
    await reply('🖼️ Visualnya sudah masuk. Sekarang kirim *audio/voice note*-nya.');
    return true;
  }

  setSesi(ctx, { stage: 'image', ...(audio ? { audio } : {}) }, sesi.kunci);
  await reply('🔊 Audio tersimpan. Sekarang kirim *gambar/stiker*-nya.');
  return true;
}

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
  // Isinya ada di prosesBalasanSesi() — jalur yang sama juga dipakai engine LEBIH
  // DULU (engine/antrianPrompt.js), jadi balasan `1`/`0` menang atas plugin yang
  // menelan teks non-perintah (mis. `00-game.js` saat ada game aktif). Ini jalur
  // cadangan kalau entri antrian sudah hilang/kedaluwarsa.
  if (!isCmd && sesi) return prosesBalasanSesi(ctx);

  if (!perintahUtama) return false;

  // ── Command utama ─────────────────────────────────────────────────────────
  const sumber = await kumpulkanSumber(ctx);

  const gambar = sumber.find((s) => s.kind === 'image');
  const audio  = sumber.find((s) => s.kind === 'audio');
  const video  = sumber.find((s) => s.kind === 'video');

  // `.sa 0` = mau pakai sound sendiri: bot tunggu audio/voice note-nya.
  const mauCustom = new Set(['0', 'audio', 'suara', 'sound'])
    .has(String(args?.[0] || '').toLowerCase());

  if (!sumber.length) {
    hapusSesi(ctx);
    if (!mauCustom) { await reply(caraPakai(p)); return true; }
    setSesi(ctx, { stage: 'image', custom: true });
    await reply('🎛️ Mode *sound custom*.\n\nKirim *gambar/stiker/video* + *audio/voice note* '
      + 'yang mau dipakai — urutan bebas, bot tunggu sampai keduanya ada.');
    return true;
  }

  // Sudah lengkap (gambar/stiker + audio) -> langsung kirim.
  if (gambar && audio) return prosesKirim(ctx, gambar, audio);

  // `.sa 0`: visual apa saja, audionya nanti dari member.
  if (mauCustom && (gambar || video)) {
    setSesi(ctx, { stage: 'audio', image: gambar || video });
    await reply('🎛️ Oke, kirim *audio/voice note* yang mau dipakai untuk stiker ini.');
    return true;
  }

  // Video (default): langsung jadi pakai suara videonya sendiri — tanpa tanya 1/0.
  if (video) {
    if (await tahanKalauBisu(ctx, video, audio)) return true;
    return prosesKirim(ctx, video, audio || video, '\n_Video jadi stiker audio._');
  }

  if (gambar) {
    setSesi(ctx, { stage: 'audio', image: gambar });
    await reply('🖼️ Gambar/stiker diterima. Sekarang kirim *audio/voice note*-nya.');
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
