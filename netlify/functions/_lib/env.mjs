// Environment checks shared by every function.
// Never log or return a value from process.env. Names only.

export const NOT_SET_UP = 'Checkout is not set up yet.';

export function envName() {
  return (process.env.MOJIA_ENV || '').toLowerCase() === 'staging' ? 'staging' : 'live';
}

// Keys that must never appear in this environment.
const LIVE_PREFIXES = ['sk_live', 'rk_live', 'pk_live'];
const TEST_PREFIXES = ['sk_test', 'rk_test', 'pk_test'];
const KEY_VARS = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'];

// Returns null when everything is fine, or a short reason (for logs only).
export function checkEnv(required) {
  for (const name of required) {
    if (!process.env[name]) return 'missing ' + name;
  }
  const bad = envName() === 'staging' ? LIVE_PREFIXES : TEST_PREFIXES;
  for (const name of KEY_VARS) {
    const v = process.env[name];
    if (v && bad.some((p) => v.startsWith(p))) return 'wrong mode key in ' + name;
  }
  return null;
}

// Startup guard. Returns a 500 response when the function must not run.
export function guard(fnName, required) {
  const reason = checkEnv(required);
  if (!reason) return null;
  console.error(fnName + ': refused to start (' + reason + ')');
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ error: NOT_SET_UP }),
  };
}
