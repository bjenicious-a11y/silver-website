// Static site generator for SilverMeter. No dependencies: run `node scripts/build.mjs`.
// Reads site.config.json + data/rates.json, writes the full site to dist/.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const config = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));
const data = JSON.parse(readFileSync(join(ROOT, 'data', 'rates.json'), 'utf8'));

const BASE_URL = config.baseUrl.replace(/\/$/, '');
const BASE_PATH = new URL(BASE_URL).pathname.replace(/\/$/, '');
const WINDOW_DAYS = 30;
const PURITY_925 = 0.925;
const BUILD_DATE = new Date().toISOString().slice(0, 10);

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inr = (n, digits = 0) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const dateFmt = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
const longDate = (iso) => dateFmt(iso, { day: 'numeric', month: 'long', year: 'numeric' });
const link = (p) => `${BASE_PATH}${p}`;
const abs = (p) => `${BASE_URL}${p}`;

function write(relPath, content) {
  const file = join(OUT, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ---------- data model ----------
function analyse(slug, loc) {
  const history = [...loc.history].sort((a, b) => a.date.localeCompare(b.date));
  if (history.length === 0) throw new Error(`No history for ${slug}`);
  const today = history[history.length - 1];
  const yesterday = history.length > 1 ? history[history.length - 2] : null;
  const win = history.slice(-WINDOW_DAYS);
  const values = win.map((h) => h.rate999PerKg);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const position = max === min ? 0.5 : (today.rate999PerKg - min) / (max - min);
  let zone;
  if (max === min) zone = 'steady';
  else if (position <= 0.33) zone = 'low';
  else if (position >= 0.67) zone = 'high';
  else zone = 'normal';
  const perGram = today.rate999PerKg / 1000;
  const change = yesterday ? today.rate999PerKg - yesterday.rate999PerKg : 0;
  return { slug, name: loc.name, history, win, today, yesterday, min, max, avg, position, zone, perGram, change, days: win.length };
}

const locations = Object.entries(data.locations).map(([slug, loc]) => analyse(slug, loc));
const india = locations.find((l) => l.slug === 'india') || locations[0];
const cities = locations.filter((l) => l !== india);
const cityPath = (l) => (l === india ? '/' : `/silver-rate-today-${l.slug}/`);

const ZONES = {
  low: { headline: 'cheaper than usual', short: 'Lower than usual', cls: 'z-low' },
  normal: { headline: 'around its usual level', short: 'Normal', cls: 'z-normal' },
  high: { headline: 'costlier than usual', short: 'Higher than usual', cls: 'z-high' },
  steady: { headline: 'unchanged over this period', short: 'Steady', cls: 'z-normal' }
};

function changeText(l, unit = 'kg') {
  if (!l.yesterday) return 'No previous day to compare';
  const c = unit === 'kg' ? l.change : l.change / 1000;
  if (c === 0) return 'No change vs yesterday';
  const sign = c > 0 ? '▲ +' : '▼ −';
  return `${sign}${inr(Math.abs(c), unit === 'kg' ? 0 : 2)} vs yesterday`;
}
const changeClass = (l) => (l.change > 0 ? 'up' : l.change < 0 ? 'down' : 'flat');

// ---------- SVG pieces (rendered at build time, no JS needed) ----------
function gaugeSvg(l) {
  const cx = 190, cy = 190, r = 110;
  const theta = Math.PI * (1 - l.position);
  const x = (cx + r * Math.cos(theta)).toFixed(1);
  const y = (cy - r * Math.sin(theta)).toFixed(1);
  const label = `Gauge: today's rate is ${ZONES[l.zone].short.toLowerCase()} compared with the last ${l.days} days`;
  return `<svg class="gauge" viewBox="0 0 380 210" role="img" aria-label="${esc(label)}">
  <path d="M30 190 A160 160 0 0 1 110 51.4" fill="none" stroke="#14B8A6" stroke-width="28" stroke-linecap="round"/>
  <path d="M118 47 A160 160 0 0 1 262 47" fill="none" stroke="#FCD34D" stroke-width="28"/>
  <path d="M270 51.4 A160 160 0 0 1 350 190" fill="none" stroke="#FB7185" stroke-width="28" stroke-linecap="round"/>
  <line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#042F2E" stroke-width="6" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="12" fill="#042F2E"/>
</svg>`;
}

function chartSvg(l, points = l.win) {
  const W = 720, H = 280, pl = 12, pr = 16, pt = 30, pb = 36;
  const vals = points.map((p) => p.rate999PerKg);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1000; hi += 1000; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  const sx = (i) => pl + (points.length === 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (points.length - 1));
  const sy = (v) => pt + ((hi - v) * (H - pt - pb)) / (hi - lo);
  const line = points.map((p, i) => `${sx(i).toFixed(1)},${sy(p.rate999PerKg).toFixed(1)}`).join(' ');
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const last = points[points.length - 1];
  const ticks = [Math.max(...vals), avg, Math.min(...vals)];
  const tickLabels = ['High', 'Avg', 'Low'];
  const desc = `Silver rate per kg from ${dateFmt(points[0].date)} to ${dateFmt(last.date)}: low ${inr(Math.min(...vals))}, high ${inr(Math.max(...vals))}, latest ${inr(last.rate999PerKg)}.`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}">
  ${ticks.map((t, i) => `<line x1="${pl}" x2="${W - pr}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}" stroke="${i === 1 ? '#0F766E' : '#99F6E4'}" stroke-dasharray="${i === 1 ? '6 6' : '2 4'}"/>
  <text x="${W - pr}" y="${(sy(t) - 6).toFixed(1)}" text-anchor="end" font-size="15" font-weight="600" fill="#134E4A">${tickLabels[i]} ${esc(inr(Math.round(t / 100) * 100))}</text>`).join('\n  ')}
  <polyline points="${line}" fill="none" stroke="#042F2E" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${sx(points.length - 1).toFixed(1)}" cy="${sy(last.rate999PerKg).toFixed(1)}" r="6" fill="#0D9488" stroke="#fff" stroke-width="2"/>
  <text x="${pl}" y="${H - 10}" font-size="14" fill="#134E4A">${esc(dateFmt(points[0].date))}</text>
  <text x="${W - pr}" y="${H - 10}" font-size="14" fill="#134E4A" text-anchor="end">${esc(dateFmt(last.date))}</text>
</svg>`;
}

// ---------- layout ----------
const NAV = [
  ['/', "Today's rate"],
  ['/silver-price-calculator/', 'Calculator'],
  ['/silver-rate-history/', 'History'],
  ['/about/', 'About']
];
const FOOTER = [
  ['/data-source/', 'Data source & method'],
  ['/disclaimer/', 'Disclaimer'],
  ['/privacy-policy/', 'Privacy policy'],
  ...(config.contactEmail ? [['/contact/', 'Contact']] : [])
];

function layout({ path, title, description, body, breadcrumbs = [], jsonld = [], ogType = 'website' }) {
  const url = abs(path);
  const robots = data.sample ? 'noindex, follow' : 'index, follow, max-image-preview:large';
  const crumbsLd = breadcrumbs.length
    ? [{
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: [['/', 'Home'], ...breadcrumbs].map(([p, n], i) => ({ '@type': 'ListItem', position: i + 1, name: n, item: abs(p) }))
      }]
    : [];
  const ld = [...crumbsLd, ...jsonld].map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n');
  const crumbsHtml = breadcrumbs.length
    ? `<nav class="crumbs wrap" aria-label="Breadcrumb"><ol><li><a href="${link('/')}">Home</a></li>${breadcrumbs.map(([p, n], i) => i === breadcrumbs.length - 1 ? `<li aria-current="page">${esc(n)}</li>` : `<li><a href="${link(p)}">${esc(n)}</a></li>`).join('')}</ol></nav>`
    : '';
  const sampleBanner = data.sample
    ? `<div class="sample-banner" role="note"><strong>Preview:</strong> the rates on this site are sample data, not live prices. Connect a rate source before launch.</div>`
    : '';
  const ads = config.adsenseClientId
    ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(config.adsenseClientId)}" crossorigin="anonymous"></script>`
    : '';
  const verify = config.googleSiteVerification ? `<meta name="google-site-verification" content="${esc(config.googleSiteVerification)}">` : '';
  return `<!doctype html>
<html lang="${esc(config.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${esc(config.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${abs('/og-image.png')}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#042F2E">
${verify}
<link rel="icon" href="${link('/favicon.svg')}" type="image/svg+xml">
<link rel="manifest" href="${link('/site.webmanifest')}">
<link rel="stylesheet" href="${link('/assets/style.css')}">
${ads}
${ld}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${sampleBanner}
<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="${link('/')}">${esc(config.name)}</a>
    <nav aria-label="Main"><ul class="nav">${NAV.map(([p, n]) => `<li><a href="${link(p)}"${p === path ? ' aria-current="page"' : ''}>${esc(n)}</a></li>`).join('')}</ul></nav>
  </div>
</header>
${crumbsHtml}
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-row">
    <div><span class="brand brand-footer">${esc(config.name)}</span><p class="muted-light">${esc(config.tagline)}.</p></div>
    <nav aria-label="Footer"><ul class="footer-links">${FOOTER.map(([p, n]) => `<li><a href="${link(p)}">${esc(n)}</a></li>`).join('')}</ul></nav>
    <p class="muted-light small">Rates are indicative and for information only. Not investment advice. Confirm with your jeweller before buying. © ${new Date().getFullYear()} ${esc(config.name)}</p>
  </div>
</footer>
<script src="${link('/assets/app.js')}" defer></script>
</body>
</html>
`;
}

// ---------- shared blocks ----------
function sourceLine() {
  const updated = new Date(data.updatedAt);
  const when = updated.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const src = data.sourceUrl ? `<a href="${esc(data.sourceUrl)}" rel="nofollow noopener" target="_blank">${esc(data.sourceName)}</a>` : esc(data.sourceName);
  return `Updated ${esc(when)} IST · Source: ${src}`;
}

function rateTable(l) {
  const rows = [1, 8, 10, 100, 1000].map((g) => {
    const t = (l.today.rate999PerKg / 1000) * g;
    const y = l.yesterday ? (l.yesterday.rate999PerKg / 1000) * g : null;
    const d = y === null ? null : t - y;
    const cls = d === null || d === 0 ? 'flat' : d > 0 ? 'up' : 'down';
    const dTxt = d === null ? '—' : d === 0 ? 'No change' : `${d > 0 ? '+' : '−'}${inr(Math.abs(d), g < 10 ? 2 : 0)}`;
    const label = g === 1000 ? '1 kg' : `${g} gram${g > 1 ? 's' : ''}`;
    return `<tr><th scope="row">${label}</th><td>${inr(t, g < 10 ? 2 : 0)}</td><td>${y === null ? '—' : inr(y, g < 10 ? 2 : 0)}</td><td class="${cls}">${dTxt}</td></tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="rates">
<caption>Silver rate in ${esc(l.name)} today vs yesterday (999 fine silver)</caption>
<thead><tr><th scope="col">Quantity</th><th scope="col">Today (${esc(dateFmt(l.today.date))})</th><th scope="col">Yesterday</th><th scope="col">Change</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function calculatorBlock(l, { heading = 'h2', compact = false } = {}) {
  const perGram = l.perGram;
  const g = 10, making = 12;
  const metal = perGram * PURITY_925 * g;
  const mk = (metal * making) / 100;
  const gst = (metal + mk) * 0.03;
  return `<section class="card calc" data-calc data-rate999="${perGram}" aria-labelledby="calc-h-${l.slug}">
  <${heading} id="calc-h-${l.slug}">Jewellery price calculator</${heading}>
  ${compact ? '' : `<p class="muted">Enter the weight and making charge your jeweller quotes. The estimate uses today's ${esc(l.name)} rate.</p>`}
  <div class="calc-grid">
    <label>Weight (grams)<input type="number" inputmode="decimal" min="0.1" step="0.1" value="${g}" data-in="grams"></label>
    <label>Purity<select data-in="purity"><option value="0.925" selected>925 jewellery</option><option value="0.999">999 coin/bar</option><option value="0.9">900 coin</option><option value="0.8">800</option></select></label>
    <label>Making charge (%)<input type="number" inputmode="decimal" min="0" max="100" step="0.5" value="${making}" data-in="making"></label>
  </div>
  <dl class="calc-out" aria-live="polite">
    <div><dt>Silver value</dt><dd data-out="metal">${inr(metal)}</dd></div>
    <div><dt>Making charge</dt><dd data-out="making">${inr(mk)}</dd></div>
    <div><dt>GST (3%)</dt><dd data-out="gst">${inr(gst)}</dd></div>
    <div class="total"><dt>Estimated price</dt><dd data-out="total">${inr(metal + mk + gst)}</dd></div>
  </dl>
  <p class="small muted">925 and lower purities are estimated from the 999 rate × purity. Jewellers may add wastage or hallmarking charges.</p>
</section>`;
}

function faqFor(l) {
  const where = l === india ? 'in India' : `in ${l.name}`;
  return [
    [`What is the silver rate today ${where}?`, `On ${longDate(l.today.date)}, the 999 silver rate ${where} is ${inr(l.perGram, 2)} per gram and ${inr(l.today.rate999PerKg)} per kg.`],
    [`What is the price of 10 grams of silver today ${where}?`, `10 grams of 999 silver costs ${inr(l.perGram * 10)} on ${longDate(l.today.date)}, before GST and making charges.`],
    ['Is silver cheap today?', `Today's rate is ${ZONES[l.zone].headline} compared with the last ${l.days} days (low ${inr(l.min)}, average ${inr(Math.round(l.avg))}, high ${inr(l.max)} per kg). This is a price comparison, not investment advice.`],
    ['What is the difference between 999 and 925 silver?', '999 silver is 99.9% pure and used for coins and bars. 925 (sterling) silver is 92.5% silver mixed with other metals so it is stronger, which is why most jewellery is 925.'],
    ['How much GST is charged on silver?', 'GST on silver jewellery, coins and bars in India is 3% of the value. Making charges are added before GST is calculated.']
  ];
}

function faqBlock(l) {
  const items = faqFor(l);
  return {
    html: `<section class="card faq" aria-labelledby="faq-h"><h2 id="faq-h">Frequently asked questions</h2>
${items.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n')}
</section>`,
    ld: { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }
  };
}

function alertsBlock() {
  if (!config.whatsappChannelUrl) return '';
  return `<section class="card dark alerts"><h2>Get the rate every morning</h2><p>Join our WhatsApp channel for today's silver rate and the meter reading at 9:30 AM.</p><a class="btn btn-mint" href="${esc(config.whatsappChannelUrl)}" rel="noopener" target="_blank">Join WhatsApp channel</a></section>`;
}

function cityBoard(current) {
  if (cities.length === 0) return '';
  const all = [india, ...cities];
  return `<section class="card" aria-labelledby="board-h"><h2 id="board-h">Meter by city</h2><ul class="board">${all.map((c) => `<li><a class="board-item ${ZONES[c.zone].cls}" href="${link(cityPath(c))}"${c === current ? ' aria-current="page"' : ''}><strong>${esc(c.name)}</strong><span>${inr(c.perGram, 2)}/g · ${ZONES[c.zone].short}</span></a></li>`).join('')}</ul></section>`;
}

// ---------- pages ----------
function ratePage(l) {
  const path = cityPath(l);
  const isHome = l === india;
  const placeName = isHome ? 'India' : l.name;
  const z = ZONES[l.zone];
  const title = `Silver Rate Today in ${placeName} (${dateFmt(l.today.date)}) – ${inr(l.perGram, 0)}/g | ${config.name}`;
  const description = `Silver rate today in ${placeName}: ${inr(l.perGram, 2)} per gram, ${inr(l.today.rate999PerKg)} per kg (999). See if it's cheap vs the last ${l.days} days, plus 10 g price and calculator.`;
  const faq = faqBlock(l);
  const body = `
<section class="hero wrap">
  <div class="hero-text">
    <p class="pill">${esc(placeName)} · ${esc(longDate(l.today.date))}</p>
    <h1>Silver Rate Today in ${esc(placeName)}</h1>
    <p class="verdict">Silver is <span class="${z.cls}-text">${esc(z.headline)}</span> today.</p>
    <p class="lead">Today's rate compared with the last ${l.days} days. We compare, you decide — this is not investment advice.</p>
    <div class="big-rates">
      <div><span class="label">Per gram (999)</span><span class="big">${inr(l.perGram, 2)}</span></div>
      <div><span class="label">Per kg</span><span class="mid">${inr(l.today.rate999PerKg)}</span></div>
      <div><span class="label">10 grams</span><span class="mid">${inr(l.perGram * 10)}</span></div>
    </div>
    <p class="change ${changeClass(l)}">${esc(changeText(l))} (per kg)</p>
    <p class="small muted">${sourceLine()}</p>
  </div>
  <div class="card gauge-card">
    ${gaugeSvg(l)}
    <div class="gauge-legend"><span class="z-low-text">Lower than usual</span><span class="z-normal-text">Normal</span><span class="z-high-text">Higher</span></div>
    <div class="stats">
      <div><span>${l.days}-day low</span><strong>${inr(l.min)}</strong></div>
      <div><span>${l.days}-day avg</span><strong>${inr(Math.round(l.avg))}</strong></div>
      <div><span>${l.days}-day high</span><strong>${inr(l.max)}</strong></div>
    </div>
    <p class="small muted center">Per kg, 999 silver</p>
  </div>
</section>
<div class="wrap grid-2">
  <section class="card" aria-labelledby="chart-h"><h2 id="chart-h">Silver rate in ${esc(placeName)}: last ${l.days} days</h2>${chartSvg(l)}<p class="small"><a href="${link('/silver-rate-history/')}">See full silver rate history</a></p></section>
  ${calculatorBlock(l, { compact: true })}
</div>
<div class="wrap stack">
  <section class="card" aria-labelledby="table-h"><h2 id="table-h">Silver price today vs yesterday</h2>${rateTable(l)}
  <p class="small muted">925 sterling silver (jewellery grade) works out to about ${inr(l.perGram * PURITY_925, 2)} per gram at today's 999 rate, before making charges and GST.</p></section>
  ${alertsBlock()}
  ${cityBoard(l)}
  <section class="card" aria-labelledby="how-h"><h2 id="how-h">How the meter decides</h2><p>We take the 999 silver rate for each of the last ${l.days} days we have on record. If today's rate sits in the bottom third of that low-to-high range, the meter reads <strong>lower than usual</strong>; in the top third, <strong>higher than usual</strong>; otherwise <strong>normal</strong>. <a href="${link('/data-source/')}">Read our data source and method</a>.</p></section>
  ${faq.html}
</div>`;
  const jsonld = [faq.ld];
  if (isHome) {
    jsonld.unshift({ '@context': 'https://schema.org', '@type': 'WebSite', name: config.name, url: abs('/'), inLanguage: config.language, description: config.tagline });
  }
  return { path, html: layout({ path, title, description, body, breadcrumbs: isHome ? [] : [[path, `Silver rate in ${l.name}`]], jsonld }) };
}

function calculatorPage() {
  const path = '/silver-price-calculator/';
  const title = `Silver Price Calculator with Making Charge & GST | ${config.name}`;
  const description = `Calculate the price of silver jewellery, coins or bars from today's rate (${inr(india.perGram, 2)}/g). Add weight, purity and making charge; GST is included.`;
  const body = `<div class="wrap stack narrow">
<h1>Silver price calculator</h1>
<p class="lead">Work out what a silver anklet, chain, coin or lamp should cost today, including making charge and 3% GST.</p>
${calculatorBlock(india, { heading: 'h2' })}
<section class="card"><h2>How the price is calculated</h2>
<ol class="steps"><li><strong>Silver value</strong> = weight (g) × today's 999 rate per gram × purity (e.g. 0.925 for sterling).</li><li><strong>Making charge</strong> = silver value × making %.</li><li><strong>GST</strong> = 3% of (silver value + making charge).</li><li><strong>Estimated price</strong> = silver value + making charge + GST.</li></ol>
<p class="small muted">Today's 999 rate used: ${inr(india.perGram, 2)} per gram (${esc(longDate(india.today.date))}). ${sourceLine()}</p></section>
</div>`;
  const ld = { '@context': 'https://schema.org', '@type': 'WebApplication', name: 'Silver price calculator', url: abs(path), applicationCategory: 'FinanceApplication', operatingSystem: 'Any', offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' } };
  return { path, html: layout({ path, title, description, body, breadcrumbs: [[path, 'Silver price calculator']], jsonld: [ld] }) };
}

function historyPage() {
  const path = '/silver-rate-history/';
  const title = `Silver Rate History in India: Daily & Monthly | ${config.name}`;
  const description = `Daily silver rate history in India per kg and per gram, with monthly high, low and average. Latest: ${inr(india.today.rate999PerKg)}/kg on ${dateFmt(india.today.date)}.`;
  const sections = [india, ...cities].map((l) => {
    const months = {};
    for (const h of l.history) (months[h.date.slice(0, 7)] ||= []).push(h.rate999PerKg);
    const monthRows = Object.entries(months).sort((a, b) => b[0].localeCompare(a[0])).map(([m, v]) => {
      const label = new Date(m + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      return `<tr><th scope="row">${label}</th><td>${inr(Math.max(...v))}</td><td>${inr(Math.min(...v))}</td><td>${inr(Math.round(v.reduce((a, b) => a + b, 0) / v.length))}</td><td>${v.length}</td></tr>`;
    }).join('');
    const rows = [...l.history].reverse().map((h, i, arr) => {
      const prev = arr[i + 1];
      const d = prev ? h.rate999PerKg - prev.rate999PerKg : null;
      const cls = d === null || d === 0 ? 'flat' : d > 0 ? 'up' : 'down';
      return `<tr><th scope="row">${esc(dateFmt(h.date))}</th><td>${inr(h.rate999PerKg)}</td><td>${inr(h.rate999PerKg / 1000, 2)}</td><td class="${cls}">${d === null ? '—' : d === 0 ? 'No change' : (d > 0 ? '+' : '−') + inr(Math.abs(d))}</td></tr>`;
    }).join('');
    return `<section class="card" id="${l.slug}" aria-labelledby="h-${l.slug}"><h2 id="h-${l.slug}">Silver rate history: ${esc(l.name)}</h2>
${chartSvg(l, l.history)}
<h3>Monthly summary</h3>
<div class="table-scroll"><table class="rates"><caption>Monthly high, low and average silver rate per kg in ${esc(l.name)}</caption><thead><tr><th scope="col">Month</th><th scope="col">High</th><th scope="col">Low</th><th scope="col">Average</th><th scope="col">Days</th></tr></thead><tbody>${monthRows}</tbody></table></div>
<h3>Daily rates</h3>
<div class="table-scroll"><table class="rates"><caption>Daily 999 silver rate in ${esc(l.name)}, newest first</caption><thead><tr><th scope="col">Date</th><th scope="col">Per kg</th><th scope="col">Per gram</th><th scope="col">Change</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
  }).join('\n');
  const body = `<div class="wrap stack"><h1>Silver rate history</h1><p class="lead">Every daily 999 silver rate we have recorded, newest first, with monthly highs, lows and averages.</p><p class="small muted">${sourceLine()}</p>${sections}</div>`;
  const ld = { '@context': 'https://schema.org', '@type': 'Dataset', name: 'Daily silver rate history (India)', description: 'Daily 999 fine silver rate in INR per kg.', url: abs(path), temporalCoverage: `${india.history[0].date}/${india.today.date}`, variableMeasured: 'Silver rate (INR per kg, 999 fine)', creator: { '@type': 'Organization', name: config.name } };
  return { path, html: layout({ path, title, description, body, breadcrumbs: [[path, 'Silver rate history']], jsonld: [ld] }) };
}

function textPage(path, h1, title, description, inner, crumb) {
  const body = `<div class="wrap stack narrow prose"><h1>${esc(h1)}</h1>${inner}</div>`;
  return { path, html: layout({ path, title: `${title} | ${config.name}`, description, body, breadcrumbs: [[path, crumb || h1]] }) };
}

function staticPages() {
  const pages = [];
  pages.push(textPage('/about/', `About ${config.name}`, 'About Us',
    `${config.name} shows today's silver rate in India and tells you whether it is cheaper or costlier than usual, so you can plan jewellery and coin purchases.`,
    `<p>${esc(config.name)} answers one question every morning: <strong>is silver cheap or costly today?</strong></p>
<p>Most rate sites show a single number. We put today's 999 silver rate next to its recent low, average and high, so you can see at a glance whether it is a good day to visit your jeweller — and work out the full price of a piece with making charge and GST.</p>
<h2>What you will find here</h2><ul><li>Today's silver rate per gram, 10 grams and kilogram</li><li>The meter: today's rate compared with the last ${WINDOW_DAYS} days</li><li>A jewellery price calculator with making charge and GST</li><li>Daily and monthly silver rate history</li></ul>
<p>We do not sell silver and we do not give investment advice. Read how we get our numbers on the <a href="${link('/data-source/')}">data source and method</a> page.</p>`));
  pages.push(textPage('/data-source/', 'Data source and method', 'Data Source & Method',
    `Where ${config.name} gets its silver rates, when they are updated, and how the cheap / normal / costly meter is calculated.`,
    `<h2>Where the rates come from</h2><p>Current source: <strong>${esc(data.sourceName)}</strong>${data.sourceUrl ? ` (<a href="${esc(data.sourceUrl)}" rel="nofollow noopener" target="_blank">link</a>)` : ''}. Rates are for 999 fine silver, quoted in Indian rupees per kilogram, and are updated once a day in the morning (IST).</p>
<p>Silver rates in India are discovered on the Multi Commodity Exchange (MCX) and published as reference rates by the India Bullion and Jewellers Association (IBJA). Local rates in each city can differ slightly because of local bullion association quotes, transport and dealer margins.</p>
<h2>How the meter works</h2><p>For each location we take the daily 999 rate for up to the last ${WINDOW_DAYS} days on record and find the lowest and highest values. Today's position in that range decides the reading:</p>
<ul><li><strong>Lower than usual</strong>: bottom third of the range</li><li><strong>Normal</strong>: middle third</li><li><strong>Higher than usual</strong>: top third</li><li><strong>Steady</strong>: the rate did not change in the period</li></ul>
<h2>Other purities</h2><p>925, 900 and 800 silver prices are estimated by multiplying the 999 rate by the purity. Jewellers' actual prices include making charges, possible wastage and 3% GST.</p>
<p>Spotted a wrong rate? ${config.contactEmail ? `<a href="${link('/contact/')}">Tell us</a>` : 'Let us know'} and we will correct it.</p>`, 'Data source & method'));
  pages.push(textPage('/disclaimer/', 'Disclaimer', 'Disclaimer',
    `The silver rates, meter readings and calculator results on ${config.name} are indicative and for information only. They are not investment advice.`,
    `<p>All silver rates, meter readings and calculator results on ${esc(config.name)} are indicative and provided for general information only.</p>
<ul><li>Rates may differ from the price charged by your jeweller or dealer, which can include premiums, making charges, wastage, hallmarking fees and taxes.</li><li>The meter compares today's rate with recent rates. It does not predict future prices and is not a recommendation to buy or sell.</li><li>We try to keep the data accurate and up to date, but we cannot guarantee it. Always confirm the price before you buy.</li></ul>
<p>${esc(config.name)} is not responsible for any loss arising from use of this information.</p>`));
  pages.push(textPage('/privacy-policy/', 'Privacy policy', 'Privacy Policy',
    `How ${config.name} handles your data: what we collect, cookies and third-party services.`,
    `<p>Last updated: ${esc(longDate(BUILD_DATE))}</p>
<h2>What we collect</h2><p>${esc(config.name)} does not ask you to create an account. The calculator runs entirely in your browser; the numbers you type are not sent to us.</p>
<h2>Hosting</h2><p>This site is hosted on GitHub Pages. GitHub may log technical information such as IP addresses to keep the service secure. See GitHub's privacy statement for details.</p>
<h2>Advertising and cookies</h2>${config.adsenseClientId
      ? `<p>We show ads from Google AdSense. Google and its partners use cookies to serve ads based on your visits to this and other websites. You can opt out of personalised advertising in Google's Ads Settings. Visitors in some regions will be asked for consent before cookies are set.</p>`
      : `<p>This site does not currently set advertising or tracking cookies. If we add advertising (such as Google AdSense) in future, this policy will be updated before it goes live.</p>`}
<h2>External links</h2><p>Links to other websites (such as WhatsApp) are governed by those sites' own privacy policies.</p>
${config.contactEmail ? `<h2>Contact</h2><p>Questions about this policy: <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a>.</p>` : ''}`));
  if (config.contactEmail) {
    pages.push(textPage('/contact/', 'Contact us', 'Contact', `Contact ${config.name} about silver rates, corrections or advertising.`,
      `<p>For corrections, feedback or advertising enquiries, email <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a>.</p>`));
  }
  return pages;
}

function notFoundPage() {
  const body = `<div class="wrap stack narrow center"><h1>Page not found</h1><p class="lead">That page does not exist. Today's silver rate is just a click away.</p><p><a class="btn" href="${link('/')}">See today's silver rate</a></p></div>`;
  return layout({ path: '/404.html', title: `Page not found | ${config.name}`, description: 'This page could not be found.', body }).replace(/<meta name="robots" content="[^"]*">/, '<meta name="robots" content="noindex">');
}

// ---------- build ----------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const pages = [...locations.map(ratePage), calculatorPage(), historyPage(), ...staticPages()];
for (const p of pages) write(p.path === '/' ? 'index.html' : join(p.path, 'index.html'), p.html);
write('404.html', notFoundPage());

mkdirSync(join(OUT, 'assets'), { recursive: true });
copyFileSync(join(ROOT, 'src', 'style.css'), join(OUT, 'assets', 'style.css'));
copyFileSync(join(ROOT, 'src', 'app.js'), join(OUT, 'assets', 'app.js'));
copyFileSync(join(ROOT, 'src', 'favicon.svg'), join(OUT, 'favicon.svg'));
copyFileSync(join(ROOT, 'src', 'og-image.png'), join(OUT, 'og-image.png'));

write('site.webmanifest', JSON.stringify({ name: config.name, short_name: config.name, start_url: `${BASE_PATH}/`, display: 'standalone', background_color: '#ECFEFF', theme_color: '#042F2E', icons: [{ src: `${BASE_PATH}/favicon.svg`, sizes: 'any', type: 'image/svg+xml' }] }, null, 2));

const lastmod = india.today.date;
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${abs(p.path)}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>
`);
write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${abs('/sitemap.xml')}\n`);
write('.nojekyll', '');

console.log(`Built ${pages.length} pages + 404 into dist/ (sample data: ${data.sample})`);
