// Fetches real silver prices and writes data/rates.json.
//
// Source: MetalCharts API (https://metalcharts.org) – international silver spot price
// converted to INR, plus India's import duty, gives an estimated India rate (before 3% GST).
//
// Environment:
//   METALCHARTS_API_KEY  required (GitHub Actions secret). Free plan works.
//   IMPORT_DUTY_PCT      optional, default from data/rates.json (15 = 10% BCD + 5% AIDC).
//
// Usage:
//   node scripts/update-rates.mjs             -> add/refresh today's rate (1 API call)
//   node scripts/update-rates.mjs --backfill  -> replace history with the last ~30 days (1 call)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'rates.json');
const API = process.env.METALCHARTS_API_BASE || 'https://api.metalcharts.org';
const KEY = process.env.METALCHARTS_API_KEY;
const BACKFILL = process.argv.includes('--backfill');

if (!KEY) {
  console.log('METALCHARTS_API_KEY not set - skipping rate update.');
  process.exit(0);
}

// Silver markets are closed on Saturday and Sunday: the price would just repeat Friday's.
const istWeekday = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCDay();
if (!BACKFILL && (istWeekday === 0 || istWeekday === 6)) {
  console.log('Weekend in India - markets closed, no new rate added.');
  process.exit(0);
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const dutyPct = Number(process.env.IMPORT_DUTY_PCT ?? data.importDutyPct ?? 15);
const factor = 1 + dutyPct / 100;

async function api(path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`MetalCharts ${path} -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

// Plausibility guard: 999 silver in India per kg should be between ₹20,000 and ₹20,00,000.
function check(rate, label) {
  if (!Number.isFinite(rate) || rate < 20000 || rate > 2000000) {
    throw new Error(`Implausible rate for ${label}: ${rate}`);
  }
  return Math.round(rate);
}

const istDate = (d) => new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const india = (data.locations.india ||= { name: 'India', history: [] });

// The first real run (sample data still in the file) backfills automatically.
if (BACKFILL || data.sample) {
  const body = await api('/v1/history/XAG?range=1M&interval=1d&currency=INR&unit=kg');
  const points = (body.data || [])
    .map((p) => ({ date: istDate(p.timestamp), rate999PerKg: check((p.close ?? p.price) * factor, p.timestamp) }))
    .filter((p) => ![0, 6].includes(new Date(p.date + 'T00:00:00Z').getUTCDay()));
  if (points.length < 5) throw new Error(`Backfill returned only ${points.length} points`);
  const byDate = new Map(points.map((p) => [p.date, p]));
  india.history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  console.log(`Backfilled ${india.history.length} days: ${india.history[0].date} .. ${india.history.at(-1).date}`);
}

if (![0, 6].includes(istWeekday)) {
  const body = await api('/v1/convert?from=XAG&to=INR&amount=1&unit=kg');
  const spotPerKg = Number(body.result);
  const rate = check(spotPerKg * factor, 'today');
  const today = istDate(Date.now());
  const existing = india.history.find((h) => h.date === today);
  if (existing) existing.rate999PerKg = rate;
  else india.history.push({ date: today, rate999PerKg: rate });
  india.history.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`India ${today}: spot ₹${Math.round(spotPerKg)}/kg x ${factor} = ₹${rate}/kg`);
}

// Keep at most 400 days of history in the file.
india.history = india.history.slice(-400);

data.sample = false;
data.method = 'estimate';
data.importDutyPct = dutyPct;
data.sourceName = 'MetalCharts (international silver spot price in INR)';
data.sourceUrl = 'https://metalcharts.org';
data.unit = 'INR per kg, 999 fine silver, estimated India rate before GST';
data.updatedAt = new Date().toISOString();
writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
