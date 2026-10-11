// Release 1.4 #32: pass kinds and their lengths, in one place.
//   48h     old 48-hour pass (kept for running passes and cards printed before 1.4)
//   30d     30-day pass, $4.99, never renews by itself
//   7d      gift of 7 free days
//   holder  gift holder for a free-week family (end time = free week end plus reward days)
//   forever Forever
const HOUR = 3600e3;
export const DAY = 24 * HOUR;
export const KIND_MS = { '48h': 48 * HOUR, '30d': 30 * DAY, '7d': 7 * DAY };
export const TIMED = ['48h', '30d', '7d', 'holder'];
export const KINDS = ['48h', '30d', '7d', 'holder', 'forever'];
export const FREE_DAYS = 7;          // free week from the first open on a device
export const GIFT_DAYS = 7;          // what one gift gives a friend
export const GIFTS_PER_FAMILY = 3;
export const REWARD_DAYS = 7;        // what the giver gets when a friend turns a gift on
export const REWARD_CAP = 21;        // most reward days one family earns
export const GIFT_USE_DAYS = 30;     // a gift works for 30 days from the day it is made
export function lengthOf(kind) { return KIND_MS[kind] || 0; }
// The free week end a device reports, clamped to now .. now + 7 days.
export function freeWeekEnd(input, now = Date.now()) {
  const v = Number(input);
  return Number.isFinite(v) ? Math.min(now + FREE_DAYS * DAY, Math.max(now, v)) : now + FREE_DAYS * DAY;
}
