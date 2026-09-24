# Mojialand

Four little emoji games for kids 3 and up. Pattern, Bounce, Match, Parade.

No framework, no dependencies. `site/` is the only public folder: `site/index.html` is the website, `site/play/index.html` is the game. Everything outside `site/` (this README, `scripts/`, `netlify.toml`) stays private.

Live: https://mojialand.displayedux.com

## Deploy
Push to `main`. Netlify publishes only `site/`.

The Netlify build command runs `scripts/update-csp-hash.py`. It hashes the one inline script in each page under `site/` and writes the security headers to `site/_headers`: shared headers on `/*`, and a Content-Security-Policy with the matching hash on each page path. Netlify recomputes the hash on every deploy, so any change to the game code ships with a matching policy. `_headers` is generated and not committed.
