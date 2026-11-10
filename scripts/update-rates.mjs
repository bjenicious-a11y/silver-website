// Daily rate updater. Adds today's rate to data/rates.json from a rate API you configure.
//
// Environment variables (set as GitHub Actions secrets):
//   RATE_API_URL      required. URL returning JSON in one of these shapes:
//                       { "rate999PerKg": 220900 }                       -> updates "india"
//                       { "locations": { "india": 220900, "chennai": 222900 } }
//   RATE_API_KEY      optional. Sent as "Authorization: Bearer <key>".
//   RATE_SOURCE_NAME  optional. Shown on the site as the data source.
//   RATE_SOURCE_URL   optional. Link for the data source.
// If RATE_API_URL is not set, the script exits without changing anything.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'data', 'rates.json');
const url = process.env.RATE_API_URL;

if (!url) {
  console.log('RATE_API_URL not set - skipping rate update.');
  process.exit(0);
}

const headers = { Accept: 'application/json' };
if (process.env.RATE_API_KEY) headers.Authorization = `Bearer ${process.env.RATE_API_KEY}`;

const res = await fetch(url, { headers });
if (!res.ok) {
  console.error(`Rate API returned HTTP ${res.status}`);
  process.exit(1);
}
const body = await res.json();
const incoming = body.locations ?? (body.rate999PerKg != null ? { india: body.rate999PerKg } : null);
if (!incoming || typeof incoming !== 'object') {
  console.error('Unexpected API response shape:', JSON.stringify(body).slice(0, 300));
  process.exit(1);
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const now = new Date();
const istDate = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

for (const [slug, value] of Object.entries(incoming)) {
  const rate = Number(value);
  // Sanity check: 999 silver per kg in INR should be a plausible positive number.
  if (!Number.isFinite(rate) || rate < 10000 || rate > 10000000) {
    console.error(`Rejected implausible rate for ${slug}: ${value}`);
    process.exit(1);
  }
  const loc = (data.locations[slug] ||= { name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), history: [] });
  const existing = loc.history.find((h) => h.date === istDate);
  if (existing) existing.rate999PerKg = Math.round(rate);
  else loc.history.push({ date: istDate, rate999PerKg: Math.round(rate) });
  loc.history.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`${slug}: ${istDate} = ${Math.round(rate)}`);
}

data.updatedAt = now.toISOString();
if (process.env.RATE_SOURCE_NAME) data.sourceName = process.env.RATE_SOURCE_NAME;
if (process.env.RATE_SOURCE_URL) data.sourceUrl = process.env.RATE_SOURCE_URL;
writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
