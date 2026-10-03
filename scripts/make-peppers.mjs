// Release 1.1.1 #44 L4: makes ADMIN_PEPPER and RATE_SALT and writes them to a
// file. Prints nothing secret.
// Run on the Mac:  node scripts/make-peppers.mjs ~/Downloads/peppers-staging.txt
// Paste each value into Netlify (Project configuration, Environment variables,
// mark as secret), then delete the file. Staging and live each get their own file.
// ADMIN_PEPPER scrambles admin sign-in codes, admin sessions and Home Screen
// pairing numbers. RATE_SALT scrambles the rate limit keys. Setting them signs
// every admin session out once and resets rate limit counters. Pass codes and
// device counts keep RESTORE_CODE_PEPPER, so no family loses a pass.
import crypto from 'node:crypto';
import fs from 'node:fs';

const out = process.argv[2];
if (!out) { console.log('Give a file path, for example ~/Downloads/peppers-staging.txt'); process.exit(1); }
const v = () => crypto.randomBytes(32).toString('base64url');
fs.writeFileSync(out, 'ADMIN_PEPPER (mark as secret)\n' + v() + '\n\nRATE_SALT (mark as secret)\n' + v() + '\n', { mode: 0o600 });
console.log('Wrote ' + out);
