'use strict';

/**
 * plugins/whatsapp/12-tema.js
 * Commands: tema, settema, theme, temagc
 *
 * Ganti tema (warna latar) grup WhatsApp lewat stanza `chat_theme`.
 *
 * Asalnya dari referensi Baileys yang dikasih Pak: WhatsApp menerima pengaturan
 * tema sebagai pesan grup terenkripsi `skmsg` bermediatype `chat_theme`, dengan
 * isi proto:
 *
 *     Message.protocolMessage(98) { type(16) = 34, 242: ChatThemeSetting }
 *
 * zapo 1.12.1 belum punya API resmi untuk ini, jadi pengirimannya lewat
 * `client.message.kirimPesanGrupMentah()` — jalur bagian-dalam zapo yang sudah
 * diverifikasi ada di versi terpasang (lihat komentar di engine/zapo/client.js
 * dan references/porting-baileys-features.md).
 *
 * TIDAK didukung: wallpaper foto. Referensinya mengunggah gambar ke endpoint
 * khusus WhatsApp (`/mms/chat-wallpaper-image/...`) yang zapo tidak punya.
 *
 * Gerbang akses: cuma di grup, dan cuma admin grup (atau owner/dev bot).
 */

const { proto } = require('zapo-js');
const mess = require('../../config/mess');

const COMMANDS = new Set(['tema', 'settema', 'theme', 'temagc']);

const WARNA_CEPAT = {
  pink: 'ff69b4',
  biru: '1e90ff',
  ungu: '9b59b6',
  hitam: '121212',
  hijau: '2ecc71',
  merah: 'e74c3c',
  kuning: 'f1c40f',
  oren: 'e67e22',
  putih: 'f5f6fa',
};

// Tipe proto ChatThemeSetting ada di bundel zapo (verified lewat encode).
// Kalau hilang (versi lain), command ini bilang terus terang daripada kirim
// payload kosong.
const ADA_PROTO_TEMA = typeof proto?.Message?.ChatThemeSetting?.encode === 'function';
if (!ADA_PROTO_TEMA) {
  console.warn('[TEMA] proto.Message.ChatThemeSetting tidak ada di zapo ini — command tema dilewati');
}

// ── Penulis protobuf kecil ───────────────────────────────────────────────────
// Cuma butuh varint + field length-delimited; nggak perlu protobufjs.
const varint = (n) => {
  const out = [];
  let v = Number(n) >>> 0;
  while (v > 127) { out.push((v & 127) | 128); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
const fBytes = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), Buffer.from(buf)]);
const fVarint = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);

/**
 * Bungkus payload tema jadi pesan yang dibaca WhatsApp:
 *
 *   Message.protocolMessage (tag 98 = field 12) {
 *     type (tag 16 = field 2)   = 34   // ProtocolMessage.Type.CHAT_THEME_SETTING
 *     theme (tag 242 = field 30) = <ChatThemeSetting>
 *   }
 *
 * Angka di komentar itu TAG protobuf, persis seperti referensi.
 * `34` bukan karangan: di proto zapo enum-nya `t[e[34]] = "CHAT_THEME_SETTING"`.
 */
const bungkusTema = (payload) => fBytes(12, Buffer.concat([fVarint(2, 34), fBytes(30, payload)]));

/** Payload `ChatThemeSetting`: warna solid, atau reset ke bawaan. */
const payloadTema = ({ hex, reset }) => {
  const isi = { settingTimestampMs: Date.now() };
  if (reset) {
    isi.clearTheme = true;
  } else {
    const argb = (0xff000000 | parseInt(hex, 16)) >>> 0;
    isi.solidColor = {
      backgroundLightArgb: argb,
      backgroundDarkArgb: argb,
      isDoodleEnabled: true,
    };
  }
  return Buffer.from(proto.Message.ChatThemeSetting.encode(isi).finish());
};

const telanjang = (j) => String(j || '').split(':')[0].split('@')[0];

/** Peserta grup yang cocok dengan salah satu identitas (nomor/LID). */
const cariPeserta = (meta, kandidat) => {
  const k = (kandidat || []).map(telanjang).filter(Boolean);
  if (k.length === 0) return null;
  return (meta?.participants || []).find((p) => {
    const dia = [p.jid, p.lid, p.phoneNumber].map(telanjang).filter(Boolean);
    return dia.some((x) => k.includes(x));
  }) || null;
};

const caraPakai = (p) =>
  '🎨 *TEMA / WARNA GRUP*\n\n'
  + `• Warna cepat: \`${p}tema pink\`\n`
  + `  _(pink, biru, ungu, hitam, hijau, merah, kuning, oren, putih)_\n`
  + `• Warna kode hex: \`${p}tema #ff69b4\`\n`
  + `• Balikin ke bawaan: \`${p}tema reset\`\n\n`
  + '_Cuma admin grup (atau owner bot) yang bisa ganti._';

module.exports = async function (ctx) {
  const { client, botData, jid, isGroup, body, command, args, reply, react, isOwner, isDev, isAdmin } = ctx;

  if (!COMMANDS.has(String(command || '').toLowerCase())) return false;

  if (!isGroup) {
    await reply('❌ Perintah tema cuma bisa dipakai di dalam grup.');
    return true;
  }

  const p = botData?.prefix ?? '.';

  if (!ADA_PROTO_TEMA) {
    await reply('❌ Fitur tema nggak didukung versi bot ini (proto tema nggak ada).');
    return true;
  }

  const meta = await client.group?.queryGroupMetadata?.(jid).catch(() => null);
  if (!meta) {
    await reply('❌ Gagal ambil data grup.');
    return true;
  }

  // Identitas bot (buat cek bot admin). Kredensial bisa sinkron atau promise.
  const credsMentah = client.auth?.getCurrentCredentials?.() ?? {};
  const creds = (credsMentah && typeof credsMentah.then === 'function') ? await credsMentah : credsMentah;
  const aku = [creds?.meJid, creds?.meLid].map(telanjang).filter(Boolean);

  // Cuma admin grup / owner / dev.
  if (!isAdmin && !isOwner && !isDev) {
    await reply('❌ Cuma admin grup atau owner yang bisa ganti tema grup.');
    return true;
  }

  // Grup mode "cuma admin yang bisa ngomong" -> bot wajib admin dulu.
  if (meta.restrict === true) {
    const botAdmin = cariPeserta(meta, aku)?.isAdmin === true;
    if (!botAdmin) {
      await reply('❌ Jadikan bot admin grup dulu supaya bisa ganti tema.');
      return true;
    }
  }

  const q = args.join(' ').trim();
  const preset = WARNA_CEPAT[q.toLowerCase()];
  const hex = preset || (/^#?[0-9a-f]{6}$/i.test(q) ? q.replace('#', '').toLowerCase() : null);
  const reset = /^(reset|hapus|clear|bawaan|default)$/i.test(q);

  if (!hex && !reset) {
    await reply(caraPakai(p));
    return true;
  }

  const label = reset ? 'kembali ke tema bawaan' : `warna #${String(hex).toUpperCase()}`;

  await react(mess.reactLoading).catch(() => {});

  try {
    const bytes = bungkusTema(payloadTema({ hex, reset }));
    const hasil = await client.message.kirimPesanGrupMentah(jid, bytes, { mediatype: 'chat_theme' });

    await react(mess.reactSuccess).catch(() => {});
    await reply(
      `✅ Tema grup diubah: ${label}.\n`
      + '_Kalau warnanya belum kelihatan di HP, buka ulang grupnya (atau kirim satu pesan biasa di grup ini lalu ulangi)._',
    );

    if (hasil?.kunciBaru) {
      console.warn('[TEMA] kunci grup baru dibuat (SKDM belum terkirim) — peserta bisa belum bisa membaca');
    }
    return true;
  } catch (e) {
    console.error('[TEMA] gagal:', e?.stack || e?.message || e);
    await react(mess.reactError).catch(() => {});
    await reply(`❌ Gagal ganti tema:\n${e?.message || e}`);
    return true;
  }
};

module.exports.limitedCmds = new Set();
