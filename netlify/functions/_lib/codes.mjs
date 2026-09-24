// Pass codes: MOJI-XXXX-XXXX-XXXX (12 characters after the prefix).
// Paid codes are derived from the Stripe session ID with a secret pepper,
// so the webhook and confirm-session make the same code without storing it.
import crypto from 'node:crypto';

export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 characters, no 0 O 1 I L
const N = ALPHABET.length;
const LIMIT = 256 - (256 % N); // reject bytes >= 248 so every character is equally likely

export function formatCode(prefix, chars) {
  return prefix + '-' + chars.match(/.{1,4}/g).join('-');
}

// Map a byte stream into the alphabet without bias.
function mapBytes(nextBytes, count) {
  let out = '';
  while (out.length < count) {
    for (const b of nextBytes()) {
      if (b < LIMIT) out += ALPHABET[b % N];
      if (out.length === count) break;
    }
  }
  return out;
}

export function deriveCode(pepper, sessionId) {
  if (!pepper) throw new Error('pepper missing');
  let i = 0;
  const next = () => {
    const h = crypto.createHmac('sha256', pepper).update('code:' + sessionId + (i ? ':' + i : '')).digest();
    i++;
    return h;
  };
  return formatCode('MOJI', mapBytes(next, 12));
}

export function randomCode(prefix = 'MOJI') {
  return formatCode(prefix, mapBytes(() => crypto.randomBytes(32), 12));
}

// Uppercase, drop everything that is not a letter or digit, then re-dash.
export function normalizeCode(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^(MOJI|GIFT)([A-Z0-9]+)$/.exec(s);
  if (!m || m[2].length % 4 !== 0 || m[2].length < 8 || m[2].length > 16) return null;
  for (const c of m[2]) if (!ALPHABET.includes(c)) return null;
  return formatCode(m[1], m[2]);
}

export function codeHash(pepper, code) {
  const n = normalizeCode(code);
  if (!n) return null;
  return crypto.createHash('sha256').update(pepper + n, 'utf8').digest('hex');
}

export const codeLast4 = (code) => String(code).replace(/-/g, '').slice(-4);

export const codeNoDashes = (code) => String(code).replace(/-/g, '');
