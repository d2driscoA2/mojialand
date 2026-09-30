// POST {action, ...} for the admin page. Every call needs the session cookie.
import { guard } from './_lib/env.mjs';
import { json, fail, readJson, header, originFromHost } from './_lib/http.mjs';
import { rest, patchPass, safeErr } from './_lib/db.mjs';
import { isSignedIn } from './_lib/admin.mjs';
import { randomCode, codeHash, codeLast4, deriveCode, codeNoDashes } from './_lib/codes.mjs';
import { buildEmail, sendEmail } from './_lib/email.mjs';
import { friendPass } from './_lib/friend.mjs';
import { getStripe } from './_lib/stripe.mjs';
import { pushReady, readSubscription, MODES, alertMode, pushAll, sendPush, summaryText, michiganDay } from './_lib/push.mjs';
import { liveView, historyView, campaignsView, createCampaign, setCampaignActive } from './_lib/analytics-admin.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'STRIPE_SECRET_KEY'];
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const enc = encodeURIComponent;
const UUID = /^[0-9a-f-]{36}$/i;
const PASS_FIELDS = 'id,code_last4,prefix,kind,source,email,stripe_session_id,amount_cents,created_at,starts_at,ends_at,device_limit,status,uses_left,use_by,note,emailed_at,batch';
const SETTING_KEYS = ['first_visit_minutes', 'daily_minutes', 'daily_reset', 'devices_per_code', 'warning_minutes', 'credit_days', 'delete_ended_after_days'];

async function passWithDevices(id) {
  const { data } = await rest('GET', 'passes?id=eq.' + enc(id) + '&select=' + PASS_FIELDS + '&limit=1');
  const pass = Array.isArray(data) && data[0];
  if (!pass) return null;
  const d = await rest('GET', 'devices?pass_id=eq.' + enc(id) + '&select=id');
  pass.devices = Array.isArray(d.data) ? d.data.length : 0;
  return pass;
}

// Paid codes come from the Stripe session ID, so the admin can show or re-send
// them without the code ever being stored. Gift and manual codes are not stored
// anywhere and cannot be shown again.
async function paidCode(id) {
  if (!UUID.test(String(id || ''))) throw new Error('bad id');
  const p = await passWithDevices(id);
  if (!p) throw new Error('pass not found');
  if (p.source !== 'stripe' || !p.stripe_session_id) throw new Error('only paid passes can show their code. For a gift or manual code, make a new code');
  return { p, code: deriveCode(process.env.RESTORE_CODE_PEPPER, p.stripe_session_id) };
}
const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;

const actions = {
  // ---- passes
  async 'passes.code'({ id }, event) {
    const { code } = await paidCode(id);
    return { code, link: originFromHost(header(event, 'host')) + '/r/' + codeNoDashes(code) };
  },
  async 'passes.email'({ id, to }, event) {
    const addr = String(to || '').trim();
    if (!EMAIL_RE.test(addr)) throw new Error('type a full email address');
    const { p, code } = await paidCode(id);
    const plan = p.kind === 'forever' ? 'life' : 'pass';
    const friend = await friendPass(p).catch(() => null);
    const ok = await sendEmail(addr, buildEmail({ plan, pass: p, code, origin: originFromHost(header(event, 'host')), friend }));
    if (ok === false) throw new Error('email is not set up on this site');
    await patchPass('id=eq.' + enc(id), { note: ((p.note ? p.note + ' · ' : '') + 'code emailed from admin ' + new Date().toISOString().slice(0, 10)).slice(0, 500) });
    return { pass: await passWithDevices(id), sent: true };
  },
  async 'passes.list'({ q }) {
    const s = String(q || '').trim();
    let filter = '';
    if (s) {
      const safe = s.replace(/[%*,()]/g, '');
      if (/^[A-Za-z0-9]{4}$/.test(safe)) filter = '&code_last4=eq.' + enc(safe.toUpperCase());
      else if (s.startsWith('cs_')) filter = '&stripe_session_id=eq.' + enc(s);
      else filter = '&email=ilike.' + enc('*' + safe + '*');
    }
    const { data } = await rest('GET', 'passes?select=' + PASS_FIELDS + filter + '&order=created_at.desc&limit=50');
    return { passes: Array.isArray(data) ? data : [] };
  },
  async 'passes.get'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    return { pass: await passWithDevices(id) };
  },
  async 'passes.add48'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    const p = await passWithDevices(id);
    if (!p || p.kind === 'forever') throw new Error('not a 48-hour pass');
    const base = Math.max(Date.now(), p.ends_at ? new Date(p.ends_at).getTime() : 0);
    await patchPass('id=eq.' + enc(id), { ends_at: new Date(base + 48 * HOUR).toISOString(), status: 'active', starts_at: p.starts_at || new Date().toISOString() });
    return { pass: await passWithDevices(id) };
  },
  async 'passes.forever'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    await patchPass('id=eq.' + enc(id), { kind: 'forever', ends_at: null, status: 'active', starts_at: new Date().toISOString() });
    return { pass: await passWithDevices(id) };
  },
  async 'passes.end'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    await patchPass('id=eq.' + enc(id), { status: 'ended', ends_at: new Date().toISOString() });
    return { pass: await passWithDevices(id) };
  },
  async 'passes.note'({ id, note }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    await patchPass('id=eq.' + enc(id), { note: String(note || '').slice(0, 500) || null });
    return { pass: await passWithDevices(id) };
  },
  // Refunds the pass's own Stripe payment in full and ends the pass. Add-on
  // payments (add 48 hours, upgrade) are separate sessions: refund those in Stripe.
  async 'passes.refund'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    const p = await passWithDevices(id);
    if (!p) throw new Error('pass not found');
    if (p.source !== 'stripe' || !p.stripe_session_id) throw new Error('this pass was not paid through Stripe');
    if (p.status === 'refunded') throw new Error('already refunded');
    const session = await getStripe().checkout.sessions.retrieve(p.stripe_session_id);
    const pi = session && session.payment_intent;
    if (!pi) throw new Error('no payment to refund');
    await getStripe().refunds.create({ payment_intent: typeof pi === 'string' ? pi : pi.id });
    await patchPass('id=eq.' + enc(id), { status: 'refunded', note: ((p.note ? p.note + ' · ' : '') + 'refunded from admin ' + new Date().toISOString().slice(0, 10)).slice(0, 500) });
    return { pass: await passWithDevices(id) };
  },

  // Lets the family start over with their devices ("move it to a new device").
  async 'passes.devices_reset'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    await rest('DELETE', 'devices?pass_id=eq.' + enc(id));
    return { pass: await passWithDevices(id) };
  },

  // ---- gift and support codes. One code = one family's pass. The code is shown once and never stored.
  async 'codes.create'({ kind, source, days_valid, note }) {
    const k = kind === 'forever' ? 'forever' : '48h';
    const src = source === 'support' ? 'support' : 'gift';
    const days = Math.min(365, Math.max(1, parseInt(days_valid, 10) || 90));
    const code = randomCode('GIFT');
    const row = {
      code_hash: codeHash(process.env.RESTORE_CODE_PEPPER, code),
      code_last4: codeLast4(code),
      prefix: 'GIFT',
      kind: k,
      source: src,
      status: 'unused',
      uses_left: 1,
      use_by: new Date(Date.now() + days * DAY).toISOString(),
      note: String(note || '').slice(0, 500) || null,
      device_limit: 5,
    };
    const { data } = await rest('POST', 'passes', { body: row, prefer: 'return=representation' });
    const pass = Array.isArray(data) && data[0];
    return { code, pass };
  },

  // Many codes at once, for printed cards. Up to 30 per call (function time limit); the page loops for more.
  async 'codes.batch'({ kind, source, days_valid, note, count }) {
    const n = Math.min(30, Math.max(1, parseInt(count, 10) || 1));
    const out = [];
    for (let i = 0; i < n; i++) out.push(await actions['codes.create']({ kind, source, days_valid, note }));
    return { codes: out.map((c) => ({ code: c.code, id: c.pass && c.pass.id })) };
  },

  // ---- support inbox
  async 'support.list'({ status }) {
    const st = status === 'done' ? 'done' : 'open';
    const { data } = await rest('GET', 'support_messages?status=eq.' + st + '&select=*&order=created_at.desc&limit=100');
    return { messages: Array.isArray(data) ? data : [] };
  },
  async 'support.set'({ id, status }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    const st = status === 'done' ? 'done' : 'open';
    await rest('PATCH', 'support_messages?id=eq.' + enc(id), { body: { status: st }, prefer: 'return=minimal' });
    return { ok: true };
  },

  // ---- analytics (counts only, small places folded into their state)
  async 'analytics.live'() { return liveView(); },
  async 'analytics.history'({ range }) { return historyView(range); },
  async 'campaigns.list'() { return campaignsView(); },
  async 'campaigns.create'(input) { await createCampaign(input); return campaignsView(); },
  async 'campaigns.active'(input) { await setCampaignActive(input); return campaignsView(); },

  // ---- phone alerts (Release 1.1 #23)
  async 'alerts.get'() {
    const { data } = await rest('GET', 'push_subs?select=endpoint,created_at');
    const subs = Array.isArray(data) ? data : [];
    const t = await rest('GET', 'alert_counts?day=eq.' + michiganDay() + '&select=kind,label,n');
    return { ready: pushReady(), publicKey: process.env.VAPID_PUBLIC_KEY || '', mode: await alertMode(), phones: subs.map((x) => x.endpoint), today: summaryText(Array.isArray(t.data) ? t.data : []).body };
  },
  async 'alerts.subscribe'({ sub }) {
    if (!pushReady()) throw new Error('alerts are not set up on this site yet');
    const row = readSubscription(sub);
    if (!row) throw new Error('this browser gave an address that is not a push service');
    const { data } = await rest('GET', 'push_subs?select=endpoint');
    if (Array.isArray(data) && data.length >= 10 && !data.some((x) => x.endpoint === row.endpoint)) throw new Error('10 phones at most. Remove one first');
    await rest('POST', 'push_subs?on_conflict=endpoint', { body: { ...row, created_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
    const r = await sendPush(row, { title: 'Alerts are on', body: 'This phone gets Mojialand alerts.', tag: 'test' });
    return { ok: true, test: r };
  },
  async 'alerts.unsubscribe'({ endpoint }) {
    const e = String(endpoint || '');
    if (!e || e.length > 600) throw new Error('bad phone');
    await rest('DELETE', 'push_subs?endpoint=eq.' + enc(e), { prefer: 'return=minimal' });
    return { ok: true };
  },
  async 'alerts.mode'({ mode }) {
    if (!MODES.includes(mode)) throw new Error('unknown choice');
    await rest('POST', 'settings?on_conflict=key', { body: { key: 'alerts_mode', value: mode, help: 'Phone alerts: each, daily, or off.', updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
    return { ok: true, mode };
  },
  async 'alerts.test'() {
    if (!pushReady()) throw new Error('alerts are not set up on this site yet');
    return { sent: await pushAll({ title: 'Test alert', body: 'Mojialand alerts work.', tag: 'test' }) };
  },

  // ---- settings
  async 'settings.get'() {
    const { data } = await rest('GET', 'settings?select=key,value,help,updated_at&order=key');
    return { settings: Array.isArray(data) ? data.filter((r) => r.key !== 'alerts_mode') : [] };
  },
  async 'settings.set'({ key, value }) {
    if (!SETTING_KEYS.includes(key)) throw new Error('unknown setting');
    let v;
    if (key === 'daily_reset') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) throw new Error('time must look like 04:00');
      v = String(value);
    } else {
      v = parseInt(value, 10);
      if (!Number.isFinite(v) || v < 0 || v > 100000) throw new Error('enter a whole number');
    }
    await rest('PATCH', 'settings?key=eq.' + enc(key), { body: { value: v, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
    return { ok: true };
  },
};

export const handler = async (event) => {
  const stop = guard('admin-api', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
  try {
    if (!(await isSignedIn(event))) return fail(401, 'Please sign in.');
  } catch (e) {
    console.error('admin-api: session check failed (' + safeErr(e) + ')');
    return fail(500, 'Try again in a minute.');
  }
  const input = readJson(event) || {};
  const fn = actions[input.action];
  if (!fn) return fail(400, 'Unknown action.');
  try {
    const out = await fn(input, event);
    if (!/^analytics\./.test(input.action)) console.log('admin-api: ' + input.action);
    return json(200, out);
  } catch (e) {
    console.error('admin-api: ' + input.action + ' failed (' + safeErr(e) + ')');
    const msg = e && e.message && !/^db /.test(e.message) ? e.message : 'That did not work. Try again.';
    return fail(400, msg.charAt(0).toUpperCase() + msg.slice(1) + (/[.!?]$/.test(msg) ? '' : '.'));
  }
};
