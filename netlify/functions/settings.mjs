// GET -> the play settings the admin page edits. Public, read-only, no secrets.
import { guard } from './_lib/env.mjs';
import { json, fail } from './_lib/http.mjs';
import { rest, safeErr } from './_lib/db.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const KEYS = ['first_visit_minutes', 'daily_minutes', 'daily_reset', 'devices_per_code', 'warning_minutes', 'credit_days'];

export const handler = async (event) => {
  const stop = guard('settings', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'GET') return fail(405, 'Use GET.');
  try {
    const { data } = await rest('GET', 'settings?select=key,value');
    const out = {};
    for (const row of Array.isArray(data) ? data : []) if (KEYS.includes(row.key)) out[row.key] = row.value;
    return { ...json(200, out), headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } };
  } catch (e) {
    console.error('settings: failed (' + safeErr(e) + ')');
    return fail(500, 'Not available.');
  }
};
