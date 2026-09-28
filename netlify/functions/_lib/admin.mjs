// Admin sign-in: a 6-digit code emailed to the admin inbox, then a session
// cookie. Codes and session tokens live in the database only as hashes.
import crypto from 'node:crypto';
import { rest } from './db.mjs';
import { header, sha256hex } from './http.mjs';
import { sendEmail } from './email.mjs';

export const SESSION_HOURS = 12;
const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const COOKIE = 'mojia_admin';
const enc = encodeURIComponent;

const pepper = () => process.env.ADMIN_PEPPER || process.env.RESTORE_CODE_PEPPER || '';
const hashCode = (id, code) => sha256hex(pepper() + ':admincode:' + id + ':' + code);
const hashToken = (t) => sha256hex(pepper() + ':adminsession:' + t);

export function adminEmail() {
  return process.env.ADMIN_EMAIL || 'hello@mojialand.com';
}

// Makes a code, stores its hash, emails it. Returns the code row id.
export async function startLogin() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const id = crypto.randomUUID();
  await rest('POST', 'admin_codes', {
    body: { id, code_hash: hashCode(id, code), expires_at: new Date(Date.now() + CODE_MINUTES * 60e3).toISOString() },
    prefer: 'return=minimal',
  });
  const spaced = code.slice(0, 3) + ' ' + code.slice(3);
  await sendEmail(adminEmail(), {
    subject: 'Mojialand: admin sign-in code ' + spaced,
    text: 'Your Mojialand admin code is ' + spaced + '.\n\nIt works for ' + CODE_MINUTES + ' minutes. If you did not ask for it, ignore this email.',
  });
  return id;
}

// Checks a code. Returns a new session token, or null.
export async function finishLogin(id, code) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || '')) || !/^\d{6}$/.test(String(code || ''))) return null;
  const { data } = await rest('GET', 'admin_codes?id=eq.' + enc(id) + '&select=*&limit=1');
  const row = Array.isArray(data) && data[0];
  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now() || row.tries >= MAX_TRIES) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(id, code)));
  await rest('PATCH', 'admin_codes?id=eq.' + enc(id), { body: ok ? { used: true } : { tries: row.tries + 1 }, prefer: 'return=minimal' });
  if (!ok) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await rest('POST', 'admin_sessions', {
    body: { token_hash: hashToken(token), expires_at: new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString() },
    prefer: 'return=minimal',
  });
  return token;
}

function readCookie(event) {
  const raw = header(event, 'cookie') || '';
  for (const part of String(raw).split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

// True when the request carries a live session cookie.
export async function isSignedIn(event) {
  const token = readCookie(event);
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return false;
  const { data } = await rest('GET', 'admin_sessions?token_hash=eq.' + enc(hashToken(token)) + '&select=expires_at&limit=1');
  const row = Array.isArray(data) && data[0];
  return !!row && new Date(row.expires_at).getTime() > Date.now();
}

export async function signOut(event) {
  const token = readCookie(event);
  if (token) {
    try { await rest('DELETE', 'admin_sessions?token_hash=eq.' + enc(hashToken(token))); } catch { /* cookie clears anyway */ }
  }
}

// Cookie for the admin functions only. Secure, HttpOnly, same-site strict.
export function sessionCookie(token) {
  const base = COOKIE + '=' + (token || '') + '; Path=/.netlify/functions/; HttpOnly; Secure; SameSite=Strict';
  return token ? base + '; Max-Age=' + SESSION_HOURS * 3600 : base + '; Max-Age=0';
}
