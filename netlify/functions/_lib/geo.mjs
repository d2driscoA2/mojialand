// Places outside the US for the admin Analytics tab (Admin 1, #62).
// Region ids follow ISO 3166-2: US-MI, CA-ON, MX-NLE. The network sends the
// part after the dash; Mexico state codes vary by source, so they are mapped
// to the ISO code here.

export const NA = new Set(['US', 'CA', 'MX']);

// Mexico: postal, HASC and old ISO codes to the ISO 3166-2 code
const MX = {
  AG: 'AGU', BC: 'BCN', BN: 'BCN', BS: 'BCS', CM: 'CAM', CH: 'CHH', CS: 'CHP', CP: 'CHP', CO: 'COA', CA: 'COA',
  CL: 'COL', DF: 'CMX', DIF: 'CMX', CDMX: 'CMX', DG: 'DUR', DU: 'DUR', GR: 'GRO', GJ: 'GUA', GT: 'GUA', HG: 'HID', HI: 'HID',
  JA: 'JAL', JC: 'JAL', MX: 'MEX', EM: 'MEX', ME: 'MEX', MI: 'MIC', MC: 'MIC', MO: 'MOR', MR: 'MOR', NA: 'NAY', NL: 'NLE',
  OA: 'OAX', PU: 'PUE', PB: 'PUE', QT: 'QUE', QE: 'QUE', QR: 'ROO', QRO: 'QUE', SI: 'SIN', SL: 'SLP', SO: 'SON', TB: 'TAB',
  TM: 'TAM', TL: 'TLA', VE: 'VER', VZ: 'VER', YU: 'YUC', YUC: 'YUC', ZA: 'ZAC',
};
// Canada: old postal codes
const CA = { NF: 'NL', PQ: 'QC', YK: 'YT' };

export function regionCode(co, st) {
  const s = String(st || '').toUpperCase();
  if (!s) return '';
  if (co === 'MX') return MX[s] || s;
  if (co === 'CA') return CA[s] || s;
  return s;
}
export function regionId(co, st) {
  const s = regionCode(co, st);
  return co && s ? co + '-' + s : '';
}

// Countries and regions Mojialand blocks (Release 1.5, #66). Their plays from
// before the block stay in the totals and show with a Blocked tag (Danny,
// October 15). When Release 1.5 merges in, read its shared country file instead.
export const BLOCKED = new Set([
  'CU', 'IR', 'KP',
  'DE', 'RU', 'BY', 'SY', 'IQ', 'KW', 'IL', 'CN',
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'NO', 'IS', 'LI', 'GB', 'CH',
]);
export const BLOCKED_REGIONS = new Set(['UA-43', 'UA-40', 'UA-14', 'UA-09']);
