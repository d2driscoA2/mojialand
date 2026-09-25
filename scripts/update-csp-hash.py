#!/usr/bin/env python3
"""Compute the sha256 hash of the one inline script in each page and write
the site's security headers to _headers. Netlify runs this as the build
command, so every Content-Security-Policy hash is recomputed on every deploy.

Pages (all under site/, the only folder Netlify publishes):
  site/index.html            the Mojialand website (grown-ups: passes, help, legal)
  site/play/index.html       the game (kid screens: nothing leaves the device)
  site/pass/index.html       checkout (Stripe Embedded Checkout; the only page that loads Stripe)
  site/pass/done/index.html  after payment: confirms the pass, then opens the game
  site/r/index.html          the email button: turns a pass on with its code

Before hashing, the pass token public key (env PASS_SIGNING_PUBLIC_JWK) goes
into the game and the done page in place of the __PASS_PUBLIC_JWK__ placeholder.
Without the variable the key stays null, and no pass counts as valid.
"""
import re, hashlib, base64, sys, os, pathlib, json

root = pathlib.Path(__file__).resolve().parent.parent
site_dir = root / 'site'   # the only folder Netlify publishes

# Staging mode: the staging Netlify project sets MOJIA_ENV=staging.
# Same code on both branches; only this setting differs.
STAGING = os.environ.get('MOJIA_ENV', '').lower() == 'staging'
BADGE = ('<div aria-hidden="true" style="position:fixed;left:8px;bottom:8px;z-index:99999;'
         'pointer-events:none;background:#30254A;color:#FFC83D;font:900 12px/1 system-ui,sans-serif;'
         'letter-spacing:.12em;padding:7px 10px;border-radius:999px;opacity:.9">STAGING</div>')

if STAGING:
    for rel in ('index.html', 'play/index.html', 'pass/index.html', 'pass/done/index.html', 'r/index.html'):
        f = site_dir / rel
        h = f.read_text(encoding='utf-8')
        if 'STAGING</div>' not in h:
            h = h.replace('</body>', BADGE + '</body>', 1)
            f.write_text(h, encoding='utf-8')
    (site_dir / 'robots.txt').write_text('User-agent: *\nDisallow: /\n', encoding='utf-8')


# Pass token public key. Only a public EC P-256 key is allowed in a page:
# a JWK with a "d" member is a private key and fails the build.
JWK_PAGES = ('play/index.html', 'pass/done/index.html', 'r/index.html')
JWK_RE = re.compile(r'(?:/\*)?__PASS_PUBLIC_JWK__(?:\*/null)?')


def public_jwk():
    raw = os.environ.get('PASS_SIGNING_PUBLIC_JWK', '').strip()
    if not raw:
        return 'null'
    try:
        k = json.loads(raw)
    except ValueError:
        sys.exit('PASS_SIGNING_PUBLIC_JWK is not valid JSON')
    if not isinstance(k, dict) or k.get('kty') != 'EC' or k.get('crv') != 'P-256' \
            or not isinstance(k.get('x'), str) or not isinstance(k.get('y'), str):
        sys.exit('PASS_SIGNING_PUBLIC_JWK must be a public EC P-256 JWK (kty EC, crv P-256, x, y)')
    if 'd' in k:
        sys.exit('PASS_SIGNING_PUBLIC_JWK contains a private key ("d"). Use the public key only.')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', k['x']) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', k['y']):
        sys.exit('PASS_SIGNING_PUBLIC_JWK has malformed x or y')
    return json.dumps({'kty': 'EC', 'crv': 'P-256', 'x': k['x'], 'y': k['y']}, separators=(',', ':'))


JWK = public_jwk()
for rel in JWK_PAGES:
    f = site_dir / rel
    h = f.read_text(encoding='utf-8')
    h2, n = JWK_RE.subn(JWK, h)
    if n:
        f.write_text(h2, encoding='utf-8')


def script_hash(rel):
    html = (site_dir / rel).read_text(encoding='utf-8')
    scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
    if len(scripts) != 1:
        sys.exit('%s: expected exactly one inline <script>, found %d' % (rel, len(scripts)))
    return base64.b64encode(hashlib.sha256(scripts[0].encode('utf-8')).digest()).decode()


game = script_hash('play/index.html')
site = script_hash('index.html')
pay_hashes = "'sha256-%s' 'sha256-%s'" % (script_hash('pass/index.html'), script_hash('pass/done/index.html'))
redeem = script_hash('r/index.html')

# Game: same strict policy as before. The website may show the game in its
# play window, so the game allows framing by its own site only.
game_csp = ("default-src 'none'; script-src 'self' 'sha256-%s'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; media-src data:; manifest-src 'self'; connect-src 'self'; "
            "base-uri 'self'; form-action 'none'; frame-ancestors 'self'; upgrade-insecure-requests") % game

# Website: adds the contact form (posts to this site) and the play window.
site_csp = ("default-src 'none'; script-src 'self' 'sha256-%s'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; "
            "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests") % site

# Code link page (/r/CODE): talks only to this site. No Stripe.
redeem_csp = ("default-src 'none'; script-src 'self' 'sha256-%s'; style-src 'self' 'unsafe-inline'; "
              "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
              "base-uri 'self'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests") % redeem

# Checkout pages (/pass/ and /pass/done/): the only place Stripe may load.
# Both inline scripts' hashes are listed, since one block covers both pages.
pass_csp = ("script-src 'self' %s https://js.stripe.com https://*.js.stripe.com; "
            "frame-src https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://hooks.stripe.com; "
            "connect-src 'self' https://api.stripe.com https://checkout.stripe.com; "
            "img-src 'self' data: https://*.stripe.com; style-src 'self' 'unsafe-inline'; font-src 'self'; "
            "default-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'") % pay_hashes

# Apple Pay and Google Pay inside Stripe's frame need the payment feature.
# /* turns payment off for every page. This /pass/* block comes after /*, so
# its Permissions-Policy wins whether Netlify overrides (later rule wins) or
# joins the two values with a comma (a repeated key: the last value wins).
pass_pp = ('camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com" "https://checkout.stripe.com"), '
           'usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=(), browsing-topics=()')

common = """/*
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=(), browsing-topics=()
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin"""
if STAGING:
    common += "\n  X-Robots-Tag: noindex, nofollow"
common += "\n"

def block(path, csp, xfo):
    return f"""{path}
  Content-Security-Policy: {csp}
  X-Frame-Options: {xfo}
"""

headers = "".join([
    common,
    block('/', site_csp, 'DENY'),
    block('/index.html', site_csp, 'DENY'),
    block('/play/*', game_csp, 'SAMEORIGIN'),
    block('/r/*', redeem_csp, 'DENY') + "  Cache-Control: no-store\n",
    block('/pass/*', pass_csp, 'DENY') + "  Permissions-Policy: %s\n" % pass_pp,
    "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n",
])
(site_dir / '_headers').write_text(headers, encoding='utf-8')
print('wrote _headers (%s): game sha256-%s, site sha256-%s, pass %s, code link sha256-%s, pass key %s' % (
    'staging' if STAGING else 'production', game, site, pay_hashes, redeem, 'set' if JWK != 'null' else 'not set'))
