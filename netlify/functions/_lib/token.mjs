// Pass tokens, signed with ECDSA P-256 (SHA-256). The pages hold only the
// public key and check the signature with WebCrypto. Signature format is
// IEEE P1363 (r||s, 64 bytes), which is what WebCrypto expects.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Release 1.1.1 #42 (audit M4): a Forever token carries x, the time the token
// itself stops working (30 days). The game renews it in the background while
// the pass is still good (pass-check), so a refund or chargeback turns Forever
// off within 30 days even on a device that never asks again. 48-hour tokens
// already end at e and carry no x.
export const FOREVER_TOKEN_DAYS = 30;

export function makeTokenPayload(pass, env, now = Date.now()) {
  const forever = pass.kind === 'forever';
  const payload = {
    v: 1,
    k: forever ? 'forever' : '48h',
    e: forever || !pass.ends_at ? 0 : new Date(pass.ends_at).getTime(),
    t: b64u(crypto.randomBytes(16)),
    p: pass.id,
    env,
  };
  if (forever) payload.x = now + FOREVER_TOKEN_DAYS * 86400e3;
  return payload;
}

// The private key may be stored as a JWK JSON string (preferred; one line,
// safe for the Netlify CLI), a PEM, or a base64-encoded PEM.
export function loadPrivateKey(value) {
  let v = String(value || '').trim();
  if (v.startsWith('{')) return crypto.createPrivateKey({ key: JSON.parse(v), format: 'jwk' });
  if (!v.includes('BEGIN')) v = Buffer.from(v, 'base64').toString('utf8');
  return crypto.createPrivateKey(v.replace(/\\n/g, '\n'));
}

export function signToken(payload, privatePem) {
  const key = loadPrivateKey(privatePem);
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign('sha256', Buffer.from(body, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return body + '.' + b64u(sig);
}

// Node-side check, used by tests and available to later functions.
export function verifyToken(token, publicJwk) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  try {
    const key = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
    const ok = crypto.verify('sha256', Buffer.from(parts[0], 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[1], 'base64url'));
    return ok ? JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) : null;
  } catch {
    return null;
  }
}
