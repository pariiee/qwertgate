'use strict';

/**
 * engine/tiktok.js
 * Cadangan pengambilan data TikTok saat endpoint `api/download/tiktok` milik
 * YaPari gagal — 2026-11-25 kasusnya: BE balas
 *   "gagal ambil data TikTok (ssr retry 0..2: status 200 tanpa api-data | embed: ...)"
 * padahal link-nya sehat dan halaman TikTok NORMAL kalau diambil dari VPS ini.
 * Artinya scraper di sisi BE yang kena blok/berubah, bukan link-nya.
 *
 * Dua lapis, dicoba berurutan:
 *   1. `ssr-vps` — ambil halaman TikTok langsung dari VPS, baca
 *      `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">` → itemStruct.
 *      Metadata paling lengkap (caption, author, bitrate HD, audio, slide foto).
 *   2. `aio` — endpoint generik `api/download/aio` (backend berbeda di BE),
 *      dipakai kalau TikTok balas halaman tanpa api-data dari VPS ini
 *      (mis. captcha/verify). Metadata lebih minim (judul generik).
 *
 * Hasilnya SENGAJA dibentuk sama dengan `results` dari `api/download/tiktok`,
 * supaya pemanggil (plugins/whatsapp/04-tools.js, case 'tt') tidak perlu diubah
 * selain menukar sumber. Bentuk yang dipakai pemanggil:
 *   { title, author:{nickname,uniqueId}, postType:'video'|'photo',
 *     video:{ no_watermark, duration },
 *     download:{ hd, default, wm, audio, photo[], variants? } }
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// URL di dalam JSON TikTok kadang menyimpan '&amp;' (terutama music.playUrl).
const bersihUrl = (u) => String(u || '').replace(/&amp;/g, '&');

function normalisasiAio(u) {
  return String(u || '').replace(/&amp;/g, '&');
}

/** True kalau `res` (bentuk results API) punya sesuatu yang bisa dikirim. */
function adaMediaTikTok(res) {
  if (!res || typeof res !== 'object') return false;
  const d = res.download;
  const foto = (Array.isArray(d?.photo) && d.photo.length)
    || (Array.isArray(res.images) && res.images.length);
  return Boolean(
    d?.hd || d?.default || d?.wm || d?.audio
    || res.video?.no_watermark
    || (Array.isArray(d?.variants) && d.variants.length)
    || foto
  );
}

/** Ambil HTML halaman video TikTok (short link di-follow redirect-nya). */
async function ambilHtml(url) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.tiktok.com/',
    },
    timeout: 25000,
    maxRedirects: 6,
    responseType: 'text',
    // HTML TikTok ~500 KB; biarkan axios yang urus gzip/br
  });
  return String(res.data || '');
}

/** itemStruct dari `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">`. */
function bacaItemStruct(html) {
  const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const scope = JSON.parse(m[1]).__DEFAULT_SCOPE__ || {};
    const detail = scope['webapp.video-detail'];
    // statusCode !== 0 = TikTok balas halaman error/captcha
    if (detail && detail.statusCode && detail.statusCode !== 0) return null;
    return detail?.itemInfo?.itemStruct || null;
  } catch {
    return null;
  }
}

/** itemStruct → bentuk `results` API. */
function dariItemStruct(item) {
  const v = item.video || {};

  // bitrateInfo memuat beberapa kualitas; ambil yang terbesar (biasanya tanpa watermark)
  const bitrate = (Array.isArray(v.bitrateInfo) ? v.bitrateInfo : [])
    .map((b) => ({ url: b?.PlayAddr?.UrlList?.[0], kbps: Number(b?.Bitrate) || 0 }))
    .filter((x) => x.url)
    .sort((a, b) => b.kbps - a.kbps);

  const hd = bersihUrl(bitrate[0]?.url || v.playAddr || '');
  const sd = bersihUrl(v.downloadAddr || '') || hd;

  // Slide foto (photomode): tiap gambar punya imageURL.urlList
  const foto = (item.imagePost?.images || [])
    .map((i) => i?.imageURL?.urlList?.[0] || i?.displayImage?.urlList?.[0])
    .filter(Boolean)
    .map(bersihUrl);

  return {
    title: item.desc || '',
    author: {
      nickname: item.author?.nickname || '',
      uniqueId: item.author?.uniqueId || '',
    },
    postType: foto.length ? 'photo' : 'video',
    video: { no_watermark: hd, duration: v.duration },
    download: {
      hd,
      default: sd,
      wm: sd,
      audio: bersihUrl(item.music?.playUrl || ''),
      photo: foto,
      variants: bitrate.map((b) => ({ url: bersihUrl(b.url), quality: `${b.kbps}kbps` })),
    },
  };
}

/** Lapis 2: endpoint generik BE (backend berbeda dari scraper TikTok-nya). */
async function lewatAio(url) {
  const base = String(process.env.BASE_API || '').replace(/\/+$/, '');
  const { data } = await axios.get(`${base}/api/download/aio`, {
    params: { url },
    headers: { 'X-API-Key': process.env.KEY_API },
    timeout: 35000,
  });
  if (!data?.success) return null;
  const r = data.results || {};

  const videos = (Array.isArray(r.videos) ? r.videos : []).map((v) => normalisasiAio(v?.url)).filter(Boolean);
  // `images` di aio juga terisi untuk post VIDEO (itu cover/thumbnail, cuma 1).
  // Kalau ikut dihitung, post video terbaca sebagai slide foto → jalur foto dipakai
  // lalu gagal ("Gagal mengunduh atau mengirim slide foto TikTok"). Jadi slide hanya
  // kalau backend memang bilang type=photo.
  const fotos = (r.type === 'photo' && Array.isArray(r.images) ? r.images : [])
    .map((i) => normalisasiAio(typeof i === 'string' ? i : i?.url)).filter(Boolean);
  const audio  = (Array.isArray(r.audio) ? r.audio : []).map((a) => normalisasiAio(a?.url)).filter(Boolean)[0] || '';

  if (!videos.length && !fotos.length) return null;

  const utama = videos[0] || '';
  return {
    title: r.title || '',
    author: {},
    postType: fotos.length || r.type === 'photo' ? 'photo' : 'video',
    video: { no_watermark: utama },
    download: { hd: utama, default: utama, wm: utama, audio, photo: fotos },
  };
}

/**
 * Coba semua cadangan. Balikin `{ res, sumber }` atau `null`.
 * Tidak pernah melempar — pemanggil yang memutuskan mau lempar error atau tidak,
 * supaya pesan asli dari BE tetap bisa ditampilkan kalau cadangan juga gagal.
 */
async function ambilTikTokCadangan(url) {
  // Dua-duanya dijalankan paralel: SSR cepat (~0,5 dtk) tapi URL CDN-nya DITOLAK
  // (403) dari IP VPS ini; aio lebih lambat (~10 dtk) tapi URL-nya lewat proxy
  // tikcdn.io yang bisa diunduh. Jadi: metadata dari SSR, media dari aio.
  const [ssrHasil, aioHasil] = await Promise.allSettled([lewatSsr(url), lewatAio(url)]);

  const meta  = ssrHasil.status === 'fulfilled' ? ssrHasil.value : null;
  const media = aioHasil.status === 'fulfilled' ? aioHasil.value : null;

  if (ssrHasil.status === 'rejected') console.warn(`[tiktok cadangan] ssr gagal: ${ssrHasil.reason?.message}`);
  if (aioHasil.status === 'rejected') console.warn(`[tiktok cadangan] aio gagal: ${aioHasil.reason?.message}`);

  if (media) {
    const res = meta
      ? {
        ...media,
        title: meta.title || media.title,
        author: meta.author || media.author,
        video: { ...media.video, duration: meta.video?.duration },
        download: {
          ...media.download,
          // Slide foto: aio biasanya kosong, pakai daftar dari SSR
          photo: media.download.photo.length ? media.download.photo : (meta.download.photo || []),
        },
      }
      : media;
    return { res, sumber: meta ? 'ssr-vps+aio' : 'aio' };
  }

  // aio mati: pakai SSR apa adanya. Di IP lain CDN-nya mungkin bisa diunduh.
  if (meta && adaMediaTikTok(meta)) return { res: meta, sumber: 'ssr-vps' };

  return null;
}

/** Lapis 1: SSR langsung dari VPS (metadata lengkap). */
async function lewatSsr(url) {
  const html = await ambilHtml(url);
  const item = bacaItemStruct(html);
  if (!item) {
    console.warn('[tiktok cadangan] SSR tidak memuat api-data (kemungkinan captcha dari IP ini)');
    return null;
  }
  const res = dariItemStruct(item);
  return adaMediaTikTok(res) ? res : null;
}

module.exports = { ambilTikTokCadangan, adaMediaTikTok, dariItemStruct, bacaItemStruct };