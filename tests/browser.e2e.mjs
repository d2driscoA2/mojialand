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
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function serve(site) {
  const blocks = parseHeaders(site);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(u.pathname);
    let f = path.join(site, p);
    if (!f.startsWith(site)) { res.writeHead(403).end(); return; }
    if (/^\/r\/[^/]+$/.test(p)) f = path.join(site, 'r', 'index.html'); // _redirects: /r/*  /r/index.html  200
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
for (const rel of ['index.html', 'play/index.html', 'pass/index.html', 'pass/done/index.html', 'r/index.html']) {
  const n = (fs.readFileSync(path.join(site, rel), 'utf8').match(/<script>/g) || []).length;
  check('one inline script: ' + rel, n === 1, String(n));
}

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
  check('All set: Home Screen card, share link, next', await page.isVisible('#pwOkHS') && await page.isVisible('#pwOkShare') && await page.isVisible('.pw-next'));
  const fits = await page.evaluate(() => { const s = document.querySelector('#s-allset'); return s.scrollHeight <= s.clientHeight + 1; });
  check('All set fits at 390x844 with no scrolling', fits);
  await page.screenshot({ path: path.join(SHOTS, 'allset-48h-390.png') });
  await page.click('#pwOkShare');
  check('Send code: Coming soon sheet', await page.isVisible('#pwOvSoon'));
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
  await page.click('#pwHelp');
  check('game: Contact us opens a form, not an email app', await page.isVisible('#pwOvContact') && await page.isVisible('#pwCEmail'));
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

// 10. play normal load: splash, no foreign requests, no CSP errors
{
  const { ctx, page } = await newPage();
  await page.goto(base + '/play/');
  await page.waitForTimeout(600);
  check('play normal load shows welcome screen', await page.isVisible('#splash'));
  check('play: zero third-party requests', page.reqs.every((u) => u.startsWith(base) || u.startsWith('data:')));
  check('play: no CSP violations', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

await browser.close();
A.srv.close(); B.srv.close();
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' browser checks passed');
process.exit(failed.length ? 1 : 0);
