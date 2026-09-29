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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

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
for (const rel of ['index.html', 'play/index.html', 'pass/index.html', 'pass/done/index.html', 'r/index.html', 'admin/index.html']) {
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
  check('All set: Home Screen card, share link, next', await page.isVisible('#pwOkHS') && await page.isVisible('#pwOkShare') && await page.isVisible('.pw-next'));
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
  check('page address carries the pass', new URL(page.url()).search === '?restore=' + encodeURIComponent(token) + '&code=MOJI-HAND-OFFF-2345', page.url());
  check('body is fixed so the app never scrolls under the status bar', (await page.evaluate(() => getComputedStyle(document.body).position)) === 'fixed');
  await ctx.close();
}
{
  const { ctx, page } = await newPage(); // a fresh "Home Screen app" with empty storage
  const { token } = tokenFor('48h', Date.now() + 40 * 3600e3);
  await page.goto(base + '/play/?restore=' + encodeURIComponent(token) + '&code=MOJI-HAND-OFFF-2345');
  await page.waitForFunction(() => { const c = document.querySelector('#s-home [data-chip]'); return c && /h left/.test(c.textContent); }, null, { timeout: 8000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.pass')));
  check('restore: pass saved from the address', saved && saved.token === token && saved.code === 'MOJI-HAND-OFFF-2345');
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

// 9d2. Home Screen handoff through the server: Safari offers, the standalone app claims
{
  const { ctx, page } = await newPage();
  const { token, payload } = tokenFor('48h', Date.now() + 30 * 3600e3);
  const offers = [];
  await page.route('**/.netlify/functions/handoff', (r) => { const b = r.request().postDataJSON(); offers.push(b); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await page.evaluate(() => 0).catch(() => {});
  await page.goto(base + '/play/');
  await page.evaluate(([tok, e]) => localStorage.setItem('mojia.pass', JSON.stringify({ code: 'MOJI-HAND-OFFF-2345', kind: '48h', ends_at: e, token: tok })), [token, payload.e]);
  await page.reload(); await page.waitForTimeout(900);
  check('safari: offers the pass to the server once, with device traits', offers.length === 1 && offers[0].action === 'offer' && offers[0].token === token && offers[0].code === 'MOJI-HAND-OFFF-2345' && /\|/.test(offers[0].traits), JSON.stringify(offers).slice(0, 80));
  await page.reload(); await page.waitForTimeout(700);
  check('safari: no second offer within 10 minutes', offers.length === 1);
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await page.emulateMedia({ media: null });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
  const { token, payload } = tokenFor('48h', Date.now() + 30 * 3600e3);
  const claims = [];
  await page.route('**/.netlify/functions/handoff', (r) => { const b = r.request().postDataJSON(); claims.push(b);
    if (b.action === 'claim') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'MOJI-HAND-OFFF-2345', kind: '48h', ends_at: payload.e, token, email_masked: '' }) });
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await page.goto(base + '/play/');
  await page.waitForSelector('#s-allset:not(.hidden)', { timeout: 8000 });
  check('home screen app: claims the pass on first open and shows Mojialand is on', claims.some((c) => c.action === 'claim' && /^[0-9a-f]{32}$/.test(c.device_id)) && (await page.textContent('#pwOkTitle')) === 'Mojialand is on!');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.pass')));
  check('home screen app: pass saved from the claim', saved && saved.token === token && saved.code === 'MOJI-HAND-OFFF-2345');
  check('home screen app: never offers back', !claims.some((c) => c.action === 'offer'));
  await ctx.close();
}

// 9e. Pattern: a badge after each place, like Match
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/');
  await page.click('#splash');
  await page.click('[data-go="pattern"]');
  await page.waitForSelector('#s-pattern:not(.hidden)');
  await page.waitForTimeout(800);
  check('pattern: the next dot pulses', (await page.locator('#pdots i.next').count()) === 1 && (await page.locator('#pdots i.on').count()) === 0);
  for (let i = 0; i < 3; i++) {
    await page.waitForSelector('#pchoices .choice[data-ok="1"]');
    await page.click('#pchoices .choice[data-ok="1"]');
    await page.waitForTimeout(300);
    if (i === 0) check('pattern: first right answer lights one dot', (await page.locator('#pdots i.on').count()) === 1);
    if (i === 2) { await page.waitForTimeout(400); check('pattern: third dot sets off the party and confetti', await page.locator('#pdots.full').count() === 1 && (await page.locator('#s-pattern .confetti').count()) > 0); await page.screenshot({ path: path.join(SHOTS, 'pattern-dots-full-390.png') }); }
    await page.waitForTimeout(1000);
  }
  await page.waitForSelector('#preward:not(.hidden)', { timeout: 5000 });
  const txt = await page.textContent('#preward');
  check('pattern: bronze medal after the first place', /bronze medal/.test(txt) && (await page.locator('#preward .shelf span.got').count()) === 1, txt.slice(0, 60));
  await page.screenshot({ path: path.join(SHOTS, 'pattern-reward-390.png') });
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
  page.on('dialog', (d) => d.accept('note from test'));
  await page.route('**/.netlify/functions/admin-login', (r) => {
    const m = r.request().method(); const b = m === 'POST' ? r.request().postDataJSON() : {};
    if (m === 'GET') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signed_in: signedIn }) });
    if (b.step === 'send') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"11111111-1111-4111-8111-111111111111"}' });
    if (b.step === 'verify') { if (b.code === '123 456') { signedIn = true; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); } return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"That code did not work. Check it, or send a new one."}' }); }
    signedIn = false; r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const pass = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code_last4: 'AB12', prefix: 'MOJI', kind: '48h', source: 'stripe', email: 'parent@example.com', stripe_session_id: 'cs_test_x1', amount_cents: 150, created_at: new Date().toISOString(), ends_at: new Date(Date.now() + 3600e3).toISOString(), device_limit: 5, status: 'active', note: null, devices: 2 };
  await page.route('**/.netlify/functions/admin-api', (r) => {
    const b = r.request().postDataJSON(); calls.push(b.action);
    if (!signedIn) return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Please sign in."}' });
    const out = { 'passes.list': { passes: [pass] }, 'passes.note': { pass: { ...pass, note: b.note } }, 'passes.add48': { pass: { ...pass, ends_at: new Date(Date.now() + 49 * 3600e3).toISOString() } },
      'codes.create': { code: 'GIFT-ABCD-EFGH-JKMN', pass: {} }, 'passes.refund': { pass: { ...pass, status: 'refunded' } }, 'codes.batch': { codes: Array.from({ length: b.count }, (_, i) => ({ code: 'GIFT-B' + String(i).padStart(3, '0') + '-EFGH-JKMN', id: 'id' + i })) }, 'support.list': { messages: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'mom@example.com', topic: 'pass', message: 'Code not working\n\nCode ending AB12: pass ...', created_at: new Date().toISOString(), status: 'open' }] },
      'support.set': { ok: true }, 'settings.get': { settings: [{ key: 'daily_minutes', value: 3, help: 'Free play each day.' }, { key: 'daily_reset', value: '04:00', help: 'Reset time.' }] }, 'settings.set': { ok: true } }[b.action];
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
  check('admin: Refund button on a Stripe pass', await page.isVisible('#pList [data-act="passes.refund"]'));
  await page.click('#pList [data-act="passes.refund"]');
  await page.waitForFunction(() => /refunded/.test(document.querySelector('#pList .pill').textContent));
  check('admin: refund marks the pass refunded and hides the button', (await page.locator('#pList [data-act="passes.refund"]').count()) === 0);
  await page.screenshot({ path: path.join(SHOTS, 'admin-passes.png') });
  await page.click('[data-tab="codes"]');
  await page.click('#cGo');
  await page.waitForSelector('#cOut:not([hidden])');
  check('admin: gift code shown once with a /r/ link', (await page.textContent('#cCode')) === 'GIFT-ABCD-EFGH-JKMN' && (await page.getAttribute('#cLink', 'href')).endsWith('/r/GIFTABCDEFGHJKMN'));
  check('admin: share row with Text and Email links carrying the code', /GIFT-ABCD-EFGH-JKMN/.test(decodeURIComponent(await page.getAttribute('#cSms', 'href'))) && /r\/GIFTABCDEFGHJKMN/.test(decodeURIComponent(await page.getAttribute('#cMail', 'href'))) && await page.isVisible('#cShare [data-share="share"]'));
  await page.fill('#bCards', '4'); await page.click('#bGo');
  await page.waitForSelector('#bOut:not([hidden])');
  check('admin: cards batch makes 3 codes per card', (await page.locator('#bList > div').count()) === 12 && /12 codes made, 4 cards/.test(await page.textContent('#bOk')));
  const sheet = await page.evaluate(() => ({ cards: document.querySelectorAll('#sheet .bc').length, qrs: [...document.querySelectorAll('#sheet .q img')].filter((i) => i.src.startsWith('data:image/')).length, codes: document.querySelectorAll('#sheet .q code').length }));
  check('admin: print sheet has 4 cards, 12 QR codes, 12 codes', sheet.cards === 4 && sheet.qrs === 12 && sheet.codes === 12, JSON.stringify(sheet));
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: path.join(SHOTS, 'admin-cards-print.png'), fullPage: true });
  await page.emulateMedia({ media: null });
  await page.screenshot({ path: path.join(SHOTS, 'admin-codes.png') });
  await page.click('[data-tab="support"]');
  await page.waitForSelector('#sList .item');
  check('admin: support inbox lists the message', /mom@example\.com/.test(await page.textContent('#sList')));
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
  check('draw: empty canvas opens the page picker first', await page.isVisible('#dfriend') && (await page.getAttribute('#dpages .dpage:first-child', 'aria-label')) === 'Blank page' && (await page.locator('#dpages .dpage').count()) === 37);
  check('draw: book button shows a unicorn page, no words', (await page.locator('#dbook .dbthumb svg path').count()) > 3 && ((await page.textContent('#dbook')).replace(/[\s🖍️️]/gu, '')) === '');
  await page.screenshot({ path: path.join(SHOTS, 'draw-picker-390.png') });
  await page.click('#dpages .dpage.blank');
  check('draw: blank page closes the picker', await page.isHidden('#dfriend'));
  const ink = () => page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  const line = () => page.evaluate(() => { const c = document.querySelector('#dline'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  const box = await page.locator('#dmain').boundingBox();
  const setSize = async (t) => { const s = await page.locator('#dslider').boundingBox(); await page.mouse.click(s.x + 14 + t * (s.width - 28), s.y + s.height / 2); };
  const prevInk = () => page.evaluate(() => { const c = document.querySelector('#dprev'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, h = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { n++; h = (h * 31 + d[i - 3] + d[i - 2] * 3 + d[i - 1] * 7) >>> 0; } return { n, h }; });
  const stroke = async (x0, y0, x1, y1, steps = 12) => { await page.mouse.move(box.x + x0, box.y + y0); await page.mouse.down(); for (let i = 1; i <= steps; i++) await page.mouse.move(box.x + x0 + (x1 - x0) * i / steps, box.y + y0 + (y1 - y0) * i / steps); await page.mouse.up(); };
  check('draw: twelve tools, one size slider with a preview card, seven brand colors', (await page.locator('#dtools .dtool').count()) === 12 && (await page.locator('#dslider[role=slider]').count()) === 1 && (await page.locator('#dprev').count()) === 1 && (await page.locator('#dswatches .dsw').count()) === 7);
  const small = await page.evaluate(() => [...document.querySelectorAll('#s-draw button')].filter((b) => b.offsetParent && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44)).map((b) => b.id || b.className || b.getAttribute('aria-label')));
  check('draw: every visible button is at least 44 px', small.length === 0, small.join(','));
  const pal = await page.evaluate(() => [...document.querySelectorAll('#dswatches .dsw i')].map((b) => getComputedStyle(b).backgroundColor));
  check('draw: palette is the brand colors', pal.join('|') === 'rgb(113, 56, 209)|rgb(255, 95, 162)|rgb(255, 200, 61)|rgb(77, 188, 236)|rgb(114, 214, 154)|rgb(48, 37, 74)|rgb(255, 255, 255)', pal.join('|'));
  check('draw: canvas starts empty', (await ink()) === 0);
  await stroke(40, 60, 250, 90);
  const a1 = await ink();
  check('draw: crayon leaves a mark', a1 > 500, String(a1));
  await page.click('#dtools [data-tool="marker"]'); await page.click('#dswatches .dsw:nth-child(2)'); await stroke(40, 130, 250, 150);
  const a2 = await ink();
  check('draw: marker adds a mark', a2 > a1, a2 + ' > ' + a1);
  await page.click('#dtools [data-tool="paint"]'); await stroke(40, 200, 250, 220);
  const a3 = await ink();
  check('draw: paint brush adds a wide mark', a3 - a2 > 4000, String(a3 - a2));
  await page.click('#dtools [data-tool="trail"]');
  check('draw: emoji tools swap colors for the emoji tray', await page.isVisible('#dtray') && await page.isHidden('#dswatches'));
  await stroke(40, 280, 300, 290, 20);
  const a4 = await ink();
  check('draw: emoji brush leaves a trail', a4 > a3, String(a4 - a3));
  await page.click('#dtools [data-tool="stamp"]'); await page.click('#dtray .tile:nth-child(2)');
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
  check('draw: undo and redo sit in the top bar, all tools show without scrolling', await page.evaluate(() => { const u = document.querySelector('#dundo').getBoundingClientRect(), r = document.querySelector('#dredo').getBoundingClientRect(), t = document.querySelector('#dtools'), tb = t.getBoundingClientRect(); return u.bottom <= tb.top && Math.abs(u.top - r.top) < 2 && getComputedStyle(t).overflowX === "visible" && [...t.children].every((b) => { const x = b.getBoundingClientRect(); return x.right <= innerWidth && x.left >= 0; }); }));
  check('draw: colors and size sit above the canvas', await page.evaluate(() => document.querySelector('#dswatches').getBoundingClientRect().bottom < document.querySelector('#dstage').getBoundingClientRect().top && document.querySelector('#dsizes').getBoundingClientRect().bottom < document.querySelector('#dstage').getBoundingClientRect().top));
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
  check('draw: after Clear the page picker opens', await page.isVisible('#dfriend'));
  await page.click('#dundo');
  check('draw: Undo brings back a cleared drawing', (await ink()) === a4, String(await ink()));
  await page.click('#dclear'); await page.click('#dcyes'); await page.waitForTimeout(800);
  await page.click('#dclear');
  check('draw: Clear on an empty page does nothing', await page.isHidden('#dconfirm'));
  // round 2 tools: pen, sizes, rainbow, glitter, eraser
  await page.click('#dtools [data-tool="pen"]'); await page.click('#dswatches .dsw:nth-child(6)');
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
  await page.click('#dtools [data-tool="rainbow"]'); await stroke(40, 170, 300, 170);
  const rb = await page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const hues = new Set(); for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3] > 200) hues.add(Math.round(d[i] / 64) + ',' + Math.round(d[i + 1] / 64) + ',' + Math.round(d[i + 2] / 64)); return hues.size; });
  check('draw: rainbow brush lays down many colors', rb >= 6, String(rb));
  const s0 = await ink();
  await page.click('#dtools [data-tool="sprinkles"]'); await stroke(40, 250, 300, 250);
  const sp = await page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, Math.round(236 * 2), c.width, 56).data; const hues = new Set(); for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 220) hues.add(Math.round(d[i] / 64) + ',' + Math.round(d[i + 1] / 64) + ',' + Math.round(d[i + 2] / 64)); return hues.size; });
  check('draw: sprinkles brush tosses many colored bits', (await ink()) > s0 && sp >= 5, String(sp));
  await page.screenshot({ path: path.join(SHOTS, 'draw-sprinkles-390.png') });
  const g0 = await ink();
  await setSize(.5); const pr = await prevInk(); await page.click('#dtools [data-tool="glitter"]'); const pg = await prevInk();
  check('draw: preview card changes when the tool changes', pg.n > 20 && pg.h !== pr.h);
  await page.focus('#dslider'); await page.keyboard.press('ArrowRight');
  check('draw: arrow keys move the slider', (await page.getAttribute('#dslider', 'aria-valuenow')) === '60'); await stroke(40, 240, 300, 240);
  check('draw: glitter adds sparkles', (await ink()) > g0, String((await ink()) - g0));
  // ice cream: waffle cone then a scoop on top
  const w0 = await ink();
  await page.click('#dtools [data-tool="waffle"]'); await stroke(150, 330, 190, 400, 10);
  const waf = await page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let tan = 0, dark = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; const r = d[i], g = d[i + 1], b = d[i + 2]; if (r > 200 && g > 150 && g < 215 && b < 140) tan++; else if (r > 180 && r < 215 && g > 115 && g < 150 && b < 90) dark++; } return { tan, dark }; });
  check('draw: waffle cone draws tan with a darker crosshatch', (await ink()) > w0 && waf.tan > 300 && waf.dark > 50, JSON.stringify(waf));
  const i0 = await ink();
  await page.click('#dtools [data-tool="scoop"]'); await page.click('#dswatches .dsw:nth-child(2)'); await stroke(140, 320, 200, 320, 8);
  check('draw: ice cream scoop adds a round scoop', (await ink()) - i0 > 1500, String((await ink()) - i0));
  check('draw: scoop and waffle tools show a picture, no words', ((await page.textContent('#dtools [data-tool="scoop"]')) + (await page.textContent('#dtools [data-tool="waffle"]'))).replace(/[\s🍦🧇️]/gu, '') === '');
  await page.screenshot({ path: path.join(SHOTS, 'draw-icecream-390.png') });
  await page.click('#dtools [data-tool="crayon"]'); await page.click('#dswatches .dsw:nth-child(1)'); await stroke(40, 320, 300, 320);
  const holes = await page.evaluate(() => { const c = document.querySelector('#dmain'); const k = c.getContext('2d'); const y = Math.round((320 - 8) * 2); const d = k.getImageData(100, y, 400, 6).data; let empty = 0, full = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] < 20) empty++; else full++; } return { empty, full }; });
  check('draw: crayon edge shows paper grain gaps', holes.empty > 150 && holes.full > 150, JSON.stringify(holes));
  await page.click('#dtools [data-tool="paint"]'); await stroke(20, 400, 360, 400, 40);
  await page.screenshot({ path: path.join(SHOTS, 'draw-tools2-390.png') });
  const e0 = await ink();
  check('draw: eraser sits in the top bar with undo and redo, not in the tool grid', (await page.locator('#dtools [data-tool="eraser"]').count()) === 0 && await page.evaluate(() => { const e = document.querySelector('#derase').getBoundingClientRect(), r = document.querySelector('#dredo').getBoundingClientRect(); return Math.abs(e.top - r.top) < 2 && e.left > r.left && e.width >= 44 && e.height >= 44; }) && !!(await page.$('#derase svg')));
  check('draw: eraser has a gray border until picked', await page.evaluate(() => getComputedStyle(document.querySelector('#derase')).borderTopColor === 'rgb(233, 226, 247)'));
  await page.click('#derase');
  check('draw: picked eraser gets the purple border', await page.evaluate(() => getComputedStyle(document.querySelector('#derase')).borderTopColor === 'rgb(113, 56, 209)'));
  check('draw: eraser button lights up when picked, grid tools go dark', /\bon\b/.test(await page.getAttribute('#derase', 'class')) && (await page.getAttribute('#derase', 'aria-pressed')) === 'true' && (await page.locator('#dtools .dtool.on').count()) === 0);
  await stroke(20, 60, 360, 400, 30);
  const e1 = await ink();
  check('draw: eraser removes ink', e1 < e0, e0 + ' -> ' + e1);
  await page.click('#dundo');
  check('draw: Undo brings back erased ink', (await ink()) === e0, String(await ink()));
  // wet sponge smears the paint: pulls color into blank paper, keeps a record for undo and redo
  const sig = () => page.evaluate(() => { const c = document.querySelector('#dmain'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) >>> 0; return h; });
  const below = () => page.evaluate(() => { const c = document.querySelector('#dmain'), k = c.width / c.getBoundingClientRect().width; const d = c.getContext('2d').getImageData(Math.round(150 * k), Math.round(430 * k), Math.round(100 * k), Math.round(40 * k)).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; });
  const sp0 = await sig(), b0 = await below();
  await page.click('#dtools [data-tool="sponge"]');
  check('draw: picking the sponge turns the eraser off', !/\bon\b/.test(await page.getAttribute('#derase', 'class')) && /\bon\b/.test(await page.getAttribute('#dtools [data-tool="sponge"]', 'class')));
  await stroke(200, 380, 200, 470, 20);
  const sp1 = await sig(), b1 = await below();
  check('draw: sponge smears paint onto blank paper below the stroke', sp1 !== sp0 && b1 > b0 + 200, b0 + ' -> ' + b1);
  await page.click('#dundo');
  check('draw: Undo removes the smear', (await sig()) === sp0);
  await page.click('#dredo');
  check('draw: Redo puts back the same smear', (await sig()) === sp1);
  await page.screenshot({ path: path.join(SHOTS, 'draw-sponge-390.png') });
  await page.click('#dclear'); await page.waitForTimeout(350); await page.click('#dcyes'); await page.waitForTimeout(800);
  await page.click('#dtools [data-tool="crayon"]');
  // color a friend
  await page.click('#dbook');
  check('draw: coloring book shows 36 pages and a blank page', (await page.locator('#dpages .dpage').count()) === 37 && (await page.locator('#dpages .dpage svg').count()) === 36);
  await page.screenshot({ path: path.join(SHOTS, 'draw-friends-390.png') });
  const pgNames = await page.evaluate(() => [...document.querySelectorAll('#dpages .dpage')].map((b) => b.getAttribute('aria-label')));
  check('draw: book starts with the blank page and the unicorn, and has the new treat, sparkle, and animal pages', pgNames[0] === 'Blank page' && pgNames[1] === 'unicorn' && ['ice cream cone', 'cupcake', 'crown', 'rainbow', 'donut', 'kitty', 'sundae', 'castle', 'magic wand', 'diamond', 'dinosaur', 'mermaid tail'].every((n) => pgNames.includes(n)) && new Set(pgNames).size === 37, pgNames.join(','));
  await page.click('#dpages .dpage[aria-label="ice cream cone"]');
  check('draw: ice cream cone outline appears', (await line()) > 1000);
  await page.click('#dbook');
  await page.click('#dpages .dpage[aria-label="smiley"]');
  check('draw: smiley outline appears, crayon selected', (await line()) > 1000 && /on/.test(await page.getAttribute('#dtools [data-tool="crayon"]', 'class')));
  await page.click('#dtools [data-tool="paint"]');
  for (let y = 40; y < box.height - 30; y += 18) await stroke(20, y, box.width - 20, y, 8);
  await page.waitForTimeout(200);
  check('draw: coloring the friend sets off the cheer', (await page.getAttribute('#dstage', 'data-cheered')) === 'smiley');
  await page.screenshot({ path: path.join(SHOTS, 'draw-friend-done-390.png') });
  await page.click('#dbook');
  check('draw: finished page gets a gold star in the book', (await page.locator('#dpages .dpage[aria-label="smiley"] .gold').count()) === 1);
  await page.click('#dfriend [data-dclose]');
  // fridge scene
  await page.click('#dfridgeBtn');
  check('draw: fridge scene with 9 empty spots, first spot glows', await page.isVisible('#dfridge .fridge') && (await page.locator('#dfslots .fslot.empty').count()) === 9 && (await page.locator('#dfslots .fslot.glow').count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-empty-390.png') });
  await page.click('#dfslots .fslot.glow'); await page.waitForTimeout(800);
  const fr = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.fridge') || '[]'));
  check('draw: tapping a spot hangs the drawing there (this device only)', fr.length === 1 && fr[0].slot === 0 && /^data:image\/jpeg;base64,/.test(fr[0].src) && fr[0].src.length < 600000, String(fr[0] && fr[0].src.length));
  check('draw: fresh page after hanging the drawing', (await ink()) === 0 && (await line()) === 0 && (await page.locator('#dfslots .fslot.full').count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-390.png') });
  await page.click('#dfslots .fslot.empty'); await page.waitForTimeout(200);
  check('draw: empty page does not go on the fridge', (await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.fridge')).length)) === 1);
  await page.click('#dfslots .fslot.full'); await page.waitForTimeout(300);
  check('draw: tapping a fridge drawing opens it', await page.isHidden('#dfridge') && (await ink()) > 50000);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= 390 && document.querySelector('#s-draw .helprow').getBoundingClientRect().height < 60);
  check('draw: fits 390 wide, help row on one line', fits);
  const swOk = await page.evaluate(() => { const r = document.querySelector('#dswatches').getBoundingClientRect(); return [...document.querySelectorAll('#dswatches .dsw')].every((b) => { const q = b.getBoundingClientRect(); return q.left >= r.left && q.right <= r.right; }); });
  check('draw: every color shows without scrolling at 390', swOk);
  check('draw: kid screen has no links and no inputs', (await page.locator('#s-draw a, #s-draw input').count()) === 0);
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
  await page.click('#pwPhGrid .rm');
  check('draw: Grown-ups remove a drawing', (await page.locator('#pwPhGrid img').count()) === 0 && (await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.fridge')).length)) === 0);
  check('draw: zero third-party requests', page.reqs.every((u) => u.startsWith(base) || u.startsWith('data:')));
  check('draw: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}


// 11b. Emoji Draw: full fridge door sends the oldest drawing to the basket
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true');
    const c = document.createElement('canvas'); c.width = 30; c.height = 40; const src = c.toDataURL('image/png');
    localStorage.setItem('mojia.fridge', JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ id: 'd' + i, src, t: 1000 + i, slot: i })))); });
  await page.goto(base + '/play/');
  await page.click('#splash');
  await page.click('[data-go="draw"]');
  await page.waitForSelector('#s-draw:not(.hidden)'); await page.waitForTimeout(300);
  const box = await page.locator('#dmain').boundingBox();
  await page.click('#dpages .dpage.blank');
  await page.mouse.move(box.x + 40, box.y + 60); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 90, { steps: 10 }); await page.mouse.up();
  await page.click('#dfridgeBtn'); await page.waitForTimeout(300);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('mojia.fridge')).map((x) => x.id + ':' + x.slot).join(','));
  check('draw: full door moves the oldest drawing to the basket', /d0:-1/.test(st) && (await page.locator('#dfslots .fslot.empty.glow').count()) === 1 && (await page.textContent('#dbasket b')) === '1', st);
  await page.screenshot({ path: path.join(SHOTS, 'draw-fridge-full-390.png') });
  await page.click('#dfslots .fslot.glow'); await page.waitForTimeout(600);
  check('draw: new drawing takes the open spot', (await page.locator('#dfslots .fslot.full').count()) === 9);
  await page.click('#dbasket');
  check('draw: basket shows the older drawing', await page.isVisible('#dfbasketview') && (await page.locator('#dfgrid img').count()) === 1);
  await page.click('#dfback');
  check('draw: back from the basket shows the fridge', await page.isVisible('#dfridge .fridge'));
  check('draw: fridge and basket: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}


// 11c. Emoji Draw on upright iPad: tools in a side panel so the drawing area is as big as possible
{
  const { ctx, page } = await newPage({ viewport: { width: 480, height: 691 }, deviceScaleFactor: 2, isMobile: false });
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/');
  await page.click('#splash');
  await page.click('[data-go="draw"]');
  await page.waitForSelector('#s-draw:not(.hidden)'); await page.waitForTimeout(400);
  await page.click('#dpages .dpage.blank');
  const g = await page.evaluate(() => { const c = document.querySelector('#dmain').getBoundingClientRect(), p = document.querySelector('#s-draw .dctl'), pr = p.getBoundingClientRect(); return { area: Math.round(c.width * c.height), side: pr.right <= c.left, fits: p.scrollHeight <= p.clientHeight + 1, sw: [...document.querySelectorAll('#dswatches .dsw')].every((b) => { const r = b.getBoundingClientRect(); return r.bottom <= pr.bottom && r.width >= 44; }) }; });
  check('draw iPad upright: tools sit in a side panel, drawing area over 140,000 square points', g.side && g.area > 140000, JSON.stringify(g));
  check('draw iPad upright: every tool, the slider, and all 7 colors fit without scrolling', g.fits && g.sw, JSON.stringify(g));
  const small = await page.evaluate(() => [...document.querySelectorAll('#s-draw button,#dslider')].filter((b) => b.offsetParent && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44)).map((b) => b.id || b.className));
  check('draw iPad upright: every control is at least 44 px', small.length === 0, small.join(','));
  await page.screenshot({ path: path.join(SHOTS, 'draw-ipad-upright.png') });
  check('draw iPad upright: no CSP violations or errors', page.csp.length === 0 && page.errors.length === 0, page.csp.concat(page.errors).join(' | '));
  await ctx.close();
}

// 12. Home: big stamp canvas first, featured card peeks at the bottom edge, games scroll below
{
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('mojia.demos', 'false'); localStorage.setItem('mojia.welcomed', 'true'); });
  await page.goto(base + '/play/');
  await page.click('#splash'); await page.waitForTimeout(400);
  const lay = await page.evaluate(() => { const c = document.querySelector('#canvas').getBoundingClientRect(), f = document.querySelector('#hfeat .hfeat').getBoundingClientRect(), sc = document.querySelector('#s-home'); return { canvas: Math.round(c.height), featTop: Math.round(f.top), vh: innerHeight, scrolls: sc.scrollHeight > sc.clientHeight + 100 }; });
  check('home: stamp canvas fills most of the first screen', lay.canvas >= 420, JSON.stringify(lay));
  check('home: featured card peeks at the bottom edge', lay.featTop < lay.vh - 60 && lay.featTop > lay.vh - 150, JSON.stringify(lay));
  check('home: games below the fold scroll', lay.scrolls);
  check('home: original header kept (centered logo, tagline, timer chip, gear over Grown-ups)', await page.isVisible('.homehead .tagline') && await page.isVisible('#lockBtn .gl') && await page.isVisible('.homehead [data-chip]') && await page.evaluate(() => { const r = document.querySelector('.homehead .wordmark').getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 12; }));
  check('home: new Draw game is featured with a New! tag', (await page.getAttribute('#hfeat .hfeat', 'data-go')) === 'draw' && /New!/.test(await page.textContent('#hfeat')));
  check('home: grid shows the other four games once each', (await page.evaluate(() => [...document.querySelectorAll('#hgrid .hcell')].map((b) => b.dataset.go).join(','))) === 'pattern,bounce,match,parade');
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

await browser.close();
A.srv.close(); B.srv.close();
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' browser checks passed');
process.exit(failed.length ? 1 : 0);
