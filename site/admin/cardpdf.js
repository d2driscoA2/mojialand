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
    /* Release 1.5.1: one rectangle per run of dark squares in a row, in a module grid (y down), for a smaller PDF. */
    var m = q.getModuleCount(), cell = size / m, parts = [];
    for (var r = 0; r < m; r++) for (var c = 0; c < m; c++) if (q.isDark(r, c)) {
      var c0 = c; while (c + 1 < m && q.isDark(r, c + 1)) c++;
      parts.push(c0 + ' ' + r + ' ' + (c - c0 + 1.01) + ' 1.01 re');
    }
    this.ops.push('q 0 0 0 rg ' + (Math.round(cell * 10000) / 10000) + ' 0 0 ' + (-Math.round(cell * 10000) / 10000) + ' ' + n(x) + ' ' + n(PAGE_H - yTop) + ' cm ' + parts.join(' ') + ' f Q');
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
    return pdfFrom(pages, opts.logo ? [opts.logo] : []);
  }

  /* PDF writer: pages are content streams; images are JPEG faces named /Im1, /Im2, ... */
  function pdfFrom(pages, images) {
    if (!pages.length) pages.push('');
    var objs = [];
    function add(parts) { objs.push(parts); return objs.length; }
    var catalog = add(null), pagesId = add(null);
    var f1 = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    var f2 = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    var f3 = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>']);
    var imgs = images.map(function (im) { return add(['<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n', im.bytes, '\nendstream']); });
    var res = '<< /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R /F3 ' + f3 + ' 0 R >>' + (imgs.length ? ' /XObject << ' + imgs.map(function (id, i) { return '/Im' + (i + 1) + ' ' + id + ' 0 R'; }).join(' ') + ' >>' : '') + ' >>';
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

  /* ---- Release 1.5.1 #73: card B, the golden ticket (Danny, October 19, design B, one side).
     The art (colors, friends icon, Nunito words) is drawn on a canvas at 300 dpi, 1050 by 600 px, one
     image per distinct card face. The QR code and the code stay vector on top, so they print sharp.
     Positions come from the approved artboard: every px divides by 300 for inches (x 0.24 for points). */
  var PX = CARD_W / 1050;
  var TK = { yellow: '#FFC83D', cream: '#FFF8E8', purple: '#7138D1', deep: '#5122A5', pink: '#FF5FA2', white: '#FFFFFF', gray: '#5E5577', label: '#9A8FB0' };
  var FACE_FONT = 'MojiCardNunito';
  /* Every word printed on a ticket. A test reads this list: never the word "emoji" on a card (Brand section 10). */
  var TICKET_TEXT = {
    pill: 'GIFT PASS', small: 'Picture games for kids 3 and up', sub: 'of Mojialand games',
    safe1: 'No ads. No chat.', safe2: 'Nothing collected from your child.', scan: 'Grown-up: scan with your camera',
    devices: 'Up to 5 devices.', turnOn: 'Turn on by ', campaign: 'Scan to play free', freeDays: ' FREE DAYS',
    head: { '7d': '7 FREE DAYS', '30d': '30 FREE DAYS', '90d': '90 FREE DAYS', forever: 'FOREVER' }
  };
  function headlineFor(kind) { return TICKET_TEXT.head[kind] || TICKET_TEXT.head['7d']; }
  var assets = null;
  function loadAssets() {
    if (assets) return assets;
    var font = Promise.resolve(false);
    try {
      if (typeof FontFace === 'function' && document.fonts) {
        var ff = new FontFace(FACE_FONT, 'url(/fonts/nunito-latin.woff2) format("woff2")', { weight: '700 900' });
        font = ff.load().then(function (f) { document.fonts.add(f); return Promise.all(['800 30px', '900 100px'].map(function (w) { return document.fonts.load(w + ' ' + FACE_FONT); })); }).then(function () { return true; }, function () { return false; });
      }
    } catch (e) {}
    var icon = new Promise(function (resolve) { var im = new Image(); im.onload = function () { resolve(im); }; im.onerror = function () { resolve(null); }; im.src = '/logo/app-icon-1024.png'; });
    assets = Promise.all([font, icon]).then(function (r) { return { font: r[0], icon: r[1] }; });
    return assets;
  }
  function f(g, weight, size, fam) { g.font = weight + ' ' + size + 'px ' + (fam || FACE_FONT + ', Nunito, sans-serif'); }
  function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  /* Balanced wrap: the split with the narrowest longest line. Keeps a lone word ("up") off its own line. */
  function balance(g, s, max, lines) {
    var words = s.split(' ');
    if (lines === 1 || g.measureText(s).width <= max) return [s];
    var best = null;
    for (var i = 1; i < words.length; i++) {
      var a = words.slice(0, i).join(' '), b = words.slice(i).join(' '), w = Math.max(g.measureText(a).width, g.measureText(b).width);
      if (!best || w < best.w) best = { w: w, l: [a, b] };
    }
    return best.l;
  }
  /* Greedy wrap, the way the artboard wraps ("Grown-up: scan with" / "your camera"). */
  function greedy(g, s, max) { var out = [], cur = ''; s.split(' ').forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (!cur || g.measureText(t).width <= max) cur = t; else { out.push(cur); cur = w; } }); if (cur) out.push(cur); return out; }
  /* Baseline of a CSS line box: Nunito ascent 1.011 em, descent 0.353 em, normal line height 1.364 em. */
  function base(top, size, lh) { return top + ((lh || size * 1.364) - size * 1.364) / 2 + size * 1.011; }
  var SHIELD = ['M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z', 'M8.5 12l2.5 2.5 4.5-5'];

  /* face: { headline, useBy ('' for none), label, campaign } -> layout of the right column (px), drawn on g */
  function rightLayout(face) {
    var items = [{ k: 'scan', h: 62.1 }, { k: 'qr', h: 240 }, { k: 'code', h: 30 }];
    if (!face.campaign) items.push({ k: 'use', h: face.useBy ? 48 : 24 });
    if (face.label) items.push({ k: 'label', h: 21 });
    var total = items.reduce(function (t, it) { return t + it.h; }, 0) + 12 * (items.length - 1), y = 58 + (484 - total) / 2, at = {};
    items.forEach(function (it) { at[it.k] = y; y += it.h + 12; });
    return at;
  }
  function drawFace(g, face, A) {
    g.textBaseline = 'alphabetic';
    g.fillStyle = TK.yellow; g.fillRect(0, 0, 1050, 600);
    g.fillStyle = TK.cream; rrect(g, 26, 26, 998, 548, 28); g.fill();
    g.fillStyle = TK.yellow; [26, 1024].forEach(function (cx) { g.beginPath(); g.arc(cx, 300, 26, 0, Math.PI * 2); g.fill(); });
    /* left column: x 66, width 550, y 58 to 542, rows spread top, middle, bottom */
    if (A.icon) { g.save(); rrect(g, 66, 69, 110, 110, 26); g.clip(); g.drawImage(A.icon, 66, 69, 110, 110); g.restore(); }
    f(g, 900, 24); var pillTxt = face.campaign ? (face.pill || '') : TICKET_TEXT.pill;
    var smallTop = 58;
    if (pillTxt) {
      if (g.letterSpacing !== undefined) g.letterSpacing = '1px';
      var pw = g.measureText(pillTxt).width + 32 + (g.letterSpacing !== undefined ? 0 : pillTxt.length);
      g.fillStyle = TK.pink; rrect(g, 194, 58, pw, 44, 22); g.fill();
      g.fillStyle = TK.white; g.fillText(pillTxt, 210, base(64, 24, 32));
      if (g.letterSpacing !== undefined) g.letterSpacing = '0px';
      smallTop = 108;
    }
    f(g, 800, 30); g.fillStyle = TK.deep;
    var small = balance(g, TICKET_TEXT.small, 422);
    if (!pillTxt) smallTop = 58 + (132 - small.length * 41) / 2;
    small.forEach(function (l, i) { g.fillText(l, 194, base(smallTop + i * 41, 30)); });
    f(g, 900, 100); var head = balance(g, face.headline, 550);
    var sub = face.campaign ? '' : TICKET_TEXT.sub;
    var blockH = head.length * 95 + (sub ? 4 + 49 : 0), gap = (484 - 132 - blockH - 80) / 2, top = 58 + 132 + gap;
    g.fillStyle = TK.purple; head.forEach(function (l, i) { g.fillText(l, 66, base(top + i * 95, 100, 95)); });
    if (sub) { f(g, 800, 36); g.fillStyle = TK.deep; g.fillText(sub, 66, base(top + head.length * 95 + 4, 36)); }
    /* safety badge: purple box, yellow shield check, white words on two lines (word for word) */
    f(g, 900, 25); var tw = Math.max(g.measureText(TICKET_TEXT.safe1).width, g.measureText(TICKET_TEXT.safe2).width);
    g.fillStyle = TK.purple; rrect(g, 66, 462, Math.min(550, 16 + 30 + 12 + tw + 22), 80, 20); g.fill();
    g.save(); g.translate(82, 487); g.scale(30 / 24, 30 / 24); g.strokeStyle = TK.yellow; g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round';
    if (typeof Path2D === 'function') SHIELD.forEach(function (d) { g.stroke(new Path2D(d)); });
    g.restore();
    g.fillStyle = TK.white; g.fillText(TICKET_TEXT.safe1, 124, base(472, 25, 30)); g.fillText(TICKET_TEXT.safe2, 124, base(502, 25, 30));
    /* right column after a dashed purple line */
    g.fillStyle = TK.purple; for (var y = 58; y < 542; y += 20) g.fillRect(650, y, 4, Math.min(12, 542 - y));
    var at = rightLayout(face);
    f(g, 900, 27); g.textAlign = 'center'; g.fillStyle = TK.purple;
    greedy(g, TICKET_TEXT.scan, 300).forEach(function (l, i) { g.fillText(l, 834, base(at.scan + i * 31.05, 27, 31.05)); });
    if (at.use !== undefined) {
      f(g, 700, 18); g.fillStyle = TK.gray;
      g.fillText(TICKET_TEXT.devices, 834, base(at.use, 18, 24));
      if (face.useBy) g.fillText(TICKET_TEXT.turnOn + face.useBy + '.', 834, base(at.use + 24, 18, 24));
    }
    if (face.label) { f(g, 800, 17); g.fillStyle = TK.label; g.fillText(face.label, 834, base(at.label, 17, 21)); }
    g.textAlign = 'left';
  }
  function faceJpeg(face, A) {
    var cv = faceCanvas(face, A);
    var bin = atob(cv.toDataURL('image/jpeg', 0.95).split(',')[1]), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes: bytes, w: 1050, h: 600, canvas: cv };
  }
  /* One card face; assets must be loaded (loadAssets). */
  function faceOf(opts, useBy) { return { headline: opts.campaign ? TICKET_TEXT.campaign : headlineFor(opts.kind), useBy: useBy || '', label: opts.campaign ? '' : (opts.label || ''), campaign: !!opts.campaign, pill: opts.campaign ? (opts.campaign.freeDays > 0 ? opts.campaign.freeDays + TICKET_TEXT.freeDays : '') : '' }; }
  function faceCanvas(face, A) { var cv = document.createElement('canvas'); cv.width = 1050; cv.height = 600; drawFace(cv.getContext('2d'), face, A); return cv; }
  /* Use-by date on the card: "Jan 17, 2027". No date, no clause. */
  function useByText(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  /* opts: { cards: [{ code, link, useBy }], kind, label, campaign: { link, host, freeDays } }
     Gift cards: one code per card. Campaign cards: 10 of the same QR (the campaign link), no code. */
  function buildTicket(opts) {
    return loadAssets().then(function (A) {
      var faces = [], keyOf = {};
      var cards = opts.campaign ? new Array(10).fill(null).map(function () { return { code: '', link: opts.campaign.link, useBy: '', text: opts.campaign.host }; }) : opts.cards;
      cards.forEach(function (c) {
        var face = faceOf(opts, c.useBy);
        var k = JSON.stringify(face);
        if (!(k in keyOf)) { keyOf[k] = faces.length; faces.push({ face: face, img: faceJpeg(face, A) }); }
        c.face = keyOf[k];
      });
      var pages = [];
      for (var p = 0; p < cards.length; p += 10) {
        var pg = new Page();
        cards.slice(p, p + 10).forEach(function (c, k) {
          var x = LEFT + (k % 2) * CARD_W, yTop = TOP + Math.floor(k / 2) * CARD_H, fc = faces[c.face].face, at = rightLayout(fc);
          pg.ops.push('q ' + n(CARD_W) + ' 0 0 ' + n(CARD_H) + ' ' + n(x) + ' ' + n(PAGE_H - yTop - CARD_H) + ' cm /Im' + (c.face + 1) + ' Do Q');
          pg.qr(x + 714 * PX, yTop + at.qr * PX, 240 * PX, c.link);
          var txt = c.text || c.code, size = 26 * PX;
          while (textW(clean(txt), 'Courier-Bold', size) > 290 * PX && size > 3) size -= 0.2;
          pg.center(x + 834 * PX, yTop + (at.code + 22) * PX, txt, 'Courier-Bold', size, '5122A5');
        });
        pages.push(pg.ops.join('\n'));
      }
      return { blob: pdfFrom(pages, faces.map(function (x) { return x.img; })), faces: faces.length, canvases: faces.map(function (x) { return x.img.canvas; }) };
    });
  }

  /* Share sheet on phones (and inside the admin Home Screen app), download elsewhere. */
  function deliver(blob, name) {
    try { var file = new File([blob], name, { type: 'application/pdf' }); if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Mojialand cards' }).catch(function () {}); return 'share'; } } catch (e) {}
    var url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 60000); return 'download';
  }

  window.MojiCardPdf = { build: build, buildTicket: buildTicket, deliver: deliver, drawFace: drawFace, faceOf: faceOf, faceCanvas: faceCanvas, rightLayout: rightLayout, useByText: useByText, loadAssets: loadAssets, headlineFor: headlineFor, TICKET_TEXT: TICKET_TEXT, loadLogo: loadLogo, CARD_W_IN: CARD_W / PT, CARD_H_IN: CARD_H / PT };
})();
