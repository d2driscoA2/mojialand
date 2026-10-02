import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { KEYS, setEnv, fakeDb, fakeStripe, paidSession, ev } from './helpers.mjs';
import { ALPHABET, deriveCode, normalizeCode, codeHash, codeLast4, randomCode } from '../netlify/functions/_lib/codes.mjs';
import { makeTokenPayload, signToken, verifyToken } from '../netlify/functions/_lib/token.mjs';
import { grantPass } from '../netlify/functions/_lib/grant.mjs';
import { setStripe } from '../netlify/functions/_lib/stripe.mjs';
import { originFromHost, maskEmail } from '../netlify/functions/_lib/http.mjs';
import { handler as createCheckout } from '../netlify/functions/create-checkout.mjs';
import { handler as confirmSession } from '../netlify/functions/confirm-session.mjs';
import { handler as webhook } from '../netlify/functions/stripe-webhook.mjs';
import { handler as redeem } from '../netlify/functions/redeem-code.mjs';
import { handler as contact } from '../netlify/functions/contact.mjs';
import { handler as adminLogin } from '../netlify/functions/admin-login.mjs';
import { handler as adminApi } from '../netlify/functions/admin-api.mjs';
import { handler as redeemFn } from '../netlify/functions/redeem-code.mjs';
import { handler as settingsFn } from '../netlify/functions/settings.mjs';
import { handler as handoff } from '../netlify/functions/handoff.mjs';
import { handler as friendFn } from '../netlify/functions/friend-code.mjs';
import { friendPass } from '../netlify/functions/_lib/friend.mjs';
import { deriveFriendCode } from '../netlify/functions/_lib/codes.mjs';
import ping from '../netlify/functions/ping.mjs';
import { placeFromGeo, readPing } from '../netlify/functions/_lib/analytics.mjs';
import { localMidnight, lastDays } from '../netlify/functions/_lib/analytics-admin.mjs';

let db, stripe;
beforeEach(() => {
  setEnv();
  db = fakeDb();
  globalThis.fetch = db.fetch;
  stripe = fakeStripe();
  setStripe(stripe);
});

const CODE_RE = new RegExp('^MOJI-[' + ALPHABET + ']{4}-[' + ALPHABET + ']{4}-[' + ALPHABET + ']{4}$');

test('codes: same session gives the same code; format and alphabet', () => {
  const a = deriveCode('pep', 'cs_test_abc'), b = deriveCode('pep', 'cs_test_abc');
  assert.equal(a, b);
  assert.match(a, CODE_RE);
  assert.notEqual(a, deriveCode('pep', 'cs_test_abd'));
  assert.notEqual(a, deriveCode('other', 'cs_test_abc'));
  for (let i = 0; i < 500; i++) assert.match(deriveCode('pep', 'cs_' + i), CODE_RE);
  for (let i = 0; i < 200; i++) assert.match(randomCode(), CODE_RE);
  assert.equal(ALPHABET.length, 31);
  for (const c of '01OIL') assert.ok(!ALPHABET.includes(c));
});

test('codes: normalize and hash', () => {
  const code = deriveCode('pep', 'cs_test_1');
  const messy = ' ' + code.toLowerCase().replace(/-/g, ' ') + ' ';
  assert.equal(normalizeCode(messy), code);
  assert.equal(normalizeCode(code.replace(/-/g, '')), code);
  assert.equal(codeHash('pep', messy), codeHash('pep', code));
  assert.equal(codeHash('pep', code), crypto.createHash('sha256').update('pep' + code).digest('hex'));
  assert.notEqual(codeHash('pep', code), codeHash('pep2', code));
  assert.equal(codeLast4(code), code.slice(-4));
  assert.equal(normalizeCode('MOJI-0000-1111-2222'), null);
  assert.equal(normalizeCode('hello'), null);
  assert.equal(codeHash('pep', 'nope'), null);
});

test('token: sign and verify round trip; tampering fails', () => {
  const pass = { id: crypto.randomUUID(), kind: '48h', ends_at: new Date(Date.now() + 3600e3).toISOString() };
  const payload = makeTokenPayload(pass, 'staging');
  const tok = signToken(payload, KEYS.pem);
  assert.deepEqual(verifyToken(tok, KEYS.jwk), payload);
  const [body, sig] = tok.split('.');
  assert.equal(Buffer.from(sig, 'base64url').length, 64, 'P1363 signature is 64 bytes');
  const forged = Buffer.from(JSON.stringify({ ...payload, k: 'forever', e: 0 })).toString('base64url');
  assert.equal(verifyToken(forged + '.' + sig, KEYS.jwk), null);
  const flip = body.slice(0, -2) + (body.at(-2) === 'A' ? 'B' : 'A') + body.at(-1);
  assert.equal(verifyToken(flip + '.' + sig, KEYS.jwk), null);
  assert.equal(verifyToken(tok, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })), null);
  const fp = makeTokenPayload({ id: 'x', kind: 'forever', ends_at: null }, 'live');
  assert.equal(fp.k, 'forever'); assert.equal(fp.e, 0);
});

test('startup guard: wrong-mode keys and missing vars refuse to run', async () => {
  setEnv({ MOJIA_ENV: 'staging', STRIPE_SECRET_KEY: 'sk_live_x' });
  let r = await createCheckout(ev({ plan: 'pass' }));
  assert.equal(r.statusCode, 500); assert.equal(JSON.parse(r.body).error, 'Checkout is not set up yet.');
  setEnv({ MOJIA_ENV: 'staging', STRIPE_SECRET_KEY: 'rk_live_x' });
  assert.equal((await webhook(ev('{}'))).statusCode, 500);
  setEnv({ MOJIA_ENV: 'staging', STRIPE_PUBLISHABLE_KEY: 'pk_live_x' });
  assert.equal((await confirmSession(ev({ session_id: 'cs_test_abcdefghij' }))).statusCode, 500);
  setEnv({ MOJIA_ENV: undefined, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x' });
  assert.equal((await createCheckout(ev({ plan: 'pass' }))).statusCode, 500);
  setEnv({ MOJIA_ENV: undefined, STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_PUBLISHABLE_KEY: 'pk_test_x' });
  assert.equal((await createCheckout(ev({ plan: 'pass' }))).statusCode, 500);
  setEnv({ MOJIA_ENV: undefined, STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x' });
  assert.equal((await createCheckout(ev({ plan: 'pass' }))).statusCode, 200);
  setEnv({ STRIPE_PRICE_FOREVER: undefined });
  r = await createCheckout(ev({ plan: 'pass' }));
  assert.equal(r.statusCode, 500); assert.equal(r.body, JSON.stringify({ error: 'Checkout is not set up yet.' }));
  setEnv({ PASS_SIGNING_PRIVATE_KEY: undefined });
  assert.equal((await confirmSession(ev({ session_id: 'cs_test_abcdefghij' }))).statusCode, 500);
  assert.equal(db.calls.filter((c) => !c.includes('rate_hit')).length, 0);
});

test('create-checkout: input validation', async () => {
  for (const bad of [{}, { plan: 'free' }, { plan: 'toString' }, { plan: ['pass'] }, { plan: '__proto__' }]) {
    const r = await createCheckout(ev(bad));
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await createCheckout(ev('not json'))).statusCode, 400);
  assert.equal((await createCheckout(ev({ plan: 'pass' }, {}, 'GET'))).statusCode, 405);
  assert.equal((await createCheckout(ev({ plan: 'add' }))).statusCode, 400);
  const r = await createCheckout(ev({ plan: 'up', code: 'MOJI-AAAA-BBBB-CCCC' }));
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).error, "That pass can't be changed. Pick a new pass.");
  assert.equal(stripe.calls.create.length, 0);
});

test('create-checkout: builds an embedded session from env prices only', async () => {
  const r = await createCheckout(ev({ plan: 'life', price: 1 }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { clientSecret: 'cs_test_created123_secret_abc', publishableKey: 'pk_test_fake' });
  assert.equal(r.headers['Access-Control-Allow-Origin'], undefined);
  const p = stripe.calls.create[0];
  assert.equal(p.ui_mode, 'embedded_page');
  assert.equal(p.mode, 'payment');
  assert.deepEqual(p.line_items, [{ price: 'price_forever', quantity: 1 }]);
  assert.equal(p.return_url, 'https://mojialand.displayedux.com/pass/done/?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(p.allow_promotion_codes, true);
  assert.equal(p.discounts, undefined);
  assert.deepEqual(p.metadata, { plan: 'life', env: 'staging' });
  assert.equal(p.customer_creation, undefined);
  // promo
  const r2 = await createCheckout(ev({ plan: 'pass', promo: 'FRIENDS50' }, { host: 'evil.example' }));
  assert.equal(r2.statusCode, 200);
  const p2 = stripe.calls.create[1];
  assert.deepEqual(p2.discounts, [{ promotion_code: 'promo_123' }]);
  assert.equal(p2.allow_promotion_codes, undefined);
  assert.ok(p2.return_url.startsWith('https://mojialand.com/'));
  assert.equal((await createCheckout(ev({ plan: 'pass', promo: 'NOPE' }))).statusCode, 400);
  assert.equal(originFromHost('localhost:8888'), 'http://localhost:8888');
  assert.equal(originFromHost('mojialand.com.evil.io'), 'https://mojialand.com');
});

test('create-checkout: add and up check the pass', async () => {
  const pep = process.env.RESTORE_CODE_PEPPER;
  const code = deriveCode(pep, 'cs_test_orig');
  const id = crypto.randomUUID();
  db.passes.push({ id, code_hash: codeHash(pep, code), kind: '48h', status: 'active', ends_at: new Date(Date.now() + 3600e3).toISOString() });
  let r = await createCheckout(ev({ plan: 'add', code: code.toLowerCase() }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(stripe.calls.create.at(-1).metadata, { plan: 'add', env: 'staging', pass_id: id });
  assert.deepEqual(stripe.calls.create.at(-1).line_items, [{ price: 'price_48h', quantity: 1 }]);
  // ended 3 days ago: add refused, up allowed
  db.passes[0].status = 'ended'; db.passes[0].ends_at = new Date(Date.now() - 3 * 864e5).toISOString();
  assert.equal((await createCheckout(ev({ plan: 'add', code }))).statusCode, 400);
  r = await createCheckout(ev({ plan: 'up', code }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(stripe.calls.create.at(-1).line_items, [{ price: 'price_upgrade', quantity: 1 }]);
  // ended 8 days ago: up refused
  db.passes[0].ends_at = new Date(Date.now() - 8 * 864e5).toISOString();
  assert.equal((await createCheckout(ev({ plan: 'up', code }))).statusCode, 400);
});

test('create-checkout: rate limit 5 per minute', async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await createCheckout(ev({ plan: 'pass' }))).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  assert.ok([...db.rate.keys()].every((k) => /^[0-9a-f]{64}$/.test(k)), 'rate keys are hashes');
});

test('grantPass: idempotent for pass, life, add, up', async () => {
  const s = paidSession('cs_test_one', 'pass');
  const a = await grantPass(s), b = await grantPass(s);
  assert.equal(db.passes.length, 1);
  assert.equal(a.code, b.code);
  assert.equal(a.pass.id, b.pass.id);
  assert.equal(db.passes[0].code_hash, codeHash(process.env.RESTORE_CODE_PEPPER, a.code));
  assert.equal(db.passes[0].code_last4, a.code.slice(-4));
  assert.equal(db.passes[0].kind, '48h');
  assert.ok(!JSON.stringify(db.passes).includes(a.code), 'code itself never stored');
  const ends0 = new Date(db.passes[0].ends_at).getTime();
  const add = paidSession('cs_test_add', 'add', { pass_id: a.pass.id });
  await grantPass(add); await grantPass(add);
  assert.equal(new Date(db.passes[0].ends_at).getTime(), ends0 + 48 * 3600e3);
  const up = paidSession('cs_test_up', 'up', { pass_id: a.pass.id });
  const u1 = await grantPass(up), u2 = await grantPass(up);
  assert.equal(u1.pass.kind, 'forever'); assert.equal(u2.pass.kind, 'forever');
  assert.equal(db.passes[0].ends_at, null); assert.equal(u1.code, a.code, 'upgrade keeps the same code');
  const life = await grantPass(paidSession('cs_test_life', 'life'));
  assert.equal(life.pass.kind, 'forever'); assert.equal(db.passes.length, 2);
  await assert.rejects(grantPass({ ...s, payment_status: 'unpaid' }));
});

test('confirm-session: pending, paid, bad ids', async () => {
  assert.equal((await confirmSession(ev({ session_id: 'nope' }))).statusCode, 400);
  assert.equal((await confirmSession(ev({ session_id: 'cs_test_missing1' }))).statusCode, 404);
  stripe.sessions.set('cs_test_pending1', { ...paidSession('cs_test_pending1', 'pass'), payment_status: 'unpaid', status: 'open' });
  let r = await confirmSession(ev({ session_id: 'cs_test_pending1' }));
  assert.equal(r.statusCode, 402); assert.deepEqual(JSON.parse(r.body), { status: 'pending' });
  stripe.sessions.set('cs_test_paid0001', paidSession('cs_test_paid0001', 'pass'));
  r = await confirmSession(ev({ session_id: 'cs_test_paid0001' }));
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.code, deriveCode(process.env.RESTORE_CODE_PEPPER, 'cs_test_paid0001'));
  assert.equal(d.kind, '48h'); assert.equal(d.plan, 'pass'); assert.equal(d.email_masked, 'p•••@example.com');
  const payload = verifyToken(d.token, KEYS.jwk);
  assert.ok(payload); assert.equal(payload.e, d.ends_at); assert.equal(payload.env, 'staging');
  r = await confirmSession(ev({ session_id: 'cs_test_paid0001' }));
  assert.equal(JSON.parse(r.body).code, d.code);
  assert.equal(db.passes.length, 1);
  stripe.sessions.set('cs_test_livex1', { ...paidSession('cs_test_livex1', 'pass'), metadata: { plan: 'pass', env: 'live' } });
  assert.equal((await confirmSession(ev({ session_id: 'cs_test_livex1' }))).statusCode, 400);
  assert.equal(maskEmail('abc'), '');
});

function signed(evt, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(evt);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return ev(payload, { 'stripe-signature': sig });
}

test('webhook: bad signatures are rejected with 400 and grant nothing', async () => {
  const evt = { id: 'evt_1', type: 'checkout.session.completed', data: { object: paidSession('cs_test_wh1', 'pass') } };
  assert.equal((await webhook(signed(evt, 'whsec_wrong'))).statusCode, 400);
  assert.equal((await webhook(ev(JSON.stringify(evt), { 'stripe-signature': 't=1,v1=abc' }))).statusCode, 400);
  assert.equal((await webhook(ev(JSON.stringify(evt)))).statusCode, 400);
  const good = signed(evt);
  good.body = good.body.replace('"pass"', '"life"');
  assert.equal((await webhook(good)).statusCode, 400);
  assert.equal(db.passes.length, 0);
});

test('webhook: completed grants once and emails once; base64 body; refund; dispute', async () => {
  const s = paidSession('cs_test_wh2', 'pass');
  stripe.sessions.set(s.id, s);
  const evt = { id: 'evt_2', type: 'checkout.session.completed', data: { object: s } };
  const req = signed(evt);
  req.body = Buffer.from(req.body).toString('base64'); req.isBase64Encoded = true;
  assert.equal((await webhook(req)).statusCode, 200);
  const dup = await webhook(signed(evt));
  assert.equal(dup.statusCode, 200); assert.equal(JSON.parse(dup.body).duplicate, true);
  assert.equal((await webhook(signed({ ...evt, id: 'evt_2b' }))).statusCode, 200);
  assert.equal(db.passes.filter((p) => p.source === 'stripe').length, 1);
  { const fr = db.passes.filter((p) => p.batch === 'FRIEND'); assert.equal(fr.length, 1, 'one friend pass made with the email'); assert.equal(fr[0].status, 'unused'); assert.equal(fr[0].source, 'gift'); }
  assert.match(db.emails.at(-1).text, /Give a friend 48 free hours/); assert.match(db.emails.at(-1).html, /sms:\?&(amp;)?body=/);
  assert.equal(db.emails.length, 1);
  const m = db.emails[0];
  const code = deriveCode(process.env.RESTORE_CODE_PEPPER, s.id);
  assert.equal(m.subject, 'Mojialand: your 48-hour pass');
  assert.deepEqual(m.to, ['parent@example.com']);
  assert.equal(m.reply_to, 'hello@mojialand.com');
  assert.ok(m.html.includes(code) && m.text.includes(code));
  assert.ok(m.text.includes('https://mojialand.displayedux.com/r/' + code.replace(/-/g, '')));
  assert.ok(m.text.includes('Open this email on each phone or tablet where you want Mojialand, then tap the button.'));
  assert.ok(m.html.includes('Turn on Mojialand') && m.html.includes('/logo/email-logo.png'));
  assert.ok(!m.html.includes('mailto:'), 'no mailto links');
  assert.ok(!/\u2014/.test(m.html + m.text), 'no em dashes');
  assert.ok(m.html.includes('https://displayedux.com'));
  assert.ok(/E[DS]T/.test(m.text), 'Detroit time');
  assert.ok(!/danny/i.test(m.html + m.text));
  assert.ok(db.passes[0].emailed_at);
  // add: separate email
  const add = paidSession('cs_test_wh3', 'add', { pass_id: db.passes[0].id });
  await webhook(signed({ id: 'evt_3', type: 'checkout.session.completed', data: { object: add } }));
  await webhook(signed({ id: 'evt_3b', type: 'checkout.session.completed', data: { object: add } }));
  assert.equal(db.emails.length, 2);
  assert.equal(db.emails[1].subject, 'Mojialand: 48 hours added');
  assert.ok(db.emails[1].text.includes('/r/' + code.replace(/-/g, '')), 'add email carries the same code link');
  // refund
  await webhook(signed({ id: 'evt_4', type: 'charge.refunded', data: { object: { object: 'charge', refunded: true, payment_intent: s.payment_intent } } }));
  assert.equal(db.passes[0].status, 'refunded');
  // dispute on a life pass
  const life = paidSession('cs_test_wh5', 'life');
  stripe.sessions.set(life.id, life);
  await webhook(signed({ id: 'evt_5', type: 'checkout.session.completed', data: { object: life } }));
  await webhook(signed({ id: 'evt_6', type: 'charge.dispute.created', data: { object: { object: 'dispute', payment_intent: life.payment_intent } } }));
  assert.equal(db.passes.find((p) => p.stripe_session_id === life.id).status, 'disputed');
  assert.equal(db.emails.at(-1).subject, 'Mojialand: your Forever pass');
});

test('webhook: email skipped without EMAIL_API_KEY', async () => {
  setEnv({ EMAIL_API_KEY: undefined });
  const s = paidSession('cs_test_wh7', 'life');
  assert.equal((await webhook(signed({ id: 'evt_7', type: 'checkout.session.completed', data: { object: s } }))).statusCode, 200);
  assert.equal(db.passes.filter((p) => p.source === 'stripe').length, 1);
  assert.equal(db.emails.length, 0);
});

const DEV = (n) => String(n).repeat(32).slice(0, 32);

test('confirm-session: paid but database down gives 202 paid_pending; counts the device', async () => {
  stripe.sessions.set('cs_test_grace01', paidSession('cs_test_grace01', 'pass'));
  db.down = true;
  let r = await confirmSession(ev({ session_id: 'cs_test_grace01', device_id: DEV('a') }));
  assert.equal(r.statusCode, 202); assert.deepEqual(JSON.parse(r.body), { status: 'paid_pending' });
  db.down = false;
  r = await confirmSession(ev({ session_id: 'cs_test_grace01', device_id: DEV('a') }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.devices.length, 1);
  await confirmSession(ev({ session_id: 'cs_test_grace01', device_id: DEV('a') }));
  assert.equal(db.devices.length, 1, 'same device counts once');
  assert.ok(!JSON.stringify(db.devices).includes(DEV('a')), 'device value stored only as a hash');
});

test('redeem-code: turns a pass on, counts devices, limit 5, refunds stop it', async () => {
  const s = paidSession('cs_test_red01', 'pass');
  const { code } = await grantPass(s);
  const plain = code.replace(/-/g, '').toLowerCase();
  let r = await redeem(ev({ code: plain, device_id: DEV('1') }));
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.code, code); assert.equal(d.kind, '48h');
  assert.ok(verifyToken(d.token, KEYS.jwk));
  for (const n of ['2', '3', '4', '5']) assert.equal((await redeem(ev({ code, device_id: DEV(n) }))).statusCode, 200);
  assert.equal((await redeem(ev({ code, device_id: DEV('1') }))).statusCode, 200, 'a counted device can come back');
  r = await redeem(ev({ code, device_id: DEV('6') }));
  assert.equal(r.statusCode, 409); assert.match(JSON.parse(r.body).error, /5 devices/);
  assert.equal((await redeem(ev({ code: 'MOJI-AAAA-BBBB-CCCC', device_id: DEV('1') }))).statusCode, 404);
  assert.equal((await redeem(ev({ code: 'hello', device_id: DEV('1') }))).statusCode, 404, 'not a pass code, not a promotion code');
  assert.equal((await redeem(ev({ code, device_id: 'x' }))).statusCode, 400);
  db.passes[0].status = 'refunded';
  assert.equal((await redeem(ev({ code, device_id: DEV('1') }))).statusCode, 403);
  db.passes[0].status = 'active'; db.passes[0].ends_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await redeem(ev({ code, device_id: DEV('1') }))).statusCode, 410);
});

test('redeem-code: a Stripe promotion code comes back as a discount', async () => {
  let r = await redeemFn(ev({ code: 'friends50', device_id: 'd'.repeat(32) }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body).discount, { code: 'FRIENDS50', percent_off: 50, amount_off: null, name: 'Friends' });
  assert.equal((await redeemFn(ev({ code: 'NOPE99', device_id: 'd'.repeat(32) }))).statusCode, 404);
  assert.equal((await redeemFn(ev({ code: 'bad code!', device_id: 'd'.repeat(32) }))).statusCode, 400);
});

test('redeem-code: gift code starts on first use; rate limit', async () => {
  const code = randomCode('GIFT');
  db.passes.push({ id: crypto.randomUUID(), code_hash: codeHash(process.env.RESTORE_CODE_PEPPER, code), code_last4: codeLast4(code), prefix: 'GIFT', kind: '48h', source: 'gift', status: 'unused', device_limit: 5, ends_at: null });
  const r = await redeem(ev({ code, device_id: DEV('7') }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.passes[0].status, 'active');
  assert.ok(Math.abs(new Date(db.passes[0].ends_at).getTime() - Date.now() - 48 * 3600e3) < 5000);
  db.rateLimit = 0;
  assert.equal((await redeem(ev({ code, device_id: DEV('7') }))).statusCode, 429);
});

test('contact: validates, saves, emails support with reply-to; works when the database is down', async () => {
  assert.equal((await contact(ev({ email: 'bad', message: 'hi there' }))).statusCode, 400);
  assert.equal((await contact(ev({ email: 'a@b.co', message: '' }))).statusCode, 400);
  let r = await contact(ev({ email: 'parent@example.com', topic: 'pass', message: 'My pass is missing', session_id: 'cs_test_abc' }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.support_messages.length, 1);
  assert.ok(db.support_messages[0].message.includes('cs_test_abc'));
  const m = db.emails.at(-1);
  assert.deepEqual(m.to, ['hello@mojialand.com']); assert.equal(m.reply_to, 'parent@example.com');
  assert.ok(m.subject.startsWith('Mojialand:'));
  // a pass code identifies the pass even when the contact email differs from the paid email
  const { code, pass } = await grantPass(paidSession('cs_test_ct1', 'pass'));
  r = await contact(ev({ email: 'other@example.com', topic: 'pass', message: 'Code not working', code: code.toLowerCase() }));
  assert.equal(r.statusCode, 200);
  const saved = db.support_messages.at(-1).message;
  assert.ok(saved.includes('pass ' + pass.id) && saved.includes('paid with parent@example.com') && saved.includes('cs_test_ct1'), saved);
  assert.ok(!saved.includes(code) && !saved.includes(code.replace(/-/g, '')), 'full code never stored');
  assert.ok(db.emails.at(-1).text.includes('pass ' + pass.id));
  r = await contact(ev({ email: 'other@example.com', message: 'Lost it', code: 'MOJI-AAAA-BBBB-CCCC' }));
  assert.ok(db.support_messages.at(-1).message.includes('no pass found'));
  db.down = true;
  r = await contact(ev({ email: 'parent@example.com', topic: 'weird', message: 'Still here' }));
  assert.equal(r.statusCode, 200, 'email still goes out');
});


const codeFromEmail = () => /code is (\d{3}) (\d{3})/.exec(db.emails.at(-1).text).slice(1).join('');
async function adminSignIn() {
  const r = await adminLogin(ev({ step: 'send' }));
  const { id } = JSON.parse(r.body);
  const v = await adminLogin(ev({ step: 'verify', id, code: codeFromEmail() }));
  assert.equal(v.statusCode, 200);
  return v.headers['Set-Cookie'].split(';')[0];
}
const withCookie = (body, cookie) => ev(body, { cookie });

test('admin-login: code goes to the admin inbox; wrong code fails; right code sets a strict cookie; sign out clears it', async () => {
  let r = await adminLogin(ev({ step: 'send' }));
  assert.equal(r.statusCode, 200);
  const { id } = JSON.parse(r.body);
  const m = db.emails.at(-1);
  assert.deepEqual(m.to, ['admin@example.test']); assert.ok(m.subject.startsWith('Mojialand: admin sign-in code'));
  assert.ok(!JSON.stringify(db.admin_codes).includes(codeFromEmail()), 'code stored only as a hash');
  r = await adminLogin(ev({ step: 'verify', id, code: '000000' }));
  assert.equal(r.statusCode, codeFromEmail() === '000000' ? 200 : 401);
  r = await adminLogin(ev({ step: 'verify', id, code: codeFromEmail().slice(0, 3) + ' ' + codeFromEmail().slice(3) }));
  assert.equal(r.statusCode, 200);
  const cookie = r.headers['Set-Cookie'];
  assert.match(cookie, /^mojia_admin=[A-Za-z0-9_-]{40,}; Path=\/\.netlify\/functions\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
  assert.equal((await adminLogin(ev({ step: 'verify', id, code: codeFromEmail() }))).statusCode, 401, 'a code works once');
  const c = cookie.split(';')[0];
  assert.equal(JSON.parse((await adminLogin(ev({}, { cookie: c }, 'GET'))).body).signed_in, true);
  assert.equal(JSON.parse((await adminLogin(ev({}, {}, 'GET'))).body).signed_in, false);
  r = await adminLogin(withCookie({ step: 'out' }, c));
  assert.match(r.headers['Set-Cookie'], /Max-Age=0/);
  assert.equal(JSON.parse((await adminLogin(ev({}, { cookie: c }, 'GET'))).body).signed_in, false);
});

test('admin-login: five wrong tries burn the code; send is rate limited', async () => {
  const { id } = JSON.parse((await adminLogin(ev({ step: 'send' }))).body);
  const right = codeFromEmail();
  const wrong = right === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) assert.equal((await adminLogin(ev({ step: 'verify', id, code: wrong }))).statusCode, 401);
  assert.equal((await adminLogin(ev({ step: 'verify', id, code: right }))).statusCode, 401, 'burned after 5 tries');
  db.rateLimit = 0;
  assert.equal((await adminLogin(ev({ step: 'send' }))).statusCode, 429);
});

test('admin-login (Release 1.1.1 #38): parallel wrong guesses stop at 5 tries', async () => {
  const { id } = JSON.parse((await adminLogin(ev({ step: 'send' }))).body);
  const right = codeFromEmail();
  const wrong = right === '111111' ? '222222' : '111111';
  const ip = (i) => ({ 'x-nf-client-connection-ip': '198.51.100.' + i });
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => adminLogin(ev({ step: 'verify', id, code: wrong }, ip(i)))));
  assert.ok(res.every((r) => r.statusCode === 401));
  assert.equal(db.admin_codes.find((r) => r.id === id).tries, 5, 'tries never pass 5');
  assert.equal((await adminLogin(ev({ step: 'verify', id, code: right }, ip(50)))).statusCode, 401, 'burned after 5 tries');
});

test('admin-login (Release 1.1.1 #38): a new code cancels the old one', async () => {
  const { id: first } = JSON.parse((await adminLogin(ev({ step: 'send' }))).body);
  const firstCode = codeFromEmail();
  const { id: second } = JSON.parse((await adminLogin(ev({ step: 'send' }))).body);
  const secondCode = codeFromEmail();
  assert.equal((await adminLogin(ev({ step: 'verify', id: first, code: firstCode }))).statusCode, 401, 'old code cancelled');
  assert.equal((await adminLogin(ev({ step: 'verify', id: second, code: secondCode }))).statusCode, 200, 'newest code works');
  assert.equal(db.admin_codes.filter((r) => !r.used).length, 0);
});

test('admin-login (Release 1.1.1 #38): 21 failures across networks lock sign-in for an hour and email the admin', async () => {
  const ip = (i) => ({ 'x-nf-client-connection-ip': '192.0.2.' + i });
  let fails = 0;
  for (let round = 0; fails < 20; round++) {
    const { id } = JSON.parse((await adminLogin(ev({ step: 'send' }, ip(100 + round)))).body);
    const wrong = codeFromEmail() === '111111' ? '222222' : '111111';
    for (let t = 0; t < 5 && fails < 20; t++, fails++) assert.equal((await adminLogin(ev({ step: 'verify', id, code: wrong }, ip(fails)))).statusCode, 401);
  }
  const before = db.emails.length;
  const { id } = JSON.parse((await adminLogin(ev({ step: 'send' }, ip(200)))).body);
  const right = codeFromEmail();
  let r = await adminLogin(ev({ step: 'verify', id, code: right === '111111' ? '222222' : '111111' }, ip(201)));
  assert.equal(r.statusCode, 423, '21st failure locks');
  assert.equal(db.emails.length, before + 2, 'code email plus lock email');
  assert.equal(db.emails.at(-1).subject, 'Mojialand: admin sign-in locked for 1 hour');
  assert.deepEqual(db.emails.at(-1).to, ['admin@example.test']);
  assert.equal((await adminLogin(ev({ step: 'verify', id, code: right }, ip(202)))).statusCode, 423, 'even the right code waits');
  assert.equal((await adminLogin(ev({ step: 'send' }, ip(203)))).statusCode, 423, 'no new codes while locked');
  db.adminLockAt = Date.now() - 3601e3; db.adminFails = 0;
  const { id: id2 } = JSON.parse((await adminLogin(ev({ step: 'send' }, ip(204)))).body);
  assert.equal((await adminLogin(ev({ step: 'verify', id: id2, code: codeFromEmail() }, ip(205)))).statusCode, 200, 'works again after the hour');
});

test('admin-api: needs the cookie; passes, codes, support, settings', async () => {
  assert.equal((await adminApi(ev({ action: 'passes.list' }))).statusCode, 401);
  const cookie = await adminSignIn();
  const A = (action, extra) => adminApi(withCookie({ action, ...extra }, cookie)).then((r) => [r.statusCode, JSON.parse(r.body)]);
  // passes
  const { pass, code } = await grantPass(paidSession('cs_test_adm1', 'pass'));
  let [st, d] = await A('passes.list', { q: 'parent@' });
  assert.equal(st, 200); assert.equal(d.passes.length, 1); assert.equal(d.passes[0].id, pass.id);
  assert.ok(!JSON.stringify(d).includes('code_hash'), 'hashes never leave the server');
  [st, d] = await A('passes.list', { q: code.slice(-4).toLowerCase() });
  assert.equal(d.passes.length, 1);
  const ends0 = new Date(d.passes[0].ends_at).getTime();
  [st, d] = await A('passes.add48', { id: pass.id });
  assert.equal(new Date(d.pass.ends_at).getTime(), ends0 + 48 * 3600e3);
  // show and re-send the paid code (hotfix September 30): rebuilt from the Stripe session, never stored
  [st, d] = await A('passes.code', { id: pass.id });
  assert.equal(st, 200); assert.equal(d.code, code); assert.ok(d.link.endsWith('/r/' + code.replace(/-/g, '')));
  const sent0 = db.emails.length;
  [st, d] = await A('passes.email', { id: pass.id, to: 'not-an-email' });
  assert.equal(st, 400); assert.equal(db.emails.length, sent0);
  [st, d] = await A('passes.email', { id: pass.id, to: 'real.parent@example.com' });
  assert.equal(st, 200); assert.equal(d.sent, true);
  const em = db.emails.at(-1);
  assert.deepEqual(em.to, ['real.parent@example.com']); assert.ok(em.subject.startsWith('Mojialand:')); assert.ok(em.text.includes(code));
  assert.match(d.pass.note, /code emailed from admin/);
  assert.ok(!JSON.stringify(db.passes).includes(code), 'code still never stored');
  [st, d] = await A('passes.note', { id: pass.id, note: 'called mom' });
  assert.equal(d.pass.note, 'called mom');
  await redeemFn(ev({ code, device_id: 'a'.repeat(32) }));
  [st, d] = await A('passes.get', { id: pass.id });
  assert.equal(d.pass.devices, 1);
  [st, d] = await A('passes.devices_reset', { id: pass.id });
  assert.equal(d.pass.devices, 0);
  [st, d] = await A('passes.forever', { id: pass.id });
  assert.equal(d.pass.kind, 'forever'); assert.equal(d.pass.ends_at, null);
  [st, d] = await A('passes.end', { id: pass.id });
  assert.equal(d.pass.status, 'ended');
  // refund: Stripe refund on the session's payment intent, pass marked refunded
  stripe.sessions.set('cs_test_adm1', paidSession('cs_test_adm1', 'pass'));
  [st, d] = await A('passes.refund', { id: pass.id });
  assert.equal(st, 200); assert.equal(d.pass.status, 'refunded');
  assert.deepEqual(stripe.calls.refunds, [{ payment_intent: 'pi_cs_test_adm1' }]);
  [st, d] = await A('passes.refund', { id: pass.id });
  assert.equal(st, 400, 'no double refund');
  [st, d] = await A('passes.add48', { id: 'nope' });
  assert.equal(st, 400);
  // gift code: shown once, works in redeem-code, never stored
  [st, d] = await A('codes.create', { kind: '48h', source: 'gift', days_valid: 30, note: 'grandma' });
  assert.equal(st, 200); assert.match(d.code, /^GIFT-/); assert.equal(d.pass.status, 'unused');
  { const [s2] = await A('passes.code', { id: d.pass.id }); assert.equal(s2, 400, 'gift codes cannot be shown again'); }
  assert.ok(!JSON.stringify(db.passes).includes(d.code) && !JSON.stringify(db.passes).includes(d.code.replace(/-/g, '')));
  const rr = await redeemFn(ev({ code: d.code, device_id: 'b'.repeat(32) }));
  assert.equal(rr.statusCode, 200);
  // batch for printed cards
  [st, d] = await A('codes.batch', { kind: '48h', source: 'gift', days_valid: 365, note: 'school', count: 7 });
  assert.equal(st, 200); assert.equal(d.codes.length, 7); assert.equal(new Set(d.codes.map((c) => c.code)).size, 7);
  assert.ok(d.codes.every((c) => /^GIFT-/.test(c.code) && c.id));
  [st, d] = await A('codes.batch', { count: 999 });
  assert.equal(d.codes.length, 30, 'capped at 30 per call');
  // support
  await contact(ev({ email: 'p@example.com', topic: 'pass', message: 'Help me' }));
  [st, d] = await A('support.list', {});
  assert.equal(d.messages.length, 1);
  [st, d] = await A('support.set', { id: db.support_messages[0].id, status: 'done' });
  [st, d] = await A('support.list', { status: 'done' });
  assert.equal(d.messages.length, 1);
  // settings
  [st, d] = await A('settings.get', {});
  assert.equal(d.settings.length, 2);
  [st, d] = await A('settings.set', { key: 'daily_minutes', value: '5' });
  assert.equal(st, 200); assert.equal(db.settings[0].value, 5);
  [st, d] = await A('settings.set', { key: 'daily_reset', value: '25:00' });
  assert.equal(st, 400);
  [st, d] = await A('settings.set', { key: 'evil', value: '1' });
  assert.equal(st, 400);
  [st, d] = await A('nope', {});
  assert.equal(st, 400);
});

test('settings: public read of play settings only', async () => {
  const r = await settingsFn(ev({}, {}, 'GET'));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { daily_minutes: 3, daily_reset: '04:00' });
  assert.equal((await settingsFn(ev({}))).statusCode, 405);
});

test('handoff: Safari offers, the Home Screen app on the same phone claims once; other phones get nothing', async () => {
  const { pass, code } = await grantPass(paidSession('cs_test_ho1', 'pass'));
  const tok = signToken(makeTokenPayload(pass, 'staging'), process.env.PASS_SIGNING_PRIVATE_KEY);
  const safari = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' };
  const app = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'x-nf-client-connection-ip': '198.51.100.7' };
  const traits = '393|852|3|America/Detroit|en-US|6';
  assert.equal((await handoff(ev({ action: 'offer', token: 'nope', code, traits }, safari))).statusCode, 400);
  let r = await handoff(ev({ action: 'offer', token: tok, code, traits }, safari));
  assert.equal(r.statusCode, 200); assert.equal(db.handoffs.length, 1);
  assert.ok(!JSON.stringify(db.handoffs).includes('Detroit'), 'traits stored only as a hash');
  r = await handoff(ev({ action: 'claim', device_id: 'c'.repeat(32), traits: '430|932|3|America/Detroit|en-US|6' }, app));
  assert.equal(r.statusCode, 404, 'a different phone model gets nothing');
  r = await handoff(ev({ action: 'claim', device_id: 'c'.repeat(32), traits }, app), 'same phone, different network address still claims');
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.token, tok); assert.equal(d.code, code); assert.equal(d.kind, '48h');
  assert.equal(db.devices.length, 1);
  assert.equal((await handoff(ev({ action: 'claim', device_id: 'c'.repeat(32) }, app))).statusCode, 404, 'claimed once');
});

// ---------------------------------------------------------------- analytics
const GEO = { city: 'Troy', country: { code: 'US', name: 'United States' }, subdivision: { code: 'MI', name: 'Michigan' }, postalCode: '48084', latitude: 42.6, longitude: -83.1, timezone: 'America/Detroit' };
const pingReq = (body, method = 'POST') => new Request('https://mojialand.displayedux.com/api/ping', { method, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
const ctx = (geo = GEO) => ({ geo, ip: '203.0.113.9' });

test('analytics: geo keeps only country, state and city', () => {
  assert.deepEqual(placeFromGeo(GEO), { country: 'US', state: 'MI', city: 'Troy' });
  assert.deepEqual(placeFromGeo(null), { country: '', state: '', city: '' });
  assert.equal(placeFromGeo({ city: '<b>Ann Arbor</b>' }).city, 'bAnn Arborb');
  assert.equal(readPing({ e: 'open', g: 'chess' }), null);
  assert.equal(readPing({ e: 'close', g: 'draw', b: 7 }), null);
  assert.equal(readPing({ e: 'camp', c: 'BAD LABEL' }), null);
  assert.deepEqual(readPing({ e: 'open', g: 'draw', m: 'app', c: 'mi-troy-lib', cp: 1, name: 'Ava' }), { e: 'open', g: 'draw', m: 'app', c: 'mi-troy-lib' });
});

test('ping: counts opens, still-playing marks and closes; stores no IP, ZIP or coordinates', async () => {
  assert.equal((await ping(pingReq(null, 'GET'), ctx())).status, 405);
  assert.equal((await ping(pingReq('{"e":"open","g":"nope"}'), ctx())).status, 400);
  assert.equal((await ping(pingReq('x'.repeat(600)), ctx())).status, 400);
  assert.equal((await ping(pingReq({ e: 'open', g: 'draw', m: 'app' }), ctx())).status, 204);
  assert.equal((await ping(pingReq({ e: 'beat', g: 'draw', m: 'app' }), ctx())).status, 204);
  assert.equal((await ping(pingReq({ e: 'close', g: 'draw', m: 'web', b: 2 }), ctx())).status, 204);
  assert.equal(db.analytics.length, 3);
  assert.deepEqual(db.analytics[0], { p_country: 'US', p_state: 'MI', p_city: 'Troy', p_game: 'draw', p_mode: 'app', p_open: 1, p_live: 0, p_bucket: -1 });
  assert.equal(db.analytics[1].p_live, 1); assert.equal(db.analytics[1].p_open, 0);
  assert.equal(db.analytics[2].p_bucket, 2);
  const all = JSON.stringify(db.analytics) + JSON.stringify(db.calls);
  for (const bad of ['48084', '203.0.113.9', '42.6', '-83.1']) assert.ok(!all.includes(bad), 'never sends ' + bad);
});

test('ping: campaign opens count only for real labels; first play counts once per open ping flag; rate limit', async () => {
  db.campaigns.push({ label: 'mi-troy-lib-sep', name: 'Troy library', active: true });
  await ping(pingReq({ e: 'camp', c: 'mi-troy-lib-sep' }), ctx());
  await ping(pingReq({ e: 'camp', c: 'made-up-label' }), ctx());
  await ping(pingReq({ e: 'open', g: 'match', m: 'web', c: 'mi-troy-lib-sep', cp: 1 }), ctx());
  await ping(pingReq({ e: 'open', g: 'match', m: 'web', c: 'mi-troy-lib-sep' }), ctx());
  assert.deepEqual(db.campaignEvents.map((e) => e.p_event), ['open', 'play']);
  assert.equal(db.campaignEvents[0].p_city, 'Troy');
  db.rateLimit = 0;
  assert.equal((await ping(pingReq({ e: 'open', g: 'draw' }), ctx())).status, 429);
});

test('campaign credit: checkout carries the label; webhook counts the pass; gift code first use counts', async () => {
  db.campaigns.push({ label: 'oh-pumpkin-sep', name: 'Pumpkin fest', active: true });
  let r = await createCheckout(ev({ plan: 'pass', camp: { l: 'oh-pumpkin-sep', d: 1.26 } }));
  assert.equal(r.statusCode, 200);
  assert.equal(stripe.calls.create[0].metadata.camp, 'oh-pumpkin-sep');
  assert.equal(stripe.calls.create[0].metadata.camp_days, '1.3');
  r = await createCheckout(ev({ plan: 'pass', camp: { l: 'Bad Label!', d: 1 } }));
  assert.equal(stripe.calls.create[1].metadata.camp, undefined);
  const s = paidSession('cs_test_camp1', 'life', { camp: 'oh-pumpkin-sep', camp_days: '1.3' });
  const body = JSON.stringify({ id: 'evt_camp1', object: 'event', type: 'checkout.session.completed', data: { object: s } });
  const sig = stripe.webhooks.generateTestHeaderString({ payload: body, secret: process.env.STRIPE_WEBHOOK_SECRET });
  assert.equal((await webhook(ev(body, { 'stripe-signature': sig }))).statusCode, 200);
  assert.equal((await webhook(ev(body, { 'stripe-signature': sig }))).statusCode, 200);
  assert.deepEqual(db.campaignEvents.map((e) => [e.p_event, e.p_days]), [['forever', 1.3]], 'counted once');
  // gift code from the admin, first use carries the label
  const cookie = await adminSignIn();
  const made = JSON.parse((await adminApi(ev({ action: 'codes.create', kind: '48h', source: 'gift' }, { cookie }))).body);
  r = await redeem(ev({ code: made.code, device_id: 'a'.repeat(32), camp: 'oh-pumpkin-sep' }));
  assert.equal(r.statusCode, 200);
  r = await redeem(ev({ code: made.code, device_id: 'b'.repeat(32), camp: 'oh-pumpkin-sep' }));
  assert.deepEqual(db.campaignEvents.map((e) => e.p_event), ['forever', 'gift'], 'gift counted on first use only');
});

test('admin analytics: live folds small cities into the state and runs 5 minutes behind', async () => {
  const cookie = await adminSignIn();
  const SLOT = 300e3;
  const asOf = Math.floor(Date.now() / SLOT) * SLOT - SLOT;
  const at = (t) => new Date(t).toISOString();
  db.plays_live.push(
    { slot_start: at(asOf), country: 'US', state: 'MI', city: 'Troy', game: 'draw', n: 3 },
    { slot_start: at(asOf), country: 'US', state: 'MI', city: 'Troy', game: 'match', n: 1 },
    { slot_start: at(asOf), country: 'US', state: 'MI', city: 'Novi', game: 'draw', n: 2 },
    { slot_start: at(asOf), country: 'CA', state: 'ON', city: 'Windsor', game: 'bounce', n: 1 },
    { slot_start: at(asOf + SLOT), country: 'US', state: 'MI', city: 'Troy', game: 'draw', n: 9 },
    { slot_start: at(asOf - SLOT), country: 'US', state: 'OH', city: 'Toledo', game: 'pattern', n: 5 },
  );
  const r = await adminApi(ev({ action: 'analytics.live' }, { cookie }));
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.asOf, at(asOf));
  assert.equal(d.total, 7, 'the slot still filling is left out');
  assert.deepEqual(d.cities.map((c) => [c.city, c.total]), [['Troy', 4]]);
  assert.deepEqual(d.rolls, { MI: 2 });
  assert.equal(d.other, 1);
  assert.ok(!r.body.includes('Novi') && !r.body.includes('Windsor'), 'small places never reach the page');
  assert.deepEqual(d.feed.map((f) => [f.city, f.game, f.n]), [['Troy', 'draw', 4], ['Toledo', 'pattern', 5]]);
  assert.equal((await adminApi(ev({ action: 'analytics.live' }))).statusCode, 401);
});

test('admin analytics: history applies the 5-a-day rule and adds minutes from ranges', async () => {
  const cookie = await adminSignIn();
  const [d1, d2] = lastDays(2, Date.now());
  db.rpcData.analytics_history = {
    days: [
      { d: d1, co: 'US', st: 'MI', ci: 'Troy', g: 'draw', m: 'app', o: 6, b0: 0, b1: 0, b2: 6, b3: 0 },
      { d: d2, co: 'US', st: 'MI', ci: 'Troy', g: 'draw', m: 'web', o: 2, b0: 2, b1: 0, b2: 0, b3: 0 },
      { d: d1, co: 'US', st: 'MI', ci: 'Novi', g: 'match', m: 'web', o: 4, b0: 0, b1: 4, b2: 0, b3: 0 },
      { d: '1999-01-01', co: 'US', st: 'MI', ci: 'Troy', g: 'draw', m: 'app', o: 99, b0: 0, b1: 0, b2: 0, b3: 0 },
    ],
    hours: [{ h: 9, co: 'US', st: 'MI', ci: 'Troy', g: 'draw', o: 8 }, { h: 16, co: 'US', st: 'MI', ci: 'Novi', g: 'match', o: 4 }],
  };
  const r = await adminApi(ev({ action: 'analytics.history', range: 7 }, { cookie }));
  const d = JSON.parse(r.body);
  assert.equal(d.plays, 12);
  assert.deepEqual(d.cities.map((c) => [c.city, c.total]), [['Troy', 6]]);
  assert.deepEqual(d.rolls, { MI: 6 }, 'Troy on its 2-play day and Novi fold into Michigan');
  assert.equal(d.minutes, 6 * 10 + 2 * 1 + 4 * 3.5);
  assert.equal(d.appShare, 50);
  assert.equal(d.hours[9], 8);
  assert.deepEqual(Object.keys(d.cityHours), ['MI|Troy']);
  assert.deepEqual(Object.keys(d.stateHours), ['MI']);
  assert.ok(!r.body.includes('Novi'));
  assert.equal(db.rpcCalls[0][1].p_tz, 'America/Detroit');
  assert.equal(db.rpcCalls[0][1].p_from, new Date(localMidnight(Date.now(), 6)).toISOString());
});

test('admin campaigns: make, validate, list with small places folded', async () => {
  const cookie = await adminSignIn();
  const call = async (b) => { const r = await adminApi(ev(b, { cookie })); return [r.statusCode, JSON.parse(r.body)]; };
  let [s, d] = await call({ action: 'campaigns.create', name: '', label: 'ok-label' });
  assert.equal(s, 400);
  [s, d] = await call({ action: 'campaigns.create', name: 'Troy', label: 'Has Spaces' });
  assert.equal(s, 400);
  [s] = await call({ action: 'campaigns.create', name: 'Troy library', label: 'mi-troy-lib-sep', note: '150 cards' });
  assert.equal(s, 200);
  assert.equal(db.campaigns[0].label, 'mi-troy-lib-sep');
  [s, d] = await call({ action: 'campaigns.create', name: 'Again', label: 'mi-troy-lib-sep' });
  assert.equal(s, 400); assert.match(d.error, /taken/);
  const today = lastDays(1, Date.now())[0];
  db.rpcData.campaign_stats = {
    campaigns: [{ label: 'mi-troy-lib-sep', name: 'Troy library', note: '150 cards', active: true, created_at: new Date().toISOString() }],
    days: [{ l: 'mi-troy-lib-sep', d: today, e: 'open', n: 9, ds: 0 }, { l: 'mi-troy-lib-sep', d: today, e: 'pass48', n: 2, ds: 3 }],
    places: [{ l: 'mi-troy-lib-sep', co: 'US', st: 'MI', ci: 'Troy', n: 6 }, { l: 'mi-troy-lib-sep', co: 'US', st: 'MI', ci: 'Novi', n: 3 }],
  };
  [s, d] = await call({ action: 'campaigns.list' });
  const c = d.campaigns[0];
  assert.equal(c.open, 9); assert.equal(c.pass48, 2); assert.equal(c.avgDays, 1.5);
  assert.deepEqual(c.cities, [{ city: 'Troy', state: 'MI', county: '26125', countyName: 'Oakland', n: 6 }]);
  assert.deepEqual(c.rolls, { MI: 3 });
  assert.deepEqual(c.daily, [{ d: today, n: 9 }]);
});

test('analytics: small cities fold into a county first, then the state', async () => {
  const { foldPlaces, countyOf } = await import('../netlify/functions/_lib/analytics-admin.mjs');
  assert.equal(countyOf('MI', 'Troy'), '26125');
  const by = (n) => [n, 0, 0, 0, 0];
  const f = foldPlaces([
    { st: 'MI', ci: 'Troy', n: 6, by: by(6) },
    { st: 'MI', ci: 'Novi', n: 3, by: by(3) },
    { st: 'MI', ci: 'Royal Oak', n: 2, by: by(2) },
    { st: 'MI', ci: 'Ann Arbor', n: 2, by: by(2) },
    { st: 'MI', ci: '', n: 1, by: by(1) },
  ], 5);
  assert.deepEqual(f.cities.map((c) => [c.city, c.county, c.total]), [['Troy', '26125', 6]]);
  assert.deepEqual(f.counties.map((c) => [c.name, c.total]), [['Oakland', 5]], 'Novi and Royal Oak together pass the rule as Oakland County');
  assert.deepEqual(f.rolls, { MI: 3 }, 'Ann Arbor alone stays hidden inside Michigan');
});

test('admin analytics: 90-day range compares with the 90 days before; bad ranges fall back to 7', async () => {
  const cookie = await adminSignIn();
  const d = lastDays(180, Date.now());
  db.rpcData.analytics_history = {
    days: [
      { d: d[179], co: 'US', st: 'MI', ci: 'Troy', g: 'draw', m: 'app', o: 8, b0: 0, b1: 8, b2: 0, b3: 0 },
      { d: d[100], co: 'US', st: 'MI', ci: 'Troy', g: 'draw', m: 'app', o: 4, b0: 0, b1: 0, b2: 0, b3: 0 },
      { d: d[10], co: 'US', st: 'MI', ci: 'Troy', g: 'match', m: 'web', o: 2, b0: 2, b1: 0, b2: 0, b3: 0 },
    ],
    hours: [],
  };
  let r = JSON.parse((await adminApi(ev({ action: 'analytics.history', range: 90 }, { cookie }))).body);
  assert.equal(r.range, 90);
  assert.equal(r.days.length, 90);
  assert.equal(r.plays, 12);
  assert.equal(r.prev.plays, 2);
  assert.equal(r.perDayMinutes.at(-1), 28);
  assert.equal(db.rpcCalls.length, 2, 'one call for the period, one for the period before');
  r = JSON.parse((await adminApi(ev({ action: 'analytics.history', range: 365 }, { cookie }))).body);
  assert.equal(r.days.length, 365);
  assert.equal(r.prev, null, 'no comparison past the 400 days kept');
  r = JSON.parse((await adminApi(ev({ action: 'analytics.history', range: 12 }, { cookie }))).body);
  assert.equal(r.range, 7);
});


test('friend pass: one per pass, from the pass token; only for devices new to Mojialand; 30 days', async () => {
  const { pass } = await grantPass(paidSession('cs_test_fr1', 'pass'));
  const tok = signToken(makeTokenPayload(pass, 'staging'), process.env.PASS_SIGNING_PRIVATE_KEY);
  assert.equal((await friendFn(ev({ token: 'nope.nope' }))).statusCode, 403);
  assert.equal((await friendFn(ev({ token: signToken(makeTokenPayload(pass, 'live'), process.env.PASS_SIGNING_PRIVATE_KEY) }))).statusCode, 403, 'live token on staging');
  let r = await friendFn(ev({ token: tok }));
  assert.equal(r.statusCode, 200);
  const f = JSON.parse(r.body);
  assert.equal(f.code, deriveFriendCode(process.env.RESTORE_CODE_PEPPER, pass.id)); assert.match(f.code, /^GIFT-/);
  assert.equal(f.state, 'ready'); assert.ok(f.link.endsWith('/g/' + f.code.replace(/-/g, '')));
  assert.equal(JSON.parse((await friendFn(ev({ token: tok }))).body).code, f.code, 'same code again');
  assert.equal(db.passes.filter((p) => p.batch === 'FRIEND').length, 1, 'one friend pass per pass');
  assert.ok(!JSON.stringify(db.passes).includes(f.code) && !JSON.stringify(db.passes).includes(f.code.replace(/-/g, '')), 'friend code never stored');
  const useBy = new Date(db.passes.find((p) => p.batch === 'FRIEND').use_by).getTime();
  assert.ok(Math.abs(useBy - (new Date(pass.starts_at).getTime() + 30 * 86400e3)) < 5000, 'use by 30 days after the pass started');
  // the buyer's own device had a pass: the friend pass refuses it
  await redeem(ev({ code: deriveCode(process.env.RESTORE_CODE_PEPPER, 'cs_test_fr1'), device_id: 'c'.repeat(32) }));
  r = await redeem(ev({ code: f.code, device_id: 'c'.repeat(32) }));
  assert.equal(r.statusCode, 403); assert.match(JSON.parse(r.body).error, /families new to Mojialand/);
  // a new family's device: turns on for 48 hours
  r = await redeem(ev({ code: f.code, device_id: 'd'.repeat(32) }));
  assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.body).kind, '48h');
  assert.equal(JSON.parse((await friendFn(ev({ token: tok }))).body).state, 'used');
  // Release 1.1.1 #37 (audit H1): a friend pass never makes another friend pass
  const fp = db.passes.find((p) => p.batch === 'FRIEND');
  const ftok = signToken(makeTokenPayload(fp, 'staging'), process.env.PASS_SIGNING_PRIVATE_KEY);
  r = await friendFn(ev({ token: ftok }));
  assert.equal(r.statusCode, 410, 'friend pass gets no friend code');
  assert.equal(db.passes.filter((p) => p.batch === 'FRIEND').length, 1, 'no second friend pass row');
  assert.equal(await friendPass(fp), null);
  // a printed gift card pass still gives one; a support pass gives none
  const gift = { id: crypto.randomUUID(), code_hash: 'h-gift', code_last4: 'GFT1', prefix: 'GIFT', kind: '48h', source: 'gift', status: 'active', device_limit: 5, starts_at: new Date().toISOString(), batch: 'IN-FAIR-OCT' };
  const sup = { ...gift, id: crypto.randomUUID(), code_hash: 'h-sup', code_last4: 'SUP1', source: 'support', batch: null };
  db.passes.push(gift, sup);
  const gf = await friendPass(gift); assert.ok(gf && /^GIFT-/.test(gf.code), 'gift card pass gives one friend pass');
  assert.equal(await friendPass(sup), null, 'support pass gives none');
  assert.equal((await friendFn(ev({ token: signToken(makeTokenPayload(sup, 'staging'), process.env.PASS_SIGNING_PRIVATE_KEY) }))).statusCode, 410);
  // refunded passes give nothing; old passes past 30 days give nothing new
  const { pass: old } = await grantPass(paidSession('cs_test_fr2', 'pass'));
  old.starts_at = new Date(Date.now() - 31 * 86400e3).toISOString(); db.passes.find((p) => p.id === old.id).starts_at = old.starts_at;
  assert.equal((await friendFn(ev({ token: signToken(makeTokenPayload(old, 'staging'), process.env.PASS_SIGNING_PRIVATE_KEY) }))).statusCode, 410);
  db.passes.find((p) => p.id === pass.id).status = 'refunded';
  assert.equal((await friendFn(ev({ token: tok }))).statusCode, 410);
});

// ---- Release 1.1 #23: phone alerts (web push)
import { encryptPayload, vapidAuth, readSubscription, summaryText, michiganDay, dailySummary } from '../netlify/functions/_lib/push.mjs';
import { handler as redeemAlert } from '../netlify/functions/redeem-code.mjs';

function vapidEnv() {
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  setEnv({ VAPID_PUBLIC_KEY: e.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32 - e.getPrivateKey().length), e.getPrivateKey()]).toString('base64url') });
}
// A pretend phone: its own key pair and auth secret, and the RFC 8291 decrypt step.
function phone() {
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/QOkPzI2cfake', keys: { p256dh: e.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  sub.read = (buf) => {
    const salt = buf.subarray(0, 16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
    const shared = e.computeSecret(asPublic);
    const ikm = hm(hm(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), e.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = hm(salt, ikm);
    const cek = hm(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hm(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
    const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    assert.equal(pt[pt.length - 1], 2);
    return JSON.parse(pt.subarray(0, pt.length - 1).toString('utf8'));
  };
  return sub;
}
const saveSub = (sub) => db.push_subs.push({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });

test('alerts: encryption only the phone can read; VAPID note signed by our key; only real push services', () => {
  vapidEnv();
  const p = phone(), row = readSubscription(p);
  assert.ok(row);
  assert.deepEqual(p.read(encryptPayload(JSON.stringify({ title: 'Hi' }), row)), { title: 'Hi' });
  const auth = vapidAuth(p.endpoint);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  const [h, b, sig] = jwt.split('.');
  const pub = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + b), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:hello@mojialand.com', 'push contact is the public inbox, never ADMIN_EMAIL');
  for (const endpoint of ['https://evil.example.com/x', 'http://web.push.apple.com/x', 'https://web.push.apple.com:8443/x', 'https://169.254.169.254/x']) assert.equal(readSubscription({ ...p, endpoint }), null, endpoint);
  assert.equal(readSubscription({ ...p, keys: { p256dh: 'short', auth: p.keys.auth } }), null);
});

test('alerts: first start ping buzzes the phone with no game, place or device; counts for the day', async () => {
  vapidEnv();
  const p = phone(); saveSub(p);
  const res = await ping(pingReq({ e: 'first', g: 'draw', c: 'x' }), { geo: { city: 'Ann Arbor', subdivision: { code: 'MI' }, country: { code: 'US' } }, ip: '1.2.3.4' });
  assert.equal(res.status, 204);
  assert.equal(db.analytics.length, 0);
  assert.deepEqual(db.alerts, [{ p_day: michiganDay(), p_kind: 'player', p_label: '' }]);
  assert.equal(db.pushes.length, 1);
  const msg = p.read(db.pushes[0].body);
  assert.deepEqual(msg, { title: 'New player', body: 'Mojialand opened on a new device.', tag: 'player' });
  assert.ok(!JSON.stringify(msg).includes('Ann Arbor'));
  assert.equal(db.pushes[0].headers['Content-Encoding'], 'aes128gcm');
  assert.deepEqual(readPing({ e: 'first', g: 'draw' }), { e: 'first' });
});

test('alerts: daily mode and off mode only count; 12 alerts an hour at most; a gone phone is dropped', async () => {
  vapidEnv();
  const p = phone(); saveSub(p);
  db.settings.push({ key: 'alerts_mode', value: 'daily' });
  await ping(pingReq({ e: 'first' }), { ip: '1.1.1.1' });
  assert.equal(db.pushes.length, 0); assert.equal(db.alerts.length, 1);
  db.settings.find((r) => r.key === 'alerts_mode').value = 'each';
  for (let i = 0; i < 15; i++) await ping(pingReq({ e: 'first' }), { ip: '1.1.1.' + i });
  assert.equal(db.pushes.length, 12); assert.equal(db.alerts.length, 16);
  db.rate.clear(); db.pushStatus = 410;
  await ping(pingReq({ e: 'first' }), { ip: '2.2.2.2' });
  assert.equal(db.push_subs.length, 0);
});

test('alerts: a gift code first use buzzes with its batch; a second device does not', async () => {
  vapidEnv();
  const p = phone(); saveSub(p);
  const code = randomCode('GIFT');
  db.passes.push({ id: crypto.randomUUID(), code_hash: codeHash(process.env.RESTORE_CODE_PEPPER, code), code_last4: codeLast4(code), prefix: 'GIFT', kind: '48h', source: 'gift', status: 'unused', device_limit: 5, ends_at: null, batch: 'IN-FAIR-OCT', use_by: null });
  const r1 = await redeemAlert(ev({ code, device_id: DEV('a') }));
  assert.equal(r1.statusCode, 200);
  const r2 = await redeemAlert(ev({ code, device_id: DEV('b') }));
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(db.alerts.map((a) => a.p_kind + ':' + a.p_label), ['gift:IN-FAIR-OCT']);
  assert.deepEqual(p.read(db.pushes[0].body), { title: 'Gift code used', body: 'Batch IN-FAIR-OCT.', tag: 'gift' });
});

test('alerts: evening summary text; skipped when off', async () => {
  assert.equal(summaryText([]).body, 'No new players, no gift codes used.');
  assert.equal(summaryText([{ kind: 'player', label: '', n: 3 }, { kind: 'gift', label: 'FRIEND', n: 1 }, { kind: 'gift', label: 'IN-FAIR-OCT', n: 2 }]).body, '3 new players, 3 gift codes used (IN-FAIR-OCT 2, FRIEND 1).');
  assert.equal(summaryText([{ kind: 'player', label: '', n: 1 }, { kind: 'gift', label: '', n: 1 }]).body, '1 new player, 1 gift code used.');
  vapidEnv();
  const p = phone(); saveSub(p);
  db.alert_counts.push({ day: michiganDay(), kind: 'player', label: '', n: 2 });
  assert.equal(await dailySummary(), true);
  assert.deepEqual(p.read(db.pushes[0].body), { title: 'Today in Mojialand', body: '2 new players, no gift codes used.', tag: 'summary' });
  db.settings.push({ key: 'alerts_mode', value: 'off' });
  assert.equal(await dailySummary(), false);
});

test('admin-api: alerts subscribe, mode, test; settings list hides the alerts row', async () => {
  const cookie = await adminSignIn();
  const call = (body) => adminApi(withCookie(body, cookie));
  let r = await call({ action: 'alerts.get' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).ready, false);
  r = await call({ action: 'alerts.subscribe', sub: phone() });
  assert.equal(r.statusCode, 400);
  vapidEnv();
  const call2 = call;
  const p = phone();
  r = await call2({ action: 'alerts.subscribe', sub: { ...p, endpoint: 'https://evil.example.com/x' } });
  assert.equal(r.statusCode, 400);
  r = await call2({ action: 'alerts.subscribe', sub: p });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).test, 'ok');
  assert.equal(p.read(db.pushes[0].body).title, 'Alerts are on');
  r = await call2({ action: 'alerts.subscribe', sub: p });
  assert.equal(db.push_subs.length, 1);
  r = await call2({ action: 'alerts.mode', mode: 'daily' });
  assert.equal(r.statusCode, 200);
  assert.equal(db.settings.find((x) => x.key === 'alerts_mode').value, 'daily');
  assert.equal((await call2({ action: 'alerts.mode', mode: 'loud' })).statusCode, 400);
  r = await call2({ action: 'alerts.test' });
  assert.equal(JSON.parse(r.body).sent, 1);
  r = await call2({ action: 'settings.get' });
  assert.ok(!JSON.parse(r.body).settings.some((x) => x.key === 'alerts_mode'));
  r = await call2({ action: 'alerts.get' });
  const g = JSON.parse(r.body);
  assert.equal(g.mode, 'daily'); assert.equal(g.phones.length, 1); assert.ok(g.publicKey.length > 80);
  r = await call2({ action: 'alerts.unsubscribe', endpoint: p.endpoint });
  assert.equal(db.push_subs.length, 0);
});
