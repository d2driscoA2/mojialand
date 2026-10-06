// Browser checks for /pass/, /pass/done/, /play/ and the website.
// Run: NODE_PATH=$(npm root -g) node tests/browser.e2e.mjs [shotsDir]
// Builds a copy of site/ with a test public key, serves it with the
// headers from _headers (CSP included), and drives headless Chromium.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signToken, makeTokenPayload } from '../netlify/functions/_lib/token.mjs';
import { liveView, historyView, campaignsView, lastDays } from '../netlify/functions/_lib/analytics-admin.mjs';

// Admin analytics sample data, shaped by the real server code from fake database rows.
async function analyticsSamples() {
  process.env.SUPABASE_URL = 'https://db.example.test'; process.env.SUPABASE_SERVICE_KEY = 'k';
  const SLOT = 300e3, asOf = Math.floor(Date.now() / SLOT) * SLOT - SLOT, G = ['pattern', 'bounce', 'match', 'parade', 'draw', 'share', 'feelings'];
  const PL = [['MI', 'Troy', 9], ['MI', 'Royal Oak', 7], ['MI', 'Ann Arbor', 8], ['MI', 'Detroit', 6], ['MI', 'Novi', 4], ['MI', 'Grand Rapids', 4], ['OH', 'Columbus', 3], ['OH', 'Toledo', 2], ['IN', 'Indianapolis', 3], ['IL', 'Chicago', 3], ['TX', 'Austin', 1], ['CA', 'Los Angeles', 1], ['NY', 'New York', 2], ['KS', 'Salina', 0.3], ['MI', 'Birmingham', 1.1], ['MI', 'Southfield', 1.1], ['MI', 'Farmington Hills', 1.1], ['MI', 'Rochester Hills', 1.1]];
  const live = [], days = [], hours = [];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const [st, ci, w] of PL) for (const g of G) {
    for (let k = 0; k < 6; k++) { const n = Math.round(w * rnd() * 0.9); if (n) live.push({ slot_start: new Date(asOf - k * SLOT).toISOString(), country: 'US', state: st, city: ci, game: g, n }); }
    for (const d of lastDays(180, Date.now())) { const o = Math.round(w * 1.3 * rnd()); if (o) days.push({ d, co: 'US', st, ci, g, m: rnd() < 0.58 ? 'app' : 'web', o, b0: Math.round(o * 0.2), b1: Math.round(o * 0.3), b2: Math.round(o * 0.35), b3: Math.round(o * 0.15) }); }
    for (let h = 6; h < 22; h++) hours.push({ h, co: 'US', st, ci, g, o: Math.round(w * 3 * rnd() * (h > 15 && h < 20 ? 2 : 1)) });
  }
  const today = lastDays(1, Date.now())[0];
  const camp = { campaigns: [{ label: 'mi-troy-lib-sep', name: 'Troy library story time', note: '150 cards', active: true, created_at: new Date(Date.now() - 5 * 864e5).toISOString() }, { label: 'ig-reel-1', name: 'Instagram Reel 1', note: '', active: true, created_at: new Date(Date.now() - 2 * 864e5).toISOString() }],
    days: [{ l: 'mi-troy-lib-sep', d: today, e: 'open', n: 41, ds: 0 }, { l: 'mi-troy-lib-sep', d: today, e: 'play', n: 33, ds: 0 }, { l: 'mi-troy-lib-sep', d: today, e: 'gift', n: 12, ds: 0 }, { l: 'mi-troy-lib-sep', d: today, e: 'pass48', n: 3, ds: 4.5 }, { l: 'ig-reel-1', d: today, e: 'open', n: 18, ds: 0 }],
    places: [{ l: 'mi-troy-lib-sep', co: 'US', st: 'MI', ci: 'Troy', n: 22 }, { l: 'mi-troy-lib-sep', co: 'US', st: 'MI', ci: 'Royal Oak', n: 9 }, { l: 'mi-troy-lib-sep', co: 'US', st: 'MI', ci: 'Novi', n: 3 }, { l: 'ig-reel-1', co: 'US', st: 'TX', ci: 'Austin', n: 6 }] };
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('plays_live') ? live : u.includes('analytics_history') ? { days, hours } : camp;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const out = { live: await liveView(), history: await historyView(7), history1: await historyView(1), history90: await historyView(90), campaigns: await campaignsView() };
  globalThis.fetch = saved;
  return out;
}


const { chromium } = createRequire(import.meta.url)('playwright'); // global install; NODE_PATH=$(npm root -g)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'mojia-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? ' :: ' + info : '')); };

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const JWK = publicKey.export({ format: 'jwk' });

function build(withKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mojia-build-'));
  fs.cpSync(path.join(ROOT, 'site'), path.join(dir, 'site'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  const env = { ...process.env, MOJIA_ENV: '' };
  if (withKey) env.PASS_SIGNING_PUBLIC_JWK = JSON.stringify(JWK); else delete env.PASS_SIGNING_PUBLIC_JWK;
  const r = spawnSync('python3', ['scripts/update-csp-hash.py'], { cwd: dir, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('build failed: ' + r.stderr);
  return path.join(dir, 'site');
}

function parseHeaders(site) {
  const blocks = []; let cur = null;
  for (const line of fs.readFileSync(path.join(site, '_headers'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) { cur = { path: line.trim(), h: {} }; blocks.push(cur); }
    else { const i = line.indexOf(':'); cur.h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
  return blocks;
}
const matches = (pat, p) => pat.endsWith('*') ? p.startsWith(pat.slice(0, -1)) : p === pat;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function serve(site) {
  const blocks = parseHeaders(site);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(u.pathname);
    let f = path.join(site, p);
    if (!f.startsWith(site)) { res.writeHead(403).end(); return; }
    if (/^\/r\/[^/]+$/.test(p)) f = path.join(site, 'r', 'index.html'); // _redirects: /r/*  /r/index.html  200
    if (/^\/g\/[^/]+$/.test(p)) f = path.join(site, 'g', 'index.html'); // _redirects: /g/*  /g/index.html  200
    if (p.endsWith('/')) f = path.join(f, 'index.html');
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end('not found'); return; }
    const h = {};
    for (const b of blocks) if (matches(b.path, p)) Object.assign(h, b.h); // later rule wins (Netlify Dev behavior)
    if (h['Content-Security-Policy']) h['Content-Security-Policy'] = h['Content-Security-Policy'].replace(/;\s*upgrade-insecure-requests/, '');
    delete h['Strict-Transport-Security'];
    h['Content-Type'] = TYPES[path.extname(f)] || 'application/octet-stream';
    res.writeHead(200, h); res.end(fs.readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

const FAKE_STRIPE = `window.Stripe=function(pk){return{createEmbeddedCheckoutPage:async function(o){await o.fetchClientSecret();return{mount:function(sel){var d=document.querySelector(sel);d.innerHTML='<div style="border:1px solid #ddd;border-radius:14px;padding:14px;font:14px system-ui;color:#333;display:grid;gap:9px"><div style="background:#000;color:#fff;border-radius:8px;padding:12px;text-align:center;font-weight:600">Apple Pay</div><div style="text-align:center;color:#777;font-size:12px">or pay with card</div><div>Email</div><div style="border:1px solid #ccc;border-radius:6px;height:36px"></div><div>Card information</div><div style="border:1px solid #ccc;border-radius:6px;height:36px"></div><div style="background:#7138D1;color:#fff;border-radius:8px;padding:12px;text-align:center;font-weight:600">Pay</div><div style="text-align:center;color:#777;font-size:12px">Powered by Stripe (test stand-in)</div></div>';},destroy:function(){}};}};};`;

function tokenFor(kind, endsMs) {
  const payload = makeTokenPayload({ id: crypto.randomUUID(), kind, ends_at: kind === 'forever' ? null : new Date(endsMs).toISOString() }, 'staging');
  return { token: signToken(payload, PEM), payload };
}
function tamper(tok) {
  const [b, s] = tok.split('.');
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  p.k = 'forever'; p.e = 0;
  return Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + s;
}

const site = build(true);
const siteNoKey = build(false);
const A = await serve(site), B = await serve(siteNoKey);
const base = 'http://localhost:' + A.port, baseNoKey = 'http://localhost:' + B.port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, ...opts });
  const page = await ctx.newPage();
  page.csp = []; page.errors = []; page.reqs = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) page.csp.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('request', (r) => page.reqs.push(r.url()));
  return { ctx, page };
}

// one inline script per built page
for (const rel of ['index.html', 'play/index.html', 'pass/index.html', 'pass/done/index.html', 'r/index.html', 'admin/index.html']) {
  const n = (fs.readFileSync(path.join(site, rel), 'utf8').match(/<script>/g) || []).length;
  check('one inline script: ' + rel, n === 1, String(n));
}

// Release 1.2 #18: device wording says up to 5, never "every device" or "all your devices"
for (const rel of ['index.html', 'play/index.html', 'pass/index.html', 'pass/done/index.html', 'r/index.html']) {
  const t = fs.readFileSync(path.join(site, rel), 'utf8');
  check('#18 no "every device" wording: ' + rel, !/every device|all your devices/i.test(t));
}
check('#18 website pass card says up to 5 devices', /Up to 5 devices share the same 48 hours\./.test(fs.readFileSync(path.join(site, 'index.html'), 'utf8')));

// 1. WebCrypto verifies node-signed tokens
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/logo/favicon.svg');
  const { token } = tokenFor('48h', Date.now() + 3600e3);
  const r = await page.evaluate(async ([jwk, tok, bad]) => {
    const b64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const v = async (t) => { const [b, s] = t.split('.'); return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u(s), new TextEncoder().encode(b)); };
    return [await v(tok), await v(bad)];
  }, [JWK, token, tamper(token)]);
  check('Chromium WebCrypto verifies node token', r[0] === true);
  check('Chromium WebCrypto rejects tampered token', r[1] === false);
  await ctx.close();
}

// 2. /pass/?plan=pass: sheet with Stripe stand-in; create-checkout mocked
{
  const { ctx, page } = await newPage();
  let body = null;
  await page.route('https://js.stripe.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_STRIPE }));
  await page.route('**/.netlify/functions/create-checkout', (r) => { body = r.request().postDataJSON(); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientSecret: 'cs_test_x_secret', publishableKey: 'pk_test_x' }) }); });
  await page.goto(base + '/pass/?plan=pass');
  await page.waitForSelector('#checkout >> text=Apple Pay');
  check('/pass/ sheet: item and price', (await page.textContent('#coItem')) === '48-hour pass' && (await page.textContent('#coPrice')) === '$1.50');
  await page.goto(base + '/play/#passes'); await page.waitForSelector('#s-ngate:not(.hidden)');
  { const ans = await page.getAttribute('#pwChoices', 'data-a'); await page.click('#pwChoices [data-n="' + ans + '"]'); }
  await page.waitForSelector('#s-plans:not(.hidden)');
  check('pass screen CTA names the pass', (await page.textContent('#pwPay')) === 'Start 48 hours · $1.50', await page.textContent('#pwPay'));
  await page.click('[data-plan="life"]');
  check('pass screen CTA for Forever', (await page.textContent('#pwPay')) === 'Get Forever · $14.99');
  await page.goto(base + '/pass/?plan=pass'); await page.waitForSelector('#checkout >> text=Apple Pay');
  check('/pass/ sends only the plan', JSON.stringify(body) === '{"plan":"pass"}', JSON.stringify(body));
  check('/pass/ wordmark visible', await page.isVisible('header img[src="/logo/wordmark.png"]'));
  check('/pass/ no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check('/pass/ no horizontal scroll at 390', noScroll);
  await page.screenshot({ path: path.join(SHOTS, 'pass-sheet-390.png') });
  await page.click('#coCancel');
  await page.waitForURL('**/play/**');
  await page.waitForSelector('#s-ngate:not(.hidden)');
  check('Cancel returns to /play/ and routes through the gate', (await page.evaluate(() => location.hash)) === '' && await page.isVisible('#s-ngate'));
  await page.screenshot({ path: path.join(SHOTS, 'cancel-gate-390.png') });
  await ctx.close();
}

// 3. /pass/ with Stripe blocked: friendly error state
{
  const { ctx, page } = await newPage();
  let calls = 0;
  await page.route('https://js.stripe.com/**', (r) => r.abort());
  await page.route('**/.netlify/functions/create-checkout', (r) => { calls++; r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Checkout could not start. Please try again."}' }); });
  await page.goto(base + '/pass/?plan=life');
  await page.waitForSelector('#coError:not([hidden])');
  check('/pass/ Stripe blocked: error state', await page.isVisible('#coRetry') && await page.isVisible('#coError a[href="/play/#passes"]') && (await page.locator('a[href^="mailto:"]').count()) === 0);
  check('/pass/ Stripe blocked: no checkout request made', calls === 0);
  check('/pass/ life shows Forever $14.99', (await page.textContent('#coItem')) === 'Forever' && (await page.textContent('#coPrice')) === '$14.99');
  await page.screenshot({ path: path.join(SHOTS, 'pass-error-stripe-blocked-390.png') });
  await ctx.close();
}

// 4. /pass/ create-checkout fails, then Try again works; add sends the device code
{
  const { ctx, page } = await newPage();
  const bodies = []; let n = 0;
  await page.addInitScript(() => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-AAAA-BBBB-CCCC', kind: '48h', ends_at: Date.now() + 3600e3 })));
  await page.route('https://js.stripe.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_STRIPE }));
  await page.route('**/.netlify/functions/create-checkout', (r) => { bodies.push(r.request().postDataJSON()); n++;
    if (n === 1) r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: "That pass can't be changed. Pick a new pass." }) });
    else r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientSecret: 'cs_test_y_secret', publishableKey: 'pk_test_x' }) }); });
  await page.goto(base + '/pass/?plan=add');
  await page.waitForSelector('#coError:not([hidden])');
  check('/pass/ server error text shown', (await page.textContent('#coErrorText')) === "That pass can't be changed. Pick a new pass.");
  await page.screenshot({ path: path.join(SHOTS, 'pass-error-server-390.png') });
  await page.click('#coRetry');
  await page.waitForSelector('#checkout >> text=Apple Pay');
  check('/pass/ Try again mounts checkout', await page.isHidden('#coError'));
  check('/pass/?plan=add sends device code', bodies[0].plan === 'add' && bodies[0].code === 'MOJI-AAAA-BBBB-CCCC', JSON.stringify(bodies[0]));
  check('/pass/ add shows Add 48 hours $1.50', (await page.textContent('#coItem')) === 'Add 48 hours');
  await ctx.close();
}

// 5. /pass/done/ -> pending, then paid -> /play/#allset -> All set -> home chip green
{
  const { ctx, page } = await newPage();
  const ends = Date.now() + 48 * 3600e3;
  const { token, payload } = tokenFor('48h', ends);
  let n = 0;
  await page.route('**/.netlify/functions/confirm-session', (r) => { n++;
    if (n === 1) return r.fulfill({ status: 402, contentType: 'application/json', body: '{"status":"pending"}' });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'MOJI-TEST-CODE-2345', kind: '48h', ends_at: payload.e, token, email_masked: 'p•••@example.com', plan: 'pass' }) }); });
  await page.goto(base + '/pass/done/?session_id=cs_test_x');
  await page.screenshot({ path: path.join(SHOTS, 'done-turning-on-390.png') });
  await page.waitForURL('**/play/**', { timeout: 15000 });
  await page.waitForSelector('#s-allset:not(.hidden)');
  check('done: retried after 402', n === 2, String(n));
  check('All set: title', (await page.textContent('#pwOkTitle')) === "You're all set for 48 hours");
  const okText = await page.textContent('#pwOkText');
  check('All set: line', /^Pass on until .+\. Code emailed to p•••@example\.com\.$/.test(okText), okText);
  check('All set: hash and flag cleared', (await page.evaluate(() => location.hash)) === '' && (await page.evaluate(() => localStorage.getItem('mojia.allset'))) === null);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.pass')));
  check('done: saved pass', saved.code === 'MOJI-TEST-CODE-2345' && saved.kind === '48h' && saved.ends_at === payload.e && saved.token === token, JSON.stringify(saved).slice(0, 120));
  check('All set: big Hand it back button, then two quiet links (Release 1.1.1 #48)', await page.isVisible('#pwOkBack') && await page.isVisible('#pwOkHS') && await page.isVisible('#pwOkShare')
    && (await page.textContent('#pwOkHSt')) === "Put Mojialand on this phone's Home Screen" && /Use Mojialand on another device/.test(await page.textContent('#pwOkShare')));
  check('All set: the big button comes first', await page.evaluate(() => { const ids = [...document.querySelectorAll('#s-allset button')].filter((b) => b.offsetParent).map((b) => b.id); return ids[0] === 'pwOkBack'; }));
  check('All set: no friend card buttons and no Home Screen card', (await page.locator('#s-allset [data-gift]').count()) === 0 && (await page.locator('#s-allset .pw-hsbig').count()) === 0);
  const fits = await page.evaluate(() => { const s = document.querySelector('#s-allset'); return s.scrollHeight <= s.clientHeight + 1; });
  check('All set fits at 390x844 with no scrolling', fits);
  await page.screenshot({ path: path.join(SHOTS, 'allset-48h-390.png') });
  await page.evaluate(() => { navigator.share = undefined; });
  await page.click('#pwOkShare');
  await page.waitForSelector('#pwOvSoon:not(.hidden)');
  check('Send code: sheet shows the /r/ link and the code when no share sheet exists', /\/r\/MOJITESTCODE2345/.test(await page.textContent('#pwSoonText')) && /MOJI-TEST-CODE-2345/.test(await page.textContent('#pwSoonText')));
  await page.click('#pwOvSoon [data-pw-close]');
  await page.click('#pwOkBack');
  await page.waitForSelector('#s-home:not(.hidden)');
  const chip = page.locator('#s-home [data-chip]');
  check('home chip shows green pass', /pass/.test(await chip.getAttribute('class')) && /48h left/.test(await chip.textContent()), await chip.textContent());
  await page.screenshot({ path: path.join(SHOTS, 'home-chip-pass-390.png') });
  const foreign = page.reqs.filter((u) => u.includes('/play/') || true).filter((u) => !u.startsWith(base) && !u.startsWith('data:'));
  check('no third-party requests (done + play)', foreign.length === 0, foreign.join(','));
  check('no CSP violations (done + play)', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 6. add/up keep the device's code; forever shows "yours for good"
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('forever');
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-KEEP-THIS-CODE', kind: '48h', ends_at: 1, device_id: 'dev-123' })); } });
  await page.route('**/.netlify/functions/confirm-session', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: null, kind: 'forever', ends_at: payload.e, token, email_masked: 'p•••@example.com', plan: 'up' }) }));
  await page.goto(base + '/pass/done/?session_id=cs_test_up1');
  await page.waitForSelector('#s-allset:not(.hidden)', { timeout: 15000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.pass')));
  check('up: keeps existing code; saves a device id', saved.code === 'MOJI-KEEP-THIS-CODE' && /^[0-9a-f]{32}$/.test(saved.device_id) && saved.kind === 'forever', JSON.stringify(saved).slice(0, 100));
  check('up: "Mojialand is yours for good"', (await page.textContent('#pwOkTitle')) === 'Mojialand is yours for good');
  await page.screenshot({ path: path.join(SHOTS, 'allset-forever-390.png') });
  await page.click('#pwOkBack');
  check('forever chip', (await page.locator('#s-home [data-chip]').textContent()).includes('Forever'));
  await ctx.close();
}

// 7. tampered token: done page refuses; play ignores a tampered stored pass
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('48h', Date.now() + 48 * 3600e3);
  const bad = tamper(token);
  await page.route('**/.netlify/functions/confirm-session', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'MOJI-TEST-CODE-2345', kind: 'forever', ends_at: 0, token: bad, email_masked: 'x', plan: 'life' }) }));
  await page.goto(base + '/pass/done/?session_id=cs_test_bad');
  await page.waitForSelector('#dGrace:not([hidden])');
  check('done: tampered token refused, nothing saved, grace instead', (await page.evaluate(() => localStorage.getItem('mojia.pass'))) === null
    && (await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.grace')).sid)) === 'cs_test_bad');
  await page.evaluate(() => localStorage.removeItem('mojia.grace'));
  await page.evaluate(([bad]) => { localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-TEST-CODE-2345', kind: 'forever', ends_at: 0, token: bad })); localStorage.setItem('mojia.allset', JSON.stringify({ plan: 'life', email_masked: 'x', at: Date.now() })); }, [bad]);
  await page.goto(base + '/play/#allset');
  await page.waitForTimeout(800);
  const chip = await page.locator('#s-home [data-chip]').textContent();
  check('play: tampered pass ignored (no All set, free play chip)', await page.isHidden('#s-allset') && /^\d+:\d\d$/.test(chip.trim()), chip);
  // payload edited ends_at in storage but token valid: ignored
  await page.evaluate(([tok, e]) => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'X', kind: '48h', ends_at: e + 864e5, token: tok })), [token, payload.e]);
  await page.reload(); await page.waitForTimeout(800);
  check('play: stored ends_at not matching token ignored', /^\d+:\d\d$/.test((await page.locator('#s-home [data-chip]').textContent()).trim()));
  await page.evaluate(([tok, e]) => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'X', kind: '48h', ends_at: e, token: tok })), [token, payload.e]);
  await page.reload(); await page.waitForTimeout(800);
  check('play: valid stored pass honored', /48h left/.test(await page.locator('#s-home [data-chip]').textContent()));
  await ctx.close();
}

// 7b. server keeps failing after payment: quiet retries, then free minutes; the game finishes the job
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('48h', Date.now() + 48 * 3600e3);
  let n = 0, ok = false;
  await page.route('**/.netlify/functions/confirm-session', (r) => { n++;
    if (!ok) return r.fulfill({ status: n % 2 ? 202 : 500, contentType: 'application/json', body: n % 2 ? '{"status":"paid_pending"}' : '{"error":"x"}' });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'MOJI-LATE-CODE-2345', kind: '48h', ends_at: payload.e, token, email_masked: 'p•••@example.com', plan: 'pass' }) }); });
  await page.goto(base + '/pass/done/?session_id=cs_test_slow1');
  await page.waitForSelector('#dGrace:not([hidden])', { timeout: 45000 });
  check('done: retried quietly about 30 seconds', n >= 10, String(n));
  check('done: "Payment received" with one Back button', (await page.textContent('#dGraceTitle')) === 'Payment received'
    && (await page.locator('#dGrace a.primary').count()) === 1 && (await page.locator('#dGrace a.primary').getAttribute('href')) === '/play/');
  check('done: no mailto anywhere', (await page.locator('a[href^="mailto:"]').count()) === 0);
  await page.screenshot({ path: path.join(SHOTS, 'done-grace-390.png') });
  await page.click('#dGrace [data-contact]');
  check('done: contact form opens in page', await page.isVisible('#cSheet') && await page.isVisible('#cEmail'));
  await page.screenshot({ path: path.join(SHOTS, 'done-contact-390.png') });
  let sent = null;
  await page.route('**/.netlify/functions/contact', (r) => { sent = r.request().postDataJSON(); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  check('done: contact form has a pass code field', await page.isVisible('#cCode'));
  await page.fill('#cEmail', 'parent@example.com'); await page.fill('#cMsg', 'Paid, pass not on');
  await page.click('#cSend');
  await page.waitForSelector('#cDone:not([hidden])');
  check('done: contact sends email, message and payment id', sent && sent.email === 'parent@example.com' && sent.session_id === 'cs_test_slow1', JSON.stringify(sent));
  await page.click('#cDone [data-close]');
  ok = true;
  await page.click('#dGrace a.primary');
  await page.waitForURL('**/play/**');
  await page.waitForFunction(() => { const c = document.querySelector('#s-home [data-chip]'); return c && /48h left/.test(c.textContent); }, null, { timeout: 15000 });
  const saved = await page.evaluate(() => [JSON.parse(localStorage.getItem('mojia.pass')), localStorage.getItem('mojia.grace')]);
  check('play: background retry turns the pass on and clears grace', saved[0] && saved[0].code === 'MOJI-LATE-CODE-2345' && saved[1] === null);
  check('no CSP violations (grace flow)', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 7c. grace chip while waiting; free play does not run down
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.grace', JSON.stringify({ sid: 'cs_test_wait1', until: Date.now() + 60 * 60e3, at: Date.now() })); localStorage.setItem('mojia.freeUsed', '999'); localStorage.setItem('mojia.firstDone', 'true'); });
  await page.route('**/.netlify/functions/confirm-session', (r) => r.fulfill({ status: 202, contentType: 'application/json', body: '{"status":"paid_pending"}' }));
  await page.goto(base + '/play/');
  await page.waitForTimeout(900);
  const chip = (await page.locator('#s-home [data-chip]').textContent()).trim();
  check('grace: chip shows minutes, not blocked', /min/.test(chip) && await page.isHidden('#s-rest'), chip);
  await ctx.close();
}

// 7d. /pass/done/ with an unknown payment: clear message, Back and Contact us
{
  const { ctx, page } = await newPage();
  await page.route('**/.netlify/functions/confirm-session', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"We could not find that payment."}' }));
  await page.goto(base + '/pass/done/?session_id=cs_test_nope1');
  await page.waitForSelector('#dErr:not([hidden])');
  check('done 404: Back to Mojialand and in-page Contact us', await page.isVisible('#dErr a[href="/play/"]') && await page.isVisible('#dErr [data-contact]'));
  await page.screenshot({ path: path.join(SHOTS, 'done-error-390.png') });
  await ctx.close();
}

// 7e. /r/CODE from the email button: turns the pass on, strips the code from the address bar
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('48h', Date.now() + 20 * 3600e3);
  let body = null;
  await page.route('**/.netlify/functions/redeem-code', (r) => { body = r.request().postDataJSON(); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'MOJI-ABCD-EFGH-JKMN', kind: '48h', ends_at: payload.e, token, email_masked: 'p•••@example.com' }) }); });
  const hist = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) hist.push(f.url()); });
  await page.goto(base + '/r/MOJIABCDEFGHJKMN');
  await page.waitForSelector('#rReady:not([hidden])');
  await page.waitForTimeout(800);
  check('#33 /r/: nothing redeems before a tap', body === null && await page.isVisible('#rTap'));
  check('#33 /r/: code out of the address bar before the tap', new URL(page.url()).pathname === '/r/');
  await page.screenshot({ path: path.join(SHOTS, 'r-ready-390.png') });
  await page.click('#rTap');
  await page.waitForSelector('#s-allset:not(.hidden)', { timeout: 15000 });
  check('/r/: sends normalized code and device id', body && body.code === 'MOJI-ABCD-EFGH-JKMN' && /^[0-9a-f]{32}$/.test(body.device_id), JSON.stringify(body));
  check('/r/: All set says "Mojialand is on!"', (await page.textContent('#pwOkTitle')) === 'Mojialand is on!');
  check('/r/: no email line on this device', !/emailed/.test(await page.textContent('#pwOkText')));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.pass')));
  check('/r/: pass saved with code', saved.code === 'MOJI-ABCD-EFGH-JKMN' && saved.token === token);
  await page.screenshot({ path: path.join(SHOTS, 'r-allset-390.png') });
  check('/r/: no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await page.route('**/.netlify/functions/redeem-code', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"This code is on 5 devices already. Contact us to move it to a new device."}' }));
  await page.goto(base + '/r/MOJIABCDEFGHJKMN');
  await page.click('#rTap');
  await page.waitForSelector('#rStop:not([hidden])');
  check('/r/: code gone from the address bar', new URL(page.url()).pathname === '/r/');
  check('/r/ 409: device limit message and contact', /5 devices/.test(await page.textContent('#rStopText')) && await page.isVisible('#rStop [data-contact]'));
  await page.screenshot({ path: path.join(SHOTS, 'r-limit-390.png') });
  await page.goto(base + '/r/');
  await page.waitForSelector('#rForm:not([hidden])');
  await page.fill('#rCode', 'moji abcd');
  await page.click('#rGo');
  check('/r/ no code: form with format hint', /MOJI-XXXX/.test(await page.textContent('#rErr')));
  await page.screenshot({ path: path.join(SHOTS, 'r-form-390.png') });
  await ctx.close();
}

// Release 1.2 #33: gift links wait for a tap; a stale or mismatched /g/ tap never counts
{
  const { ctx, page } = await newPage();
  const bodies = [];
  await page.route('**/.netlify/functions/redeem-code', (r) => { bodies.push(r.request().postDataJSON()); r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"x"}' }); });
  await page.goto(base + '/r/');
  await page.evaluate(() => sessionStorage.setItem('mojia.tap', JSON.stringify({ c: 'GIFTZZZZZZZZZZZZ', t: Date.now() })));
  await page.goto(base + '/r/GIFTABCDEFGHJKMN');
  await page.waitForSelector('#rReady:not([hidden])'); await page.waitForTimeout(800);
  check('#33 /r/ gift link waits; tap flag for a different code ignored', bodies.length === 0);
  await page.evaluate(() => sessionStorage.setItem('mojia.tap', JSON.stringify({ c: 'GIFTABCDEFGHJKMN', t: Date.now() - 600000 })));
  await page.goto(base + '/r/GIFTABCDEFGHJKMN');
  await page.waitForSelector('#rReady:not([hidden])'); await page.waitForTimeout(800);
  check('#33 /r/ old tap flag (10 minutes) ignored', bodies.length === 0);
  await page.click('#rTap'); await page.waitForSelector('#rStop:not([hidden])');
  check('#33 /r/ gift code redeems after the tap', bodies.length === 1 && bodies[0].code === 'GIFT-ABCD-EFGH-JKMN', JSON.stringify(bodies));
  check('#33 /r/ no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// Release 1.2 #11: sports, fruit and vegetable emoji in every picker; balls lead Bounce
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/');
  await page.click('#splash'); await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#s-home [data-go="bounce"]').click()); await page.waitForTimeout(400);
  const tray = await page.evaluate(() => [...document.querySelectorAll('#vtray .tile')].slice(0, 11).map((t) => t.textContent));
  check('#11 Bounce: balls lead the tray, soccer ball picked first', tray.slice(0, 4).join('') === '⚽🏀🏈⚾' && (await page.evaluate(() => document.querySelector('#vtray .tile.on').textContent)) === '⚽', tray.join(''));
  await page.evaluate(() => document.querySelector('#s-bounce [data-go="home"]').click()); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#s-home [data-go="parade"]').click()); await page.waitForTimeout(400);
  await page.click('#addBtn'); await page.waitForSelector('#drawer:not(.hidden)');
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#dtabs .dtab')].map((t) => t.textContent.replace(/\p{Extended_Pictographic}|\uFE0F/gu, '').trim()));
  check('#11 picker: Balls, Sports, Fruits and Veggies tabs join the library', ['Balls', 'Sports', 'Fruits', 'Veggies'].every((n) => tabs.includes(n)), tabs.join(','));
  await page.evaluate(() => { const t = [...document.querySelectorAll('#dtabs .dtab')].find((x) => /Veggies/.test(x.textContent)); t.scrollIntoView(); t.click(); });
  await page.waitForTimeout(200);
  const pk = await page.evaluate(() => { const tabsEl = document.querySelector('#dtabs'), grid = document.querySelector('#dgrid'), first = grid.querySelector('.tile'); return { first: first.textContent, scrolls: tabsEl.scrollWidth > tabsEl.clientWidth, tabsBottom: tabsEl.getBoundingClientRect().bottom, gridTop: grid.getBoundingClientRect().top, tileTop: first.getBoundingClientRect().top }; });
  check('#11 picker: the tab row scrolls sideways and covers no emoji; Veggies opens on the carrot', pk.first === '🥕' && pk.scrolls && pk.tabsBottom <= pk.tileTop + 1, JSON.stringify(pk));
  await page.screenshot({ path: path.join(SHOTS, 'picker-veggies-390.png') });
  const lib = await page.evaluate(() => [...document.querySelectorAll('#dtabs .dtab')].length);
  check('#11 picker: 10 categories', lib === 10, String(lib));
  check('#11 no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 7f. Have a code? and Contact us inside the game (behind the grown-up gate)
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('forever');
  await page.route('**/.netlify/functions/redeem-code', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'GIFT-ABCD-EFGH-JKMN', kind: 'forever', ends_at: payload.e, token, email_masked: '' }) }));
  await page.goto(base + '/play/#passes');
  await page.waitForSelector('#s-ngate:not(.hidden)');
  const ans = await page.getAttribute('#pwChoices', 'data-a');
  await page.click('#pwChoices [data-n="' + ans + '"]');
  await page.waitForSelector('#s-plans:not(.hidden)');
  await page.evaluate(() => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-SAVE-DCOD-E234', kind: '48h', ends_at: 1 })));
  await page.click('#pwHelp');
  check('game: Contact us opens a form, not an email app', await page.isVisible('#pwOvContact') && await page.isVisible('#pwCEmail'));
  check('game: contact form prefills the saved pass code', (await page.inputValue('#pwCCode')) === 'MOJI-SAVE-DCOD-E234');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, 'play-contact-390.png') });
  await page.click('#pwOvContact #pwCForm [data-pw-close]');
  await page.click('#pwCode');
  await page.fill('#pwCodeIn', 'gift-abcd-efgh-jkmn');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, 'play-code-390.png') });
  await page.click('#pwCodeGo');
  await page.waitForSelector('#s-allset:not(.hidden)');
  check('game: Have a code? turns Forever on', (await page.textContent('#pwOkTitle')) === 'Mojialand is on!');
  check('game: no CSP violations (code + contact)', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 8. no public key in the build: no pass is valid
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('forever');
  await page.goto(baseNoKey + '/play/');
  await page.evaluate(([tok]) => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'X', kind: 'forever', ends_at: 0, token: tok })), [token]);
  await page.reload(); await page.waitForTimeout(800);
  const chip = (await page.locator('#s-home [data-chip]').textContent()).trim();
  check('play without key: pass not honored', /^\d+:\d\d$/.test(chip), chip);
  const src = fs.readFileSync(path.join(siteNoKey, 'play/index.html'), 'utf8');
  check('build without key writes null', src.includes('const PASS_PUBLIC_JWK=null;'));
  await ctx.close();
}

// 9. website footer credit
{
  const { ctx, page } = await newPage({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  await page.goto(base + '/');
  const a = page.locator('footer a[href="https://displayedux.com"]');
  check('website footer credit link', (await a.count()) === 1 && (await a.getAttribute('rel')).includes('noopener') && (await page.locator('footer .credit').textContent()).trim() === 'Mojialand is made by DisplayedUX');
  check('website no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await a.scrollIntoViewIfNeeded();
  await page.locator('footer').screenshot({ path: path.join(SHOTS, 'website-footer.png') });
  await ctx.close();
}

// 9b. website play window: phones go straight to /play/; desktop X sits outside the game frame
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/');
  await page.click('[data-play]');
  await page.waitForURL('**/play/**');
  check('website on a phone: Play opens /play/ full screen (no overlay, no X)', new URL(page.url()).pathname === '/play/');
  await ctx.close();
}
{
  const { ctx, page } = await newPage({ viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(base + '/');
  await page.click('[data-play]');
  await page.waitForURL('**/play/**');
  check('website on a sideways iPad: Play opens /play/ full screen (no phone-sized frame)', new URL(page.url()).pathname === '/play/' && (await page.locator('#player').count()) === 0);
  await ctx.close();
}
{
  const { ctx, page } = await newPage({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  await page.goto(base + '/');
  await page.click('[data-play]');
  await page.waitForSelector('#player:not([hidden])');
  const r = await page.evaluate(() => { const x = document.querySelector('#closePlayer').getBoundingClientRect(), d = document.querySelector('.device').getBoundingClientRect(); return { x, d, sep: x.left >= d.right || x.bottom <= d.top }; });
  check('website desktop: X does not overlap the game frame', r.sep, JSON.stringify(r));
  await page.screenshot({ path: path.join(SHOTS, 'website-player-desktop.png') });
  await ctx.close();
}

// 9c. Grown-ups: one tap on the gear opens the number gate; the label is visible
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/play/#passes');
  await page.waitForSelector('#s-ngate:not(.hidden)');
  await page.click('#pwGateBack');
  await page.waitForSelector('#s-home:not(.hidden)');
  check('home: gear shows a "Grown-ups" label', (await page.textContent('#lockBtn .gl')).trim() === 'Grown-ups' && await page.isVisible('#lockBtn .gl'));
  await page.click('#lockBtn');
  await page.waitForSelector('#s-ngate:not(.hidden)');
  check('home: one tap on Grown-ups opens the number gate', await page.isVisible('#s-ngate'));
  const ans = await page.getAttribute('#pwChoices', 'data-a');
  await page.click('#pwChoices [data-n="' + ans + '"]');
  await page.waitForSelector('#s-gate:not(.hidden)');
  check('number gate leads to Grown-ups', await page.isVisible('#s-gate'));
  await page.screenshot({ path: path.join(SHOTS, 'home-grownups-label-390.png') });
  await ctx.close();
}

// 9d. Home Screen handoff: manifest link carries the pass; /play/?restore= saves it
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('48h', Date.now() + 40 * 3600e3);
  await page.goto(base + '/play/');
  await page.waitForTimeout(500);
  check('manifest link on a non-iPhone is the install file with start_url', (await page.getAttribute('link[rel="manifest"]', 'href')) === '/manifest-install.webmanifest');
  await page.evaluate(([tok, e]) => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-HAND-OFFF-2345', kind: '48h', ends_at: e, token: tok })), [token, payload.e]);
  await page.reload(); await page.waitForTimeout(800);
  check('page address carries the pass token only, never the pass code (Security R1)', new URL(page.url()).search === '?restore=' + encodeURIComponent(token) && !/MOJI/.test(page.url()), page.url());
  check('body is fixed so the app never scrolls under the status bar', (await page.evaluate(() => getComputedStyle(document.body).position)) === 'fixed');
  await ctx.close();
}
{
  const { ctx, page } = await newPage(); // a fresh "Home Screen app" with empty storage
  const { token } = tokenFor('48h', Date.now() + 40 * 3600e3);
  await page.goto(base + '/play/?restore=' + encodeURIComponent(token) + '&code=MOJI-HAND-OFFF-2345');
  await page.waitForFunction(() => { const c = document.querySelector('#s-home [data-chip]'); return c && /h left/.test(c.textContent); }, null, { timeout: 8000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.pass')));
  check('restore: older Home Screen apps with &code still restore the pass and code', saved && saved.token === token && saved.code === 'MOJI-HAND-OFFF-2345');
  check('restore: address keeps the pass for Home Screen adds', new URL(page.url()).search.startsWith('?restore='));
  const badTok = tamper(token);
  await page.evaluate(() => localStorage.clear());
  await page.goto(base + '/play/?restore=' + encodeURIComponent(badTok));
  await page.waitForTimeout(800);
  check('restore: tampered token ignored', (await page.evaluate(() => localStorage.getItem('mojia.pass'))) === null);
  await ctx.close();
}

// 9c2. Have a code? with a discount code shows the pass screen with the discount and passes it to checkout
{
  const { ctx, page } = await newPage();
  let payUrl = '';
  await page.route('**/.netlify/functions/redeem-code', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"discount":{"code":"FRIENDS50","percent_off":50,"amount_off":null,"name":"Friends"}}' }));
  await page.goto(base + '/play/#passes'); await page.waitForSelector('#s-ngate:not(.hidden)');
  { const ans = await page.getAttribute('#pwChoices', 'data-a'); await page.click('#pwChoices [data-n="' + ans + '"]'); }
  await page.waitForSelector('#s-plans:not(.hidden)');
  await page.click('#pwCode'); await page.fill('#pwCodeIn', 'friends50'); await page.click('#pwCodeGo');
  await page.waitForSelector('#pwDiscount:not([hidden])');
  check('discount: green line and halved prices', (await page.textContent('#pwDiscount')) === 'FRIENDS50 applied: 50% off' && (await page.textContent('#pwPay')) === 'Start 48 hours · $0.75');
  await page.screenshot({ path: path.join(SHOTS, 'plans-discount-390.png') });
  await page.evaluate(() => { window.__nav = null; });
  await page.route('**/pass/**', (r) => { payUrl = r.request().url(); r.fulfill({ status: 200, contentType: 'text/html', body: '<title>x</title>' }); });
  await page.click('#pwPay');
  await page.waitForTimeout(500);
  check('discount: checkout link carries plan and promo', /\/pass\/\?plan=pass&promo=FRIENDS50$/.test(payUrl), payUrl);
  await ctx.close();
}

// 9d1. iPhone gets the manifest with no start_url, so the Home Screen app opens the page it was added from
{
  const { ctx, page } = await newPage({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' });
  await page.goto(base + '/play/'); await page.waitForTimeout(400);
  check('iphone: manifest link stays the file without start_url', (await page.getAttribute('link[rel="manifest"]', 'href')) === '/manifest.webmanifest');
  const m = JSON.parse(fs.readFileSync(path.join(site, 'manifest.webmanifest'), 'utf8'));
  const mi = JSON.parse(fs.readFileSync(path.join(site, 'manifest-install.webmanifest'), 'utf8'));
  check('manifest files: iPhone one has no start_url, install one has /play/, both scope /', !('start_url' in m) && mi.start_url === '/play/' && m.scope === '/' && mi.scope === '/');
  await ctx.close();
}

// 9d2. Release 1.1.1 #39 (final, Danny October 5): no pairing number anywhere. The Home Screen card only invites; no server handoff.
{
  {
    const { ctx, page } = await newPage();
    const { token, payload } = tokenFor('48h', Date.now() + 30 * 3600e3);
    const calls = [];
    await page.route('**/.netlify/functions/handoff', (r) => { calls.push(1); r.fulfill({ status: 404, body: '' }); });
    await page.route('**/.netlify/functions/pass-check', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'on', kind: '48h', ends_at: payload.e, token }) }));
    await page.addInitScript(([tok, e]) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-HAND-OFFF-2345', kind: '48h', ends_at: e, token: tok })); } }, [token, payload.e]);
    await page.goto(base + '/play/'); await page.waitForTimeout(600);
    await page.click('#splash'); await page.waitForTimeout(400); await page.click('#lockBtn'); await page.waitForSelector('#s-ngate:not(.hidden)');
    { const ans = await page.getAttribute('#pwChoices', 'data-a'); await page.click('#pwChoices [data-n="' + ans + '"]'); }
    await page.waitForSelector('#s-gate:not(.hidden)'); await page.waitForTimeout(500);
    const card = await page.textContent('#pwHS');
    check('Home Screen card: only the invite, no number, no pass talk', !/pairing|number|paid in safari|pass/i.test(card) && await page.isVisible('#pwHSbtn'), card);
    check('no server handoff calls', calls.length === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
    await page.goto(base + '/play/'); await page.waitForTimeout(600);
    await page.click('#splash'); await page.waitForTimeout(400); await page.click('#lockBtn'); await page.waitForSelector('#s-ngate:not(.hidden)');
    { const ans = await page.getAttribute('#pwChoices', 'data-a'); await page.click('#pwChoices [data-n="' + ans + '"]'); }
    await page.waitForSelector('#s-gate:not(.hidden)'); await page.waitForTimeout(400);
    check('Home Screen app with no pass: card says it is on the Home Screen, nothing about passes', /On your Home Screen/.test(await page.textContent('#pwHS')) && !/pairing|paid in safari/i.test(await page.textContent('#pwHS')));
    check('Home Screen app with no pass: the status line points to Have a code?', /Paid already\? Type the code from your email under Have a code\? below\./.test(await page.textContent('#pwStatus')) && await page.isVisible('.pw-gurow[data-a="code"]'));
    await ctx.close();
  }
}

// 9e. Pattern (Release 1.2 #35): 6 games per level, basket fruit each game, friend on game 3, bronze after level 1
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/');
  await page.click('#splash');
  await page.click('[data-go="pattern"]');
  await page.waitForSelector('#s-pattern:not(.hidden)');
  await page.waitForTimeout(800);
  check('#35 pattern: World 1 level 1 is AB with 2 choices', (await page.locator('#pchoices .choice').count()) === 2 && (await page.textContent('#plevel')) === 'World 1 · Level 1' && (await page.locator('#prow .pc').count()) === 5);
  check('#35 pattern: 6 dots per level, the next one pulses', (await page.locator('#pdots i').count()) === 6 && (await page.locator('#pdots i.next').count()) === 1 && (await page.locator('#pdots i.on').count()) === 0);
  check('#35 pattern: empty basket to start', (await page.textContent('#pbasket .bn')) === '0');
  await page.click('#pchoices .choice[data-ok="0"]'); await page.waitForTimeout(300);
  check('#35 pattern: a wrong pick changes nothing', (await page.textContent('#pbasket .bn')) === '0' && (await page.evaluate(() => localStorage.getItem('mojia.patGame'))) === '0');
  for (let i = 0; i < 6; i++) {
    await page.waitForSelector('#pchoices .choice[data-ok="1"]');
    await page.click('#pchoices .choice[data-ok="1"]');
    await page.waitForTimeout(300);
    if (i === 0) { await page.waitForTimeout(900); check('#35 pattern: each game drops a fruit or veggie into the basket', (await page.textContent('#pbasket .bn')) === '1' && (await page.locator('#pdots i.on').count()) === 1); }
    if (i === 2) { check('#35 pattern: game 3 sends a friend running across', (await page.locator('#s-pattern .prun').count()) === 1 && (await page.locator('#pdots i.on').count()) === 3 && await page.isHidden('#preward')); await page.screenshot({ path: path.join(SHOTS, 'pattern-halfway-390.png') }); }
    if (i === 5) { await page.waitForTimeout(400); check('#35 pattern: sixth dot sets off the party', await page.locator('#pdots.full').count() === 1 && (await page.locator('#s-pattern .confetti').count()) > 0); }
    if (i < 5) await page.waitForTimeout(1000);
  }
  await page.waitForSelector('#preward:not(.hidden)', { timeout: 5000 });
  const txt = await page.textContent('#preward');
  check('#35 pattern: level 1 gives the bronze medal and shows the basket', /bronze medal/.test(txt) && (await page.locator('#preward .pmedals span.got').count()) === 1 && /🧺/.test(txt), txt.slice(0, 80));
  await page.screenshot({ path: path.join(SHOTS, 'pattern-reward-390.png') });
  check('#35 pattern: progress stays on the device', (await page.evaluate(() => localStorage.getItem('mojia.patGame'))) === '6');
  await page.waitForSelector('#preward.hidden', { state: 'attached', timeout: 6000 });
  check('#35 pattern: level 2 is AAB, still 2 choices', (await page.textContent('#plevel')) === 'World 1 · Level 2' && (await page.locator('#pchoices .choice').count()) === 2);
  await page.reload(); await page.click('#splash'); await page.click('[data-go="pattern"]'); await page.waitForTimeout(800);
  check('#35 pattern: progress survives a reopen', (await page.textContent('#plevel')) === 'World 1 · Level 2' && (await page.textContent('#pbasket .bn')) === '6');
  await ctx.close();
}
{
  // An old saved streak maps onto the new levels; level 6 gives the crown and the world badge; world 4 has a gap in the middle
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', '1'); localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); localStorage.setItem('mojia.patStreak', '20'); });
  await page.goto(base + '/play/');
  await page.click('#splash'); await page.click('[data-go="pattern"]'); await page.waitForTimeout(800);
  check('#35 pattern: old streak 20 maps to 15 games (World 1 level 3, game 4)', (await page.evaluate(() => localStorage.getItem('mojia.patGame'))) === '15' && (await page.textContent('#plevel')) === 'World 1 · Level 3' && (await page.locator('#pdots i.on').count()) === 3);
  await page.evaluate(() => localStorage.setItem('mojia.patGame', '35'));
  await page.reload(); await page.click('#splash'); await page.click('[data-go="pattern"]'); await page.waitForTimeout(800);
  await page.click('#pchoices .choice[data-ok="1"]');
  await page.waitForSelector('#preward:not(.hidden)', { timeout: 5000 });
  const t6 = await page.textContent('#preward');
  check('#35 pattern: level 6 gives the crown plus the unicorn badge, then a new world', /crown/.test(t6) && /unicorn badge/.test(t6) && /New world next/.test(t6) && (await page.locator('#preward .pworld span.got').count()) === 1, t6.slice(0, 120));
  await page.screenshot({ path: path.join(SHOTS, 'pattern-world-390.png') });
  await page.waitForSelector('#preward.hidden', { state: 'attached', timeout: 6000 });
  check('#35 pattern: World 2 starts with an empty basket and 3 choices', (await page.textContent('#plevel')) === 'World 2 · Level 1' && (await page.textContent('#pbasket .bn')) === '0' && (await page.locator('#pchoices .choice').count()) === 3);
  await page.evaluate(() => localStorage.setItem('mojia.patGame', String(36 * 3)));
  await page.reload(); await page.click('#splash'); await page.click('[data-go="pattern"]'); await page.waitForTimeout(800);
  const g = await page.evaluate(() => { const cells = [...document.querySelectorAll('#prow .pc')]; const i = cells.findIndex((c) => c.id === 'pslot'); return { i, n: cells.length }; });
  check('#35 pattern: World 4 puts the gap in the middle with 4 choices', g.i > 0 && g.i < g.n - 1 && (await page.locator('#pchoices .choice').count()) === 4, JSON.stringify(g));
  await page.click('#pchoices .choice[data-ok="1"]'); await page.waitForTimeout(400);
  check('#35 pattern: the right answer fills the middle gap', (await page.textContent('#pslot')).length > 0);
  check('#35 pattern: no errors', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

// 9e2. play settings from the admin page apply on the next open
{
  const { ctx, page } = await newPage();
  await page.route('**/.netlify/functions/settings', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"first_visit_minutes":20,"daily_minutes":3,"daily_reset":"04:00"}' }));
  await page.goto(base + '/play/');
  await page.waitForTimeout(700);
  const first = (await page.locator('#s-home [data-chip]').textContent()).trim();
  await page.reload(); await page.waitForTimeout(700);
  const second = (await page.locator('#s-home [data-chip]').textContent()).trim();
  check('play: server settings apply on the next open (15:00 then 20:00)', /^15:0\d|^14:5\d/.test(first) && /^20:0\d|^19:5\d/.test(second), first + ' -> ' + second);
  await ctx.close();
}

// 9f. admin page: sign in with an emailed code, then passes, codes, support, settings, services
{
  const { ctx, page } = await newPage({ viewport: { width: 1024, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  let signedIn = false; const calls = [];
  page.on('dialog', (d) => d.accept(/Send the code email/.test(d.message()) ? 'real.parent@example.com' : 'note from test'));
  await page.route('**/.netlify/functions/admin-login', (r) => {
    const m = r.request().method(); const b = m === 'POST' ? r.request().postDataJSON() : {};
    if (m === 'GET') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signed_in: signedIn }) });
    if (b.step === 'send') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"11111111-1111-4111-8111-111111111111"}' });
    if (b.step === 'verify') { if (b.code === '123 456') { signedIn = true; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); } return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"That code did not work. Check it, or send a new one."}' }); }
    signedIn = false; r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const pass = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code_last4: 'AB12', prefix: 'MOJI', kind: '48h', source: 'stripe', email: 'parent@example.com', stripe_session_id: 'cs_test_x1', amount_cents: 150, created_at: new Date().toISOString(), ends_at: new Date(Date.now() + 3600e3).toISOString(), device_limit: 5, status: 'active', note: null, devices: 2 };
  const AN = await analyticsSamples();
  const tellBodies = []; const bodiesBy = {};
  await page.route('**/.netlify/functions/admin-api', (r) => {
    const b = r.request().postDataJSON(); calls.push(b.action); if (/^passes\.(add48|forever)$/.test(b.action)) tellBodies.push(b); bodiesBy[b.action] = b;
    if (signedIn && /^(analytics|campaigns)\./.test(b.action)) {
      if (b.action === 'campaigns.create' && !/^[a-z0-9][a-z0-9-]{1,23}$/.test(b.label || '')) return r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Use 2 to 24 lowercase letters, numbers or dashes for the label."}' });
      const made = b.action === 'campaigns.create' ? { campaigns: [{ ...AN.campaigns.campaigns[0], label: b.label, name: b.name, open: 0, play: 0, gift: 0, pass48: 0, forever: 0, cities: [], rolls: {}, daily: [{ d: AN.campaigns.campaigns[0].daily.at(-1).d, n: 0 }], avgDays: null }, ...AN.campaigns.campaigns] } : null;
      const o = { 'analytics.live': AN.live, 'analytics.history': b.range === 1 ? AN.history1 : b.range === 90 ? AN.history90 : AN.history, 'campaigns.list': AN.campaigns, 'campaigns.create': made, 'campaigns.active': AN.campaigns }[b.action];
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    }
    if (!signedIn) return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Please sign in."}' });
    const out = { 'passes.list': { passes: [pass] }, 'passes.note': { pass: { ...pass, note: b.note } }, 'passes.add48': { pass: { ...pass, ends_at: new Date(Date.now() + 49 * 3600e3).toISOString() }, tell: b.skip_email ? { email: 'skipped' } : { email: 'sent', to: 'p•••@example.com' } },
      'passes.batches': { batches: [{ label: 'in-fair-oct', name: 'in-fair-oct', note: 'Busy table', made: new Date().toISOString(), codes: 30, cards: 10, used: 12, pct: 40, avgDays: 2.5, bought: 3 }] },
      'codes.labels': { labels: ['in-fair-oct', 'lincoln-elem'] }, 'campaigns.note': { ok: true },
      'passes.forever': { pass: { ...pass, kind: 'forever', ends_at: null, email: null, source: 'gift', stripe_session_id: null }, tell: { email: 'none', share: 'Good news: your Mojialand pass is Forever now. Open Mojialand on each phone or tablet and Forever shows up.' } },
      'codes.create': { code: 'GIFT-ABCD-EFGH-JKMN', pass: {} }, 'passes.code': { code: 'MOJI-ABCD-EFGH-JKMN', link: 'https://mojialand.com/r/MOJIABCDEFGHJKMN' }, 'passes.email': b.to === 'real.parent@example.com' ? { pass, sent: true } : null, 'passes.refund': { pass: { ...pass, status: 'refunded' } }, 'codes.batch': { codes: Array.from({ length: b.count }, (_, i) => ({ code: 'GIFT-B' + String(i).padStart(3, '0') + '-EFGH-JKMN', id: 'id' + i })) }, 'support.list': { messages: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'mom@example.com', topic: 'pass', message: 'Code not working\n\nCode ending AB12: pass ...', created_at: new Date().toISOString(), status: 'open' }] },
      'support.set': { ok: true }, 'settings.get': { settings: [{ key: 'daily_minutes', value: 3, help: 'Free play each day.' }, { key: 'daily_reset', value: '04:00', help: 'Reset time.' }] }, 'settings.set': { ok: true }, 'alerts.get': { ready: true, publicKey: 'BAAA', mode: 'each', phones: [], today: 'No new players, no gift codes used.' }, 'alerts.mode': { ok: true, mode: b.mode } }[b.action];
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out || { error: 'Unknown action.' }) });
  });
  await page.goto(base + '/admin/');
  await page.waitForSelector('#vLogin:not([hidden])');
  check('admin: sign-in screen first, no data calls', await page.isVisible('#lSendBtn') && calls.length === 0);
  await page.click('#lSendBtn');
  await page.waitForSelector('#lVerify:not([hidden])');
  await page.fill('#lCode', '000000'); await page.click('#lGo');
  await page.waitForFunction(() => document.querySelector('#lErr2').textContent.length > 0);
  check('admin: wrong code shows the server message', /did not work/.test(await page.textContent('#lErr2')));
  await page.fill('#lCode', '123 456'); await page.click('#lGo');
  await page.waitForSelector('#vApp:not([hidden])');
  await page.waitForSelector('#pList .item');
  check('admin: passes list after sign-in', /parent@example\.com/.test(await page.textContent('#pList')) && /2 of 5 devices/.test(await page.textContent('#pList')));
  await page.click('#pList [data-act="note"]');
  await page.waitForFunction(() => /note from test/.test(document.querySelector('#pList').textContent));
  check('admin: note saved through prompt', true);
  await page.click('#pList [data-act="passes.code"]');
  await page.waitForSelector('#pList .codebox');
  check('admin: Show code shows the full paid code with copy buttons', /MOJI-ABCD-EFGH-JKMN/.test(await page.textContent('#pList .codebox')) && (await page.locator('#pList .codebox [data-copy]').count()) === 2);
  await page.click('#pList [data-act="passes.email"]');
  await page.waitForFunction(() => /Code email sent to real\.parent@example\.com/.test(document.querySelector('#pErr').textContent));
  check('admin: Email code sends to the typed address', calls.includes('passes.email'));
  // Release 1.2 #27: Add 48 hours asks first, emails unless Skip email is checked
  await page.click('#pList [data-act="passes.add48"]');
  await page.waitForSelector('#pList .tellbox');
  check('#27 admin: Add 48 hours asks first and names the masked email; nothing sent yet', /p•••@example\.com/.test(await page.textContent('#pList .tellbox')) && !(await page.isChecked('#pList .skipmail')) && tellBodies.length === 0);
  await page.screenshot({ path: path.join(SHOTS, 'admin-tell-ask.png') });
  await page.click('#pList [data-tell="passes.add48"]');
  await page.waitForFunction(() => /Email sent to p•••@example\.com/.test(document.querySelector('#pList').textContent));
  check('#27 admin: confirm sends with skip_email false and shows the confirm line', tellBodies.length === 1 && tellBodies[0].skip_email === false);
  await page.click('#pList [data-act="passes.add48"]');
  await page.check('#pList .tellbox .skipmail');
  await page.click('#pList [data-tell="passes.add48"]');
  await page.waitForFunction(() => /No email sent/.test(document.querySelector('#pList').textContent));
  check('#27 admin: Skip email sends skip_email true', tellBodies.length === 2 && tellBodies[1].skip_email === true);
  await page.click('#pList [data-act="passes.add48"]'); await page.click('#pList [data-tell="cancel"]');
  check('#27 admin: Cancel closes the ask without a call', tellBodies.length === 2 && (await page.locator('#pList .tellbox').count()) === 0);
  // Release 1.2 #2: Passes tabs, sort, Campaigns and schools; iPhone width keeps cards inside their border
  await page.setViewportSize({ width: 390, height: 844 });
  const over = await page.evaluate(() => [...document.querySelectorAll('#pList .item')].some((i) => i.scrollWidth > i.clientWidth + 1 || i.getBoundingClientRect().right > document.querySelector('#pList').getBoundingClientRect().right + 1));
  check('#2 admin: pass cards fit inside their border at 390 px', !over);
  await page.screenshot({ path: path.join(SHOTS, 'admin-passes-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.click('#pTabs [data-ptab="active"]');
  await page.waitForFunction(() => document.querySelector('#pList .item'));
  check('#2 admin: Active tab asks for active passes, most recently turned on first', bodiesBy['passes.list'].tab === 'active' && bodiesBy['passes.list'].sort === 'on' && (await page.inputValue('#pSort')) === 'on');
  await page.click('#pTabs [data-ptab="gifts"]'); await page.waitForTimeout(150);
  check('#2 admin: Gifts tab', bodiesBy['passes.list'].tab === 'gifts');
  await page.selectOption('#pSort', 'ends'); await page.waitForTimeout(150);
  check('#2 admin: sort menu sends Ends soonest', bodiesBy['passes.list'].sort === 'ends');
  await page.click('#pTabs [data-ptab="camps"]');
  await page.waitForSelector('#pList [data-label="in-fair-oct"]');
  check('#2 admin: Campaigns and schools shows one row per batch with counts', /30 codes · 10 cards · 12 used · 2.5 days from making to use · 3 passes bought after/.test(await page.textContent('#pList')) && /40% used/.test(await page.textContent('#pList')) && await page.isHidden('#pSortL'));
  await page.screenshot({ path: path.join(SHOTS, 'admin-campaigns.png') });
  await page.click('#pList [data-batch="view"]');
  await page.waitForSelector('#pBatchHead:not([hidden])');
  check('#2 admin: tapping a batch lists its codes', bodiesBy['passes.list'].batch === 'in-fair-oct' && /Codes in in-fair-oct/.test(await page.textContent('#pBatchHead')));
  await page.click('#pBack'); await page.waitForSelector('#pList [data-label]');
  await page.click('#pList [data-batch="note"]'); await page.waitForTimeout(200);
  check('#2 admin: batch note saves', bodiesBy['campaigns.note'] && bodiesBy['campaigns.note'].label === 'in-fair-oct' && bodiesBy['campaigns.note'].note === 'note from test');
  await page.click('#pTabs [data-ptab="all"]'); await page.waitForSelector('#pList .item[data-id]');
  check('admin: search hint names Hide My Email', /Hide My Email/.test(await page.getAttribute('#pq', 'placeholder')));
  check('admin: Refund button on a Stripe pass', await page.isVisible('#pList [data-act="passes.refund"]'));
  await page.click('#pList [data-act="passes.refund"]');
  await page.waitForFunction(() => /refunded/.test(document.querySelector('#pList .pill').textContent));
  check('admin: refund marks the pass refunded and hides the button', (await page.locator('#pList [data-act="passes.refund"]').count()) === 0);
  await page.click('#pList [data-act="passes.forever"]');
  await page.click('#pList [data-tell="passes.forever"]');
  await page.waitForSelector('#pList .tellbox .msg');
  check('#27 admin: no email on file shows the message with Share and Copy', /Forever now/.test(await page.textContent('#pList .tellbox .msg')) && await page.isVisible('#pList [data-sharemsg]') && await page.isVisible('#pList .tellbox [data-copy]'));
  await page.screenshot({ path: path.join(SHOTS, 'admin-tell-share.png') });
  await page.screenshot({ path: path.join(SHOTS, 'admin-passes.png') });
  await page.click('[data-tab="codes"]');
  await page.waitForSelector('#cLabels [data-label="lincoln-elem"]');
  await page.click('#cLabels [data-label="lincoln-elem"]');
  check('#2 admin: last labels offered as taps fill the batch label', (await page.inputValue('#cBatch')) === 'lincoln-elem');
  check('#2 admin: batch label rule says event or school, never a family or a child (Security R1)', /Name the event or the school, never a family or a child\./.test(await page.textContent('[data-panel="codes"]')));
  await page.fill('#cBatch', '');
  await page.click('#cGo');
  await page.waitForSelector('#cOut:not([hidden])');
  check('admin: gift code shown once with a /r/ link', (await page.textContent('#cCode')) === 'GIFT-ABCD-EFGH-JKMN' && (await page.getAttribute('#cLink', 'href')).endsWith('/r/GIFTABCDEFGHJKMN'));
  check('admin: share row with Text and Email links carrying the code', /GIFT-ABCD-EFGH-JKMN/.test(decodeURIComponent(await page.getAttribute('#cSms', 'href'))) && /r\/GIFTABCDEFGHJKMN/.test(decodeURIComponent(await page.getAttribute('#cMail', 'href'))) && await page.isVisible('#cShare [data-share="share"]'));
  await page.fill('#cBatch', 'lincoln-elem');
  await page.fill('#bCards', '4'); await page.click('#bGo');
  await page.waitForSelector('#bOut:not([hidden])');
  check('admin: cards batch makes 3 codes per card', (await page.locator('#bList > div').count()) === 12 && /12 codes made, 4 cards/.test(await page.textContent('#bOk')));
  const sheet = await page.evaluate(() => ({ cards: document.querySelectorAll('#sheet .bc').length, qrs: [...document.querySelectorAll('#sheet .q img')].filter((i) => i.src.startsWith('data:image/')).length, codes: document.querySelectorAll('#sheet .q code').length }));
  check('admin: print sheet has 4 cards, 12 QR codes, 12 codes', sheet.cards === 4 && sheet.qrs === 12 && sheet.codes === 12, JSON.stringify(sheet));
  check('#2 admin: cards carry the batch label in small print and in the batch call', bodiesBy['codes.batch'].batch === 'lincoln-elem' && (await page.locator('#sheet .blabel').count()) === 4 && /lincoln-elem/.test(await page.textContent('#sheet .blabel')));
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: path.join(SHOTS, 'admin-cards-print.png'), fullPage: true });
  await page.emulateMedia({ media: null });
  await page.screenshot({ path: path.join(SHOTS, 'admin-codes.png') });
  await page.click('[data-tab="support"]');
  await page.waitForSelector('#sList .item');
  check('admin: support inbox lists the message', /mom@example\.com/.test(await page.textContent('#sList')));
  // phone alerts (Release 1.1 #23)
  await page.click('[data-tab="settings"]');
  await page.waitForFunction(() => /Today so far/.test(document.querySelector('#alInfo').textContent));
  check('admin: Phone alerts card with turn on, test, and when to buzz', await page.isVisible('#alOn') && await page.isVisible('#alTest') && (await page.inputValue('#alMode')) === 'each' && /No phones get alerts yet/.test(await page.textContent('#alInfo')));
  await page.selectOption('#alMode', 'daily');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#alOk').textContent));
  check('admin: changing when to buzz saves', calls.includes('alerts.mode'));
  check('admin: page carries a Home Screen manifest', (await page.getAttribute('link[rel=manifest]', 'href')) === '/admin/manifest.webmanifest');
  const man = await page.evaluate(() => fetch('/admin/manifest.webmanifest').then((r) => r.json()));
  const sw = await page.evaluate(() => fetch('/admin/sw.js').then((r) => r.text()));
  check('admin: manifest opens standalone at /admin/; service worker shows pushes', man.display === 'standalone' && man.start_url === '/admin/' && man.scope === '/admin/' && /showNotification/.test(sw) && !/addEventListener\('fetch'/.test(sw));
  await page.screenshot({ path: path.join(SHOTS, 'admin-alerts.png') });
  await page.click('[data-tab="support"]'); await page.waitForSelector('#sList .item');
  await page.click('#sList [data-st="done"]');
  await page.waitForTimeout(300);
  check('admin: mark done calls support.set', calls.includes('support.set'));
  await page.click('[data-tab="settings"]');
  await page.waitForSelector('#stList .item');
  await page.fill('#stList .item[data-key="daily_minutes"] input', '5');
  await page.press('#stList .item[data-key="daily_minutes"] input', 'Tab');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#stOk').textContent));
  check('admin: settings save on change', calls.includes('settings.set'));
  await page.click('[data-tab="services"]');
  check('admin: services tab lists Stripe, Supabase, Resend with links', (await page.locator('#svcList a[href^="https://"]').count()) >= 8 && /Stripe/.test(await page.textContent('#svcList')));
  await page.screenshot({ path: path.join(SHOTS, 'admin-services.png') });
  // Analytics tab
  await page.click('[data-tab="analytics"]');
  await page.waitForSelector('#anLiveMap svg .anBub');
  await page.waitForTimeout(300);
  check('analytics: live counter and map bubbles', Number((await page.textContent('#anTotal')).replace(/,/g, '')) === AN.live.total && (await page.locator('#anLiveMap .anBub').count()) === AN.live.cities.length + AN.live.counties.length && AN.live.cities.length > 0, AN.live.total + ' / ' + AN.live.cities.length + ' + ' + AN.live.counties.length);
  check('analytics: small places show as +N on the state, never by name', !JSON.stringify(AN).includes('Salina') && (await page.locator('#anLiveMap .anRoll').count()) >= 1);
  check('analytics: live boards filled', (await page.locator('#anBusy .anRow').count()) >= 1 && (await page.locator('#anGames .anRow').count()) === 7 && (await page.locator('#anFeed .it').count()) >= 1);
  await page.focus('#anLiveMap .anBub');
  check('analytics: bubble tip shows counts by game', await page.isVisible('#anLiveMap .anTip') && /,\s*MI|,\s*[A-Z]{2}/.test(await page.textContent('#anLiveMap .anTip')));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, 'admin-analytics-live.png'), fullPage: true });
  await page.click('#anViews [data-v="history"]');
  await page.waitForSelector('#anHistMap svg .anBub');
  check('analytics: history tiles, charts and tables', /Plays/.test(await page.textContent('#anKpis')) && (await page.locator('#anOverTime rect').count()) > 5 && (await page.locator('#anHours rect').count()) === 24 && (await page.locator('#anTPlays tbody tr').count()) >= 1);
  await page.fill('#anHour', '9');
  await page.dispatchEvent('#anHour', 'input');
  check('analytics: hour slider replays the day', /By /.test(await page.textContent('#anHourLbl')));
  await page.click('#anRanges [data-r="1"]');
  await page.waitForFunction(() => /by hour today/.test(document.querySelector('#anOtTitle').textContent));
  check('analytics: Today shows plays by hour', calls.filter((c) => c === 'analytics.history').length === 2);
  await page.click('#anRanges [data-r="7"]');
  await page.waitForFunction(() => /per day/.test(document.querySelector('#anOtTitle').textContent));
  check('analytics: usage trend with the week before', (await page.locator('#anTrendPlays polyline.anCur').count()) === 1 && (await page.locator('#anTrendPlays polyline.anPrev').count()) === 1 && /vs the 7 days before/.test(await page.textContent('#anKpis')));
  check('analytics: small towns show as a county bubble', AN.history.counties.some((k) => k.name === 'Oakland') && (await page.locator('#anHistMap .anBub.cty').count()) >= 1, JSON.stringify(AN.history.counties.map((k) => k.name + ' ' + k.total)));
  await page.$eval('#anHistMap path.anState[data-st="MI"]', (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForSelector('#anHistMap path.anCounty');
  await page.waitForTimeout(600);
  check('analytics: tap a state zooms in with its counties and a place list', (await page.locator('#anHistMap path.anCounty').count()) === 83 && /Michigan/.test(await page.textContent('#anHistMap .anCrumbs')) && /Troy/.test(await page.textContent('#anHistPlaces')) && /Small towns in Oakland County/.test(await page.textContent('#anHistPlaces')));
  await page.screenshot({ path: path.join(SHOTS, 'admin-analytics-state.png'), fullPage: false, clip: { x: 0, y: 0, width: 1024, height: 1400 } }).catch(() => {});
  await page.$eval('#anHistMap path.anCounty[data-id="26125"]', (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForFunction(() => /Oakland County, Michigan/.test(document.querySelector('#anHistPlaces').textContent));
  await page.waitForTimeout(600);
  check('analytics: tap a county lists its towns', /Troy/.test(await page.textContent('#anHistPlaces')) && !/Ann Arbor/.test(await page.textContent('#anHistPlaces')));
  await page.locator('#anHistMap').screenshot({ path: path.join(SHOTS, 'admin-analytics-county.png') });
  await page.click('#anHistMap .anBack');
  await page.waitForFunction(() => !/Oakland County, Michigan/.test(document.querySelector('#anHistPlaces').textContent));
  await page.click('#anHistMap .anBack');
  await page.waitForFunction(() => document.querySelectorAll('#anHistMap path.anCounty').length === 0);
  check('analytics: Back returns to the whole US', (await page.textContent('#anHistPlaces')) === '');
  await page.click('#anRanges [data-r="90"]');
  await page.waitForFunction(() => /per week/.test(document.querySelector('#anTrendPlaysT').textContent));
  check('analytics: 90 days groups by week and compares with the 90 days before', /vs the 90 days before/.test(await page.textContent('#anKpis')) && (await page.locator('#anTrendPlays polyline.anPrev').count()) === 1 && await page.isHidden('#anReplayRow'));
  await page.screenshot({ path: path.join(SHOTS, 'admin-analytics-90.png'), fullPage: true });
  await page.click('#anRanges [data-r="7"]');
  await page.waitForFunction(() => /per day/.test(document.querySelector('#anTrendPlaysT').textContent));
  await page.screenshot({ path: path.join(SHOTS, 'admin-analytics-history.png'), fullPage: true });
  await page.click('#anViews [data-v="campaigns"]');
  await page.waitForSelector('#anCamps .anCamp');
  check('analytics: campaign cards with QR codes', (await page.locator('#anCamps .anCamp img[src^="data:image/"]').count()) === 2);
  check('analytics: campaign board funnel', /41/.test(await page.textContent('#anBoardC')) && /1\.5/.test(await page.textContent('#anBoardC')) && (await page.locator('#anCampMap .anBub').count()) === 2);
  await page.fill('#anName', 'Pumpkin Fest Oct!');
  check('analytics: label fills from the name', (await page.inputValue('#anLabel')) === 'pumpkin-fest-oct' && /\?c=pumpkin-fest-oct$/.test(await page.textContent('#anLinkPrev')));
  await page.click('#anMakeBtn');
  await page.waitForFunction(() => /Pumpkin Fest Oct!/.test(document.querySelector('#anBoardC').textContent));
  check('analytics: new campaign opens its board', /No opens yet/.test(await page.textContent('#anBoardC')));
  await page.fill('#anName', 'x'); await page.fill('#anLabel', '');
  await page.click('#anMakeBtn');
  await page.waitForFunction(() => document.querySelector('#anMakeErr').textContent.length > 0);
  check('analytics: bad label shows the server message', /lowercase/.test(await page.textContent('#anMakeErr')));
  await page.click('#anPrintC').catch(() => {});
  const csheet = await page.evaluate(() => ({ cards: document.querySelectorAll('#sheet .bc.camp').length, qr: [...document.querySelectorAll('#sheet .bc.camp .r img')].every((i) => i.src.startsWith('data:image/')) }));
  check('analytics: campaign print sheet has 10 QR cards', csheet.cards === 10 && csheet.qr, JSON.stringify(csheet));
  await page.screenshot({ path: path.join(SHOTS, 'admin-analytics-campaigns.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#anViews [data-v="live"]');
  await page.waitForTimeout(400);
  check('analytics: no sideways scroll at phone width', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(SHOTS, 'admin-analytics-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.click('[data-tab="services"]');
  await page.click('#outBtn');
  await page.waitForSelector('#vLogin:not([hidden])');
  check('admin: sign out returns to the sign-in screen', await page.isHidden('#vApp'));
  check('admin: no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 10. play normal load: splash, no foreign requests, no CSP errors
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/play/');
  await page.waitForTimeout(600);
  check('play normal load shows welcome screen', await page.isVisible('#splash'));
  check('welcome screen shows the 3D logo', (await page.getAttribute('#splash img.sp-word', 'src')) === '/logo/logo-3d-1000.webp' && await page.isVisible('#splash img.sp-word'));
  await page.screenshot({ path: path.join(SHOTS, 'welcome-3d-390.png') });
  check('Welcome screen switch is gone', (await page.locator('#replaySplash').count()) === 0);
  const order = await page.evaluate(() => [...document.querySelectorAll('#s-gate > *')].map((e) => e.id || e.className.split(' ')[0]));
  const ix = (k) => order.indexOf(k);
  check('Grown-ups order: pass rows, Home Screen, settings, promise last', ix('pwGuList') < ix('pwHS') && ix('pwHS') < ix('banner') && ix('note') === order.length - 1, order.join(','));
  check('play: zero third-party requests', page.reqs.every((u) => u.startsWith(base) || u.startsWith('data:')));
  check('play: no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 10a. new-player alert (Release 1.1 #23): one bare ping the first time the game starts on a new device
{
  const { ctx, page } = await newPage();
  const pings = [];
  await page.route('**/api/ping', (r) => { pings.push(JSON.parse(r.request().postData() || 'null')); r.fulfill({ status: 204 }); });
  await page.goto(base + '/play/');
  await page.waitForTimeout(300);
  const firsts = () => pings.filter((p) => p && p.e === 'first');
  check('alerts: a new device sends one first-start ping with nothing else in it', firsts().length === 1 && JSON.stringify(firsts()[0]) === '{"e":"first"}', JSON.stringify(pings));
  await page.reload(); await page.waitForTimeout(300);
  check('alerts: the same device never sends it again', firsts().length === 1);
  await ctx.close();
  const b = await newPage();
  const p2 = [];
  await b.page.route('**/api/ping', (r) => { p2.push(JSON.parse(r.request().postData() || 'null')); r.fulfill({ status: 204 }); });
  await b.page.addInitScript(() => { localStorage.setItem('mojia.welcomed', 'true'); });
  await b.page.goto(base + '/play/'); await b.page.waitForTimeout(300);
  check('alerts: a device that played before the update is not counted as new', !p2.some((p) => p && p.e === 'first'));
  await b.ctx.close();
}

// 10b. play counts: QR label saved and counted once, game open and close pings carry no personal data
{
  const { ctx, page } = await newPage();
  const pings = [];
  await page.route('**/api/ping', (r) => { pings.push(JSON.parse(r.request().postData() || 'null')); r.fulfill({ status: 204 }); });
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/?c=mi-troy-lib-sep');
  await page.waitForTimeout(300);
  const camp = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.camp') || 'null'));
  check('counts: QR label saved on the device with a time only', camp && camp.l === 'mi-troy-lib-sep' && Object.keys(camp).join() === 'l,t', JSON.stringify(camp));
  check('counts: label leaves the address bar', !/c=/.test(page.url()));
  check('counts: first QR open counted once', pings.filter((p) => p && p.e === 'camp').length === 1);
  await page.click('#splash');
  await page.click('[data-go="draw"]');
  await page.waitForSelector('#s-draw:not(.hidden)');
  await page.waitForTimeout(200);
  const open = pings.find((p) => p && p.e === 'open');
  check('counts: game open sends game, mode and the campaign once', open && open.g === 'draw' && open.m === 'web' && open.c === 'mi-troy-lib-sep' && open.cp === 1 && Object.keys(open).length === 5, JSON.stringify(open));
  await page.click('#s-draw [data-go="home"]');
  await page.waitForTimeout(200);
  const close = pings.find((p) => p && p.e === 'close');
  check('counts: leaving a game sends a play-length range, not a time', close && close.g === 'draw' && close.b === 0 && !('t' in close), JSON.stringify(close));
  await page.click('#s-home [data-go="match"]');
  await page.waitForTimeout(200);
  check('counts: later games do not credit the campaign again', pings.filter((p) => p && p.e === 'open').length === 2 && !pings.filter((p) => p && p.e === 'open')[1].c);
  check('counts: pings carry no device or pass data', !JSON.stringify(pings).match(/device|token|MOJI-|restore/i));
  // Release 1.3: Share Party and Feelings Faces count like the other games
  for (const g of ['share', 'feelings']) {
    await page.evaluate(() => { const b = document.querySelector('.screen:not(.hidden) [data-go="home"]'); if (b) b.click(); }); await page.waitForTimeout(200);
    await page.evaluate((id) => document.querySelector('#s-home [data-go="' + id + '"]').click(), g); await page.waitForTimeout(300);
    check('counts 1.3: opening ' + g + ' sends one open ping with the game id', pings.filter((p) => p && p.e === 'open' && p.g === g).length === 1);
  }
  await page.goto(base + '/play/?c=mi-troy-lib-sep');
  await page.waitForTimeout(200);
  check('counts: scanning the same card again counts nothing', pings.filter((p) => p && p.e === 'camp').length === 1);
  check('counts: no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  const pings = [];
  await page.route('**/api/ping', (r) => { pings.push(JSON.parse(r.request().postData() || 'null')); r.fulfill({ status: 204 }); });
  await page.goto(base + '/?c=oh-pumpkin-sep');
  await page.waitForTimeout(300);
  check('counts: website QR link saves the label and counts the open', pings.length === 1 && pings[0].e === 'camp' && pings[0].c === 'oh-pumpkin-sep' && !/c=/.test(page.url()) && JSON.parse(await page.evaluate(() => localStorage.getItem('mojia.camp'))).l === 'oh-pumpkin-sep');
  await page.goto(base + '/?c=BAD LABEL<script>');
  await page.waitForTimeout(200);
  check('counts: a bad label counts nothing', pings.length === 1);
  check('counts: website no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 11. Emoji Draw: tools, marks, Undo, picture-only Clear check, color a friend, fridge, Save to Photos behind the gate
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/');
  await page.click('#splash');
  check('draw: home has a Draw tile', await page.isVisible('#s-home [data-go="draw"]'));
  await page.screenshot({ path: path.join(SHOTS, 'draw-home-390.png') });
  await page.click('[data-go="draw"]');
  await page.waitForSelector('#s-draw:not(.hidden)');
  await page.waitForTimeout(300);
  check('draw: Draw opens straight to a blank canvas, no page picker', await page.isHidden('#dfriend'));
  check('draw: coloring book button pulses on the first visit', /\bbookpulse\b/.test(await page.getAttribute('#dbook', 'class')) && (await page.evaluate(() => getComputedStyle(document.querySelector('#dbook')).animationName)) === 'dbookhint');
  check('draw: book button shows a unicorn page, no words', (await page.locator('#dbook .dbthumb svg path').count()) > 3 && ((await page.textContent('#dbook')).replace(/[\s🖍️️]/gu, '')) === '');
  await page.screenshot({ path: path.join(SHOTS, 'draw-open-390.png') });
  const ink = () => page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  const line = () => page.evaluate(() => { const c = document.querySelector('#dline'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  const box = await page.locator('#dmain').boundingBox();
  const setSize = async (t) => { await tools(); const s = await page.locator('#dslider').boundingBox(); await page.mouse.click(s.x + 14 + t * (s.width - 28), s.y + s.height / 2); };
  const prevInk = () => page.evaluate(() => { const c = document.querySelector('#dprev'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, h = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { n++; h = (h * 31 + d[i - 3] + d[i - 2] * 3 + d[i - 1] * 7) >>> 0; } return { n, h }; });
  // Release 1.2 #30: the tools panel slides over the canvas. Pick tools with the panel open; draw with it hidden.
  const isFull = () => page.evaluate(() => document.querySelector('#s-draw').classList.contains('dfull'));
  const tools = async () => { if (await isFull()) { await page.click('#dtab'); await page.waitForTimeout(380); } };
  const hideTools = async () => { if (!(await isFull())) { await page.click('#dhide'); await page.waitForTimeout(380); } };
  const stroke = async (x0, y0, x1, y1, steps = 12) => { await hideTools(); await page.mouse.move(box.x + x0, box.y + y0); await page.mouse.down(); for (let i = 1; i <= steps; i++) await page.mouse.move(box.x + x0 + (x1 - x0) * i / steps, box.y + y0 + (y1 - y0) * i / steps); await page.mouse.up(); };
  check('draw: thirteen tools (eraser included), one size slider with a preview card, twelve colors with your own color last', (await page.locator('#dtools .dtool').count()) === 13 && (await page.locator('#dslider[role=slider]').count()) === 1 && (await page.locator('#dprev').count()) === 1 && (await page.locator('#dswatches .dsw').count()) === 12 && (await page.locator('#dswatches .dsw:last-child#dcustom input[type=color]').count()) === 1);
  const small = await page.evaluate(() => [...document.querySelectorAll('#s-draw button')].filter((b) => b.offsetParent && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44)).map((b) => b.id || b.className || b.getAttribute('aria-label')));
  check('draw: every visible button is at least 44 px', small.length === 0, small.join(','));
  const pal = await page.evaluate(() => [...document.querySelectorAll('#dswatches .dsw:not(.dswc) i')].map((b) => getComputedStyle(b).backgroundColor));
  check('draw: palette is the brand colors plus red, orange, brown, and peach', pal.join('|') === 'rgb(113, 56, 209)|rgb(255, 95, 162)|rgb(244, 86, 92)|rgb(255, 138, 61)|rgb(255, 200, 61)|rgb(114, 214, 154)|rgb(77, 188, 236)|rgb(167, 102, 63)|rgb(255, 203, 164)|rgb(48, 37, 74)|rgb(255, 255, 255)', pal.join('|'));
  check('draw: colors sit in two rows of 6', await page.evaluate(() => { const t = [...document.querySelectorAll('#dswatches .dsw')].map((b) => Math.round(b.getBoundingClientRect().top)); return new Set(t).size === 2 && t.filter((y) => y === t[0]).length === 6; }));
  await page.evaluate(() => { const i = document.querySelector('#dcustomIn'); i.value = '#12a4b6'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  check('draw: your own color becomes the drawing color and stays on the device', await page.evaluate(() => document.querySelector('#dcustom').classList.contains('on') && document.querySelector('#dcustom').classList.contains('set') && localStorage.getItem('mojia.drawCustom') === '"#12a4b6"'));
  await tools(); await page.click('#dswatches .dsw:nth-child(1)');
  check('draw: canvas starts empty', (await ink()) === 0);
  await stroke(40, 60, 250, 90);
  const a1 = await ink();
  check('draw: crayon leaves a mark', a1 > 500, String(a1));
  await tools(); await page.click('#dtools [data-tool="marker"]'); await tools(); await page.click('#dswatches .dsw:nth-child(2)'); await stroke(40, 130, 250, 150);
  const a2 = await ink();
  check('draw: marker adds a mark', a2 > a1, a2 + ' > ' + a1);
  await tools(); await page.click('#dtools [data-tool="paint"]'); await stroke(40, 200, 250, 220);
  const a3 = await ink();
  check('draw: paint brush adds a wide mark', a3 - a2 > 4000, String(a3 - a2));
  await tools(); await page.click('#dtools [data-tool="trail"]');
  check('draw: emoji tools swap colors for the emoji tray', await page.isVisible('#dtray') && await page.isHidden('#dswatches'));
  await stroke(40, 280, 300, 290, 20);
  const a4 = await ink();
  check('draw: emoji brush leaves a trail', a4 > a3, String(a4 - a3));
  await tools(); await page.click('#dtools [data-tool="stamp"]'); await tools(); await page.click('#dtray .tile:nth-child(2)');
  await page.mouse.click(box.x + 200, box.y + 360);
  const a5 = await ink();
  check('draw: stamp drops one emoji', a5 > a4, String(a5 - a4));
  check('draw: stamp tool shows the picked emoji', (await page.textContent('#dtools [data-tool="stamp"]')).includes('❤️'));
  await page.screenshot({ path: path.join(SHOTS, 'draw-marks-390.png') });
  await page.click('#dundo');
  check('draw: Undo removes the last mark', (await ink()) === a4, String(await ink()));
  await page.click('#dredo');
  check('draw: Redo puts the mark back', (await ink()) === a5, String(await ink()));
  await page.click('#dundo');
  await tools(); await page.evaluate(() => { document.querySelector('#dtools').scrollLeft = 0; });
  const tlay = await page.evaluate(() => { const t = document.querySelector('#dtools'), tb = t.getBoundingClientRect(); return { ox: getComputedStyle(t).overflowX, tb: [tb.left, tb.right], k: [...t.children].map((b) => { const x = b.getBoundingClientRect(); return [Math.round(x.left), Math.round(x.right), Math.round(x.top)]; }) }; });
  check('draw: undo and redo sit in the top bar; phone tools sit in one sideways row with the next tool peeking', await page.evaluate(() => { const u = document.querySelector('#dundo').getBoundingClientRect(), r = document.querySelector('#dredo').getBoundingClientRect(), t = document.querySelector('#dtools'), tb = t.getBoundingClientRect(), k = [...t.children].map((b) => b.getBoundingClientRect()); return document.querySelector('#s-draw .bar').contains(document.querySelector('#dundo')) && Math.abs(u.top - r.top) < 2 && getComputedStyle(t).overflowX === 'auto' && Math.max(...k.map((x) => x.top)) - Math.min(...k.map((x) => x.top)) < 4 && k.filter((x) => x.right <= tb.right).length >= 5 && k.some((x) => x.left < tb.right && x.right > tb.right); }), JSON.stringify(tlay));
  check('#30 draw: the tools panel sits over the top of the canvas, the canvas runs from the top bar to the help row', await page.evaluate(() => { const st = document.querySelector('#dstage').getBoundingClientRect(), p = document.querySelector('#dpanel').getBoundingClientRect(), bar = document.querySelector('#s-draw .bar').getBoundingClientRect(), help = document.querySelector('#s-draw .helprow').getBoundingClientRect(); return p.top >= st.top && p.top < st.top + 20 && p.bottom < st.bottom && st.top - bar.bottom < 16 && help.top - st.bottom < 16; }));
  // Clear check: keep, time out, then clear, then Undo restores
  await page.click('#dclear'); await page.waitForTimeout(350);
  check('draw: Clear opens the picture check with a snapshot', await page.isVisible('#dconfirm') && /^data:image\/jpeg/.test(await page.getAttribute('#dcimg', 'src')));
  check('draw: Clear check has no words to read', ((await page.textContent('#dconfirm')).replace(/[\s🗑️↩️️]/gu, '')) === '', await page.textContent('#dconfirm'));
  await page.screenshot({ path: path.join(SHOTS, 'draw-clear-check-390.png') });
  await page.click('#dcno');
  check('draw: green arrow keeps the drawing', await page.isHidden('#dconfirm') && (await ink()) === a4);
  await page.click('#dclear'); await page.waitForTimeout(5400);
  check('draw: the check closes after 5 seconds and keeps the drawing', await page.isHidden('#dconfirm') && (await ink()) === a4);
  await page.click('#dclear'); await page.click('#dcyes'); await page.waitForTimeout(800);
  check('draw: red trash clears', (await ink()) === 0);
  check('draw: after Clear the canvas stays open, no page picker', await page.isHidden('#dfriend'));
  await page.click('#dundo');
  check('draw: Undo brings back a cleared drawing', (await ink()) === a4, String(await ink()));
  await page.click('#dclear'); await page.click('#dcyes'); await page.waitForTimeout(800);
  await page.click('#dclear');
  check('draw: Clear on an empty page does nothing', await page.isHidden('#dconfirm'));
  // round 2 tools: pen, sizes, rainbow, glitter, eraser
  await tools(); await page.click('#dtools [data-tool="pen"]'); await tools(); await page.click('#dswatches .dsw:nth-child(6)');
  await stroke(40, 60, 300, 60);
  const pen1 = await ink();
  check('draw: pen draws a thin line', pen1 > 200 && pen1 < 6000, String(pen1));
  const pv0 = await prevInk();
  await setSize(1); // big
  const pv1 = await prevInk();
  check('draw: dragging the slider to the end picks the biggest size', (await page.getAttribute('#dslider', 'aria-valuenow')) === '100');
  check('draw: preview card draws a sample, thicker when the size goes up', pv0.n > 50 && pv1.n > pv0.n, pv0.n + ' -> ' + pv1.n);
  await stroke(40, 110, 300, 110);
  const pen2 = await ink();
  check('draw: big pen draws wider than medium', pen2 - pen1 > pen1 * 1.2, pen1 + ' then +' + (pen2 - pen1));
  await setSize(0); // small
  check('draw: slider left end picks the smallest size', (await page.getAttribute('#dslider', 'aria-valuenow')) === '0');
  await tools(); await page.click('#dtools [data-tool="rainbow"]'); await stroke(40, 170, 300, 170);
  const rb = await page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const hues = new Set(); for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3] > 200) hues.add(Math.round(d[i] / 64) + ',' + Math.round(d[i + 1] / 64) + ',' + Math.round(d[i + 2] / 64)); return hues.size; });
  check('draw: rainbow brush lays down many colors', rb >= 6, String(rb));
  const onPal = await page.evaluate(() => { const P = [[244, 86, 92], [255, 138, 61], [255, 200, 61], [114, 214, 154], [77, 188, 236], [113, 56, 209], [255, 95, 162]]; const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let near = 0, all = 0; for (let i = 0; i < d.length; i += 4 * 5) { if (d[i + 3] < 250) continue; all++; if (P.some((p) => Math.abs(p[0] - d[i]) + Math.abs(p[1] - d[i + 1]) + Math.abs(p[2] - d[i + 2]) < 40)) near++; } return all ? near / all : 0; });
  check('draw: rainbow brush walks through the palette colors', onPal > 0.25, onPal.toFixed(2));
  const s0 = await ink();
  await tools(); await page.click('#dtools [data-tool="sprinkles"]'); await stroke(40, 250, 300, 250);
  const sp = await page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, Math.round(236 * 2), c.width, 56).data; const hues = new Set(); for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 220) hues.add(Math.round(d[i] / 64) + ',' + Math.round(d[i + 1] / 64) + ',' + Math.round(d[i + 2] / 64)); return hues.size; });
  check('draw: sprinkles brush tosses many colored bits', (await ink()) > s0 && sp >= 5, String(sp));
  await page.screenshot({ path: path.join(SHOTS, 'draw-sprinkles-390.png') });
  const g0 = await ink();
  await setSize(.5); const pr = await prevInk(); await tools(); await page.click('#dtools [data-tool="glitter"]'); const pg = await prevInk();
  check('draw: preview card changes when the tool changes', pg.n > 20 && pg.h !== pr.h);
  await page.focus('#dslider'); await page.keyboard.press('ArrowRight');
  check('draw: arrow keys move the slider', (await page.getAttribute('#dslider', 'aria-valuenow')) === '60'); await stroke(40, 240, 300, 240);
  check('draw: glitter adds sparkles', (await ink()) > g0, String((await ink()) - g0));
  // ice cream: waffle cone then a scoop on top
  const w0 = await ink();
  await tools(); await page.click('#dtools [data-tool="rainbow"]');
  const offR = await page.evaluate(() => { const e = document.querySelector('#dswatches'); return e.classList.contains('off') && parseFloat(getComputedStyle(e.querySelector('.dsw i')).opacity) < .5; });
  await tools(); await page.click('#dtools [data-tool="eraser"]'); const offE = await page.evaluate(() => document.querySelector('#dswatches').classList.contains('off'));
  await tools(); await page.click('#dtools [data-tool="waffle"]'); const onW = await page.evaluate(() => !document.querySelector('#dswatches').classList.contains('off'));
  check('draw: colors gray out for rainbow and eraser, and stay bright for the waffle cone', offR && offE && onW, JSON.stringify({ offR, offE, onW }));
  await tools(); await page.click('#dswatches .dsw:nth-child(7)'); await stroke(150, 330, 190, 400, 10);
  const waf = await page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let fill = 0, dark = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; const r = d[i], g = d[i + 1], b = d[i + 2]; if (r > 65 && r < 90 && g > 178 && g < 198 && b > 226) fill++; else if (r < 80 && g > 125 && g < 160 && b > 165 && b < 205) dark++; } return { fill, dark }; });
  check('draw: waffle cone draws in the picked color (blue) with a darker crosshatch', (await ink()) > w0 && waf.fill > 300 && waf.dark > 50 && (await page.evaluate(() => document.querySelector('#dtools .dtool.on').dataset.tool)) === 'waffle', JSON.stringify(waf));
  const i0 = await ink();
  await tools(); await page.click('#dtools [data-tool="scoop"]'); await tools(); await page.click('#dswatches .dsw:nth-child(2)'); await stroke(140, 320, 200, 320, 8);
  check('draw: ice cream scoop adds a round scoop', (await ink()) - i0 > 1500, String((await ink()) - i0));
  check('draw: scoop and waffle tools show a picture, no words', ((await page.textContent('#dtools [data-tool="scoop"]')) + (await page.textContent('#dtools [data-tool="waffle"]'))).replace(/[\s🍦🧇️]/gu, '') === '');
  await page.screenshot({ path: path.join(SHOTS, 'draw-icecream-390.png') });
  await tools(); await page.click('#dtools [data-tool="crayon"]'); await tools(); await page.click('#dswatches .dsw:nth-child(1)'); await stroke(40, 320, 300, 320);
  const holes = await page.evaluate(() => { const c = document.querySelector('#dmain'); const k = c.getContext('2d'); const y = Math.round((320 - 8) * 2); const d = k.getImageData(100, y, 400, 6).data; let empty = 0, full = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] < 20) empty++; else full++; } return { empty, full }; });
  check('draw: crayon edge shows paper grain gaps', holes.empty > 150 && holes.full > 150, JSON.stringify(holes));
  await tools(); await page.click('#dtools [data-tool="paint"]'); await stroke(20, 320, 360, 320, 40);
  await page.screenshot({ path: path.join(SHOTS, 'draw-tools2-390.png') });
  const e0 = await ink();
  await tools();
  check('#19 draw: the eraser is a full-size tile in the tool panel, next to the crayon; no eraser in the top bar', (await page.locator('#derase').count()) === 0 && (await page.locator('#dtools .dtool:nth-child(2)[data-tool="eraser"] svg').count()) === 1 && await page.evaluate(() => { const e = document.querySelector('#dtools [data-tool="eraser"]').getBoundingClientRect(), c = document.querySelector('#dtools [data-tool="crayon"]').getBoundingClientRect(); return Math.abs(e.width - c.width) < 2 && Math.abs(e.height - c.height) < 2 && Math.abs(e.top - c.top) < 4; }) && (await page.locator('#s-draw .bar #dundo').count()) === 1 && (await page.locator('#s-draw .bar #dredo').count()) === 1);
  await page.click('#dtools [data-tool="eraser"]');
  check('#19 draw: picked eraser tile lights up like the other tools', /\bon\b/.test(await page.getAttribute('#dtools [data-tool="eraser"]', 'class')) && (await page.locator('#dtools .dtool.on').count()) === 1);
  await stroke(20, 60, 360, 400, 30);
  const e1 = await ink();
  check('draw: eraser removes ink', e1 < e0, e0 + ' -> ' + e1);
  await page.click('#dundo');
  check('draw: Undo brings back erased ink', (await ink()) === e0, String(await ink()));
  // wet sponge smears the paint: pulls color into blank paper, keeps a record for undo and redo
  const sig = () => page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) >>> 0; return h; });
  const below = () => page.evaluate(() => { const c = document.querySelector('#dmain'), k = c.width / c.getBoundingClientRect().width; const d = c.getContext('2d').getImageData(Math.round(150 * k), Math.round(350 * k), Math.round(100 * k), Math.round(40 * k)).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; });
  const sp0 = await sig(), b0 = await below();
  await tools(); await page.click('#dtools [data-tool="sponge"]');
  check('draw: picking the sponge turns the eraser off', !/\bon\b/.test(await page.getAttribute('#dtools [data-tool="eraser"]', 'class')) && /\bon\b/.test(await page.getAttribute('#dtools [data-tool="sponge"]', 'class')));
  await stroke(200, 300, 200, 390, 20);
  const sp1 = await sig(), b1 = await below();
  check('draw: sponge smears paint onto blank paper below the stroke', sp1 !== sp0 && b1 > b0 + 200, b0 + ' -> ' + b1);
  await page.click('#dundo');
  check('draw: Undo removes the smear', (await sig()) === sp0);
  await page.click('#dredo');
  check('draw: Redo puts back the same smear', (await sig()) === sp1);
  await page.screenshot({ path: path.join(SHOTS, 'draw-sponge-390.png') });
  await page.click('#dclear'); await page.waitForTimeout(350); await page.click('#dcyes'); await page.waitForTimeout(800);
  await tools(); await page.click('#dtools [data-tool="crayon"]');
  // color a friend
  await page.click('#dbook');
  check('draw: opening the book stops the pulse for good', !/\bbookpulse\b/.test(await page.getAttribute('#dbook', 'class')) && (await page.evaluate(() => localStorage.getItem('mojia.bookHint'))) === '3');
  check('draw: coloring book shows 36 pages and a blank page', (await page.locator('#dpages .dpage').count()) === 37 && (await page.locator('#dpages .dpage svg').count()) === 36);
  await page.screenshot({ path: path.join(SHOTS, 'draw-friends-390.png') });
  const pgNames = await page.evaluate(() => [...document.querySelectorAll('#dpages .dpage')].map((b) => b.getAttribute('aria-label')));
  check('draw: book starts with the blank page and the unicorn, and has the new treat, sparkle, and animal pages', pgNames[0] === 'Blank page' && pgNames[1] === 'unicorn' && ['ice cream cone', 'cupcake', 'crown', 'rainbow', 'donut', 'kitty', 'sundae', 'castle', 'magic wand', 'diamond', 'dinosaur', 'mermaid tail'].every((n) => pgNames.includes(n)) && new Set(pgNames).size === 37, pgNames.join(','));
  await page.click('#dpages .dpage[aria-label="ice cream cone"]');
  check('draw: ice cream cone outline appears', (await line()) > 1000);
  await page.click('#dbook');
  await page.click('#dpages .dpage[aria-label="smiley"]');
  check('draw: smiley outline appears, crayon selected', (await line()) > 1000 && /on/.test(await page.getAttribute('#dtools [data-tool="crayon"]', 'class')));
  await tools(); await page.click('#dtools [data-tool="paint"]');
  for (let y = 40; y < box.height - 30; y += 18) await stroke(20, y, box.width - 20, y, 8);
  await page.waitForTimeout(200);
  check('draw: coloring the friend sets off the cheer', (await page.getAttribute('#dstage', 'data-cheered')) === 'smiley');
  await page.screenshot({ path: path.join(SHOTS, 'draw-friend-done-390.png') });
  await page.click('#dbook');
  check('draw: finished page gets a gold star in the book', (await page.locator('#dpages .dpage[aria-label="smiley"] .gold').count()) === 1);
  await page.click('#dfriend [data-dclose]');
  // fridge scene (Release 1.1 #20, #25, #31)
  const idb = () => new Promise((res) => { const r = indexedDB.open('mojia', 1); r.onupgradeneeded = () => r.result.createObjectStore('drawings', { keyPath: 'id' }); r.onsuccess = () => { const q = r.result.transaction('drawings').objectStore('drawings').getAll(); q.onsuccess = () => { res(q.result); r.result.close(); }; }; });
  const cv0 = await page.evaluate(() => { const r = document.querySelector('#dmain').getBoundingClientRect(); return r.width + 'x' + r.height; });
  await page.click('#dfridgeBtn');
  check('draw: fridge scene with 9 empty spots, first spot glows', await page.isVisible('#dfridge .fridge') && (await page.locator('#dfslots .fslot.empty').count()) === 9 && (await page.locator('#dfslots .fslot.glow').count()) === 1);
  check('draw: fridge opens full screen on a phone', await page.evaluate(() => { const r = document.querySelector('#dfridge').getBoundingClientRect(); return r.width >= 389 && r.height >= innerHeight - 1 && r.top <= 0; }));
  check('draw: fridge row sits 20 px lower, clear of the iPhone status bar', await page.evaluate(() => document.querySelector('#dfkids .fkid .fmini').getBoundingClientRect().top >= 40));
  check('draw: the selected fridge is a small fridge wearing the pencil; no separate pencil button', (await page.locator('#dfkids .fkid.on .fmini #dfeditBtn').count()) === 1 && (await page.locator('#dfkids .fkid.edit').count()) === 0);
  check('draw: fridge shows its friend and a trash can', (await page.locator('#dfkids .fkid.on .fk').count()) === 1 && (await page.textContent('#dfown')) === '🦄' && await page.isVisible('#dftrash'));
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-empty-390.png') });
  await page.click('#dfslots .fslot.glow'); await page.waitForTimeout(800);
  const fr = await page.evaluate(idb);
  check('draw: tapping a spot hangs the drawing there (IndexedDB, this device only)', fr.length === 1 && fr[0].slot === 0 && fr[0].f === 'f1' && /^data:image\/jpeg;base64,/.test(fr[0].src) && fr[0].src.length < 600000 && (await page.evaluate(() => localStorage.getItem('mojia.fridge'))) === null, String(fr[0] && fr[0].src.length));
  check('draw: a coloring page drawing saves the page and the coloring layer (#31)', fr[0].page === 'smiley' && /^data:image\/png;base64,/.test(fr[0].layer || '') && fr[0].rel && fr[0].rel.w > 1);
  check('draw: fresh page after hanging the drawing', (await ink()) === 0 && (await line()) === 0 && (await page.locator('#dfslots .fslot.full').count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-390.png') });
  await page.click('#dfslots .fslot.empty'); await page.waitForTimeout(200);
  check('draw: empty page does not go on the fridge', (await page.evaluate(idb)).length === 1);
  await page.click('#dfslots .fslot.full'); await page.waitForTimeout(300);
  check('draw: tapping a fridge drawing shows it big with draw more and trash', await page.isVisible('#dfview') && await page.isVisible('#dfvdraw') && await page.isVisible('#dfvtrash'));
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-view-390.png') });
  await page.click('#dfvdraw'); await page.waitForTimeout(400);
  check('draw: draw more opens a copy: coloring back, page lines live again (#31)', await page.isHidden('#dfridge') && (await ink()) > 50000 && (await line()) > 1000);
  const cv1 = await page.evaluate(() => { const r = document.querySelector('#dmain').getBoundingClientRect(); return r.width + 'x' + r.height; });
  check('draw: the canvas never resizes for the fridge', cv0 === cv1, cv0 + ' vs ' + cv1);
  await page.click('#dundo'); await page.waitForTimeout(100); await page.click('#dundo'); await page.waitForTimeout(100);
  await page.click('#dbook'); await page.click('#dpages .dpage.blank'); await page.waitForTimeout(100);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= 390 && document.querySelector('#s-draw .helprow').getBoundingClientRect().height < 60);
  check('draw: fits 390 wide, help row on one line', fits);
  const swOk = await page.evaluate(() => { const r = document.querySelector('#dswatches').getBoundingClientRect(); return [...document.querySelectorAll('#dswatches .dsw')].every((b) => { const q = b.getBoundingClientRect(); return q.left >= r.left && q.right <= r.right; }); });
  check('draw: every color shows without scrolling at 390', swOk);
  await tools();
  const cBefore = await page.evaluate(() => { const r = document.querySelector('#dmain').getBoundingClientRect(); return [r.width, r.height, document.querySelector('#dmain').width]; });
  await page.click('#dhide'); await page.waitForTimeout(400);
  const cAfter = await page.evaluate(() => { const r = document.querySelector('#dmain').getBoundingClientRect(); return [r.width, r.height, document.querySelector('#dmain').width]; });
  check('#30 draw: hiding the tools never resizes the canvas', JSON.stringify(cBefore) === JSON.stringify(cAfter) && await isFull() && (await page.getAttribute('#dtab', 'aria-label')) === 'Show tools', JSON.stringify([cBefore, cAfter]));
  check('draw: hidden tools leave a big purple tab showing the current tool', await page.evaluate(() => { const t = document.querySelector('#dtab'), r = t.getBoundingClientRect(); return r.width >= 64 && r.height >= 56 && getComputedStyle(t).backgroundColor === 'rgb(113, 56, 209)' && document.querySelector('#dtabtool').innerHTML.length > 10; }));
  await page.screenshot({ path: path.join(SHOTS, 'draw-tools-hidden-390.png') });
  await page.click('#dtab'); await page.waitForTimeout(400);
  check('draw: the tab brings the tools back', !(await isFull()) && await page.isVisible('#dtools') && await page.isHidden('#dtab'));
  await page.screenshot({ path: path.join(SHOTS, 'draw-tools-open-390.png') });
  check('draw: kid screen has no links; the only inputs are the color picker and the fridge name box', (await page.locator('#s-draw a').count()) === 0 && (await page.locator('#s-draw input:not([type=color]):not(#dfname)').count()) === 0);
  // Save to Photos behind the number gate
  await page.click('#s-draw [data-go="home"]');
  await page.click('#lockBtn');
  await page.waitForSelector('#s-ngate:not(.hidden)');
  const ans = await page.getAttribute('#pwChoices', 'data-a');
  await page.click('#pwChoices .pw-choice[data-n="' + ans + '"]');
  await page.waitForSelector('#s-gate:not(.hidden)');
  await page.click('.pw-gurow[data-a="photos"]'); await page.waitForTimeout(400);
  check('draw: Grown-ups Save to Photos lists fridge drawings', await page.isVisible('#pwOvPhotos') && (await page.locator('#pwPhGrid img').count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, 'draw-photos-390.png') });
  check('draw: Save to Photos has no delete button', (await page.locator('#pwPhGrid .rm').count()) === 0 && (await page.evaluate(idb)).length === 1);
  // Release 1.2 #30: a coloring page drawing saves with or without its lines (the grown-up picks)
  await page.evaluate(() => { window.__shared = []; navigator.canShare = () => true; navigator.share = (d) => { window.__shared.push(d.files[0].name); return Promise.resolve(); }; });
  check('#30 Save to Photos: a coloring page offers With lines and Without lines', (await page.locator('#pwPhGrid .pw-lines button').count()) === 2);
  await page.click('#pwPhGrid .pw-lines [data-l="0"]'); await page.waitForTimeout(400);
  await page.click('#pwPhGrid .pw-lines [data-l="1"]'); await page.waitForTimeout(200);
  const shared = await page.evaluate(() => window.__shared);
  check('#30 Save to Photos: Without lines saves the coloring only, With lines saves the fridge picture', shared.length === 2 && /-nolines\.jpg$/.test(shared[0]) && !/nolines/.test(shared[1]), JSON.stringify(shared));
  check('draw: zero third-party requests', page.reqs.every((u) => u.startsWith(base) || u.startsWith('data:')));
  check('draw: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}


// 11b. Emoji Draw fridges (Release 1.1 #20): old drawings move over, nothing drops out on its own, trash can with a check, a fridge per kid
{
  const { ctx, page } = await newPage();
  const idb = () => new Promise((res) => { const r = indexedDB.open('mojia', 1); r.onupgradeneeded = () => r.result.createObjectStore('drawings', { keyPath: 'id' }); r.onsuccess = () => { const q = r.result.transaction('drawings').objectStore('drawings').getAll(); q.onsuccess = () => { res(q.result); r.result.close(); }; }; });
  await page.addInitScript(() => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true');
    const c = document.createElement('canvas'); c.width = 30; c.height = 40; const src = c.toDataURL('image/png');
    localStorage.setItem('mojia.fridge', JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ id: 'd' + i, src, t: 1000 + i, slot: i })))); });
  await page.goto(base + '/play/');
  await page.click('#splash');
  await page.click('[data-go="draw"]');
  await page.waitForSelector('#s-draw:not(.hidden)'); await page.waitForTimeout(500);
  let all = await page.evaluate(idb);
  check('fridges: the old fridge moves into the first fridge, spots kept', all.length === 9 && all.every((x) => x.f === 'f1') && all.map((x) => x.slot).sort().join('') === '012345678' && (await page.evaluate(() => localStorage.getItem('mojia.fridge'))) === null);
  const box = await page.locator('#dmain').boundingBox();
  const scribble = async () => { if (!(await page.evaluate(() => document.querySelector('#s-draw').classList.contains('dfull')))) { await page.click('#dhide'); await page.waitForTimeout(380); } await page.mouse.move(box.x + 40, box.y + 60); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 90, { steps: 10 }); await page.mouse.up(); };
  await scribble();
  await page.click('#dfridgeBtn'); await page.waitForTimeout(300);
  check('fridges: a full door moves nothing; the basket glows', (await page.locator('#dfslots .fslot.full').count()) === 9 && (await page.locator('#dfslots .fslot.empty').count()) === 0 && await page.isVisible('#dbasket.glow') && (await page.evaluate(idb)).every((x) => x.slot >= 0));
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-full-390.png') });
  await page.click('#dbasket'); await page.waitForTimeout(600);
  all = await page.evaluate(idb);
  check('fridges: tapping the glowing basket puts the drawing in the basket', all.length === 10 && all.filter((x) => x.slot < 0).length === 1 && await page.isVisible('#dfbasketview') && (await page.locator('#dfgrid img').count()) === 1);
  await page.click('#dfback');
  check('fridges: back from the basket shows the fridge', await page.isVisible('#dfridge .fridge') && (await page.textContent('#dbasket b')) === '1');
  // trash: keep, then throw away
  await page.click('#dfslots .fslot.full >> nth=0'); await page.click('#dfvtrash'); await page.waitForTimeout(200);
  check('fridges: trash shows the red and green check', await page.isVisible('#dftconfirm') && await page.isVisible('#dftyes') && await page.isVisible('#dftno'));
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-trash-390.png') });
  await page.click('#dftno'); await page.waitForTimeout(200);
  check('fridges: green keeps the drawing', await page.isHidden('#dftconfirm') && (await page.evaluate(idb)).length === 10);
  await page.click('#dfslots .fslot.full >> nth=0'); await page.click('#dfvtrash'); await page.waitForTimeout(150); await page.click('#dftyes'); await page.waitForTimeout(700);
  check('fridges: red trash throws it away', (await page.evaluate(idb)).length === 9 && (await page.locator('#dfslots .fslot.full').count()) === 8);
  // drag to the trash, then wait: the check keeps it after 5 seconds
  const s1 = await page.locator('#dfslots .fslot.full >> nth=0').boundingBox(), tb = await page.locator('#dftrash').boundingBox();
  await page.mouse.move(s1.x + s1.width / 2, s1.y + s1.height / 2); await page.mouse.down(); await page.mouse.move(s1.x + 40, s1.y + 60, { steps: 4 }); await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
  check('fridges: dragging lifts the drawing and the trash can lights up', (await page.locator('.fghost').count()) === 1 && await page.isVisible('#dftrash.hot'));
  await page.mouse.up(); await page.waitForTimeout(200);
  check('fridges: dropping on the trash can asks first', await page.isVisible('#dftconfirm') && (await page.locator('.fghost').count()) === 0);
  await page.waitForTimeout(5300);
  check('fridges: 5 seconds keeps the drawing', await page.isHidden('#dftconfirm') && (await page.evaluate(idb)).length === 9);
  // a fridge per kid
  await page.click('#dfadd'); await page.waitForTimeout(200);
  check('fridges: + adds a fridge and opens its friend, color, and name', await page.isVisible('#dfedit') && (await page.locator('#dfkids .fkid:not(.add):not(.edit)').count()) === 2 && (await page.locator('#dfefriends button').count()) === 10);
  await page.fill('#dfname', "Ava's fridge"); await page.click('#dfefriends button[aria-label="dino"]'); await page.click('#dfecolors button >> nth=2');
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-edit-390.png') });
  await page.click('#dfedone'); await page.waitForTimeout(200);
  const meta = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.fridges')));
  check('fridges: name, friend, and color stay on this device', meta.list.length === 2 && meta.list[1].name === "Ava's fridge" && meta.list[1].e === '🦖' && meta.cur === meta.list[1].id && (await page.textContent('#dfkids .fkid.on b')) === "Ava's fridge");
  check('fridges: a new fridge starts empty', (await page.locator('#dfslots .fslot.empty').count()) === 9 && (await page.textContent('#dfown')) === '🦖');
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridges-390.png') });
  await page.click('#dfclose'); await scribble(); await page.click('#dfridgeBtn'); await page.waitForTimeout(200);
  await page.click('#dfslots .fslot.glow'); await page.waitForTimeout(700);
  all = await page.evaluate(idb);
  check('fridges: the drawing hangs on the fridge in use', all.length === 10 && all.filter((x) => x.f === meta.cur).length === 1);
  await page.click('#dfkids .fkid:not(.add):not(.edit) >> nth=0'); await page.waitForTimeout(200);
  await page.click('#dfclose'); await page.click('#dfridgeBtn'); await page.waitForTimeout(100);
  check('fridges: with 2 fridges, the other fridge hops to show it is tappable', (await page.locator('#dfkids .fkid.hop:not(.on)').count()) === 1 && (await page.locator('#dfkids .fkid.on.hop').count()) === 0);
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridges-hop-390.png') });
  check('fridges: switching shows the other kid\'s fridge', (await page.locator('#dfslots .fslot.full').count()) === 8 && (await page.textContent('#dfown')) === '🦄');
  // opening a drawing makes a copy; hanging it adds one, the original stays
  await page.click('#dfslots .fslot.full >> nth=0'); await page.click('#dfvdraw'); await page.waitForTimeout(300);
  await scribble(); await page.click('#dfridgeBtn'); await page.waitForTimeout(200); await page.click('#dfslots .fslot.glow'); await page.waitForTimeout(700);
  check('fridges: drawing on an opened drawing hangs a copy, the original stays', (await page.evaluate(idb)).length === 11 && (await page.locator('#dfslots .fslot.full').count()) === 9);
  // last fridge used opens first after a reload; an empty fridge can go
  await page.click('#dfkids .fkid:not(.add):not(.edit) >> nth=1'); await page.click('#dfclose');
  await page.reload(); await page.click('#splash'); await page.click('[data-go="draw"]'); await page.waitForSelector('#s-draw:not(.hidden)'); await page.waitForTimeout(400);
  await page.click('#dfridgeBtn'); await page.waitForTimeout(300);
  check('fridges: the last fridge used opens first', (await page.textContent('#dfown')) === '🦖' && (await page.locator('#dfslots .fslot.full').count()) === 1);
  await page.click('#dfslots .fslot.full >> nth=0'); await page.click('#dfvtrash'); await page.click('#dftyes'); await page.waitForTimeout(700);
  await page.click('#dfeditBtn'); await page.waitForTimeout(200);
  check('fridges: an empty fridge shows remove', await page.isVisible('#dferm'));
  await page.click('#dferm'); await page.waitForTimeout(200);
  check('fridges: removing an empty fridge leaves the first fridge whole', (await page.locator('#dfkids .fkid:not(.add):not(.edit)').count()) === 1 && (await page.locator('#dfslots .fslot.full').count()) === 9);
  await page.click('#dfeditBtn'); await page.waitForTimeout(200);
  check('fridges: a fridge with drawings cannot be removed', await page.isHidden('#dferm'));
  await page.click('#dfedone');
  for (let i = 0; i < 5; i++) { await page.click('#dfadd'); await page.click('#dfedone'); }
  check('fridges: 6 fridges at most', (await page.locator('#dfkids .fkid:not(.add):not(.edit)').count()) === 6 && (await page.locator('#dfadd').count()) === 0);
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridges-six-390.png') });
  check('fridges: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}


// Release 1.2 #19 and #30: panel opens on the first visit, drawing hides it, Draw opens the way it was left;
// eraser glow after a few strokes; coloring stays inside the lines through hide, show and a turn of the phone; Outline switch
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/');
  await page.click('#splash'); await page.click('[data-go="draw"]');
  await page.waitForSelector('#s-draw:not(.hidden)'); await page.waitForTimeout(500);
  const full = () => page.evaluate(() => document.querySelector('#s-draw').classList.contains('dfull'));
  const ink = () => page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  const line = () => page.evaluate(() => { const c = document.querySelector('#dline'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  check('#30 draw: the tools panel is open on the first visit', !(await full()) && await page.isVisible('#dtools') && await page.isHidden('#dtab'));
  let box = await page.locator('#dmain').boundingBox();
  const drag = async (pts) => { await page.mouse.move(box.x + pts[0][0], box.y + pts[0][1]); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(box.x + p[0], box.y + p[1], { steps: 6 }); await page.mouse.up(); };
  await drag([[60, box.height - 60], [300, box.height - 80]]);
  await page.waitForTimeout(450);
  check('#30 draw: drawing on the canvas slides the panel away; the purple tools button nudges', (await full()) && (await ink()) > 300 && /\bnudge\b/.test(await page.getAttribute('#dtab', 'class')) && (await page.evaluate(() => localStorage.getItem('mojia.drawToolsOpen'))) === 'false');
  await page.screenshot({ path: path.join(SHOTS, 'draw-autohide-390.png') });
  await drag([[60, 300], [300, 320]]); await drag([[60, 360], [300, 380]]);
  check('#19 draw: no eraser glow while the tools are hidden', (await page.evaluate(() => localStorage.getItem('mojia.eraserHint'))) === null);
  await page.click('#dtab'); await page.waitForTimeout(450);
  check('#19 draw: after 3 strokes the eraser tile glows once when the tools open', /\bglow\b/.test(await page.getAttribute('#dtools [data-tool="eraser"]', 'class')) && (await page.evaluate(() => localStorage.getItem('mojia.eraserHint'))) === 'true');
  await page.screenshot({ path: path.join(SHOTS, 'draw-eraser-glow-390.png') });
  await page.click('#dhide'); await page.waitForTimeout(400);
  await page.click('#s-draw [data-go="home"]'); await page.waitForTimeout(300);
  await page.click('[data-go="draw"]'); await page.waitForSelector('#s-draw:not(.hidden)'); await page.waitForTimeout(400);
  check('#30 draw: Draw opens the way the kid left the panel (hidden)', await full());
  // coloring page: color inside the lines, then hide and show the tools 5 times and turn the phone
  await page.click('#dclear'); await page.waitForTimeout(350); await page.click('#dcyes'); await page.waitForTimeout(800);
  await page.click('#dbook'); await page.click('#dpages .dpage[aria-label="smiley"]'); await page.waitForTimeout(300);
  check('#30 draw: page lines are thinner (half width)', /ox\.lineWidth=2\.5;/.test(fs.readFileSync(path.join(site, 'play', 'index.html'), 'utf8')) && !/ox\.lineWidth=5;/.test(fs.readFileSync(path.join(site, 'play', 'index.html'), 'utf8')));
  check('#30 draw: the Outline switch shows when a page is open', await page.evaluate(() => !document.querySelector('#dpagerow').classList.contains('hidden')));
  box = await page.locator('#dmain').boundingBox();
  const cx = box.width / 2, cy = box.height / 2;
  await drag([[cx - 40, cy], [cx + 40, cy], [cx - 40, cy + 10], [cx + 40, cy + 10]]);
  const inside = () => page.evaluate(() => { const m = document.querySelector('#dmain'), l = document.querySelector('#dline'); const a = m.getContext('2d').getImageData(0, 0, m.width, m.height).data, b = l.getContext('2d').getImageData(0, 0, l.width, l.height).data;
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, ix0 = 1e9, ix1 = -1, iy0 = 1e9, iy1 = -1; for (let y = 0; y < l.height; y += 2) for (let x = 0; x < l.width; x += 2) { const i = (y * l.width + x) * 4 + 3; if (b[i] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } if (a[i] > 0) { ix0 = Math.min(ix0, x); ix1 = Math.max(ix1, x); iy0 = Math.min(iy0, y); iy1 = Math.max(iy1, y); } }
    const pc = [(x0 + x1) / 2, (y0 + y1) / 2], ic = [(ix0 + ix1) / 2, (iy0 + iy1) / 2], ps = x1 - x0; return { off: Math.hypot(pc[0] - ic[0], pc[1] - ic[1]) / ps, inBox: ix0 > x0 && ix1 < x1 && iy0 > y0 && iy1 < y1 }; });
  const i0 = await inside(), n0 = await ink(), l0 = await line();
  check('#30 draw: coloring sits inside the page lines', i0.inBox && i0.off < 0.08, JSON.stringify(i0));
  for (let k = 0; k < 5; k++) { await page.click('#dtab'); await page.waitForTimeout(380); await page.click('#dhide'); await page.waitForTimeout(380); }
  const i1 = await inside();
  check('#30 draw: hide and show the tools 5 times: coloring and lines unchanged', (await ink()) === n0 && (await line()) === l0 && JSON.stringify(i1) === JSON.stringify(i0), JSON.stringify(i1));
  await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(500);
  const i2 = await inside(), n2 = await ink();
  check('#30 draw: turning the phone keeps the coloring inside the lines, smaller, never cropped', i2.inBox && i2.off < 0.08 && n2 < n0 && n2 > n0 * 0.1, JSON.stringify({ i2, n0, n2 }));
  await page.screenshot({ path: path.join(SHOTS, 'draw-turned-844.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(500);
  check('#30 draw: turning back brings the drawing back to full size', (await ink()) === n0 && (await line()) === l0, (await ink()) + ' vs ' + n0);
  // Outline switch
  await page.click('#dtab'); await page.waitForTimeout(400);
  await page.click('#dlines');
  check('#30 draw: Outline switch hides the page lines; the coloring stays', await page.evaluate(() => getComputedStyle(document.querySelector('#dline')).visibility === 'hidden') && (await page.getAttribute('#dlines', 'aria-pressed')) === 'false' && (await ink()) === n0);
  await page.screenshot({ path: path.join(SHOTS, 'draw-lines-off-390.png') });
  await page.click('#dlines');
  check('#30 draw: Outline switch shows the lines again', await page.evaluate(() => getComputedStyle(document.querySelector('#dline')).visibility === 'visible') && (await page.getAttribute('#dlines', 'aria-pressed')) === 'true');
  await page.click('#dundo'); await page.waitForTimeout(150); await page.click('#dredo'); await page.waitForTimeout(150);
  check('#30 draw: Undo and Redo stay lined up', JSON.stringify(await inside()) === JSON.stringify(i0) && (await ink()) === n0);
  check('#30 draw: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 11c. Emoji Draw on upright iPad: tools in a side panel so the drawing area is as big as possible
{
  const { ctx, page } = await newPage({ viewport: { width: 480, height: 691 }, deviceScaleFactor: 2, isMobile: false });
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); if (!sessionStorage.getItem('hinted')) { sessionStorage.setItem('hinted', '1'); localStorage.setItem('mojia.bookHint', '2'); } });
  await page.goto(base + '/play/');
  await page.click('#splash');
  await page.click('[data-go="draw"]');
  await page.waitForSelector('#s-draw:not(.hidden)'); await page.waitForTimeout(400);
  const g = await page.evaluate(() => { const c = document.querySelector('#dmain').getBoundingClientRect(), p = document.querySelector('#s-draw .dctl'), pr = p.getBoundingClientRect(); return { area: Math.round(c.width * c.height), side: pr.left >= c.left && pr.left < c.left + 16 && pr.right < c.left + c.width / 2, fits: p.scrollHeight <= p.clientHeight + 1, sw: [...document.querySelectorAll('#dswatches .dsw')].every((b) => { const r = b.getBoundingClientRect(); return r.bottom <= pr.bottom && r.width >= 44; }) }; });
  check('#30 draw iPad upright: tools panel slides over the left side; the canvas fills the screen (over 220,000 square points)', g.side && g.area > 220000, JSON.stringify(g));
  check('draw iPad upright: every tool, the slider, and all 7 colors fit without scrolling', g.fits && g.sw, JSON.stringify(g));
  const small = await page.evaluate(() => [...document.querySelectorAll('#s-draw button,#dslider')].filter((b) => b.offsetParent && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44)).map((b) => b.id || b.className));
  check('draw iPad upright: every control is at least 44 px', small.length === 0, small.join(','));
  await page.screenshot({ path: path.join(SHOTS, 'draw-ipad-upright.png') });
  check('draw: book still pulses on the third visit', /\bbookpulse\b/.test(await page.getAttribute('#dbook', 'class')));
  await page.click('#s-draw [data-go="home"]'); await page.waitForTimeout(300);
  await page.click('[data-go="draw"]'); await page.waitForSelector('#s-draw:not(.hidden)'); await page.waitForTimeout(300);
  check('draw: book stops pulsing after 3 visits', !/\bbookpulse\b/.test(await page.getAttribute('#dbook', 'class')));
  check('draw iPad upright: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 11e. Welcome screen on a sideways iPad: logo, tagline, and Tap to Play all show
{
  const { ctx, page } = await newPage({ viewport: { width: 921, height: 640 }, deviceScaleFactor: 2, isMobile: false });
  await page.goto(base + '/play/');
  await page.waitForTimeout(2000);
  const sp = await page.evaluate(() => { const vis = (sel) => { const e = document.querySelector(sel), r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.right <= innerWidth && r.bottom <= innerHeight && parseFloat(cs.opacity) > 0.9; }; return { ready: document.querySelector('#splash').classList.contains('ready'), logo: vis('#splash .sp-word') && document.querySelector('#splash .sp-word').complete && document.querySelector('#splash .sp-word').naturalWidth > 0, tag: vis('#splash .sp-tag'), cta: vis('#splash .sp-cta') }; });
  check('welcome on a sideways iPad: logo loads, tagline and Tap to Play show within 2 seconds', sp.ready && sp.logo && sp.tag && sp.cta, JSON.stringify(sp));
  await page.screenshot({ path: path.join(SHOTS, 'ipad-side-welcome.png') });
  check('welcome: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 11d. Sideways iPad: every game uses the full screen width
{
  const { ctx, page } = await newPage({ viewport: { width: 921, height: 640 }, deviceScaleFactor: 2, isMobile: false });
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/');
  await page.click('#splash'); await page.waitForTimeout(300);
  const homeCols = await page.evaluate(() => getComputedStyle(document.querySelector('#hgrid')).gridTemplateColumns.split(' ').length);
  const hv = await page.evaluate(() => { const vh = innerHeight, ok = (e) => { const r = e.getBoundingClientRect(); return r.bottom <= vh + 1 && r.top >= 0 && r.width > 0; }; return { games: [...document.querySelectorAll('#hfeat .htile, #hgrid .htile')].map(ok), tray: [...document.querySelectorAll('#tray .tile')].map(ok), app: Math.round(document.querySelector('#app').getBoundingClientRect().width), scroll: document.querySelector('#s-home').scrollHeight - document.querySelector('#s-home').clientHeight }; });
  check('sideways iPad: home fills the width; all 7 games and every emoji show without scrolling', hv.app === 921 && hv.games.length === 7 && hv.games.every(Boolean) && hv.tray.length >= 12 && hv.tray.every(Boolean) && hv.scroll <= 1, JSON.stringify(hv));
  await page.screenshot({ path: path.join(SHOTS, 'ipad-side-home.png') });
  const widths = {};
  for (const g of ['pattern', 'bounce', 'match', 'parade', 'draw']) {
    await page.evaluate((g) => document.querySelector('#s-home [data-go="' + g + '"]').click(), g); await page.waitForTimeout(500);
    widths[g] = await page.evaluate((g) => Math.round(document.querySelector('#s-' + g + ' .stage, #s-' + g + ' #dstage').getBoundingClientRect().width), g);
    if (g === 'match') widths.matchCols = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#mgrid')); return [s.gridTemplateColumns.split(' ').length, s.gridTemplateRows.split(' ').length]; });
    if (g === 'pattern') widths.choice = await page.evaluate(() => Math.round(document.querySelector('#pchoices .choice').getBoundingClientRect().width));
    await page.screenshot({ path: path.join(SHOTS, 'ipad-side-' + g + '.png') });
    await page.evaluate((g) => document.querySelector('#s-' + g + ' [data-go="home"]').click(), g); await page.waitForTimeout(300);
  }
  check('sideways iPad: Pattern, Match, and Parade stages span the screen; Bounce keeps its emoji rail', ['pattern', 'match', 'parade'].every((g) => widths[g] >= 850) && widths.bounce >= 780, JSON.stringify(widths));
  check('sideways iPad: Match lays the cards out wide (more columns than rows)', widths.matchCols[0] > widths.matchCols[1], JSON.stringify(widths.matchCols));
  check('sideways iPad: Pattern picture cards grow with the screen', widths.choice > 140, String(widths.choice));
  await page.evaluate(() => document.querySelector('#s-home [data-go="draw"]').click()); await page.waitForTimeout(400);
  await page.click('#dtools [data-tool="stamp"]'); await page.click('#dtray .tile:last-child'); await page.waitForTimeout(500);
  const dr = await page.evaluate(() => { const d = document.querySelector('#drawer').getBoundingClientRect(), tabs = [...document.querySelectorAll('#drawer .dtabs .dtab')].map((t) => t.getBoundingClientRect()), tile = document.querySelector('#drawer .dgrid .tile').getBoundingClientRect(); return { inRow: tabs.every((t) => Math.abs(t.top - tabs[0].top) < 2 && t.top >= d.top && t.bottom < d.top + 90), pos: getComputedStyle(document.querySelector('#drawer .dtabs .dtab')).position, tile: Math.round(tile.width), width: Math.round(d.width) }; });
  check('sideways iPad: emoji drawer keeps category buttons in a row and kid-sized tiles', dr.inRow && dr.pos === 'static' && dr.tile >= 56 && dr.tile <= 90 && dr.width <= 860, JSON.stringify(dr));
  await page.screenshot({ path: path.join(SHOTS, 'ipad-side-drawer.png') });
  await page.click('#drawer .dclose'); await page.waitForTimeout(300);
  check('sideways iPad: games, no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 12. Home: big stamp canvas first, featured card peeks at the bottom edge, games scroll below
// (Release 1.3: Share Party and Feelings Faces already played here, so Draw is featured; 12c covers the new games.)
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); if (!localStorage.getItem('mojia.played')) localStorage.setItem('mojia.played', JSON.stringify({ share: 1, feelings: 1 })); });
  await page.goto(base + '/play/');
  await page.click('#splash'); await page.waitForTimeout(400);
  const lay = await page.evaluate(() => { const c = document.querySelector('#canvas').getBoundingClientRect(), f = document.querySelector('#hfeat .hfeat').getBoundingClientRect(), sc = document.querySelector('#s-home'); return { canvas: Math.round(c.height), featTop: Math.round(f.top), vh: innerHeight, scrolls: sc.scrollHeight > sc.clientHeight + 100 }; });
  check('home: stamp canvas fills most of the first screen', lay.canvas >= 420, JSON.stringify(lay));
  check('home: featured card peeks at the bottom edge', lay.featTop < lay.vh - 60 && lay.featTop > lay.vh - 150, JSON.stringify(lay));
  check('home: games below the fold scroll', lay.scrolls);
  check('home: original header kept (centered logo, tagline, timer chip, gear over Grown-ups)', await page.isVisible('.homehead .tagline') && await page.isVisible('#lockBtn .gl') && await page.isVisible('.homehead [data-chip]') && await page.evaluate(() => { const r = document.querySelector('.homehead .wordmark').getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 12; }));
  check('home: new Draw game is featured with a New! tag', (await page.getAttribute('#hfeat .hfeat', 'data-go')) === 'draw' && /New!/.test(await page.textContent('#hfeat')));
  check('home: grid shows the other six games once each', (await page.evaluate(() => [...document.querySelectorAll('#hgrid .hcell')].map((b) => b.dataset.go).join(','))) === 'pattern,bounce,match,parade,share,feelings');
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.click(box.x + 120, box.y + 200);
  check('home: tapping the canvas still stamps', (await page.locator('#canvas .stamp').count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, 'home-top-390.png') });
  await page.evaluate(() => { document.querySelector('#s-home').scrollTop = 9999; }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'home-games-390.png') });
  await page.click('#hfeat .hfeat'); await page.waitForSelector('#s-draw:not(.hidden)');
  await page.click('#s-draw [data-go="home"]'); await page.waitForTimeout(300);
  check('home: Draw stays featured with New! after playing, home scrolls back to the top', (await page.getAttribute('#hfeat .hfeat', 'data-go')) === 'draw' && /New!/.test(await page.textContent('#hfeat')) && (await page.evaluate(() => document.querySelector('#s-home').scrollTop)) === 0);
  await page.click('#hgrid [data-go="match"]'); await page.waitForSelector('#s-match:not(.hidden)');
  await page.click('#s-match [data-go="home"]'); await page.waitForTimeout(300);
  check('home: after playing Match, Draw is still featured and Match stays in the grid', (await page.getAttribute('#hfeat .hfeat', 'data-go')) === 'draw' && (await page.locator('#hgrid [data-go="match"]').count()) === 1);
  await page.evaluate(() => localStorage.setItem('mojia.homeProg', JSON.stringify({ match: { medal: 1, frac: 0.5 } })));
  await page.click('#hgrid [data-go="pattern"]'); await page.waitForSelector('#s-pattern:not(.hidden)'); await page.click('#s-pattern [data-go="home"]'); await page.waitForTimeout(300);
  check('home: medal line shows the earned medal on the grid tile', /Silver/.test(await page.textContent('#hgrid [data-go="match"]')));
  await page.evaluate(() => { document.querySelector('#s-home').scrollTop = 9999; }); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, 'home-keep-390.png') });
  const small = await page.evaluate(() => [...document.querySelectorAll('#s-home button')].filter((b) => b.offsetParent && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 40)).map((b) => b.id || b.className));
  check('home: every button is a big tap target', small.length === 0, small.join(','));
  check('home: no horizontal scroll at 390', await page.evaluate(() => document.documentElement.scrollWidth <= 390 && document.querySelector('#s-home').scrollWidth <= document.querySelector('#s-home').clientWidth));
  check('home: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
// 12b. Home on a small phone (375x667) and iPad portrait
for (const [w, h, name] of [[375, 667, 'se'], [820, 1180, 'ipad']]) {
  const { ctx, page } = await newPage({ viewport: { width: w, height: h } });
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/'); await page.click('#splash'); await page.waitForTimeout(400);
  const lay = await page.evaluate(() => ({ canvas: document.querySelector('#canvas').getBoundingClientRect().height, featTop: document.querySelector('#hfeat .hfeat').getBoundingClientRect().top, vh: innerHeight }));
  check('home ' + name + ': canvas big, featured card peeks', lay.canvas >= 240 && lay.featTop < lay.vh && lay.featTop > lay.vh - 170, JSON.stringify(lay));
  await page.screenshot({ path: path.join(SHOTS, 'home-' + name + '.png') });
  await ctx.close();
}

// 12c. Release 1.3: Share Party and Feelings Faces. New tiles, silent play (no device voice), saved progress, layouts.
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => {
    localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); localStorage.setItem('mojia.voice', 'true');
    window.__spoke = []; try { speechSynthesis.speak = (u) => { window.__spoke.push(u && u.text); }; } catch (e) {}
  });
  await page.goto(base + '/play/'); await page.click('#splash'); await page.waitForTimeout(400);
  await page.evaluate(() => { window.__spoke = []; });
  check('1.3 home: Share Party is featured with New! on a fresh device', (await page.getAttribute('#hfeat .hfeat', 'data-go')) === 'share' && /New!/.test(await page.textContent('#hfeat')));
  check('1.3 home: grid holds the other six games once each', (await page.evaluate(() => [...document.querySelectorAll('#hgrid .hcell')].map((b) => b.dataset.go).join(','))) === 'pattern,bounce,match,parade,feelings,draw');
  await page.click('#hfeat .hfeat'); await page.waitForSelector('#s-share:not(.hidden)'); await page.waitForTimeout(400);
  check('1.3 share: level map shows 9 levels', (await page.locator('#sharestage .sh-lv').count()) === 9);
  check('1.3 share: timer chip shows in the game bar', await page.isVisible('#s-share [data-chip]'));
  check('1.3 share: no say-it button (no voice)', (await page.locator('#s-share .sh-again, #s-share #msay').count()) === 0);
  await page.screenshot({ path: path.join(SHOTS, 'share-map-390.png') });
  await page.click('#sharestage .sh-lv[data-lv="0"]'); await page.waitForTimeout(1200);
  check('1.3 share: pointing hand shows the first cut on level 1', await page.evaluate(() => document.querySelector('#sharestage .sh-point').classList.contains('show')));
  await page.screenshot({ path: path.join(SHOTS, 'share-cut-390.png') });
  const fb = await page.locator('#sharestage .sh-food').boundingBox();
  await page.mouse.move(fb.x + fb.width * 0.15, fb.y + fb.height * 0.5); await page.mouse.down();
  await page.mouse.move(fb.x + fb.width * 0.85, fb.y + fb.height * 0.5, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(900);
  check('1.3 share: one swipe on the dotted line cuts the pizza in 2', (await page.locator('#sharestage .sh-item.piece').count()) === 2);
  const sr = await page.locator('#sharestage').boundingBox();
  for (let i = 0; i < 2; i++) {
    const v = await page.evaluate((k) => { const p = [...document.querySelectorAll('#sharestage .sh-item.piece')].filter((e) => e.dataset.loc === '-1')[0]; return p ? [Number(p.dataset.vx), Number(p.dataset.vy)] : null; }, i);
    if (!v) break;
    await page.mouse.click(sr.x + v[0], sr.y + v[1]); await page.waitForTimeout(150);
    await page.click('#sharestage .sh-plate[data-i="' + i + '"]'); await page.waitForTimeout(500);
  }
  await page.waitForTimeout(5200);
  check('1.3 share: a fair share finishes puzzle 1 and opens puzzle 2', await page.evaluate(() => { const d = [...document.querySelectorAll('#sharestage .sh-dots i')]; return d[0].className === 'on' && d[1].className === 'cur'; }));
  await page.click('#s-share [data-go="home"]'); await page.waitForTimeout(300);
  check('1.3 home: after Share Party, Feelings Faces is featured with New!', (await page.getAttribute('#hfeat .hfeat', 'data-go')) === 'feelings' && /New!/.test(await page.textContent('#hfeat')));
  await page.evaluate(() => localStorage.setItem('mojia.shareStars', JSON.stringify([0, 1, 99, 'x'])));
  await page.click('#hgrid [data-go="share"]'); await page.waitForSelector('#s-share:not(.hidden)'); await page.waitForTimeout(300);
  check('1.3 share: stars saved on the device show on the map (bad values ignored)', (await page.locator('#sharestage .sh-lv.done').count()) === 2);
  await page.click('#s-share [data-go="home"]'); await page.waitForTimeout(300);

  await page.click('#hfeat .hfeat'); await page.waitForSelector('#s-feelings:not(.hidden)');
  check('1.3 feelings: picture strip has 3 panels, first lit', await page.evaluate(() => document.querySelectorAll('#feelingsstage .panel').length === 3 && document.querySelector('#feelingsstage .panel[data-b="1"]').classList.contains('on')));
  await page.waitForTimeout(3300);
  check('1.3 feelings: the event lights panel 2 and the spotlight', await page.evaluate(() => document.querySelector('#feelingsstage .panel[data-b="2"]').classList.contains('on') && document.querySelector('#feelingsstage svg').classList.contains('spoton')));
  await page.screenshot({ path: path.join(SHOTS, 'feelings-event-390.png') });
  await page.waitForSelector('#feelingsstage .pick', { timeout: 9000 }); await page.waitForTimeout(600);
  check('1.3 feelings: 3 face choices after the story, panel 3 lit', (await page.locator('#feelingsstage .pick').count()) === 3 && await page.evaluate(() => document.querySelector('#feelingsstage .panel[data-b="3"]').classList.contains('on')));
  const wrong = await page.evaluate(() => { const b = [...document.querySelectorAll('#feelingsstage .pick')].find((x) => x.dataset.feel !== 'sad'); return b ? b.dataset.feel : null; });
  await page.click('#feelingsstage .pick[data-feel="' + wrong + '"]'); await page.waitForTimeout(400);
  check('1.3 feelings: a wrong face keeps all choices (no penalty)', (await page.locator('#feelingsstage .pick:not(.gone)').count()) === 3);
  await page.click('#feelingsstage .pick[data-feel="sad"]'); await page.waitForTimeout(500);
  check('1.3 feelings: the right face fills panel 3 and the bubble', await page.evaluate(() => /😢/.test(document.querySelector('#feelingsstage .panel[data-b="3"]').textContent) && document.querySelector('#feelingsstage .bub').classList.contains('has')));
  await page.screenshot({ path: path.join(SHOTS, 'feelings-right-390.png') });
  await page.waitForSelector('#feelingsstage .ffhelp', { timeout: 6000 });
  await page.click('#feelingsstage .ffhelp');
  await page.waitForSelector('#feelingsstage .nextbtn', { timeout: 8000 });
  check('1.3 feelings: helping finishes the scene and saves it on the device', (await page.evaluate(() => localStorage.getItem('mojia.feelRound'))) === '1');
  await page.click('#s-feelings [data-go="home"]'); await page.waitForTimeout(300);
  await page.click('#hgrid [data-go="feelings"]'); await page.waitForSelector('#s-feelings:not(.hidden)'); await page.waitForTimeout(300);
  check('1.3 feelings: reopening starts on scene 2', await page.evaluate(() => [...document.querySelectorAll('#feelingsstage .ffdot')].findIndex((d) => d.classList.contains('now')) === 1));
  await page.click('#s-feelings [data-go="home"]'); await page.waitForTimeout(2500);
  check('1.3: leaving mid-story stops the game (stage empty)', await page.evaluate(() => document.querySelector('#feelingsstage').children.length === 0 && document.querySelector('#sharestage').children.length === 0));
  { const spoke = await page.evaluate(() => window.__spoke); check('1.3: no device voice in either game, even with Voice on', spoke.length === 0, JSON.stringify(spoke)); }
  check('1.3: no network requests from the new games', !page.reqs.some((u) => !u.startsWith(base) && !/fonts\.g/.test(u)), page.reqs.filter((u) => !u.startsWith(base)).join(' '));
  check('1.3: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
// 12d. Release 1.3 how-to cards: no Watch how button for games without a demo
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.welcomed', 'true'); localStorage.removeItem('mojia.demos'); localStorage.removeItem('mojia.demoDone'); });
  await page.goto(base + '/play/'); await page.click('#splash'); await page.waitForTimeout(400);
  for (const g of ['share', 'feelings']) {
    await page.evaluate((id) => document.querySelector('[data-go="' + id + '"]').click(), g);
    await page.waitForSelector('#glass:not(.hidden)', { timeout: 3000 });
    check('1.3 how-to card: ' + g + ' has 3 steps, Play, and no Watch how', (await page.locator('#gcard .gstep').count()) === 3 && await page.isVisible('#gGo') && (await page.locator('#gWatch').count()) === 0);
    await page.click('#gGo'); await page.waitForTimeout(200);
    await page.click('#s-' + g + ' [data-go="home"]'); await page.waitForTimeout(300);
  }
  check('1.3 how-to cards: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
// 12e. Release 1.3 layouts: phone, upright iPad, sideways iPad, reduced motion
for (const [w, h, name, rm] of [[390, 844, '390', false], [375, 667, 'se', true], [820, 1180, 'ipad', false], [1180, 820, 'ipad-side', false]]) {
  const { ctx, page } = await newPage({ viewport: { width: w, height: h }, reducedMotion: rm ? 'reduce' : 'no-preference' });
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/'); await page.click('#splash'); await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[data-go="share"]').click()); await page.waitForTimeout(500);
  const sm = await page.evaluate(() => { const st = document.querySelector('#sharestage').getBoundingClientRect(); const lv = [...document.querySelectorAll('#sharestage .sh-lv')].map((b) => b.getBoundingClientRect()); return { inside: lv.every((r) => r.left >= st.left - 1 && r.right <= st.right + 1 && r.top >= st.top - 1 && r.bottom <= st.bottom + 1), small: lv.filter((r) => r.width < 56).length, hscroll: document.documentElement.scrollWidth > innerWidth }; });
  check('1.3 layout ' + name + ': Share Party level badges fit, 56 px or bigger, no sideways scroll', sm.inside && sm.small === 0 && !sm.hscroll, JSON.stringify(sm));
  await page.screenshot({ path: path.join(SHOTS, 'share-map-' + name + '.png') });
  await page.click('#sharestage .sh-lv[data-lv="3"]'); await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOTS, 'share-break-' + name + '.png') });
  await page.click('#s-share [data-go="home"]'); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-go="feelings"]').click());
  await page.waitForSelector('#feelingsstage .pick', { timeout: 12000 }); await page.waitForTimeout(800);
  const fm = await page.evaluate(() => { const st = document.querySelector('#feelingsstage').getBoundingClientRect(); const els = [...document.querySelectorAll('#feelingsstage .pick, #feelingsstage .panel, #feelingsstage .scn')].map((e) => e.getBoundingClientRect()); return { inside: els.every((r) => r.top >= st.top - 1 && r.bottom <= st.bottom + 1 && r.left >= st.left - 1 && r.right <= st.right + 1), small: [...document.querySelectorAll('#feelingsstage .pick, #feelingsstage .replay')].filter((e) => e.getBoundingClientRect().width < 44).length, hscroll: document.documentElement.scrollWidth > innerWidth }; });
  check('1.3 layout ' + name + ': Feelings Faces scene, strip, and faces fit; tap targets 44 px or bigger', fm.inside && fm.small === 0 && !fm.hscroll, JSON.stringify(fm));
  await page.screenshot({ path: path.join(SHOTS, 'feelings-pick-' + name + '.png') });
  await page.click('#s-feelings [data-go="home"]'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'home-games-' + name + '.png'), fullPage: false });
  check('1.3 layout ' + name + ': no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
// 12f. Feelings Faces finale: 20 friends in 2 rows that do not overlap
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); localStorage.setItem('mojia.feelRound', '19'); });
  await page.goto(base + '/play/'); await page.click('#splash'); await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[data-go="feelings"]').click());
  await page.waitForSelector('#feelingsstage .pick', { timeout: 12000 });
  const ok = await page.evaluate(() => document.querySelector('#feelingsstage .pick[data-feel="lonely"]') !== null);
  check('1.3 feelings: scene 20 is Octopus (lonely)', ok);
  await page.click('#feelingsstage .pick[data-feel="lonely"]');
  await page.waitForSelector('#feelingsstage .ffhelp', { timeout: 6000 }); await page.click('#feelingsstage .ffhelp');
  await page.waitForSelector('#feelingsstage .nextbtn', { timeout: 8000 }); await page.click('#feelingsstage .nextbtn');
  await page.waitForSelector('#feelingsstage .again', { timeout: 4000 }); await page.waitForTimeout(800);
  const fin = await page.evaluate(() => { const t = [...document.querySelectorAll('#feelingsstage .hopper text')].map((e) => e.getBoundingClientRect()); let overlap = 0; for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) { const a = t[i], b = t[j]; const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (ox > a.width * 0.2 && oy > a.height * 0.2) overlap++; } const sc = document.querySelector('#feelingsstage .scn').getBoundingClientRect(); const cut = t.filter((r) => r.left < sc.left - 1 || r.right > sc.right + 1).length; return { n: t.length, overlap, cut, saved: localStorage.getItem('mojia.feelRound') }; });
  check('1.3 feelings finale: 20 friends, none overlapping or cut off, progress resets to scene 1', fin.n === 20 && fin.overlap === 0 && fin.cut === 0 && fin.saved === '0', JSON.stringify(fin));
  await page.screenshot({ path: path.join(SHOTS, 'feelings-finale-390.png') });
  check('1.3 feelings finale: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// Release 1.1 #10: how-to card. Play is the big glowing button, Watch how is a small pill without a play arrow.
{
  const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => { localStorage.setItem('mojia.welcomed', 'true'); localStorage.removeItem('mojia.demos'); localStorage.removeItem('mojia.demoDone'); });
  await page.goto(base + '/play/'); await page.click('#splash'); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#s-home [data-go="pattern"]').click()); await page.waitForTimeout(900);
  const h = await page.evaluate(() => { const go = document.querySelector('#gGo'), w = document.querySelector('#gWatch'); if (!go || !w) return null; const a = go.getBoundingClientRect(), b = w.getBoundingClientRect(), cs = getComputedStyle(go); return { goH: a.height, goW: a.width, wH: b.height, wW: b.width, anim: cs.animationName, goText: go.textContent, wText: w.textContent }; });
  check('how-to card: Play is the big glowing button', !!h && h.goH >= 80 && h.goW > h.wW && h.goH > h.wH && h.wH >= 44 && h.anim === 'gglow' && /Play/.test(h.goText), JSON.stringify(h));
  check('how-to card: Watch how has no play arrow', !!h && !/▶/.test(h.wText) && /Watch how/.test(h.wText), JSON.stringify(h));
  await page.screenshot({ path: path.join(SHOTS, 'howto-card-390.png') });
  await page.click('#gGo'); await page.waitForTimeout(300);
  check('how-to card: Play closes the card', await page.evaluate(() => document.querySelector('#glass').classList.contains('hidden')));
  await ctx.close();
}

// Release 1.1.1 #48 on an iPad (landscape): All set names the iPad; home game cards fill their width (iPadOS 16 fix, October 5)
{
  const ipadUA = 'Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
  const { ctx, page } = await newPage({ viewport: { width: 1080, height: 810 }, deviceScaleFactor: 1, userAgent: ipadUA });
  const { token, payload } = tokenFor('48h', Date.now() + 48 * 3600e3);
  await page.route('**/.netlify/functions/confirm-session', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'MOJI-TEST-CODE-2345', kind: '48h', ends_at: payload.e, token, email_masked: 'p•••@example.com', plan: 'pass' }) }));
  await page.route('**/.netlify/functions/friend-code', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'GIFT-ABCD-EFGH-JKMN', link: base + '/g/GIFTABCDEFGHJKMN', use_by: new Date(Date.now() + 30 * 86400e3).toISOString(), state: 'ready' }) }));
  await page.goto(base + '/pass/done/?session_id=cs_test_ipad');
  await page.waitForSelector('#s-allset:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#pwOkGift:not([hidden])');
  check('iPad All set: Home Screen link names the iPad', (await page.textContent('#pwOkHSt')) === "Put Mojialand on this iPad's Home Screen" && await page.isVisible('#pwOkHS'));
  await page.screenshot({ path: path.join(SHOTS, 'allset-ipad-1080.png') });
  await page.click('#pwOkBack');
  await page.waitForSelector('#s-home:not(.hidden)');
  await page.waitForTimeout(300);
  check('iPad home: each game card preview and name row span the card width', await page.evaluate(() => [...document.querySelectorAll('.hcell')].every((c) => { const cw = c.clientWidth - 20; return ['.win', '.hrow'].every((s) => Math.abs(c.querySelector(s).getBoundingClientRect().width - cw) < 2); })));
  await page.screenshot({ path: path.join(SHOTS, 'home-ipad-1080.png') });
  await ctx.close();
}

// Release 1.1 #3: friend pass on All set and in Grown-ups; /g/ link page with a preview card
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('48h', Date.now() + 48 * 3600e3);
  const useBy = new Date(Date.now() + 30 * 86400e3).toISOString();
  let fcalls = [];
  await page.route('**/.netlify/functions/confirm-session', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'MOJI-TEST-CODE-2345', kind: '48h', ends_at: payload.e, token, email_masked: 'p•••@example.com', plan: 'pass' }) }));
  await page.route('**/.netlify/functions/friend-code', (r) => { fcalls.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'GIFT-ABCD-EFGH-JKMN', link: base + '/g/GIFTABCDEFGHJKMN', use_by: useBy, state: 'ready' }) }); });
  await page.goto(base + '/pass/done/?session_id=cs_test_gift');
  await page.waitForSelector('#s-allset:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#pwOkGift:not([hidden])');
  check('friend pass: All set shows one plain line, no buttons, no link (Release 1.1.1 #48)', (await page.textContent('#pwOkGift')) === '🎁 Your pass includes 48 free hours for a friend. Find the link in Grown-ups or your email.' && (await page.locator('#pwOkGift button, #pwOkGift a').count()) === 0);
  check('friend pass: asks the server with the pass token', fcalls.length === 1 && fcalls[0].token === token);
  await page.screenshot({ path: path.join(SHOTS, 'allset-friend-390.png'), fullPage: true });
  await page.click('#pwOkBack');
  await page.waitForSelector('#s-home:not(.hidden)');
  await page.click('#lockBtn');
  await page.waitForSelector('#s-ngate:not(.hidden)');
  { const ans = await page.getAttribute('#pwChoices', 'data-a'); await page.click('#pwChoices [data-n="' + ans + '"]'); }
  await page.waitForSelector('#s-gate:not(.hidden)');
  check('friend pass: Grown-ups row', await page.isVisible('.pw-gurow[data-a="gift"]'));
  await page.click('.pw-gurow[data-a="gift"]');
  await page.waitForSelector('#pwOvGift:not(.hidden) [data-gift="share"]');
  check('friend pass: Grown-ups sheet shows the card', /use|30|Give a friend/.test(await page.textContent('#pwGuGift')));
  await page.screenshot({ path: path.join(SHOTS, 'gu-friend-390.png') });
  check('friend pass: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
// Release 1.1.1 #39: the website carries the pass into a Home Screen app added from it
{
  const { token, payload } = tokenFor('48h', Date.now() + 30 * 3600e3);
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' };
  {
    const { ctx, page } = await newPage(iphone);
    await page.addInitScript(([tok, e]) => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-WEBS-PASS-2345', kind: '48h', ends_at: e, token: tok })), [token, payload.e]);
    await page.goto(base + '/'); await page.waitForTimeout(500);
    const q = new URL(page.url()).searchParams;
    check('website in Safari: the address carries the pass token only, never the pass code (Security R1)', q.get('restore') === token && q.get('code') === null && !/MOJI/.test(page.url()));
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage();
    await page.addInitScript(([tok, e]) => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-WEBS-PASS-2345', kind: '48h', ends_at: e, token: tok })), [token, payload.e]);
    await page.goto(base + '/'); await page.waitForTimeout(500);
    check('website on non-Apple devices: the address stays clean', !/restore=/.test(page.url()));
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(iphone);
    await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
    await page.goto(base + '/?restore=' + encodeURIComponent(token) + '&code=MOJI-WEBS-PASS-2345'); await page.waitForTimeout(400);
    const nav = page.waitForURL('**/play/**', { timeout: 8000 }).catch(() => null);
    await page.evaluate(() => { const b = [...document.querySelectorAll('a,button')].find((x) => /try a game|play/i.test(x.textContent || '')); if (b) b.click(); });
    await nav; await page.waitForTimeout(1200);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.pass') || 'null'));
    check('website Home Screen app: Play brings the pass into the game', !!saved && saved.token === token, page.url());
    check('website: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
    await ctx.close();
  }
}
// Release 1.1.1 #48: one friend pass reminder in Grown-ups when a 48-hour pass has 6 hours left; how-to sheet shows the pairing number
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('48h', Date.now() + 5 * 3600e3);
  await page.addInitScript(([tok, e]) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-NUDG-PASS-2345', kind: '48h', ends_at: e, token: tok })); } }, [token, payload.e]);
  await page.route('**/.netlify/functions/pass-check', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'on', kind: '48h', ends_at: payload.e, token }) }));
  await page.route('**/.netlify/functions/friend-code', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'GIFT-ABCD-EFGH-JKMN', link: base + '/g/GIFTABCDEFGHJKMN', use_by: new Date(Date.now() + 9 * 86400e3).toISOString(), state: 'ready' }) }));
  const gu = async () => { if (await page.isVisible('#splash')) { await page.click('#splash'); await page.waitForTimeout(400); } await page.click('#lockBtn'); await page.waitForSelector('#s-ngate:not(.hidden)'); const ans = await page.getAttribute('#pwChoices', 'data-a'); await page.click('#pwChoices [data-n="' + ans + '"]'); await page.waitForSelector('#s-gate:not(.hidden)'); await page.waitForTimeout(600); };
  await page.goto(base + '/play/'); await page.waitForTimeout(800);
  await gu();
  check('reminder: 5 hours left shows one friend pass reminder in Grown-ups', /Your pass ends soon\. Know a family/.test(await page.textContent('#pwGuList')) && await page.isVisible('.pw-gurow[data-a="gift"]'));
  await page.screenshot({ path: path.join(SHOTS, 'gu-friend-reminder-390.png') });
  await page.click('#s-gate [data-go="home"]'); await gu();
  check('reminder: shows once, not on the next visit', !/Your pass ends soon/.test(await page.textContent('#pwGuList')));
  await page.click('#pwHSbtn'); await page.waitForSelector('#pwOvHS:not(.hidden)'); await page.waitForTimeout(400);
  check('how-to sheet: shows no pairing number', !/pairing/i.test(await page.textContent('#pwOvHS')));
  check('reminder and sheet: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
// Release 1.1.1 #28 with #42: the game re-checks its saved pass, at most once an hour
{
  const t1 = tokenFor('48h', Date.now() + 2 * 3600e3), t2 = tokenFor('48h', Date.now() + 50 * 3600e3);
  const seed = (tok, kind, e) => ({ code: 'MOJI-CHEK-PASS-2345', kind, ends_at: e, token: tok, email_masked: 'p•••@example.com', device_id: 'a'.repeat(32) });
  const seedInit = (s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('mojia.pass', JSON.stringify(s)); } };
  const openGU = async (page) => { if (await page.isVisible('#splash')) { await page.click('#splash'); await page.waitForTimeout(400); } await page.click('#lockBtn'); await page.waitForSelector('#s-ngate:not(.hidden)'); const ans = await page.getAttribute('#pwChoices', 'data-a'); await page.click('#pwChoices [data-n="' + ans + '"]'); await page.waitForSelector('#s-gate:not(.hidden)'); };
  {
    const { ctx, page } = await newPage(); const calls = [];
    await page.addInitScript(seedInit, seed(t1.token, '48h', t1.payload.e));
    await page.route('**/.netlify/functions/pass-check', (r) => { calls.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'on', kind: '48h', ends_at: t2.payload.e, token: t2.token }) }); });
    await page.goto(base + '/play/'); await page.waitForTimeout(1200);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.pass')));
    check('pass check: sends only the pass token and a device id', calls.length === 1 && Object.keys(calls[0]).sort().join() === 'device_id,token' && calls[0].token === t1.token && /^[0-9a-f]{32}$/.test(calls[0].device_id), JSON.stringify(calls).slice(0, 120));
    check('pass check: Add 48 hours reaches the device; code and email kept', saved.ends_at === t2.payload.e && saved.token === t2.token && saved.code === 'MOJI-CHEK-PASS-2345' && saved.email_masked === 'p•••@example.com');
    await page.reload(); await page.waitForTimeout(900);
    check('pass check: at most once an hour', calls.length === 1);
    await page.evaluate(() => localStorage.setItem('mojia.passCheckAt', String(Date.now() - 2 * 60e3)));
    await openGU(page); await page.waitForTimeout(600);
    check('pass check: opening Grown-ups checks again (once a minute at most)', calls.length === 2);
    check('pass check: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage();
    await page.addInitScript(seedInit, seed(t1.token, '48h', t1.payload.e));
    await page.route('**/.netlify/functions/pass-check', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'off', reason: 'refunded' }) }));
    await page.goto(base + '/play/'); await page.waitForTimeout(1200);
    check('pass check: a refund turns the pass off on the device', (await page.evaluate(() => localStorage.getItem('mojia.pass'))) === null);
    check('pass check: the kid sees free play, no error screen', /\d+:\d\d/.test(await page.locator('#s-home [data-chip]').textContent()) && page.errors.length === 0);
    await openGU(page);
    check('pass check: Grown-ups says why the pass turned off', /turned off\. It was refunded\./.test(await page.textContent('#pwStatus')));
    await page.screenshot({ path: path.join(SHOTS, 'gu-pass-refunded-390.png') });
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage();
    await page.addInitScript(seedInit, seed(t1.token, '48h', t1.payload.e));
    await page.route('**/.netlify/functions/pass-check', (r) => r.abort());
    await page.goto(base + '/play/'); await page.waitForTimeout(1200);
    check('pass check: offline keeps the saved pass', JSON.parse(await page.evaluate(() => localStorage.getItem('mojia.pass'))).token === t1.token && page.errors.length === 0);
    await ctx.close();
  }
  {
    const old = signToken(makeTokenPayload({ id: crypto.randomUUID(), kind: 'forever', ends_at: null }, 'staging', Date.now() - 40 * 86400e3), PEM);
    const fresh = tokenFor('forever');
    for (const online of [false, true]) {
      const { ctx, page } = await newPage();
      await page.addInitScript(seedInit, seed(old, 'forever', 0));
      await page.route('**/.netlify/functions/pass-check', (r) => online ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'on', kind: 'forever', ends_at: 0, token: fresh.token }) }) : r.abort());
      await page.goto(base + '/play/'); await page.waitForTimeout(1500);
      const chip = await page.locator('#s-home [data-chip]').textContent();
      if (online) check('Forever: an expired 30-day token renews on the next check', chip.includes('Forever'), chip);
      else check('Forever: a token past its 30 days stops working offline', !chip.includes('Forever'), chip);
      await ctx.close();
    }
  }
}
// Release 1.1.1 #40: device limit and old links show a clear message with Contact us, never a dead end
for (const [st, title] of [[403, 'This pass is on 5 devices'], [410, 'This link is more than 7 days old']]) {
  const { ctx, page } = await newPage();
  await page.route('**/.netlify/functions/confirm-session', (r) => r.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) }));
  await page.goto(base + '/pass/done/?session_id=cs_test_lim' + st);
  await page.waitForSelector('#dErr:not([hidden])', { timeout: 15000 });
  check('done ' + st + ': ' + title + ', with Contact us', (await page.textContent('#dErrTitle')) === title && await page.isVisible('#dErr [data-contact]'));
  check('done ' + st + ': no grace minutes', (await page.evaluate(() => localStorage.getItem('mojia.grace'))) === null);
  await ctx.close();
}
// Release 1.1.1 #37: a friend pass (or support pass) has no friend pass: no card, no Grown-ups row
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('48h', Date.now() + 48 * 3600e3);
  let fcalls = 0;
  await page.route('**/.netlify/functions/confirm-session', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'GIFT-FRND-PASS-2345', kind: '48h', ends_at: payload.e, token, email_masked: '', plan: 'pass' }) }));
  await page.route('**/.netlify/functions/friend-code', (r) => { fcalls++; r.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'This pass has no friend pass to give.' }) }); });
  await page.goto(base + '/pass/done/?session_id=cs_test_nofriend');
  await page.waitForSelector('#s-allset:not(.hidden)', { timeout: 15000 });
  await page.waitForTimeout(600);
  check('no friend pass: All set shows no Give a friend card', fcalls >= 1 && await page.isHidden('#pwOkGift'));
  await page.click('#pwOkBack');
  await page.waitForSelector('#s-home:not(.hidden)');
  await page.click('#lockBtn');
  await page.waitForSelector('#s-ngate:not(.hidden)');
  { const ans = await page.getAttribute('#pwChoices', 'data-a'); await page.click('#pwChoices [data-n="' + ans + '"]'); }
  await page.waitForSelector('#s-gate:not(.hidden)');
  await page.waitForTimeout(400);
  check('no friend pass: Grown-ups has no Give a friend row', (await page.locator('.pw-gurow[data-a="gift"]').count()) === 0);
  check('no friend pass: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  const gBodies = [];
  await page.route('**/.netlify/functions/redeem-code', (r) => { gBodies.push(r.request().postDataJSON()); r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"x"}' }); });
  await page.goto(base + '/g/GIFTABCDEFGHJKMN?c=fair'); await page.waitForTimeout(1500);
  check('/g/ waits for a tap (link previews never turn the pass on)', /\/g\/GIFTABCDEFGHJKMN/.test(page.url()) && !page.reqs.some((u) => u.includes('/r/GIFT')));
  const hop = page.waitForRequest((q) => /\/r\/GIFTABCDEFGHJKMN\?c=fair$/.test(q.url()), { timeout: 5000 });
  await page.click('#go');
  check('/g/ tap opens /r/ with the code and campaign', !!(await hop.catch(() => null)));
  await page.waitForSelector('#rStop:not([hidden])', { timeout: 8000 }).catch(() => null);
  check('#33 /g/ tap counts: /r/ redeems the gift code without a second tap', gBodies.length >= 1 && gBodies[0].code === 'GIFT-ABCD-EFGH-JKMN', JSON.stringify(gBodies));
  const html = fs.readFileSync(path.join(site, 'g', 'index.html'), 'utf8');
  check('/g/ has the preview card tags', /og:image" content="https:\/\/[a-z.]+\/img\/friend-pass-card\.jpg"/.test(html) && /og:title" content="48 free hours of Mojialand"/.test(html) && fs.existsSync(path.join(site, 'img', 'friend-pass-card.jpg')));
  check('/g/ no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

await browser.close();
A.srv.close(); B.srv.close();
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' browser checks passed');
process.exit(failed.length ? 1 : 0);
