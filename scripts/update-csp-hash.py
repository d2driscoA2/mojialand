#!/usr/bin/env python3
"""Compute the sha256 hash of the inline game script in index.html and write
the site's security headers to _headers. Netlify runs this as the build
command, so the Content-Security-Policy hash is recomputed on every deploy."""
import re, hashlib, base64, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
html = (root / 'index.html').read_text(encoding='utf-8')
scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
if len(scripts) != 1:
    sys.exit('expected exactly one inline <script>, found %d' % len(scripts))
digest = base64.b64encode(hashlib.sha256(scripts[0].encode('utf-8')).digest()).decode()

csp = ("default-src 'none'; script-src 'self' 'sha256-%s'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; font-src 'self'; media-src data:; manifest-src 'self'; connect-src 'self'; "
       "base-uri 'self'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests") % digest

headers = f"""/*
  Content-Security-Policy: {csp}
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=(), browsing-topics=()
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin

/fonts/*
  Cache-Control: public, max-age=31536000, immutable
"""
(root / '_headers').write_text(headers, encoding='utf-8')
print('wrote _headers with script hash sha256-' + digest)
