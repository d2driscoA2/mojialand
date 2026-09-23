# Mojialand

Four little emoji games for kids 3 and up. Pattern, Bounce, Match, Parade.

One file, no build step. `index.html` is the whole app.

Live: https://mojialand.displayedux.com

## Deploy
Push to `main`. Netlify publishes the repo root.

The Netlify build command runs `scripts/update-csp-hash.py`. It hashes the inline game script in `index.html` and writes the security headers, including the Content-Security-Policy with that hash, to `_headers`. Netlify recomputes the hash on every deploy, so any change to the game code ships with a matching policy. `_headers` is generated and not committed.
