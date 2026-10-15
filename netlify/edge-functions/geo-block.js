// Release 1.5 #66: pages in blocked countries and regions show the blocked page with status 451.
// Runs only on the page addresses below (not images, fonts or functions), so it adds few calls.
// The server functions check the same list on their own (_lib/blocked.mjs).
import { blockedFor, geoOverride } from '../functions/_lib/blocked-list.mjs';

export default async (req, context) => {
  let place = null;
  const staging = String((globalThis.Netlify && Netlify.env.get('MOJIA_ENV')) || '').toLowerCase() === 'staging';
  if (staging) {
    const o = geoOverride(req.headers.get('cookie'));
    if (o) place = blockedFor(o.country, o.sub);
  }
  if (!place) {
    const g = (context && context.geo) || {};
    place = blockedFor(g.country && g.country.code, g.subdivision && g.subdivision.code);
  }
  if (!place) return; // not blocked: the normal page

  let body = 'Mojialand is not available in your country.';
  const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
  try {
    const res = await fetch(new URL('/blocked/', req.url));
    if (res.ok) {
      body = await res.text();
      res.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'etag', 'age'].includes(k.toLowerCase())) headers.set(k, v); });
    }
  } catch { /* plain text fallback */ }
  headers.set('Cache-Control', 'no-store');
  return new Response(body, { status: 451, headers });
};

export const config = {
  path: ['/', '/index.html', '/play/', '/play/index.html', '/pass/', '/pass/index.html', '/pass/done/', '/pass/done/index.html', '/r/*', '/g/*'],
};
