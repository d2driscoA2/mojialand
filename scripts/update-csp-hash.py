#!/usr/bin/env python3
"""Compute the sha256 hash of the one inline script in each page and write
the site's security headers to _headers. Netlify runs this as the build
command, so every Content-Security-Policy hash is recomputed on every deploy.

Pages:
  index.html       the Mojialand website (grown-ups: passes, help, legal)
  play/index.html  the game (kid screens: nothing leaves the device)
"""
import re, hashlib, base64, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent


def script_hash(rel):
    html = (root / rel).read_text(encoding='utf-8')
    scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
    if len(scripts) != 1:
        sys.exit('%s: expected exactly one inline <script>, found %d' % (rel, len(scripts)))
    return base64.b64encode(hashlib.sha256(scripts[0].encode('utf-8')).digest()).decode()


game = script_hash('play/index.html')
site = script_hash('index.html')

# Game: same strict policy as before. The website may show the game in its
# play window, so the game allows framing by its own site only.
game_csp = ("default-src 'none'; script-src 'self' 'sha256-%s'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; media-src data:; manifest-src 'self'; connect-src 'self'; "
            "base-uri 'self'; form-action 'none'; frame-ancestors 'self'; upgrade-insecure-requests") % game

# Website: adds the contact form (posts to this site) and the play window.
site_csp = ("default-src 'none'; script-src 'self' 'sha256-%s'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; "
            "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests") % site

common = """  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=(), browsing-topics=()
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin"""

def block(path, csp, xfo):
    return f"""{path}
  Content-Security-Policy: {csp}
  X-Frame-Options: {xfo}
{common}
"""

headers = "".join([
    block('/', site_csp, 'DENY'),
    block('/index.html', site_csp, 'DENY'),
    block('/play/*', game_csp, 'SAMEORIGIN'),
    "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n",
])
(root / '_headers').write_text(headers, encoding='utf-8')
print('wrote _headers: game sha256-%s, site sha256-%s' % (game, site))
