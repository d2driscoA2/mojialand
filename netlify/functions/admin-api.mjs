// POST {action, ...} for the admin page. Every call needs the session cookie.
import { guard } from './_lib/env.mjs';
import { json, fail, readJson, header, originFromHost, sameOrigin, maskEmail } from './_lib/http.mjs';
import { rest, patchPass, safeErr, switchOn, resetSwitchCache, endGifts } from './_lib/db.mjs';
import { isSignedIn } from './_lib/admin.mjs';
import { randomCode, codeHash, codeLast4, deriveCode, codeNoDashes } from './_lib/codes.mjs';
import { buildEmail, sendEmail, adminShareText } from './_lib/email.mjs';
import { friendPass } from './_lib/friend.mjs';
import { getStripe } from './_lib/stripe.mjs';
import { pushReady, readSubscription, MODES, alertMode, pushAll, sendPush, summaryText, michiganDay } from './_lib/push.mjs';
import { liveView, historyView, websiteView, campaignsView, createCampaign, setCampaignActive } from './_lib/analytics-admin.mjs';
import { LABEL_RE } from './_lib/analytics.mjs';
import { lengthOf } from './_lib/kinds.mjs';
import { FRIEND_BATCH } from './_lib/friend.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'STRIPE_SECRET_KEY'];
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const enc = encodeURIComponent;
const UUID = /^[0-9a-f-]{36}$/i;
const PASS_FIELDS = 'id,code_last4,prefix,kind,source,email,stripe_session_id,amount_cents,created_at,starts_at,ends_at,device_limit,status,uses_left,use_by,note,emailed_at,batch';
const SETTING_KEYS = ['free_days', 'play_counts_off', 'emails_paused', 'new_free_paused', 'lite_home', 'first_visit_minutes', 'daily_minutes', 'daily_reset', 'devices_per_code', 'warning_minutes', 'credit_days', 'delete_ended_after_days'];

async function passWithDevices(id) {
  const { data } = await rest('GET', 'passes?id=eq.' + enc(id) + '&select=' + PASS_FIELDS + '&limit=1');
  const pass = Array.isArray(data) && data[0];
  if (!pass) return null;
  const d = await rest('GET', 'devices?pass_id=eq.' + enc(id) + '&select=id');
  pass.devices = Array.isArray(d.data) ? d.data.length : 0;
  await addPayments([pass]);
  return pass;
}

// Release 1.4 (Danny, October 12): add and upgrade payments on a pass, for the total paid and for refunds.
async function extraCheckouts(ids) {
  const ok = ids.filter((x) => UUID.test(String(x || '')));
  if (!ok.length) return [];
  try {
    const { data } = await rest('GET', 'granted_checkouts?pass_id=in.(' + ok.join(',') + ')&select=session_id,pass_id,amount_cents');
    return Array.isArray(data) ? data : [];
  } catch { return []; } // database not updated yet: first payment only
}
async function addPayments(passes) {
  const extra = await extraCheckouts(passes.map((p) => p.id));
  for (const p of passes) {
    const mine = extra.filter((x) => x.pass_id === p.id && x.session_id !== p.stripe_session_id);
    p.payments = 1 + mine.length;
    p.paid_cents = (Number(p.amount_cents) || 0) + mine.reduce((t, x) => t + (Number(x.amount_cents) || 0), 0);
  }
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
// Release 1.2 #27: tell the family after Add 48 hours or Make Forever.
// Paid passes with an email get the branded pass email (code rebuilt from the
// Stripe session). Passes with no email (gift, manual) return a message to share.
// An email problem never undoes the change.
async function tellFamily(p, plan, event, skip) {
  if (skip) return { email: 'skipped' };
  if (!p.email || p.source !== 'stripe' || !p.stripe_session_id) return { email: 'none', share: adminShareText(plan, p) };
  // Release 1.4 #14: emails paused during a spike; the admin gets the message to share instead.
  if (await switchOn('emails_paused')) return { email: 'paused', share: adminShareText(plan, p) };
  try {
    const code = deriveCode(process.env.RESTORE_CODE_PEPPER, p.stripe_session_id);
    const ok = await sendEmail(p.email, buildEmail({ plan, pass: p, code, origin: originFromHost(header(event, 'host')), byAdmin: true }));
    if (ok === false) return { email: 'off', share: adminShareText(plan, p) };
    return { email: 'sent', to: maskEmail(p.email) };
  } catch {
    console.error('admin-api: pass change email failed');
    return { email: 'failed', share: adminShareText(plan, p) };
  }
}
// Release 1.2 #2: gift codes by event and school. A batch label is a campaign
// label (lowercase letters, numbers, dashes), so QR opens and passes bought
// after a card count toward the same event. Counts cards, never people.
function cleanBatch(v) {
  const b = String(v || '').trim().toLowerCase();
  if (!b) return null;
  if (!LABEL_RE.test(b)) throw new Error('use 2 to 24 lowercase letters, numbers or dashes for the batch label, like in-fair-oct');
  // Release 1.3 Security R1: friend is reserved for friend passes (batch FRIEND).
  if (b === FRIEND_BATCH.toLowerCase()) throw new Error('friend is reserved for friend passes. Pick another label, like in-fair-oct');
  return b;
}
async function ensureCampaign(label) {
  const { data } = await rest('GET', 'campaigns?label=eq.' + enc(label) + '&select=label&limit=1');
  if (Array.isArray(data) && data.length) return;
  await rest('POST', 'campaigns', { body: { label, name: label }, prefer: 'return=minimal' });
}
const PASS_TABS = { all: '', active: '&status=eq.active', paid: '&source=eq.stripe', gifts: '&source=in.(gift,support)' };
const PASS_SORTS = { made: 'created_at.desc', on: 'starts_at.desc.nullslast', ends: 'ends_at.asc.nullslast' };
async function allRows(path) {
  const out = [];
  for (let off = 0; off < 20000; off += 1000) {
    const { data } = await rest('GET', path + '&limit=1000&offset=' + off);
    const rows = Array.isArray(data) ? data : [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
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
  // Release 1.2 #2: tabs (all, active, paid, gifts), sort, search on every tab,
  // and one batch's codes for the Campaigns and schools tab.
  async 'passes.list'({ q, tab, sort, batch }) {
    const s = String(q || '').trim();
    let filter = PASS_TABS[tab] || '';
    if (s) {
      const safe = s.replace(/[%*,()]/g, '');
      if (/^[A-Za-z0-9]{4}$/.test(safe)) filter += '&code_last4=eq.' + enc(safe.toUpperCase());
      else if (s.startsWith('cs_')) filter += '&stripe_session_id=eq.' + enc(s);
      else if (safe) filter += '&or=' + enc('(email.ilike.*' + safe + '*,batch.ilike.*' + safe + '*,note.ilike.*' + safe + '*)');
    }
    if (batch) filter += '&batch=eq.' + enc(cleanBatch(batch));
    const order = PASS_SORTS[sort] || PASS_SORTS.made;
    const { data } = await rest('GET', 'passes?select=' + PASS_FIELDS + filter + '&order=' + order + '&limit=100');
    const passes = Array.isArray(data) ? data : [];
    await addPayments(passes.filter((p) => p.source === 'stripe'));
    return { passes };
  },
  // One row per batch: codes made, codes used, percent used, days from making
  // to use, passes bought after (campaign counts). Never names or devices.
  async 'passes.batches'({ q }) {
    const camps = (await campaignsView()).campaigns || [];
    const cBy = new Map(camps.map((c) => [c.label, c]));
    const by = new Map();
    // Release 1.5 #67: one database step counts every batch (batch_stats). Before that SQL runs, count row by row.
    let fast = null;
    try { const { data } = await rest('POST', 'rpc/batch_stats', { body: {} }); if (Array.isArray(data)) fast = data; } catch { fast = null; }
    if (fast) {
      for (const r of fast) {
        if (!r.b || r.b === FRIEND_BATCH) continue;
        by.set(r.b, { label: r.b, codes: Number(r.codes) || 0, used: Number(r.used) || 0, open: Number(r.open) || 0, voided: Number(r.voided) || 0,
          daysSum: Number(r.ds) || 0, daysN: Number(r.dn) || 0, made: r.made });
      }
    }
    const rows = fast ? [] : await allRows('passes?batch=neq.' + FRIEND_BATCH + '&select=batch,status,created_at,starts_at&order=created_at.asc');
    for (const p of rows) {
      if (!p.batch) continue;
      const b = by.get(p.batch) || { label: p.batch, codes: 0, used: 0, open: 0, voided: 0, daysSum: 0, daysN: 0, made: p.created_at };
      b.codes++;
      // Release 1.4 #57: a code ended before use counts as voided, never as used.
      if (p.status === 'unused') b.open++;
      else if (!p.starts_at) b.voided++;
      if (p.status !== 'unused' && p.starts_at) {
        b.used++;
        if (p.starts_at && p.created_at) { b.daysSum += Math.max(0, (new Date(p.starts_at) - new Date(p.created_at)) / DAY); b.daysN++; }
      }
      by.set(p.batch, b);
    }
    const s = String(q || '').trim().toLowerCase();
    const list = [...by.values()].map((b) => {
      const c = cBy.get(b.label);
      return {
        label: b.label, name: c ? c.name : '', note: c ? c.note : '', made: b.made,
        codes: b.codes, used: b.used, open: b.open, voided: b.voided,
        pct: b.codes ? Math.round((b.used / b.codes) * 100) : 0,
        avgDays: b.daysN ? Math.round((b.daysSum / b.daysN) * 10) / 10 : null,
        bought: c ? (c.pass48 || 0) + (c.forever || 0) : null,
      };
    }).filter((b) => !s || b.label.includes(s) || String(b.name).toLowerCase().includes(s))
      .sort((x, y) => String(y.made).localeCompare(String(x.made)));
    return { batches: list };
  },
  async 'campaigns.note'({ label, note }) {
    const lb = cleanBatch(label);
    if (!lb) throw new Error('bad label');
    await ensureCampaign(lb);
    await rest('PATCH', 'campaigns?label=eq.' + enc(lb), { body: { note: String(note || '').trim().slice(0, 500) || null }, prefer: 'return=minimal' });
    return { ok: true };
  },
  // The last 5 batch labels used, offered as taps when making codes.
  async 'codes.labels'() {
    const { data } = await rest('GET', 'passes?batch=neq.' + FRIEND_BATCH + '&select=batch&order=created_at.desc&limit=500');
    const seen = [];
    for (const r of Array.isArray(data) ? data : []) if (r.batch && !seen.includes(r.batch)) { seen.push(r.batch); if (seen.length === 5) break; }
    return { labels: seen };
  },
  async 'passes.get'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    return { pass: await passWithDevices(id) };
  },
  // Release 1.4 #32: Add 30 days in place of Add 48 hours.
  async 'passes.add30'({ id, skip_email }, event) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    const p = await passWithDevices(id);
    if (p && p.status === 'ended' && !p.starts_at) throw new Error('this code ended before anyone used it. Make a new code instead.');
    if (!p || p.kind === 'forever') throw new Error('this pass is Forever already');
    const base = Math.max(Date.now(), p.ends_at ? new Date(p.ends_at).getTime() : 0);
    await patchPass('id=eq.' + enc(id), { ends_at: new Date(base + lengthOf('30d')).toISOString(), status: 'active', starts_at: p.starts_at || new Date().toISOString() });
    const pass = await passWithDevices(id);
    return { pass, tell: await tellFamily(pass, 'add', event, skip_email === true) };
  },
  async 'passes.forever'({ id, skip_email }, event) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    const p = await passWithDevices(id);
    if (p && p.status === 'ended' && !p.starts_at) throw new Error('this code ended before anyone used it. Make a new code instead.');
    if (!p) throw new Error('pass not found');
    if (p.kind === 'forever') throw new Error('this pass is Forever already');
    await patchPass('id=eq.' + enc(id), { kind: 'forever', ends_at: null, status: 'active', starts_at: new Date().toISOString() });
    const pass = await passWithDevices(id);
    return { pass, tell: await tellFamily(pass, 'up', event, skip_email === true) };
  },
  async 'passes.end'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    await patchPass('id=eq.' + enc(id), { status: 'ended', ends_at: new Date().toISOString() });
    await endGifts(id); // Security S2: a friend turning on a gift must not bring an ended pass back
    return { pass: await passWithDevices(id) };
  },
  async 'passes.note'({ id, note }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    await patchPass('id=eq.' + enc(id), { note: String(note || '').slice(0, 500) || null });
    return { pass: await passWithDevices(id) };
  },
  // Release 1.4 (Danny, October 12; Security M1): refund every payment on the pass (first purchase,
  // adds, upgrade). Each refund carries an idempotency key, so a double tap or a retry never refunds
  // twice. Every payment gets tried even after one fails. A refunded pass with an unrefunded add or
  // upgrade takes Refund again to finish the job.
  async 'passes.refund'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    const p = await passWithDevices(id);
    if (!p) throw new Error('pass not found');
    if (p.source !== 'stripe' || !p.stripe_session_id) throw new Error('this pass was not paid through Stripe');
    const sessions = [p.stripe_session_id, ...(await extraCheckouts([id])).map((x) => x.session_id).filter((s) => s && s !== p.stripe_session_id)];
    let refunded = 0, cents = 0, done = 0;
    const failed = [];
    for (const sid of sessions) {
      try {
        const session = await getStripe().checkout.sessions.retrieve(sid);
        const pi = session && session.payment_intent;
        if (!pi) { done++; continue; } // a free checkout (100% off code) has no payment
        const piId = typeof pi === 'string' ? pi : pi.id;
        const prior = await getStripe().refunds.list({ payment_intent: piId, limit: 10 });
        if (prior && Array.isArray(prior.data) && prior.data.some((r) => r.status === 'succeeded' || r.status === 'pending')) { done++; continue; } // refunded already
        try {
          await getStripe().refunds.create({ payment_intent: piId }, { idempotencyKey: 'refund-' + sid });
          refunded++; cents += Number(session.amount_total) || 0;
        } catch (e) {
          if (!/already been refunded|charge_already_refunded/i.test(String((e && (e.code || e.message)) || ''))) throw e;
          done++;
        }
      } catch {
        failed.push(sid);
      }
    }
    if (!refunded && !failed.length) {
      if (p.status === 'refunded') throw new Error('already refunded');
      if (sessions.length === 1 && !done) throw new Error('no payment to refund');
    }
    const what = refunded > 1 ? refunded + ' payments, $' + (cents / 100).toFixed(2) : '$' + (cents / 100).toFixed(2);
    const fail = failed.length ? ' · refund failed for ' + failed.length + ' payment' + (failed.length > 1 ? 's' : '') + ' (' + failed.map((x) => '…' + x.slice(-6)).join(', ') + '), tap Refund again' : '';
    if (refunded || p.status !== 'refunded') {
      await patchPass('id=eq.' + enc(id), { status: 'refunded', note: ((p.note ? p.note + ' · ' : '') + 'refunded from admin ' + new Date().toISOString().slice(0, 10) + ' (' + what + ')' + fail).slice(0, 500) });
      await endGifts(id); // Security S2: unused gifts of a refunded pass stop working
    }
    if (failed.length) throw new Error('Refunded ' + refunded + ' payment' + (refunded === 1 ? '' : 's') + '. ' + failed.length + ' failed at Stripe. Tap Refund again in a minute.');
    return { pass: await passWithDevices(id) };
  },

  // Lets the family start over with their devices ("move it to a new device").
  async 'passes.devices_reset'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    await rest('DELETE', 'devices?pass_id=eq.' + enc(id));
    return { pass: await passWithDevices(id) };
  },

  // ---- gift and support codes. One code = one family's pass. The code is shown once and never stored.
  async 'codes.create'({ kind, source, days_valid, note, batch }, _event, opts = {}) {
    const lb = cleanBatch(batch);
    if (lb && !opts.ensured) await ensureCampaign(lb);
    // Release 1.4 #32: gift and support codes are 7 days (default, printed cards), 30 days, or Forever.
    const k = kind === 'forever' ? 'forever' : kind === '30d' ? '30d' : '7d';
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
      batch: lb,
    };
    const { data } = await rest('POST', 'passes', { body: row, prefer: 'return=representation' });
    const pass = Array.isArray(data) && data[0];
    return { code, pass };
  },

  // Release 1.3 #16: a lost gift or support code. Cancels the unused code and makes a new one with the same
  // kind, reason, note, batch, and use-by window. Codes stay unrecoverable: the new code shows once, like any other.
  async 'codes.replace'({ id }) {
    if (!UUID.test(String(id || ''))) throw new Error('bad id');
    const old = await passWithDevices(id);
    if (!old) throw new Error('code not found');
    if (old.prefix !== 'GIFT' || (old.source !== 'gift' && old.source !== 'support')) throw new Error('only gift and support codes can be replaced');
    if (String(old.batch || '').toUpperCase() === FRIEND_BATCH) throw new Error('Friend passes come from the parent pass and cannot be replaced.');
    if (old.status !== 'unused') throw new Error(old.status === 'active' ? 'this code is already turned on; use Reset devices instead' : 'this code is no longer open');
    const span = old.use_by && old.created_at ? Math.round((new Date(old.use_by).getTime() - new Date(old.created_at).getTime()) / DAY) : 90;
    const rows = await patchPass('id=eq.' + enc(id) + '&status=eq.unused', { status: 'ended', ends_at: new Date().toISOString() });
    if (Array.isArray(rows) && rows.length === 0) throw new Error('this code was just turned on; use Reset devices instead');
    const made = await actions['codes.create']({ kind: old.kind, source: old.source, days_valid: span, note: old.note, batch: old.batch }, null, { ensured: true });
    await patchPass('id=eq.' + enc(id), { note: ((old.note ? old.note + ' · ' : '') + 'cancelled, replaced by ' + made.code.slice(-4) + ' on ' + new Date().toISOString().slice(0, 10)).slice(0, 500) });
    return { code: made.code, pass: made.pass, old: await passWithDevices(id) };
  },

  // Release 1.4 #58: how gifts spread, counted by pass and round, never by person.
  // No device values, no places, no play history, and never which family gifted which.
  async 'gifts.report'() {
    // Release 1.5 #67: one database step (gifts_summary). Before that SQL runs, the row-by-row count below.
    try {
      const { data: f } = await rest('POST', 'rpc/gifts_summary', { body: {} });
      if (f && typeof f === 'object' && f.totals) {
        const startedAs = (p) => p.kind === 'holder' ? 'free week' : p.source === 'stripe' ? 'paid' : p.kind === '7d' ? 'gift' : p.source;
        const n = (v) => Number(v) || 0;
        return {
          totals: { made: n(f.totals.made), on: n(f.totals.on), open: n(f.totals.open), expired: n(f.totals.expired), givers: n(f.givers), holders: n(f.holders), reward_days: n(f.reward_days) },
          rounds: (Array.isArray(f.rounds) ? f.rounds : []).map((r) => ({ round: n(r.round), made: n(r.made), on: n(r.on) })),
          bought: { passes: n(f.bought && f.bought.passes), forever: n(f.bought && f.bought.forever), cents: n(f.bought && f.bought.cents) },
          holders: (Array.isArray(f.top) ? f.top : []).map((p) => ({ last4: p.code_last4, prefix: p.prefix, started: startedAs(p), kind: p.kind, status: p.status,
            round: n(p.gen), on: n(p.on), left: n(p.left), reward_days: n(p.reward_days), made: p.created_at })),
        };
      }
    } catch { /* fall through to the row-by-row count */ }
    const now = Date.now();
    const gifts = await allRows('passes?batch=eq.' + FRIEND_BATCH + '&kind=eq.7d&select=id,giver_id,gen,status,starts_at,use_by,created_at&order=created_at.asc');
    const givers = new Map();
    const rounds = new Map();
    const t = { made: gifts.length, on: 0, open: 0, expired: 0 };
    for (const g of gifts) {
      const on = g.status !== 'unused' && !!g.starts_at;
      const expired = g.status === 'unused' && g.use_by && new Date(g.use_by).getTime() < now;
      if (on) t.on++; else if (expired) t.expired++; else if (g.status === 'unused') t.open++;
      const r = Math.max(1, Number(g.gen) || 1);
      const rr = rounds.get(r) || { round: r, made: 0, on: 0 }; rr.made++; if (on) rr.on++; rounds.set(r, rr);
      if (g.giver_id) { const v = givers.get(g.giver_id) || { on: 0, left: 0, made: 0 }; v.made++; if (on) v.on++; else if (!expired && g.status === 'unused') v.left++; givers.set(g.giver_id, v); }
    }
    const ids = [...givers.keys()].filter((x) => UUID.test(x));
    const rows = [];
    for (let i = 0; i < ids.length; i += 50) {
      const { data } = await rest('GET', 'passes?id=in.(' + ids.slice(i, i + 50).join(',') + ')&select=id,prefix,code_last4,kind,source,status,gen,reward_days,created_at');
      if (Array.isArray(data)) rows.push(...data);
    }
    const holderCount = (await allRows('passes?kind=eq.holder&select=id')).length;
    const bought = await allRows('passes?from_gift=eq.true&source=eq.stripe&select=kind,amount_cents');
    const startedAs = (p) => p.kind === 'holder' ? 'free week' : p.source === 'stripe' ? 'paid' : p.kind === '7d' ? 'gift' : p.source;
    const holders = rows.map((p) => {
      const v = givers.get(p.id) || { on: 0, left: 0 };
      return { last4: p.code_last4, prefix: p.prefix, started: startedAs(p), kind: p.kind, status: p.status, round: Number(p.gen) || 0,
        on: v.on, left: v.left, reward_days: Number(p.reward_days) || 0, made: p.created_at }; // Security S4: no family email in the Gifts tab
    }).sort((a, b) => (b.on - a.on) || String(b.made).localeCompare(String(a.made))).slice(0, 100);
    return {
      totals: { ...t, givers: givers.size, holders: holderCount, reward_days: rows.reduce((n, p) => n + (Number(p.reward_days) || 0), 0) },
      rounds: [...rounds.values()].sort((a, b) => a.round - b.round),
      bought: { passes: bought.length, forever: bought.filter((b) => b.kind === 'forever').length, cents: bought.reduce((n, b) => n + (Number(b.amount_cents) || 0), 0) },
      holders,
    };
  },

  // Release 1.4 #57: end every unused code in one batch (a school or event). Used codes keep working.
  async 'codes.end_unused'({ batch }) {
    const lb = cleanBatch(batch);
    if (!lb) throw new Error('pick a batch');
    const rows = await patchPass('batch=eq.' + enc(lb) + '&status=eq.unused', { status: 'ended', ends_at: new Date().toISOString() });
    console.log('admin-api: ended ' + rows.length + ' unused codes in a batch');
    return { ended: rows.length };
  },

  // Release 1.5 #67: delete a batch's codes nobody ever turned on (unused, or ended before use).
  // Codes a family turned on stay, even after they end. Gift and support codes only; never FRIEND, never paid.
  async 'codes.delete_unused'({ batch }) {
    const lb = cleanBatch(batch);
    if (!lb) throw new Error('pick a batch');
    if (lb.toUpperCase() === FRIEND_BATCH) throw new Error('friend passes cannot be deleted here');
    const filter = 'batch=eq.' + enc(lb) + '&source=in.(gift,support)&status=in.(unused,ended)&starts_at=is.null';
    const rows = await allRows('passes?' + filter + '&select=id');
    if (!rows.length) return { deleted: 0 };
    await rest('DELETE', 'passes?' + filter, { prefer: 'return=minimal' });
    console.log('admin-api: deleted ' + rows.length + ' unused codes in a batch');
    return { deleted: rows.length };
  },

  // Many codes at once, for printed cards. Up to 30 per call (function time limit); the page loops for more.
  async 'codes.batch'({ kind, source, days_valid, note, count, batch }) {
    const n = Math.min(30, Math.max(1, parseInt(count, 10) || 1));
    const lb = cleanBatch(batch);
    if (!lb) throw new Error('printed cards need a batch label, like lincoln-oct26');
    if (lb) await ensureCampaign(lb);
    const out = [];
    for (let i = 0; i < n; i++) out.push(await actions['codes.create']({ kind, source, days_valid, note, batch: lb }, null, { ensured: true }));
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
  async 'analytics.website'({ range }) { return websiteView(range); }, // Release 1.5 #64
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
    if (['play_counts_off', 'emails_paused', 'new_free_paused', 'lite_home'].includes(key) && v !== 0 && v !== 1) throw new Error('switches are 0 (off) or 1 (on)');
    if (key === 'free_days' && v > 60) throw new Error('free days: 60 at most');
    await rest('POST', 'settings?on_conflict=key', { body: { key, value: v, updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
    resetSwitchCache();
    return { ok: true };
  },
};

export const handler = async (event) => {
  const stop = guard('admin-api', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
  if (!sameOrigin(event)) return fail(403, 'Open the admin page on this site.');
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
