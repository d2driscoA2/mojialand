/* Release 1.4 #57: printable gift cards as a real PDF.
   Exact US business cards (3.5 x 2 in), 10 per US letter page, placed like
   Avery 8371 (0.5 in top, 0.75 in left, no gaps). Browsers print a PDF at
   100 percent, so the cards land at their true size on every device.
   No outside code: text uses the PDF built-in Helvetica and Courier fonts,
   QR codes are drawn as vector squares from qrcode.js. */
(function () {
  'use strict';
  var PT = 72, PAGE_W = 612, PAGE_H = 792, CARD_W = 252, CARD_H = 144, LEFT = 54, TOP = 36;
  var W = {
    Helvetica: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
    'Helvetica-Bold': [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]
  };
  var FONT_KEY = { Helvetica: 'F1', 'Helvetica-Bold': 'F2', 'Courier-Bold': 'F3' };
  function clean(s) { return String(s).replace(/[^\x20-\x7e]/g, '?'); }
  function textW(s, font, size) {
    if (font === 'Courier-Bold') return s.length * 600 * size / 1000;
    var t = W[font], w = 0; for (var i = 0; i < s.length; i++) { w += t[s.charCodeAt(i) - 32] || 556; } return w * size / 1000;
  }
  function wrap(s, font, size, max) {
    var words = clean(s).split(' '), lines = [], cur = '';
    words.forEach(function (wd) {
      var t = cur ? cur + ' ' + wd : wd;
      if (textW(t, font, size) <= max || !cur) { cur = t; } else { lines.push(cur); cur = wd; }
      while (textW(cur, font, size) > max && cur.length > 1) {
        var cut = cur.length; while (cut > 1 && textW(cur.slice(0, cut), font, size) > max) cut--;
        lines.push(cur.slice(0, cut)); cur = cur.slice(cut);
      }
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function esc(s) { return clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
  function rgb(hex) { return [0, 2, 4].map(function (i) { return (parseInt(hex.substr(i, 2), 16) / 255).toFixed(3); }).join(' '); }
  function n(x) { return (Math.round(x * 100) / 100).toString(); }

  /* Page drawing. y in the helpers counts down from the card's top edge. */
  function Page() { this.ops = []; }
  Page.prototype.text = function (x, yTop, s, font, size, color) {
    this.ops.push(rgb(color) + ' rg BT /' + FONT_KEY[font] + ' ' + n(size) + ' Tf ' + n(x) + ' ' + n(PAGE_H - yTop) + ' Td (' + esc(s) + ') Tj ET');
  };
  Page.prototype.center = function (cx, yTop, s, font, size, color) { this.text(cx - textW(clean(s), font, size) / 2, yTop, s, font, size, color); };
  Page.prototype.box = function (x, yTop, w, h, hex) { this.ops.push(rgb(hex) + ' rg ' + n(x) + ' ' + n(PAGE_H - yTop - h) + ' ' + n(w) + ' ' + n(h) + ' re f'); };
  Page.prototype.dashRect = function (x, yTop, w, h) { this.ops.push('q 0.5 w [2 2] 0 d ' + rgb('C9B8EA') + ' RG ' + n(x) + ' ' + n(PAGE_H - yTop - h) + ' ' + n(w) + ' ' + n(h) + ' re S Q'); };
  Page.prototype.image = function (x, yTop, w, h) { this.ops.push('q ' + n(w) + ' 0 0 ' + n(h) + ' ' + n(x) + ' ' + n(PAGE_H - yTop - h) + ' cm /Im1 Do Q'); };
  Page.prototype.qr = function (x, yTop, size, url) {
    var q; try { q = qrcode(0, 'M'); q.addData(url); q.make(); } catch (e) { return; }
    var m = q.getModuleCount(), cell = size / m, parts = [];
    for (var r = 0; r < m; r++) for (var c = 0; c < m; c++) if (q.isDark(r, c)) {
      parts.push(n(x + c * cell) + ' ' + n(PAGE_H - yTop - (r + 1) * cell) + ' ' + n(cell + 0.02) + ' ' + n(cell + 0.02) + ' re');
    }
    this.ops.push('0 0 0 rg ' + parts.join(' ') + ' f');
  };

  function drawCard(pg, cx, cy, codes, o) {
    var pad = 9, leftW = 84, hasLogo = !!o.logo;
    pg.dashRect(cx, cy, CARD_W, CARD_H);
    var y = cy + pad;
    if (hasLogo) { pg.image(cx + pad, y, 62, 62 * o.logo.h / o.logo.w); y += 62 * o.logo.h / o.logo.w + 5; }
    else { pg.text(cx + pad, y + 11, 'Mojialand', 'Helvetica-Bold', 12, '7138D1'); y += 16; }
    wrap(o.title, 'Helvetica-Bold', 9, leftW).forEach(function (l) { y += 9.5; pg.text(cx + pad, y, l, 'Helvetica-Bold', 9, '7138D1'); });
    y += 3;
    wrap(o.blurb, 'Helvetica', 5.8, leftW).forEach(function (l) { y += 6.8; pg.text(cx + pad, y, l, 'Helvetica', 5.8, '6B6180'); });
    if (o.label) { y += 8; pg.text(cx + pad, y, o.label, 'Helvetica-Bold', 5.5, '9A8FB0'); }
    var rx = cx + pad + leftW + 8, rw = CARD_W - (rx - cx) - pad;
    if (codes.length === 1) {
      var size = 88, qx = rx + (rw - size) / 2, qy = cy + pad + 2, c = codes[0];
      pg.qr(qx, qy, size, o.link(c));
      pg.center(rx + rw / 2, qy + size + 11, c, 'Courier-Bold', 8.5, '5122A5');
      wrap(o.short(c), 'Helvetica', 5, rw).forEach(function (l, i) { pg.center(rx + rw / 2, qy + size + 19 + i * 6, l, 'Helvetica', 5, '6B6180'); });
    } else {
      var s3 = 36, gap = (CARD_H - 2 * pad - 3 * s3) / 2;
      codes.forEach(function (c, i) {
        var qy = cy + pad + i * (s3 + gap), tx = rx + s3 + 5, tw = rw - s3 - 5;
        pg.qr(rx, qy, s3, o.link(c));
        pg.text(tx, qy + 15, c, 'Courier-Bold', 7, '5122A5');
        wrap(o.short(c), 'Helvetica', 4.8, tw).forEach(function (l, j) { pg.text(tx, qy + 23 + j * 5.6, l, 'Helvetica', 4.8, '6B6180'); });
      });
    }
  }

  function enc(s) { var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }

  /* opts: { codes, perCard, title, blurb, label, link(code), short(code), logo: {bytes:Uint8Array (JPEG), w, h} } */
  function build(opts) {
    var per = opts.perCard === 3 ? 3 : 1, cards = [];
    for (var i = 0; i < opts.codes.length; i += per) cards.push(opts.codes.slice(i, i + per));
    var pages = [];
    for (var p = 0; p < cards.length; p += 10) {
      var pg = new Page();
      cards.slice(p, p + 10).forEach(function (cs, k) { drawCard(pg, LEFT + (k % 2) * CARD_W, TOP + Math.floor(k / 2) * CARD_H, cs, opts); });
      pages.push(pg.ops.join('\n'));
    }
    if (!pages.length) pages.push('');
    var objs = [], chunks = [];
    function add(parts) { objs.push(parts); return objs.length; }
    var catalog = add(null), pagesId = add(null);
    var f1 = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    var f2 = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    var f3 = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>']);
    var img = opts.logo ? add(['<< /Type /XObject /Subtype /Image /Width ' + opts.logo.w + ' /Height ' + opts.logo.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + opts.logo.bytes.length + ' >>\nstream\n', opts.logo.bytes, '\nendstream']) : 0;
    var res = '<< /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R /F3 ' + f3 + ' 0 R >>' + (img ? ' /XObject << /Im1 ' + img + ' 0 R >>' : '') + ' >>';
    var kids = pages.map(function (ops) {
      var content = add(['<< /Length ' + ops.length + ' >>\nstream\n' + ops + '\nendstream']);
      return add(['<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources ' + res + ' /Contents ' + content + ' 0 R >>']);
    });
    objs[catalog - 1] = ['<< /Type /Catalog /Pages ' + pagesId + ' 0 R /ViewerPreferences << /PrintScaling /None >> >>'];
    objs[pagesId - 1] = ['<< /Type /Pages /Kids [' + kids.map(function (k) { return k + ' 0 R'; }).join(' ') + '] /Count ' + kids.length + ' >>'];
    var out = [enc('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')], len = out[0].length, offsets = [];
    objs.forEach(function (parts, i) {
      offsets.push(len);
      var pieces = [enc((i + 1) + ' 0 obj\n')].concat(parts.map(function (x) { return typeof x === 'string' ? enc(x) : x; }), [enc('\nendobj\n')]);
      pieces.forEach(function (b) { out.push(b); len += b.length; });
    });
    var xref = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offsets.map(function (o) { return ('000000000' + o).slice(-10) + ' 00000 n \n'; }).join('');
    out.push(enc(xref + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + len + '\n%%EOF\n'));
    return new Blob(out, { type: 'application/pdf' });
  }

  /* Logo as JPEG bytes on a white background (PDF has no WebP). */
  function loadLogo(src) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () {
        try {
          var w = 600, h = Math.round(600 * im.naturalHeight / im.naturalWidth), cv = document.createElement('canvas');
          cv.width = w; cv.height = h; var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h);
          var b64 = cv.toDataURL('image/jpeg', 0.92).split(',')[1], bin = atob(b64), bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          resolve({ bytes: bytes, w: w, h: h });
        } catch (e) { resolve(null); }
      };
      im.onerror = function () { resolve(null); };
      im.src = src;
    });
  }

  window.MojiCardPdf = { build: build, loadLogo: loadLogo, CARD_W_IN: CARD_W / PT, CARD_H_IN: CARD_H / PT };
})();
