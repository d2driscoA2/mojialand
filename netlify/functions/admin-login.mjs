// POST {step:'send'} -> {id}            emails a 6-digit code to the admin inbox
// POST {step:'verify', id, code} -> {ok}  sets the session cookie
// POST {step:'out'} -> {ok}              clears it
// GET  -> {signed_in}
import { guard } from './_lib/env.mjs';
import { json, fail, readJson, clientIp, sameOrigin } from './_lib/http.mjs';
import { rateHit, safeErr } from './_lib/db.mjs';
import { startLogin, finishLogin, isSignedIn, signOut, sessionCookie } from './_lib/admin.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESTORE_CODE_PEPPER', 'EMAIL_API_KEY', 'EMAIL_FROM'];

const withCookie = (res, cookie) => ({ ...res, headers: { ...res.headers, 'Set-Cookie': cookie } });

export const handler = async (event) => {
  const stop = guard('admin-login', REQUIRED);
  if (stop) return stop;

  try {
    if (event.httpMethod === 'GET') return json(200, { signed_in: await isSignedIn(event) });
    if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');
    if (!sameOrigin(event)) return fail(403, 'Open the admin page on this site.');
    const input = readJson(event) || {};
    const ip = clientIp(event);

    if (input.step === 'send') {
      if (!(await rateHit('admin-send', ip, 5, 3600))) return fail(429, 'Too many codes sent. Wait an hour.');
      const id = await startLogin();
      if (!id) return fail(423, 'Sign-in is locked for an hour after too many wrong codes.');
      console.log('admin-login: code sent');
      return json(200, { id });
    }
    if (input.step === 'verify') {
      if (!(await rateHit('admin-verify', ip, 15, 3600))) return fail(429, 'Too many tries. Wait an hour.');
      const { token, locked } = await finishLogin(input.id, String(input.code || '').replace(/\s/g, ''));
      if (locked) return fail(423, 'Sign-in is locked for an hour after too many wrong codes.');
      if (!token) return fail(401, 'That code did not work. Check it, or send a new one.');
      console.log('admin-login: signed in');
      return withCookie(json(200, { ok: true }), sessionCookie(token));
    }
    if (input.step === 'out') {
      await signOut(event);
      return withCookie(json(200, { ok: true }), sessionCookie(''));
    }
    return fail(400, 'Unknown step.');
  } catch (e) {
    console.error('admin-login: failed (' + safeErr(e) + ')');
    return fail(500, 'Sign-in is not working right now. Try again in a minute.');
  }
};
