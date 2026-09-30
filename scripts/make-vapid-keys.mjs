// Makes one key pair for phone alerts and writes it to a file. Prints nothing secret.
// Run on the Mac:  node scripts/make-vapid-keys.mjs ~/Downloads/vapid-staging.txt
// Then copy each line's value into Netlify (Site configuration, Environment variables)
// and delete the file. Staging and live each get their own pair.
import crypto from 'node:crypto';
import fs from 'node:fs';

const out = process.argv[2];
if (!out) { console.log('Give a file path, for example ~/Downloads/vapid-staging.txt'); process.exit(1); }
const e = crypto.createECDH('prime256v1');
e.generateKeys();
const text = 'VAPID_PUBLIC_KEY\n' + e.getPublicKey().toString('base64url') + '\n\nVAPID_PRIVATE_KEY (mark as secret)\n' + Buffer.concat([Buffer.alloc(32 - e.getPrivateKey().length), e.getPrivateKey()]).toString('base64url') + '\n';
fs.writeFileSync(out, text, { mode: 0o600 });
console.log('Wrote ' + out);
