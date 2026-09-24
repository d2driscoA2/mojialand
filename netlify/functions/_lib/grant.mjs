// grantPass: turns a paid Checkout Session into a pass. Safe to run many times
// for the same session (webhook retries, confirm-session reloads).
import { rest, getPassBy, claimEvent, releaseEvent, patchPass } from './db.mjs';
import { deriveCode, codeHash, codeLast4 } from './codes.mjs';

const HOUR = 3600e3;

export class GrantError extends Error {}

export async function grantPass(session) {
  if (!session || session.payment_status !== 'paid') throw new GrantError('not paid');
  const plan = session.metadata && session.metadata.plan;
  const pepper = process.env.RESTORE_CODE_PEPPER;

  if (plan === 'pass' || plan === 'life') {
    const code = deriveCode(pepper, session.id);
    const now = new Date();
    const row = {
      code_hash: codeHash(pepper, code),
      code_last4: codeLast4(code),
      prefix: 'MOJI',
      kind: plan === 'life' ? 'forever' : '48h',
      source: 'stripe',
      email: (session.customer_details && session.customer_details.email) || null,
      stripe_session_id: session.id,
      amount_cents: Number(session.amount_total) || 0,
      starts_at: now.toISOString(),
      ends_at: plan === 'life' ? null : new Date(now.getTime() + 48 * HOUR).toISOString(),
      device_limit: 5,
      status: 'active',
    };
    await rest('POST', 'passes?on_conflict=stripe_session_id', {
      body: row,
      prefer: 'resolution=ignore-duplicates,return=minimal',
    });
    const pass = await getPassBy('stripe_session_id', session.id);
    if (!pass) throw new GrantError('pass missing after insert');
    return { plan, pass, code };
  }

  if (plan === 'add' || plan === 'up') {
    const passId = session.metadata.pass_id;
    if (!passId || !/^[0-9a-f-]{36}$/i.test(passId)) throw new GrantError('pass id missing');
    const pass = await getPassBy('id', passId);
    if (!pass) throw new GrantError('pass not found');
    const guardId = 'grant:' + session.id;
    if (!(await claimEvent(guardId, session.id))) {
      // Already applied. Read again so the caller sees the updated row.
      await new Promise((r) => setTimeout(r, 300));
      return { plan, pass: (await getPassBy('id', passId)) || pass, code: null };
    }
    try {
      let patch;
      if (plan === 'add') {
        const base = Math.max(Date.now(), pass.ends_at ? new Date(pass.ends_at).getTime() : 0);
        patch = { ends_at: new Date(base + 48 * HOUR).toISOString(), status: 'active' };
      } else {
        patch = { kind: 'forever', ends_at: null, status: 'active' };
      }
      const rows = await patchPass('id=eq.' + encodeURIComponent(passId), patch);
      if (!rows.length) throw new GrantError('pass update failed');
      return { plan, pass: rows[0], code: null };
    } catch (e) {
      await releaseEvent(guardId); // let a retry apply it
      throw e;
    }
  }

  throw new GrantError('unknown plan');
}
