// POST /api/ping {e, g, m, b?, c?, cp?} -> 204
// Counts a game open, a still-playing mark, a close, or a QR campaign open.
// Uses the modern function signature because only it carries Netlify's geo data.
// The IP address is read for the rate limiter (hashed there) and never stored.
import { checkEnv } from './_lib/env.mjs';
import { recordPing } from './_lib/analytics.mjs';
import { safeErr } from './_lib/db.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export default async (req, context) => {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: HEADERS });
  const reason = checkEnv(REQUIRED);
  if (reason) {
    console.error('ping: refused to start (' + reason + ')');
    return new Response(null, { status: 500, headers: HEADERS });
  }
  let body = null;
  try {
    const text = await req.text();
    if (text.length <= 512) body = JSON.parse(text || 'null');
  } catch {
    body = null;
  }
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  try {
    const status = await recordPing(body, context && context.geo, ip);
    return new Response(null, { status, headers: HEADERS });
  } catch (e) {
    console.error('ping: failed (' + safeErr(e) + ')');
    return new Response(null, { status: 500, headers: HEADERS });
  }
};

export const config = { path: '/api/ping' };
