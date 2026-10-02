// Admin sign-in: a 6-digit code emailed to the admin inbox, then a session
// cookie. Codes and session tokens live in the database only as hashes.
import crypto from 'node:crypto';
import { rest } from './db.mjs';
import { header, sha256hex } from './http.mjs';
import { sendEmail } from './email.mjs';

export const SESSION_HOURS = 12;
const CODE_MINUTES = 10;
const MAX_TRIES = 5; // per code, enforced in admin_code_check
export const MAX_FAILS = 20; // per hour, all networks, enforced in admin_code_check
const COOKIE = 'mojia_admin';
const enc = encodeURIComponent;

const pepper = () => process.env.ADMIN_PEPPER || process.env.RESTORE_CODE_PEPPER || '';
const hashCode = (id, code) => sha256hex(pepper() + ':admincode:' + id + ':' + code);
const hashToken = (t) => sha256hex(pepper() + ':adminsession:' + t);

export function adminEmail() {
  return process.env.ADMIN_EMAIL || 'hello@mojialand.com';
}

// Release 1.1.1 #38 (audit H2): the database counts each try in one step
// before the compare, so parallel guesses never pass 5 tries. After 20 failed
// tries in an hour from all networks, sign-in locks for 1 hour and the admin
// gets an email. A new code cancels every older code.

// True while sign-in is locked.
export async function loginLocked() {
  const { data } = await rest('POST', 'rpc/admin_locked', { body: {} });
  return data === true;
}

// Makes a code, stores its hash, cancels older codes, emails it.
// Returns the code row id, or null while sign-in is locked.
export async function startLogin() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const id = crypto.randomUUID();
  const { data } = await rest('POST', 'rpc/admin_code_new', {
    body: { p_id: id, p_hash: hashCode(id, code), p_expires: new Date(Date.now() + CODE_MINUTES * 60e3).toISOString() },
  });
  if (data !== true) return null;
  const spaced = code.slice(0, 3) + ' ' + code.slice(3);
  await sendEmail(adminEmail(), {
    subject: 'Mojialand: admin sign-in code ' + spaced,
    text: 'Your Mojialand admin code is ' + spaced + '.\n\nIt works for ' + CODE_MINUTES + ' minutes. A newer code cancels this one. If you did not ask for it, ignore this email.',
  });
  return id;
}

// Checks a code. Returns { token } on success, { locked: true } while locked,
// or {} for a wrong, used, cancelled or old code.
export async function finishLogin(id, code) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || '')) || !/^\d{6}$/.test(String(code || ''))) return {};
  const { data } = await rest('POST', 'rpc/admin_code_check', { body: { p_id: id, p_hash: hashCode(id, code) } });
  if (data === 'lockednow') {
    await sendEmail(adminEmail(), {
      subject: 'Mojialand: admin sign-in locked for 1 hour',
      text: 'Mojialand admin sign-in saw ' + MAX_FAILS + ' wrong codes in one hour, so sign-in is locked for 1 hour. Every open code is cancelled.\n\nIf this was not you, someone is guessing admin codes. Nothing else changed. After the hour, send a new code as usual.',
    }).catch(() => {});
    console.log('admin-login: locked after too many wrong codes');
    return { locked: true };
  }
  if (data === 'locked') return { locked: true };
  if (data !== 'ok') return {};
  const token = crypto.randomBytes(32).toString('base64url');
  await rest('POST', 'admin_sessions', {
    body: { token_hash: hashToken(token), expires_at: new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString() },
    prefer: 'return=minimal',
  });
  return { token };
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
