// Post-build checks: broken internal links, missing SEO tags, duplicate titles/descriptions.
// Exits non-zero if anything is wrong, so a broken site is never deployed.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const config = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));
const BASE_PATH = new URL(config.baseUrl).pathname.replace(/\/$/, '');

const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.html')) files.push(p);
  }
})(OUT);

const errors = [];
const titles = new Map();
const descs = new Map();
const get = (html, re) => (html.match(re) || [])[1];

for (const file of files) {
  const rel = file.slice(OUT.length);
  const html = readFileSync(file, 'utf8');
  const title = get(html, /<title>([^<]*)<\/title>/);
  const desc = get(html, /<meta name="description" content="([^"]*)"/);
  const is404 = rel === '/404.html';
  if (!title) errors.push(`${rel}: missing <title>`);
  if (!desc) errors.push(`${rel}: missing meta description`);
  if (!is404) {
    if (title && title.length > 70) errors.push(`${rel}: title is ${title.length} chars (max 70)`);
    if (desc && (desc.length < 70 || desc.length > 160)) errors.push(`${rel}: description is ${desc.length} chars (want 70-160)`);
    if (!/<link rel="canonical" href="[^"]+">/.test(html)) errors.push(`${rel}: missing canonical`);
    if (titles.has(title)) errors.push(`${rel}: duplicate title with ${titles.get(title)}`);
    if (descs.has(desc)) errors.push(`${rel}: duplicate description with ${descs.get(desc)}`);
    titles.set(title, rel);
    descs.set(desc, rel);
  }
  const h1s = (html.match(/<h1[\s>]/g) || []).length;
  if (h1s !== 1) errors.push(`${rel}: has ${h1s} <h1> elements (want 1)`);
  if (!/<html lang="/.test(html)) errors.push(`${rel}: missing lang`);
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (!url.startsWith(BASE_PATH + '/') && url !== BASE_PATH) continue;
    let target = url.slice(BASE_PATH.length).split('#')[0].split('?')[0];
    if (target.endsWith('/')) target += 'index.html';
    if (!existsSync(join(OUT, target))) errors.push(`${rel}: broken link ${url}`);
  }
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch { errors.push(`${rel}: invalid JSON-LD`); }
  }
}

for (const f of ['sitemap.xml', 'robots.txt', 'favicon.svg', 'og-image.png', 'assets/style.css', 'assets/app.js']) {
  if (!existsSync(join(OUT, f))) errors.push(`missing ${f}`);
}

if (errors.length) {
  console.error(`Site check failed (${errors.length}):\n- ` + errors.join('\n- '));
  process.exit(1);
}
console.log(`Site check passed: ${files.length} HTML files, no broken links, SEO tags OK.`);
