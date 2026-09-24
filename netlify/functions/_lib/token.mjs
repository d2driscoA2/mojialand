// Pass tokens, signed with ECDSA P-256 (SHA-256). The pages hold only the
// public key and check the signature with WebCrypto. Signature format is
// IEEE P1363 (r||s, 64 bytes), which is what WebCrypto expects.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function makeTokenPayload(pass, env) {
  const forever = pass.kind === 'forever';
  return {
    v: 1,
    k: forever ? 'forever' : '48h',
    e: forever || !pass.ends_at ? 0 : new Date(pass.ends_at).getTime(),
    t: b64u(crypto.randomBytes(16)),
    p: pass.id,
    env,
  };
}

export function signToken(payload, privatePem) {
  const key = crypto.createPrivateKey(privatePem);
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
