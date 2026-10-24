import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
// import { Readable } from 'node:stream';
// import { pipeline } from 'node:stream/promises';
import { VAULT_PATH, TIMEZONE, DAY_START_HOUR } from './config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import exifr from 'exifr';

const execFileP = promisify(execFile);

/* ---------- теги ---------- */
export const TAG_RE = /#[\p{L}\p{N}_\-/]+/gu;
export const extractTags = (text = '') => [...new Set(text.match(TAG_RE) ?? [])];

/* ---------- время ---------- */
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});
const weekdayFmt = new Intl.DateTimeFormat('ru', { timeZone: TIMEZONE, weekday: 'long' });

function parts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** unix-секунды -> { date: день по правилу DAY_START_HOUR, time: реальное HH:MM, ... } */
export function stamp(unixSec) {
  const ms = unixSec * 1000;
  const real = parts(ms);
  const shifted = ms - DAY_START_HOUR * 3600_000;
  const d = parts(shifted);
  return {
    ts: unixSec,
    date: `${d.year}-${d.month}-${d.day}`,
    year: d.year,
    month: d.month,
    weekday: weekdayFmt.format(new Date(shifted)),
    time: `${real.hour}:${real.minute}`,
    clock: `${real.hour}${real.minute}${real.second}`,
  };
}

/* ---------- блокировка записи (чтобы альбом из 10 фото не затёр заметку) ---------- */
let chain = Promise.resolve();
const locked = (fn) => {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
};

/* ---------- хранилище ---------- */
export function ensureVault() {
  if (!fs.existsSync(VAULT_PATH)) throw new Error('VAULT_MISSING');
}

export function dayPaths(s) {
  const dir = path.join(VAULT_PATH, 'Days', s.year, s.month, s.date);
  return { dir, mediaDir: path.join(dir, 'media'), note: path.join(dir, `${s.date}.md`) };
}

const newDailyNote = (s) => `---
date: ${s.date}
weekday: ${s.weekday}
tags: [daily]
rating:
weight:
mood:
thought:
---
# ${s.date} · ${s.weekday}

## 📝 Лента

## 📍 Места

## 💰 Финансы
`;

async function load(s) {
  ensureVault();
  const { dir, note } = dayPaths(s);
  await fsp.mkdir(dir, { recursive: true });
  const text = fs.existsSync(note) ? await fsp.readFile(note, 'utf8') : newDailyNote(s);
  return { note, text };
}

const ENTRY_RE = /^(?:- )?(\d{2}):(\d{2})\b/;
const dayMinutes = (h, m) => ((h - DAY_START_HOUR + 24) % 24) * 60 + m;

function insertIntoSection(text, heading, line) {
  const lines = text.split('\n');
  const entry = line.replace(/^\n+/, '').split('\n');
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) {
    lines.push('', heading, ...entry);
    return lines.join('\n');
  }
  let end = i + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end++;

  // раздел -> блоки: строка со временем + её продолжения
  const head = [];
  const blocks = [];
  for (const l of lines.slice(i + 1, end)) {
    if (!l.trim()) continue;
    const m = ENTRY_RE.exec(l);
    if (m) blocks.push({ key: dayMinutes(+m[1], +m[2]), lines: [l] });
    else (blocks.at(-1)?.lines ?? head).push(l);
  }

  const m = ENTRY_RE.exec(entry[0]);
  const key = m ? dayMinutes(+m[1], +m[2]) : Infinity;
  let k = blocks.length;
  while (k > 0 && blocks[k - 1].key > key) k--;
  blocks.splice(k, 0, { key, lines: entry });

  lines.splice(i + 1, end - i - 1, ...head, ...blocks.flatMap((b) => b.lines), '');
  return lines.join('\n');
}

function replaceSection(text, heading, body) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) {
    lines.push('', heading, ...body);
    return lines.join('\n');
  }
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('## ')) j++;
  lines.splice(i + 1, j - i - 1, ...body, '');
  return lines.join('\n');
}

/** Добавляет строку в раздел дневной заметки */
export const writeLine = (s, heading, line) =>
  locked(async () => {
    const { note, text } = await load(s);
    await fsp.writeFile(note, insertIntoSection(text, heading, line));
  });

/** Меняет поле frontmatter (rating, weight, mood, thought) */
const putField = (text, key, value) => {
  const re = new RegExp(`^${key}:.*$`, 'm');
  return re.test(text)
    ? text.replace(re, () => `${key}: ${value}`)
    : text.replace(/^---\n/, () => `---\n${key}: ${value}\n`);
};

export const setField = (s, key, value) =>
  locked(async () => {
    const { note, text } = await load(s);
    await fsp.writeFile(note, putField(text, key, value));
  });

/** Дописывает в произвольный файл (создаёт с заголовком, если его нет) */
export const appendFileLocked = (file, content, header = '') =>
  locked(async () => {
    ensureVault();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file) && header) await fsp.writeFile(file, header);
    await fsp.appendFile(file, content);
  });

/** Скачивает файл из Telegram в Days/…/media и возвращает уникальное имя */
/* ---------- метаданные файлов ---------- */
const IMG_EXT = /\.(jpe?g|heic|heif|png|tiff?|webp)$/i;
const VID_EXT = /\.(mp4|mov|m4v|3gp|mkv|webm)$/i;

const sane = (sec) =>
  Number.isFinite(sec) && sec * 1000 > Date.UTC(2005, 0, 1) && sec * 1000 < Date.now() + 86400_000 ? sec : null;

/** "2026:10:23 14:05:09" (локальное время камеры) -> unix-секунды, с учётом TIMEZONE */
function wallToUnix(str, offset) {
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str ?? '');
  if (!m) return null;
  const [Y, M, D, h, mi, sec] = m.slice(1).map(Number);
  const asUtc = Date.UTC(Y, M - 1, D, h, mi, sec);
  const o = /^([+-])(\d{2}):(\d{2})$/.exec(offset ?? '');
  if (o) return Math.floor((asUtc - (o[1] === '-' ? -1 : 1) * (+o[2] * 60 + +o[3]) * 60_000) / 1000);
  let t = asUtc;
  for (let k = 0; k < 2; k++) {
    const p = parts(t);
    t -= Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - asUtc;
  }
  return Math.floor(t / 1000);
}

async function readImageMeta(file) {
  const out = {};
  try {
    const x = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTime'],
      reviveValues: false,
    });
    const raw = x?.DateTimeOriginal ?? x?.CreateDate;
    if (typeof raw === 'string') out.created = sane(wallToUnix(raw, x.OffsetTimeOriginal ?? x.OffsetTime));
  } catch {}
  try {
    const g = await exifr.gps(file);
    if (Number.isFinite(g?.latitude) && Number.isFinite(g?.longitude)) out.gps = { lat: g.latitude, lon: g.longitude };
  } catch {}
  return out;
}

async function readVideoMeta(file) {
  const out = {};
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_entries', 'format_tags:stream_tags=creation_time',
      file,
    ]);
    const j = JSON.parse(stdout);
    const tags = j.format?.tags ?? {};
    const raw = tags.creation_time ?? j.streams?.find((x) => x.tags?.creation_time)?.tags.creation_time;
    out.created = sane(Date.parse(raw) / 1000);
    // iPhone/Android кладут GPS как "+50.0045+036.2310+135.0/"
    const loc = Object.entries(tags).find(([k]) => /iso6709|^location$/i.test(k))?.[1];
    const m = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(loc ?? '');
    if (m && (+m[1] || +m[2])) out.gps = { lat: +m[1], lon: +m[2] };
  } catch {}
  return out;
}

/* ---------- места ---------- */
const PLACE_RADIUS = 150;     // м: радиус визита и места
const VISIT_GAP = 90 * 60;    // сек: пауза, после которой это уже новый визит
const placesFile = () => path.join(VAULT_PATH, 'Places', 'places.json');
const geoLogFile = (s) => path.join(VAULT_PATH, 'Places', 'log', `${s.date}.jsonl`);

function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function loadPlaces() {
  try { return JSON.parse(await fsp.readFile(placesFile(), 'utf8')); } catch { return []; }
}

/** Ближайшее именованное место в радиусе или null */
export async function findPlace(gps) {
  let best = null;
  for (const p of await loadPlaces()) {
    const d = distanceM(p, gps);
    if (d <= (p.r ?? PLACE_RADIUS) && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

export const addPlace = (name, gps) =>
  locked(async () => {
    ensureVault();
    const list = await loadPlaces();
    if (list.some((p) => p.name === name && distanceM(p, gps) < PLACE_RADIUS)) return;
    list.push({ name, lat: gps.lat, lon: gps.lon, r: PLACE_RADIUS });
    await fsp.mkdir(path.dirname(placesFile()), { recursive: true });
    await fsp.writeFile(placesFile(), JSON.stringify(list, null, 2));
  });

export const logGeo = (s, gps, file = '') =>
  appendFileLocked(geoLogFile(s), JSON.stringify({ ts: s.ts, lat: gps.lat, lon: gps.lon, file }) + '\n');

/** Пересобирает раздел «📍 Места» и поле places: подряд идущие точки рядом = один визит */
export async function rebuildVisits(s) {
  const file = geoLogFile(s);
  if (!fs.existsSync(file)) return { visits: 0, unnamed: 0 };

  const seen = new Set();
  const pts = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((p) => { const k = `${p.ts}|${p.lat}|${p.lon}`; return seen.has(k) ? false : seen.add(k); })
    .sort((a, b) => a.ts - b.ts);

  const visits = [];
  for (const p of pts) {
    const v = visits.at(-1);
    if (v && p.ts - v.end <= VISIT_GAP && distanceM(v, p) <= PLACE_RADIUS) {
      v.n++; v.end = p.ts;
      v.lat += (p.lat - v.lat) / v.n;
      v.lon += (p.lon - v.lon) / v.n;
    } else {
      visits.push({ lat: p.lat, lon: p.lon, start: p.ts, end: p.ts, n: 1 });
    }
  }

  const names = new Set();
  const body = [];
  let unnamed = 0;
  for (const v of visits) {
    const place = await findPlace(v);
    const t1 = stamp(v.start).time, t2 = stamp(v.end).time;
    let where;
    if (place) {
      names.add(place.name);
      where = `[[${place.name}]]`;
    } else {
      unnamed++;
      where = `[${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}](https://www.google.com/maps?q=${v.lat},${v.lon})`;
    }
    body.push(`- ${t1 === t2 ? t1 : `${t1}–${t2}`} 📍 ${where} · ${v.n} шт.`);
  }

  await locked(async () => {
    const { note, text } = await load(s);
    let out = replaceSection(text, '## 📍 Места', body);
    out = putField(out, 'places', JSON.stringify([...names]));
    await fsp.writeFile(note, out);
  });
  return { visits: visits.length, unnamed };
}

/* ---------- импорт файла ---------- */
/** Кладёт файл в Days/…/media по дате съёмки (если есть), иначе по fallbackStamp */
export async function importMedia(srcPath, kind, ext, fallbackStamp) {
  ensureVault();
  const skip = kind === 'voice' || kind === 'circle'; // у них время = момент отправки
  const meta = skip ? {}
    : IMG_EXT.test(ext) ? await readImageMeta(srcPath)
    : VID_EXT.test(ext) ? await readVideoMeta(srcPath)
    : {};
  const s = meta.created ? stamp(meta.created) : fallbackStamp;
  const { mediaDir } = dayPaths(s);
  await fsp.mkdir(mediaDir, { recursive: true });
  const rand = Math.random().toString(36).slice(2, 6);
  const name = `${s.date}_${s.clock}_${kind}_${rand}${ext}`;
  await fsp.copyFile(srcPath, path.join(mediaDir, name));
  if (meta.gps) await logGeo(s, meta.gps, name);
  return { s, name, fromMeta: Boolean(meta.created), gps: meta.gps ?? null };
}
/** Кладёт файл в Whoop/ГГГГ/ММ/ДАТА/ и возвращает имя */
export async function importWhoop(srcPath, ext, s) {
  ensureVault();
  const dir = path.join(VAULT_PATH, 'Whoop', s.year, s.month, s.date);
  await fsp.mkdir(dir, { recursive: true });
  const rand = Math.random().toString(36).slice(2, 6);
  const name = `${s.date}_${s.clock}_whoop_${rand}${ext}`;
  await fsp.copyFile(srcPath, path.join(dir, name));
  return name;
}



export const writeWhoopPage = (s, group) =>
  locked(async () => {
    ensureVault();
    const dir = path.join(VAULT_PATH, 'Whoop', s.year, s.month, s.date);
    await fsp.mkdir(dir, { recursive: true });
    const pageName = `Whoop ${s.date}`;
    const file = path.join(dir, `${pageName}.md`);
    if (!fs.existsSync(file)) {
      await fsp.writeFile(file, `---\ndate: ${s.date}\ntags: [whoop]\n---\n## ${s.date} · ${s.weekday}\n`);
    }
    await fsp.appendFile(file, `\n${group.join('\n')}\n`);
    return pageName;
  }); 