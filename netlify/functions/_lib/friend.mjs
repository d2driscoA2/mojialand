// Friend pass (Release 1.1 #3). Paid Stripe passes and printed gift card passes
// each give one free 48-hour pass to another family.
// Release 1.1.1 #37 (audit H1, Danny October 1): friend passes never make friend
// passes, so the chain stops after one link. Support passes made by hand in
// admin give none.
// Guardrails (Danny, September 30): one friend pass per pass; it only turns on
// for a device that never had a pass (redeem-code checks); it must be used
// within 30 days of the parent pass starting. Rows carry batch FRIEND so they
// are counted as codes, never as people.
import { rest, getPassBy } from './db.mjs';
import { deriveFriendCode, codeHash, codeLast4, codeNoDashes } from './codes.mjs';
import { DAY as DAY_MS, GIFTS_PER_FAMILY, GIFT_USE_DAYS, REWARD_DAYS, REWARD_CAP } from './kinds.mjs';

const DAY = 86400e3;
export const FRIEND_DAYS = 30;
export const FRIEND_BATCH = 'FRIEND';

// Release 1.4 #32: only 48-hour passes keep the old one friend pass. Every
// other family gets 3 gifts of 7 days (gifts below).
export function givesFriendPass(parent) {
  if (!parent || !parent.id) return false;
  if (parent.kind !== '48h') return false;
  if (parent.batch === FRIEND_BATCH) return false;
  if (parent.source === 'stripe') return true;
  return parent.source === 'gift';
}

export async function friendPass(parent) {
  if (!givesFriendPass(parent)) return null;
  if (['refunded', 'disputed', 'unused'].includes(parent.status)) return null;
  const pepper = process.env.RESTORE_CODE_PEPPER;
  const code = deriveFriendCode(pepper, parent.id);
  const hash = codeHash(pepper, code);
  let row = await getPassBy('code_hash', hash);
  if (!row) {
    const base = new Date(parent.starts_at || parent.created_at || Date.now()).getTime();
    const useBy = base + FRIEND_DAYS * DAY;
    if (Date.now() > useBy) return null;
    await rest('POST', 'passes?on_conflict=code_hash', {
      body: {
        code_hash: hash, code_last4: codeLast4(code), prefix: 'GIFT', kind: '48h', source: 'gift',
        status: 'unused', use_by: new Date(useBy).toISOString(), device_limit: 5, batch: FRIEND_BATCH,
        note: 'friend pass from ' + (parent.prefix || 'MOJI') + '-…' + parent.code_last4,
      },
      prefer: 'resolution=ignore-duplicates,return=minimal',
    });
    row = await getPassBy('code_hash', hash);
    if (!row) return null;
  }
  const expired = row.status === 'unused' && row.use_by && new Date(row.use_by).getTime() < Date.now();
  return {
    code,
    path: '/g/' + codeNoDashes(code),
    use_by: row.use_by,
    state: row.status === 'unused' ? (expired ? 'expired' : 'ready') : 'used',
  };
}

// Release 1.4 #32 (Danny, October 6 and 11): 3 gifts of 7 free days per family.
// A gift works once, on a device new to Mojialand, within 30 days of being made.
// Families who started from a gift get 3 of their own (B1). Support passes,
// unused codes, refunded and disputed passes give none. Codes are made again
// from the giver's pass ID, never stored as text.
export function givesGifts(p) {
  if (!p || !p.id) return false;
  if (p.source === 'support') return false;
  return !['refunded', 'disputed', 'unused'].includes(p.status) || p.kind === 'holder';
}

export async function gifts(parent) {
  if (!givesGifts(parent)) return null;
  const pepper = process.env.RESTORE_CODE_PEPPER;
  const out = [];
  for (let i = 1; i <= GIFTS_PER_FAMILY; i++) {
    const code = deriveFriendCode(pepper, parent.id + ':g' + i);
    const hash = codeHash(pepper, code);
    let row = await getPassBy('code_hash', hash);
    if (!row) {
      await rest('POST', 'passes?on_conflict=code_hash', {
        body: {
          code_hash: hash, code_last4: codeLast4(code), prefix: 'GIFT', kind: '7d', source: 'gift',
          status: 'unused', use_by: new Date(Date.now() + GIFT_USE_DAYS * DAY_MS).toISOString(), device_limit: 5,
          batch: FRIEND_BATCH, giver_id: parent.id, gen: (Number(parent.gen) || 0) + 1,
          note: 'gift from ' + (parent.prefix || 'MOJI') + '-…' + parent.code_last4,
        },
        prefer: 'resolution=ignore-duplicates,return=minimal',
      });
      row = await getPassBy('code_hash', hash);
      if (!row) continue;
    }
    const expired = row.status === 'unused' && row.use_by && new Date(row.use_by).getTime() < Date.now();
    out.push({ code, path: '/g/' + codeNoDashes(code), use_by: row.use_by, state: row.status === 'unused' ? (expired ? 'expired' : 'ready') : 'used' });
  }
  return { gifts: out, reward_days: Number(parent.reward_days) || 0, cap: REWARD_CAP };
}

// A friend turned a gift on: the giver gets 7 days (on the pass, or on the free
// week through the gift holder), at most 21 in all, in one locked database step.
export async function rewardGiver(giverId) {
  if (!giverId) return -1;
  try {
    const { data } = await rest('POST', 'rpc/gift_reward', { body: { p_giver: giverId, p_days: REWARD_DAYS, p_cap: REWARD_CAP } });
    return typeof data === 'number' ? data : -1;
  } catch {
    console.error('gift reward failed');
    return -1;
  }
}
