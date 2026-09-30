// Friend pass (Release 1.1 #3). Every 48-hour or Forever pass holder, paid or
// free, gets one free 48-hour pass to give to another family.
// Guardrails (Danny, September 30): one friend pass per pass; it only turns on
// for a device that never had a pass (redeem-code checks); it must be used
// within 30 days of the parent pass starting. Rows carry batch FRIEND so they
// are counted as codes, never as people.
import { rest, getPassBy } from './db.mjs';
import { deriveFriendCode, codeHash, codeLast4, codeNoDashes } from './codes.mjs';

const DAY = 86400e3;
export const FRIEND_DAYS = 30;
export const FRIEND_BATCH = 'FRIEND';

export async function friendPass(parent) {
  if (!parent || !parent.id) return null;
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
