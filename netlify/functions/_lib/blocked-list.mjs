// Release 1.5 #66: countries and regions where Mojialand is not available.
// One list for both layers: the page check (netlify/edge-functions/geo-block.js)
// and the server check (_lib/blocked.mjs). Danny approved the list October 15, 2026.
// 42 countries: the board said 45, a counting slip (3 + 8 + 26 + 5 = 42); no country is missing.
// Plain JavaScript with no imports, so Node and the Deno edge runtime both load it.

// A. US sanctions (Stripe refuses these too).
const SANCTIONS = ['CU', 'IR', 'KP'];
// B. Danny's picks.
const PICKS = ['DE', 'RU', 'BY', 'SY', 'IQ', 'KW', 'IL', 'CN'];
// C. Child privacy law: the other 26 EU countries, the EEA, the United Kingdom, Switzerland.
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
const EEA_UK_CH = ['NO', 'IS', 'LI', 'GB', 'CH'];

export const BLOCKED_COUNTRIES = [...SANCTIONS, ...PICKS, ...EU, ...EEA_UK_CH];

// Regions inside Ukraine, by ISO 3166-2 code (country, dash, subdivision).
export const BLOCKED_REGIONS = {
  'UA-43': 'Crimea',
  'UA-40': 'Sevastopol',
  'UA-14': 'Donetsk',
  'UA-09': 'Luhansk',
};

// Returns { country, region } when the place is blocked, otherwise null.
// country: two-letter code. sub: the subdivision code from Netlify geo data
// (for Ukraine, "43" or "UA-43"; both forms are accepted).
export function blockedFor(country, sub) {
  const c = String(country || '').toUpperCase().slice(0, 2);
  if (!/^[A-Z]{2}$/.test(c)) return null;
  if (BLOCKED_COUNTRIES.includes(c)) return { country: c, region: '' };
  let s = String(sub || '').toUpperCase();
  if (s.startsWith(c + '-')) s = s.slice(c.length + 1);
  const key = c + '-' + s;
  if (s && BLOCKED_REGIONS[key]) return { country: c, region: key };
  return null;
}

// Staging only: a cookie mojia_geo=DE (or UA-43) pretends to come from that place,
// so Danny tests the block from the US. Ignored on live.
export function geoOverride(cookieHeader) {
  const m = /(?:^|;\s*)mojia_geo=([A-Za-z]{2})(?:-([0-9A-Za-z]{1,3}))?(?:;|$)/.exec(String(cookieHeader || ''));
  if (!m) return null;
  return { country: m[1].toUpperCase(), sub: m[2] ? m[2].toUpperCase() : '' };
}
