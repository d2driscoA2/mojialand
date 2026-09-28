// GET ?r=<pass token>&c=<code> -> a web app manifest whose start_url carries the pass.
// Why: an iPhone Home Screen web app gets its own storage, separate from Safari.
// A pass bought in Safari would be invisible to the Home Screen app. Safari reads
// the manifest at "Add to Home Screen" time, so the game points its manifest link
// here while a pass is on the device. The app then opens with the pass in its
// address and saves it. The token is signed, so nothing here can be forged.
import { json } from './_lib/http.mjs';
import { normalizeCode } from './_lib/codes.mjs';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,1500}\.[A-Za-z0-9_-]{80,100}$/;

const BASE = {
  name: 'Mojialand',
  short_name: 'Mojialand',
  description: 'Emoji games for little hands.',
  start_url: '/play/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#FFF7E8',
  theme_color: '#9B5DE5',
  icons: [
    { src: '/logo/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/logo/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Use GET.' });
  const q = event.queryStringParameters || {};
  const token = TOKEN_RE.test(String(q.r || '')) ? q.r : '';
  const code = normalizeCode(q.c) || '';
  const manifest = { ...BASE };
  if (token) {
    manifest.start_url = '/play/?restore=' + encodeURIComponent(token) + (code ? '&code=' + encodeURIComponent(code) : '');
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(manifest),
  };
};
