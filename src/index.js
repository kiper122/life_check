import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';

import { BOT_TOKEN,OWNER_ID,VAULT_PATH, API_ROOT, BOT_API_DOCKER_DIR, BOT_API_HOST_DIR,BOT_API_CONTAINER } from './config.js';
import { stamp, writeLine, importMedia, importWhoop, writeWhoopPage, setField, addPlace, findPlace, logGeo, rebuildVisits } from './vault.js';
import { parseFinance, recordFinance, financeSummary } from './finance.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: Infinity,
  ...(API_ROOT ? { telegram: { apiRoot: API_ROOT } } : {}),
});

const MAX_TELEGRAM_FILE_SIZE = API_ROOT ? 2000 * 1024 * 1024 : 20 * 1024 * 1024;
const FEED = '## 📝 Лента';

const HELP = `Кидай что угодно, я раскладываю по дням в Obsidian:
📷 фото, 🎥 видео, ⭕ кружки, 🎙 голосовые, 📎 файлы, 💭 текст
Подпись и #теги сохраняются вместе с файлом.

💰 Финансы текстом:
-250 кофе #еда
+5000 грн зарплата #работа
-12.5 usd подписка #софт

Команды:
/today сводка дня
/fin [2026-10] итоги месяца
/rate 8 оценка дня
/weight 78.4 вес
/mood спокойный
/thought мысль дня
/whoop режим на 10 мин (или подпись #whoop к фото)
/dump («Режим выгрузки»)
/place («Имя места»)
`;

/* ---------- доступ только владельцу ---------- */
bot.use((ctx, next) => {
  if (ctx.from?.id === OWNER_ID) return next();
  console.log('Чужой/неизвестный ID:', ctx.from?.id);
});

const ICONS = { photo: '📷', video: '🎥', circle: '⭕', voice: '🎙', file: '📎', whoop: '🟢' };
const NO_META = new Set(['voice', 'circle']);
const dump = { active: false, chat: null, count: {}, noTime: 0, failed: 0, days: new Map(), timer: null };
let lastGeo = null;            // последние координаты { gps, s }
const geoByMsg = new Map();    // message_id -> { gps, s }
/* ---------- хелперы ---------- */
const stampOf = (msg) => stamp(msg.forward_origin?.date ?? msg.forward_date ?? msg.date);
const indent = (t) => t.trim().split('\n').join('\n  ');
const argOf = (ctx) => ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim();
const extOf = (name, fallback) => path.extname(name ?? '') || fallback;
const ok = (ctx) => (dump.active ? Promise.resolve() : ctx.react('👍').catch(() => {}));

/** Возвращает локальный путь к файлу и функцию очистки */
async function getLocalFile(ctx, fileId, ext) {
  const p = path.join(os.tmpdir(), `tgdiary_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);

  if (API_ROOT) {
    const f = await ctx.telegram.getFile(fileId);
    const inContainer = f.file_path; // /var/lib/telegram-bot-api/<token>/voice/file_5.oga
    await execFileP('docker', ['cp', `${BOT_API_CONTAINER}:${inContainer}`, p]);
    return {
      p,
      cleanup: async () => {
        await fsp.rm(p, { force: true });
        await execFileP('docker', ['exec', BOT_API_CONTAINER, 'rm', '-f', inContainer]).catch(() => {});
      },
    };
  }

  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.href);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  await fsp.writeFile(p, Buffer.from(await res.arrayBuffer()));
  return { p, cleanup: () => fsp.rm(p, { force: true }) };
}

const armDump = () => {
  clearTimeout(dump.timer);
  dump.timer = setTimeout(() => finishDump().catch(console.error), 10 * 60_000);
};

function track(kind, { failed = false, noTime = false, n = 1 } = {}) {
  if (!dump.active) return;
  armDump();
  if (failed) dump.failed += n;
  else dump.count[kind] = (dump.count[kind] ?? 0) + n;
  if (noTime) dump.noTime += n;
}

async function finishDump() {
  if (!dump.active) return;
  clearTimeout(dump.timer);
  const { chat, count, noTime, failed, days } = dump;
  Object.assign(dump, { active: false, count: {}, noTime: 0, failed: 0, days: new Map() });

  let visits = 0, unnamed = 0;
  for (const s of days.values()) {
    const r = await rebuildVisits(s);
    visits += r.visits;
    unnamed += r.unnamed;
  }
  const total = Object.values(count).reduce((a, b) => a + b, 0);
  const lines = [
    `✅ Выгрузка завершена: сохранено ${total}`,
    Object.entries(count).map(([k, n]) => `${ICONS[k]} ${n}`).join(' · '),
  ];
  if (noTime) lines.push(`⏱ без даты съёмки: ${noTime} (помечены в ленте)`);
  if (failed) lines.push(`⚠️ не сохранено: ${failed}`);
  if (visits) lines.push(`📍 визитов: ${visits}, без названия: ${unnamed}`);
  if (unnamed) lines.push('Назвать место: ответь на фото с GPS командой /place Название');
  await bot.telegram.sendMessage(chat, lines.filter(Boolean).join('\n'));
}

/* ---------- медиа ---------- */
const PLACE_RE = /(^|\s)!([\p{L}\p{N}_-]+)/gu;   // !Парк или !Парк_Горького
const placeName = (raw) => raw.replace(/_/g, ' ');

async function saveMediaMessage(ctx, { kind, icon, fileId, ext, label = '', fileSize = 0 }) {
  const msg = ctx.message;
  const fallback = stampOf(msg);
  const raw = (msg.caption ?? '').trim();
  const tagName = [...raw.matchAll(PLACE_RE)][0]?.[2];
  const caption = raw.replace(PLACE_RE, (_, sp, n) => `${sp}[[${placeName(n)}]]`);
  const mk = (s, extra = '') =>
    `- ${s.time} ${icon}${label ? ' ' + label : ''}${extra}${caption ? ' ' + indent(caption) : ''}`;
  if (dump.active) armDump();

  if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
    await writeLine(fallback, FEED, `${mk(fallback)}\n  ⚠️ файл слишком большой и не сохранён`);
    track(kind, { failed: true });
    return ok(ctx);
  }

  let s = fallback;
  let embed;
  let local;
  let r = null;
  try {
    local = await getLocalFile(ctx, fileId, ext);
    r = await importMedia(local.p, kind, ext, fallback);
    s = r.s;
    embed = `![[${r.name}]]`;
  } catch (e) {
    if (e.message === 'VAULT_MISSING') throw e;
    console.error(e);
    embed = '⚠️ файл не сохранён';
  } finally {
    await local?.cleanup().catch(() => {});
  }

  let extra = '';
  if (r?.gps) {
    if (tagName) await addPlace(placeName(tagName), r.gps);
    const p = await findPlace(r.gps);
    if (p) extra += ` 📍[[${p.name}]]`;
    lastGeo = { gps: r.gps, s };
    geoByMsg.set(msg.message_id, lastGeo);
  }
  const noTime = Boolean(r) && dump.active && !r.fromMeta && !NO_META.has(kind);
  if (noTime) extra += ' ⏱ время неизвестно';

  await writeLine(s, FEED, `${mk(s, extra)}\n  ${embed}`);

  if (r?.gps) {
    if (dump.active) dump.days.set(s.date, s);
    else await rebuildVisits(s);
  }
  track(kind, { failed: !r, noTime });
  await ok(ctx);
}

/* ---------- WHOOP: альбомы и режим ---------- */
const WHOOP_RE = /(^|\s)(#whoop|\/whoop)(?=\s|$)/i;
let whoopUntil = 0;
const albums = new Map(); // media_group_id -> { items, timer }

const isWhoop = (caption) => WHOOP_RE.test(caption ?? '') || Date.now() < whoopUntil;

async function saveWhoop(items) {
  const s = stampOf(items[0].ctx.message);
  let caption = items.map((i) => i.ctx.message.caption).find(Boolean) ?? '';
  caption = caption.replace(/\/whoop/gi, '#whoop').trim();
  if (!/#whoop/i.test(caption)) caption = `#whoop ${caption}`.trim();

  const embeds = [];
  for (const { ctx, opts } of items) {
    let local;
    try {
      local = await getLocalFile(ctx, opts.fileId, opts.ext);
      embeds.push(`![[${await importWhoop(local.p, opts.ext, s)}]]`);
    } catch (e) {
      if (e.message === 'VAULT_MISSING') throw e;
      console.error(e);
      embeds.push('⚠️ файл не сохранён');
    } finally {
      await local?.cleanup().catch(() => {});
    }
  }

  const text = caption.replace(/#whoop/gi, '').trim();
  const group = [`**${s.time}** #whoop${text ? ' ' + indent(text) : ''}`, ...embeds];
  const page = await writeWhoopPage(s, group);

  await writeLine(s, FEED, `\n${s.time} 🟢 WHOOP: [[${page}|${embeds.length} шт.]]`);
    if (dump.active) track('whoop', { n: embeds.length });
  else await items[0].ctx.reply(`🟢 WHOOP: сохранено ${embeds.length} шт. → ${page}`);
}

async function flushAlbum(gid) {
  const a = albums.get(gid);
  albums.delete(gid);
  if (!a) return;
  try {
    if (a.items.some((i) => isWhoop(i.ctx.message.caption))) {
      await saveWhoop(a.items);
    } else {
      for (const { ctx, opts } of a.items) await saveMediaMessage(ctx, opts);
    }
  } catch (e) {
    console.error(e);
    a.items[0].ctx.reply(`❌ Ошибка: ${e.message}`).catch(() => {});
  }
}

/** Фото и картинки-файлы идут сюда: одиночные решаются сразу, альбомы собираются 1.5 сек */
function routeImage(ctx, opts) {
  const gid = ctx.message.media_group_id;
  if (!gid) {
    return isWhoop(ctx.message.caption) ? saveWhoop([{ ctx, opts }]) : saveMediaMessage(ctx, opts);
  }
  let a = albums.get(gid);
  if (!a) albums.set(gid, (a = { items: [], timer: null }));
  a.items.push({ ctx, opts });
  clearTimeout(a.timer);
  a.timer = setTimeout(() => flushAlbum(gid), 1500);
}

bot.command('dump', async (ctx) => {
  const arg = argOf(ctx).toLowerCase();
  if (arg === 'off' || arg === 'end') {
    if (!dump.active) return ctx.reply('Режим выгрузки не включён');
    return finishDump();
  }
  dump.active = true;
  dump.chat = ctx.chat.id;
  armDump();
  await ctx.reply('📥 Режим выгрузки включён. Кидай файлы (лучше как файл: тогда сохранятся дата и GPS).\nЗакончить: /dump off. Сам завершусь через 10 минут тишины.');
});

bot.command('place', async (ctx) => {
  const name = argOf(ctx).replace(/^!/, '').trim();
  if (!name) return ctx.reply('Формат: /place Парк (ответом на фото с GPS или после геолокации)');
  const ref = geoByMsg.get(ctx.message.reply_to_message?.message_id) ?? lastGeo;
  if (!ref) return ctx.reply('Нет координат. Ответь на фото с GPS или сначала отправь геолокацию.');
  await addPlace(name, ref.gps);
  await rebuildVisits(ref.s);
  await ctx.reply(`📍 Запомнил: ${name}`);
});

bot.on(message('location'), async (ctx) => {
  const { latitude: lat, longitude: lon } = ctx.message.location;
  const gps = { lat, lon };
  const s = stampOf(ctx.message);
  await logGeo(s, gps);
  lastGeo = { gps, s };
  geoByMsg.set(ctx.message.message_id, lastGeo);
  const p = await findPlace(gps);
  const where = p ? `[[${p.name}]]` : `[${lat.toFixed(4)}, ${lon.toFixed(4)}](https://www.google.com/maps?q=${lat},${lon})`;
  await writeLine(s, FEED, `- ${s.time} 📍 ${where}`);
  if (dump.active) dump.days.set(s.date, s);
  else await rebuildVisits(s);
  await ok(ctx);
});
bot.command('whoop', async (ctx) => {
  if (argOf(ctx).toLowerCase() === 'off') {
    whoopUntil = 0;
    return ctx.reply('🟢 WHOOP-режим выключен');
  }
  whoopUntil = Date.now() + 10 * 60_000;
  await ctx.reply('🟢 WHOOP-режим на 10 минут: все фото уйдут в папку Whoop.\nВыключить: /whoop off');
});

/* ---------- команды ---------- */
bot.start((ctx) => ctx.reply(HELP));
bot.help((ctx) => ctx.reply(HELP));

bot.command('today', async (ctx) => {
  const s = stamp(ctx.message.date);
  await ctx.reply(`📅 ${s.date} (${s.weekday})\n${await financeSummary(s.date)}`);
});

bot.command('fin', async (ctx) => {
  const s = stamp(ctx.message.date);
  const arg = argOf(ctx);
  await ctx.reply(await financeSummary(/^\d{4}-\d{2}$/.test(arg) ? arg : `${s.year}-${s.month}`));
});

bot.command('rate', async (ctx) => {
  const n = Number(argOf(ctx).replace(',', '.'));
  if (!(n >= 1 && n <= 10)) return ctx.reply('Формат: /rate 8 (от 1 до 10)');
  await setField(stamp(ctx.message.date), 'rating', n);
  await ctx.reply(`⭐ Оценка дня: ${n}`);
});

bot.command('weight', async (ctx) => {
  const n = Number(argOf(ctx).replace(',', '.'));
  if (!(n > 20 && n < 400)) return ctx.reply('Формат: /weight 78.4');
  await setField(stamp(ctx.message.date), 'weight', n);
  await ctx.reply(`⚖️ Вес: ${n}`);
});

for (const [cmd, key, title] of [['mood', 'mood', '🙂 Настроение'], ['thought', 'thought', '💡 Мысль дня']]) {
  bot.command(cmd, async (ctx) => {
    const text = argOf(ctx);
    if (!text) return ctx.reply(`Формат: /${cmd} текст`);
    await setField(stamp(ctx.message.date), key, JSON.stringify(text));
    await ctx.reply(`${title}: ${text}`);
  });
}

/* ---------- медиа ---------- */
bot.on(message('photo'), (ctx) =>
  routeImage(ctx, { kind: 'photo', icon: '📷', fileId: ctx.message.photo.at(-1).file_id, ext: '.jpg' }));

bot.on(message('video'), (ctx) =>
  saveMediaMessage(ctx, { kind: 'video', icon: '🎥', fileId: ctx.message.video.file_id, ext: extOf(ctx.message.video.file_name, '.mp4') }));

bot.on(message('video_note'), (ctx) =>
  saveMediaMessage(ctx, { kind: 'circle', icon: '⭕', fileId: ctx.message.video_note.file_id, ext: '.mp4' }));

bot.on(message('voice'), (ctx) =>
  saveMediaMessage(ctx, { kind: 'voice', icon: '🎙', fileId: ctx.message.voice.file_id, ext: '.ogg' }));

bot.on(message('document'), (ctx) => {
  const d = ctx.message.document;
  const opts = { kind: 'file', icon: '📎', fileId: d.file_id, ext: extOf(d.file_name, ''), label: d.file_name ?? '' };
  return d.mime_type?.startsWith('image/') ? routeImage(ctx, opts) : saveMediaMessage(ctx, opts);
});

/* ---------- текст: финансы или заметка ---------- */
bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  const s = stampOf(ctx.message);

  const f = parseFinance(text);
  if (f) {
    await recordFinance(s, f);
    const sign = f.type === 'income' ? '➕ Доход' : '➖ Расход';
    return ctx.reply(`${sign} ${f.amount} ${f.currency} · ${f.description || f.category}\n\n${await financeSummary(s.date)}`);
  }

  await writeLine(s, FEED, `\n${s.time} 💭 ${indent(text)}`);
  await ok(ctx);
});

/* ---------- ошибки ---------- */
bot.catch((err, ctx) => {
  console.error(err);
  const text = err.message === 'VAULT_MISSING'
    ? '❌ Не вижу папку хранилища. Флешка подключена? Это сообщение не сохранено, перешли его позже.'
    : `❌ Ошибка: ${err.message}`;
  ctx.reply(text).catch(() => {});
});

/* ---------- запуск ---------- */
await bot.telegram.setMyCommands([
  { command: 'today', description: 'Сводка дня' },
  { command: 'fin', description: 'Финансы за месяц' },
  { command: 'rate', description: 'Оценка дня 1-10' },
  { command: 'weight', description: 'Вес' },
  { command: 'mood', description: 'Настроение' },
  { command: 'thought', description: 'Мысль дня' },
  { command: 'help', description: 'Подсказка' },
  { command: 'whoop', description: 'Фото в папку Whoop' },
]);

console.log(`Бот запущен. Хранилище: ${VAULT_PATH}`);
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));