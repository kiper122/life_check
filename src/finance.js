import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VAULT_PATH, DEFAULT_CURRENCY } from './config.js';
import { TAG_RE, extractTags, writeLine, appendFileLocked } from './vault.js';

const CUR = { грн: 'UAH', uah: 'UAH', '₴': 'UAH', usd: 'USD', $: 'USD', eur: 'EUR', '€': 'EUR' };

// "-250 кофе #еда", "+5000 грн зарплата #работа", "-12.5 usd подписка"
const RE = /^([+\-−–])\s*(\d+(?:[.,]\d+)?)(?:\s*(грн|uah|₴|usd|\$|eur|€)(?=\s|$))?\s*(.*)$/isu;

const ledgerFile = () => path.join(VAULT_PATH, 'Finance', 'ledger.jsonl');
const monthFile = (s) => path.join(VAULT_PATH, 'Finance', `${s.year}-${s.month}.md`);
const round = (n) => Math.round(n * 100) / 100;

export function parseFinance(text) {
  const m = text.trim().match(RE);
  if (!m) return null;
  const tags = extractTags(m[4]);
  const description = m[4].replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
  return {
    type: m[1] === '+' ? 'income' : 'expense',
    amount: Number(m[2].replace(',', '.')),
    currency: CUR[(m[3] ?? '').toLowerCase()] ?? DEFAULT_CURRENCY,
    category: tags[0]?.slice(1) ?? 'other',
    tags,
    description,
  };
}

export async function recordFinance(s, f) {
  const income = f.type === 'income';
  const line =
    `- ${s.time} ${income ? '➕ +' : '➖ −'}${f.amount} ${f.currency} · ${f.description || f.category} ${f.tags.join(' ')}`.trim();
  await writeLine(s, '## 💰 Финансы', line);

  const header =
    `# Финансы ${s.year}-${s.month}\n\n` +
    `| Дата | Время | Тип | Сумма | Валюта | Категория | Описание |\n|---|---|---|---|---|---|---|\n`;
  const row = `| ${s.date} | ${s.time} | ${income ? 'доход' : 'расход'} | ${f.amount} | ${f.currency} | ${f.category} | ${f.description.replace(/\|/g, '/')} |\n`;
  await appendFileLocked(monthFile(s), row, header);

  const record = { date: s.date, time: s.time, type: f.type, amount: f.amount, currency: f.currency, category: f.category, description: f.description };
  await appendFileLocked(ledgerFile(), JSON.stringify(record) + '\n');
}

/** prefix: "2026-10-20" (день) или "2026-10" (месяц) */
export async function financeSummary(prefix) {
  const file = ledgerFile();
  const empty = `💰 ${prefix}: записей нет`;
  if (!fs.existsSync(file)) return empty;
  const rows = (await fsp.readFile(file, 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.date.startsWith(prefix));
  if (!rows.length) return empty;

  const byCur = {};
  for (const r of rows) {
    const c = (byCur[r.currency] ??= { inc: 0, exp: 0, cats: {} });
    if (r.type === 'income') c.inc += r.amount;
    else {
      c.exp += r.amount;
      c.cats[r.category] = (c.cats[r.category] ?? 0) + r.amount;
    }
  }

  const out = [`💰 ${prefix}`];
  for (const [cur, c] of Object.entries(byCur)) {
    out.push(`${cur}: +${round(c.inc)} / −${round(c.exp)} = ${round(c.inc - c.exp)}`);
    const top = Object.entries(c.cats).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, v]) => `${k} ${round(v)}`).join(', ');
    if (top) out.push(`  расходы: ${top}`);
  }
  return out.join('\n');
}
