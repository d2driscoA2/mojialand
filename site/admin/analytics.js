// Mojialand admin: Analytics tab (Live, History, Campaigns).
// Reads counts from admin-api. The server already folds small places into
// their county or state, so this page never sees a place below the small-number rule.
(function () {
  'use strict';
  const A = window.MojiAdmin;
  const root = document.getElementById('anRoot');
  if (!A || !root) return;
  const api = A.api, esc = A.esc;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TZ = 'America/Detroit';
  const GAMES = [
    { k: 'pattern', n: 'Pattern', e: '🦄', c: '#FF5FA2' },
    { k: 'bounce', n: 'Bounce', e: '🎾', c: '#4DBCEC' },
    { k: 'match', n: 'Match', e: '😊', c: '#FFC83D' },
    { k: 'parade', n: 'Parade', e: '🐶', c: '#72D69A' },
    { k: 'draw', n: 'Draw', e: '🖍️', c: '#7138D1' },
  ];
  const GI = Object.fromEntries(GAMES.map((g, i) => [g.k, i]));
  const CC = ['#FF5FA2', '#4DBCEC', '#FFC83D', '#72D69A', '#7138D1', '#F4565C', '#FF8A3D'];
  const $ = (id) => document.getElementById(id);
  const fmtN = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const fmtTime = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const fmtHour = (h) => { const d = new Date(Date.UTC(2020, 0, 1, h)); return d.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric' }); };
  const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const fmtMonth = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
  const wkDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
  const top = (by) => by.indexOf(Math.max(...by));
  const sv = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); return e; };
  const shield = '<span aria-hidden="true">🛡️</span>';
  const countyWord = (st) => (st === 'LA' ? 'Parish' : st === 'AK' ? 'Area' : 'County');
  const RANGE_LABEL = { 1: 'today', 7: 'last 7 days', 30: 'last 30 days', 60: 'last 60 days', 90: 'last 90 days', 365: 'last 12 months' };

  // ---------------- markup
  root.innerHTML = `
  <div class="anHead">
    <div class="anSeg" role="group" aria-label="Analytics view" id="anViews">
      <button type="button" data-v="live" aria-pressed="true">Live</button>
      <button type="button" data-v="history" aria-pressed="false">History</button>
      <button type="button" data-v="campaigns" aria-pressed="false">Campaigns</button>
    </div>
    <span class="anMuted" id="anErr" role="status"></span>
  </div>

  <section id="anLive" style="display:grid;gap:16px">
    <div class="anCard anHero">
      <div class="anBig"><span id="anTotal">0</span><small>games open right now</small></div>
      <div style="display:grid;gap:10px;min-width:0">
        <div class="anStamp"><span class="anPulse" aria-hidden="true"></span><span id="anAsOf">Loading…</span></div>
        <div class="anChips" id="anChips"></div>
      </div>
    </div>
    <div class="anCard" style="display:grid;gap:10px">
      <div class="anHead"><h2>Where kids play right now</h2><span class="anMuted">Tap a state to zoom in</span></div>
      <div class="anMap" id="anLiveMap"></div>
      <div class="anLegend" data-legend></div>
      <div id="anLivePlaces"></div>
      <p class="anMuted" id="anLiveOther"></p>
    </div>
    <div class="anGrid3">
      <div class="anCard anBoard"><h3>Busiest cities right now</h3><div class="anBoard" id="anBusy"></div></div>
      <div class="anCard anBoard"><h3>Latest active cities</h3><div class="anFeed" id="anFeed"></div></div>
      <div class="anCard anBoard"><h3>Games right now</h3><div class="anBoard" id="anGames"></div></div>
    </div>
    <div class="anPrivacy">${shield}<span><b>Counts only.</b> No names, devices, IP addresses or play sessions. The live view runs 5 minutes behind. A city shows once 3 or more games are open there. Smaller towns add up to their county first, then to their state.</span></div>
  </section>

  <section id="anHistory" hidden style="display:grid;gap:16px">
    <div class="anSeg" role="group" aria-label="Time range" id="anRanges">
      <button type="button" data-r="1" aria-pressed="false">Today</button>
      <button type="button" data-r="7" aria-pressed="true">7 days</button>
      <button type="button" data-r="30" aria-pressed="false">30 days</button>
      <button type="button" data-r="60" aria-pressed="false">60 days</button>
      <button type="button" data-r="90" aria-pressed="false">90 days</button>
      <button type="button" data-r="365" aria-pressed="false">Year</button>
    </div>
    <div class="anKpis" id="anKpis"></div>
    <div class="anCard" style="display:grid;gap:10px" id="anTrendCard">
      <div class="anHead"><h2>Usage over time</h2><div class="anLegend" style="padding:0" id="anTrendLegend"></div></div>
      <div class="anGrid2">
        <div style="min-width:0"><h3 id="anTrendPlaysT">Plays per day</h3><div class="anChart" id="anTrendPlays"></div></div>
        <div style="min-width:0"><h3 id="anTrendMinsT">Minutes played per day</h3><div class="anChart" id="anTrendMins"></div></div>
      </div>
    </div>
    <div class="anCard" style="display:grid;gap:10px">
      <div class="anHead"><h2>Plays by place</h2><span class="anMuted">Tap a state to zoom in</span></div>
      <p id="anHistSub">Bubble size shows plays. Color shows the favorite game in that place.</p>
      <div class="anMap" id="anHistMap"></div>
      <div class="anLegend" data-legend></div>
      <div id="anHistPlaces"></div>
      <div class="anReplay" id="anReplayRow">
        <button type="button" class="secondary" id="anPlay">▶ Replay the day</button>
        <input type="range" id="anHour" min="0" max="23" value="23" aria-label="Hour of the day">
        <span class="hr" id="anHourLbl">All day</span>
      </div>
    </div>
    <div class="anGrid2">
      <div class="anCard"><h3 id="anOtTitle">Plays per day by game</h3><div class="anChart" id="anOverTime"></div><div class="anLegend" id="anOtLegend"></div></div>
      <div class="anCard"><h3>Busiest hours (Michigan time)</h3><div class="anChart" id="anHours"></div></div>
    </div>
    <div class="anGrid2">
      <div class="anCard anBoard"><h3>Games by plays</h3><div class="anBoard" id="anHGames"></div></div>
      <div class="anCard"><h3>How long each play lasts</h3><div id="anLen"></div><h3 style="margin-top:14px">Home Screen app or browser</h3><div id="anSplit"></div></div>
    </div>
    <div class="anGrid2">
      <div class="anCard"><h3>Top places by plays</h3><div class="anTable" id="anTPlays"></div></div>
      <div class="anCard"><h3>Top places by minutes played</h3><div class="anTable" id="anTMins"></div></div>
    </div>
    <div class="anPrivacy">${shield}<span><b>Totals by the hour, never by the person.</b> A city shows on days with 5 or more plays. Smaller towns add up to their county, and a county shows once its total passes 5. The rest rolls into the state. Minutes come from ranges (under 2, 2 to 5, 5 to 15, 15 plus), so no single play is timed. Mojialand counts plays, not people.</span></div>
  </section>

  <section id="anCampaigns" hidden style="display:grid;gap:16px">
    <div class="anCard" style="display:grid;gap:12px">
      <div class="anHead"><h2>Campaigns</h2><span class="anMuted">Tap a campaign to see its results</span></div>
      <div class="anCamps" id="anCamps"></div>
    </div>
    <div class="anCard" style="display:grid;gap:14px" id="anBoardC" hidden></div>
    <div class="anCard" style="display:grid;gap:10px" id="anCompareCard" hidden><h3>All campaigns side by side</h3><div class="anTable" id="anCompare"></div></div>
    <div class="anCard">
      <h2>Make a campaign</h2>
      <p style="margin-bottom:12px">Every card, poster or post from one event shares one label. The label names the event, never a family.</p>
      <form id="anMake" novalidate style="display:grid;gap:10px">
        <div class="row">
          <label for="anName">Name<input id="anName" maxlength="60" placeholder="Troy library story time" autocomplete="off"></label>
          <label for="anLabel">Label in the link<input id="anLabel" maxlength="24" placeholder="mi-troy-lib-oct" autocomplete="off" spellcheck="false"></label>
        </div>
        <label for="anNote">Note to yourself<input id="anNote" maxlength="200" placeholder="200 cards at the Oct 4 story time" autocomplete="off"></label>
        <span class="anMuted">Label: lowercase letters, numbers and dashes, up to 24. Filled in from the name.</span>
        <div class="anLinkbox"><img id="anQrPrev" alt="QR code preview" width="88" height="88"><div style="display:grid;gap:4px;min-width:0"><span class="anMuted">QR code opens</span><code id="anLinkPrev"></code></div></div>
        <p class="err" id="anMakeErr"></p>
        <div class="row"><button class="primary" type="submit" id="anMakeBtn">Make campaign</button></div>
      </form>
    </div>
    <div class="anPrivacy">${shield}<span><b>Campaigns count events, never people.</b> The first open from a QR code counts once, then the label leaves the address bar. The device keeps only the event label for 7 days to credit a later play, gift code or pass. Places under 5 opens add up to their county, then their state.</span></div>
  </section>
  <p class="anMuted" id="anCredit"></p>`;

  const legend = GAMES.map((g) => `<span><i style="background:${g.c}"></i>${g.e} ${g.n}</span>`).join('') + '<span><i style="background:#fff;border:2px dashed #7138D1"></i>Dashed ring = a county, several small towns together</span><span><i style="background:#fff;border:2px solid #D9CCEE"></i>+N = smaller places in the state</span>';
  root.querySelectorAll('[data-legend]').forEach((el) => { el.innerHTML = legend; });
  const setErr = (m) => { $('anErr').textContent = m || ''; };

  // ---------------- map data
  let MAP = null;
  const COUNTIES = {};
  const mapReady = fetch('/admin/usmap.json', { credentials: 'same-origin' }).then((r) => r.json()).then((m) => {
    MAP = m;
    MAP.stateBy = Object.fromEntries(m.states.map((s) => [s.ab, s]));
    $('anCredit').textContent = (m.attribution || '') + ' County outlines: US Census Bureau via us-atlas (ISC).';
  });
  function loadCounties(st) {
    if (!COUNTIES[st]) {
      COUNTIES[st] = fetch('/admin/counties/' + encodeURIComponent(st) + '.json', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : { counties: [] }))
        .then((d) => { const by = {}; for (const c of d.counties || []) by[c.id] = c; return { list: d.counties || [], by }; })
        .catch(() => ({ list: [], by: {} }));
    }
    return COUNTIES[st];
  }
  const VB_US = [0, 0, 975, 610];
  const VB_LAKES = [560, 110, 250, 156];
  function pos(state, city) {
    const p = city && MAP.cities[state + '|' + city];
    if (p) return p;
    const s = MAP.stateBy[state];
    return s ? s.c : null;
  }
  function fitBox(b, pad) {
    let [x0, y0, x1, y1] = b;
    const p = pad == null ? 0.08 : pad;
    let w = Math.max(x1 - x0, 8), h = Math.max(y1 - y0, 6);
    x0 -= w * p; y0 -= h * p; w *= 1 + 2 * p; h *= 1 + 2 * p;
    const want = 610 / 975;
    if (h / w > want) { const nw = h / want; x0 -= (nw - w) / 2; w = nw; } else { const nh = w * want; y0 -= (nh - h) / 2; h = nh; }
    return [x0, y0, w, h];
  }
  function unionBox(list) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of list) { b[0] = Math.min(b[0], c.b[0]); b[1] = Math.min(b[1], c.b[1]); b[2] = Math.max(b[2], c.b[2]); b[3] = Math.max(b[3], c.b[3]); }
    return b;
  }

  // ---------------- the map: US, then a state with its counties, then a county
  // data: { cities:[{city,state,county,total,byGame}], counties:[{id,name,state,total,byGame}], rolls:{st:n}, states:[{state,total,byGame}] }
  function makeMap(wrap, opts) {
    wrap.innerHTML = '';
    const svg = sv('svg', { viewBox: VB_US.join(' '), role: 'img', 'aria-label': opts.label });
    const gS = sv('g'), gC = sv('g'), gR = sv('g'), gL = sv('g'), gB = sv('g');
    const stateEls = {};
    for (const s of MAP.states) {
      const p = sv('path', { d: s.d, class: 'anState', tabindex: '-1' });
      p.dataset.st = s.ab;
      gS.appendChild(p);
      stateEls[s.ab] = p;
    }
    svg.append(gS, gC, gR, gL, gB);
    wrap.appendChild(svg);
    const tools = document.createElement('div');
    tools.className = 'anTools';
    wrap.appendChild(tools);
    const tip = document.createElement('div');
    tip.className = 'anTip';
    tip.hidden = true;
    wrap.appendChild(tip);
    const panel = opts.panel || null;
    let vb = VB_US.slice(), items = [], rolls = [], data = { cities: [], counties: [], rolls: {}, states: [] };
    let level = { kind: 'us' };
    const nodes = new Map();
    const width = () => svg.getBoundingClientRect().width || 900;

    function setVB(t) {
      if (reduce) { vb = t.slice(); svg.setAttribute('viewBox', vb.join(' ')); layout(); return; }
      const from = vb.slice(), t0 = performance.now();
      (function step(now) {
        const k = Math.min(1, (now - t0) / 450), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        vb = from.map((v, i) => v + (t[i] - v) * e);
        svg.setAttribute('viewBox', vb.join(' '));
        layout();
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    }
    function drawTools() {
      const crumbs = ['<button type="button" data-go="us" aria-pressed="' + (level.kind === 'us') + '">Whole US</button>'];
      if (level.kind === 'us') crumbs.push('<button type="button" data-go="lakes" aria-pressed="false">Great Lakes</button>');
      if (level.st) crumbs.push('<button type="button" data-go="state" aria-pressed="' + (level.kind === 'state') + '">' + esc(MAP.stateBy[level.st] ? MAP.stateBy[level.st].n : level.st) + '</button>');
      if (level.kind === 'county') crumbs.push('<button type="button" data-go="county" aria-pressed="true">' + esc(level.name + ' ' + countyWord(level.st)) + '</button>');
      tools.innerHTML = '<div class="anSeg anCrumbs" role="group" aria-label="Map level">' + crumbs.join('') + '</div>' + (level.kind !== 'us' ? '<button type="button" class="anBack" data-go="back" aria-label="Back one level">← Back</button>' : '');
    }
    tools.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const g = b.dataset.go;
      if (g === 'us') goUS();
      else if (g === 'lakes') { tools.querySelectorAll('[data-go]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); setVB(VB_LAKES); }
      else if (g === 'state' && level.st) zoomState(level.st);
      else if (g === 'back') { if (level.kind === 'county') zoomState(level.st); else goUS(); }
    });
    function goUS() {
      level = { kind: 'us' };
      gC.innerHTML = '';
      for (const p of Object.values(stateEls)) p.classList.remove('dim', 'sel');
      drawTools(); setVB(VB_US); drawPanel();
      if (opts.onLevel) opts.onLevel(level);
    }
    async function zoomState(st) {
      const cs = await loadCounties(st);
      level = { kind: 'state', st };
      for (const [ab, p] of Object.entries(stateEls)) { p.classList.toggle('dim', ab !== st); p.classList.toggle('sel', ab === st); }
      drawCounties(st, cs);
      drawTools();
      setVB(cs.list.length ? fitBox(unionBox(cs.list)) : VB_US);
      drawPanel();
      if (opts.onLevel) opts.onLevel(level);
    }
    async function zoomCounty(st, id) {
      const cs = await loadCounties(st);
      const c = cs.by[id];
      if (!c) return;
      level = { kind: 'county', st, id, name: c.n };
      drawCounties(st, cs);
      drawTools();
      setVB(fitBox(c.b, 0.35));
      drawPanel();
      if (opts.onLevel) opts.onLevel(level);
    }
    // county totals for shading: shown county remainders plus shown cities inside
    function countyTotals(st) {
      const t = {};
      for (const k of data.counties) if (k.state === st) t[k.id] = (t[k.id] || 0) + k.total;
      for (const c of data.cities) if (c.state === st && c.county) t[c.county] = (t[c.county] || 0) + c.total;
      return t;
    }
    function drawCounties(st, cs) {
      gC.innerHTML = '';
      const t = countyTotals(st);
      const max = Math.max(1, ...Object.values(t));
      for (const c of cs.list) {
        const v = t[c.id] || 0;
        const p = sv('path', { d: c.d, class: 'anCounty' + (v ? ' has' : '') + (level.id === c.id ? ' sel' : ''), tabindex: '0', role: 'button', 'aria-label': c.n + ' ' + countyWord(st) + (v ? ': ' + v : '') });
        if (v) p.style.fillOpacity = String(0.15 + 0.55 * Math.sqrt(v / max));
        p.dataset.id = c.id;
        gC.appendChild(p);
      }
    }
    svg.addEventListener('click', (e) => {
      const bub = e.target.closest('.anBub');
      if (bub) return;
      hideTip();
      const cty = e.target.closest('.anCounty');
      if (cty && level.st) { zoomCounty(level.st, cty.dataset.id); return; }
      const stp = e.target.closest('.anState');
      if (stp && (level.kind === 'us' || stp.dataset.st !== level.st)) zoomState(stp.dataset.st);
    });
    svg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const cty = e.target.closest && e.target.closest('.anCounty');
      if (cty && level.st) { e.preventDefault(); zoomCounty(level.st, cty.dataset.id); }
    });

    const hideTip = () => { tip.hidden = true; };
    function showTip(it) {
      const rows = it.byGame ? GAMES.map((g, i) => (it.byGame[i] ? `<div class="r"><span>${g.e} ${g.n}</span><span class="anNum">${fmtN(it.byGame[i])}</span></div>` : '')).join('') : '';
      tip.innerHTML = `<b>${esc(it.title)}</b>${it.sub ? `<div style="opacity:.8;margin-bottom:4px">${esc(it.sub)}</div>` : ''}${rows}${it.extra ? `<div class="r" style="margin-top:4px;opacity:.8"><span>${esc(it.extra)}</span></div>` : ''}`;
      tip.hidden = false;
      const wr = wrap.getBoundingClientRect(), n = nodes.get(it.key), br = n.getBoundingClientRect();
      let x = br.left - wr.left + br.width / 2 + 12, y = br.top - wr.top - 8;
      if (x + tip.offsetWidth > wr.width - 8) x = br.left - wr.left - tip.offsetWidth - 12 + br.width / 2;
      x = Math.max(8, x); y = Math.max(8, Math.min(y, wr.height - tip.offsetHeight - 8));
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    wrap.addEventListener('pointerleave', hideTip);

    function layout() {
      const w = width(), u0 = vb[2] / w, u = u0 * Math.max(0.5, Math.min(1, w / 760));
      const P = items.map((it) => ({ it, x: it.x, y: it.y, r: it.rpx * u }));
      for (let k = 0; k < 80; k++) {
        let moved = false;
        for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
          const a = P[i], b = P[j];
          let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
          const m = a.r + b.r + 2 * u;
          if (d < m) { if (d < 1e-6) { dx = 1; dy = 0; d = 1; } const push = (m - d) / 2; dx /= d; dy /= d; a.x -= dx * push; a.y -= dy * push; b.x += dx * push; b.y += dy * push; moved = true; }
        }
        for (const p of P) { p.x += (p.it.x - p.x) * 0.04; p.y += (p.it.y - p.y) * 0.04; }
        if (!moved) break;
      }
      gL.innerHTML = '';
      for (const p of P) {
        const n = nodes.get(p.it.key);
        if (!n) continue;
        n.setAttribute('transform', `translate(${p.x.toFixed(2)},${p.y.toFixed(2)}) scale(${u.toFixed(4)})`);
        if (Math.hypot(p.x - p.it.x, p.y - p.it.y) > p.r * 0.6) {
          gL.appendChild(sv('line', { x1: p.it.x, y1: p.it.y, x2: p.x, y2: p.y, class: 'anLead', 'stroke-width': 1.2 * u }));
          gL.appendChild(sv('circle', { cx: p.it.x, cy: p.it.y, r: 2 * u, class: 'anPin' }));
        }
      }
      gR.innerHTML = '';
      for (const r of rolls) {
        const g = sv('g', { class: 'anRoll', transform: `translate(${r.x},${r.y}) scale(${u.toFixed(4)})` });
        const wd = r.text.length * 7 + 12;
        g.appendChild(sv('rect', { x: -wd / 2, y: -10, width: wd, height: 20, rx: 10 }));
        const t = sv('text', { x: 0, y: 1, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        t.textContent = r.text;
        g.appendChild(t);
        gR.appendChild(g);
      }
    }
    function drawBubbles(newItems) {
      const keep = new Set(newItems.map((i) => i.key));
      for (const [k, n] of nodes) if (!keep.has(k)) { n.remove(); nodes.delete(k); }
      let idx = 0;
      for (const it of newItems) {
        let n = nodes.get(it.key);
        const r = it.rpx;
        if (!n) {
          n = sv('g', { class: 'anBub' + (it.county ? ' cty' : ''), tabindex: '0', role: 'button' });
          const inner = sv('g', { class: 'in' }), bob = sv('g', { class: 'bob' });
          bob.append(sv('circle', { class: 'ring' }), sv('circle', { class: 'fillc' }), sv('text', { class: 'em' }));
          const badge = sv('g', { class: 'badge' });
          badge.append(sv('rect'), sv('text'));
          inner.append(bob, badge);
          n.appendChild(inner);
          gB.appendChild(n);
          nodes.set(it.key, n);
          n.addEventListener('pointerenter', () => showTip(n._it));
          n.addEventListener('click', (e) => { e.stopPropagation(); showTip(n._it); });
          n.addEventListener('focus', () => showTip(n._it));
          n.addEventListener('blur', hideTip);
          const st = (idx % 11) * 0.13;
          inner.style.animationDelay = (reduce ? 0 : st) + 's';
          bob.style.animationDelay = st * 1.7 + 's';
        } else if (n._it && n._it.count !== it.count && !reduce) { n.classList.remove('bump'); void n.getBBox(); n.classList.add('bump'); }
        idx++;
        n._it = it;
        n.setAttribute('aria-label', it.title);
        const [ring, fillc, em] = n.querySelector('.bob').childNodes;
        ring.setAttribute('r', r + 3);
        fillc.setAttribute('r', r);
        fillc.setAttribute('fill', it.color);
        em.setAttribute('font-size', Math.max(11, r * 1.05));
        em.textContent = it.emoji || '';
        const badge = n.querySelector('.badge'), bt = badge.querySelector('text'), bb = badge.querySelector('rect');
        const s = it.badge != null ? String(it.badge) : '';
        if (s) {
          const bw = Math.max(18, s.length * 7.5 + 8);
          bb.setAttribute('x', r * 0.55); bb.setAttribute('y', -r - 4); bb.setAttribute('width', bw); bb.setAttribute('height', 17); bb.setAttribute('rx', 8.5);
          bt.setAttribute('x', r * 0.55 + bw / 2); bt.setAttribute('y', -r + 4.5); bt.setAttribute('font-size', 11);
          bt.textContent = s;
          badge.removeAttribute('display');
        } else badge.setAttribute('display', 'none');
      }
      items = newItems;
    }
    // Builds bubbles from the data. County bubbles sit at the county label point.
    async function render(d) {
      data = { cities: d.cities || [], counties: d.counties || [], rolls: d.rolls || {}, states: d.states || [] };
      const needStates = [...new Set(data.counties.map((c) => c.state))];
      const loaded = {};
      await Promise.all(needStates.map(async (st) => { loaded[st] = await loadCounties(st); }));
      const val = opts.value || ((x) => x.total);
      const all = data.cities.map(val).concat(data.counties.map(val));
      const maxV = Math.max(1, ...all);
      const size = (v) => 10 + 14 * Math.sqrt(v / maxV);
      const out = [];
      for (const c of data.cities) {
        const p = pos(c.state, c.city);
        if (!p) continue;
        const v = val(c), t = c.byGame ? top(c.byGame) : -1;
        out.push({ key: 'c|' + c.state + '|' + c.city, x: p[0], y: p[1], rpx: size(v), color: opts.color ? opts.color(c) : GAMES[t].c, emoji: opts.emoji ? opts.emoji(c) : GAMES[t].e, badge: opts.badge ? v : null, count: v, byGame: c.byGame, title: `${c.city}, ${c.state}: ${fmtN(v)}${opts.unit ? ' ' + opts.unit : ''}`, sub: c.countyName ? c.countyName + ' ' + countyWord(c.state) : '', extra: opts.extra ? opts.extra(c) : '' });
      }
      for (const k of data.counties) {
        const cs = loaded[k.state], cc = cs && cs.by[k.id];
        const p = cc ? cc.c : pos(k.state, '');
        if (!p) continue;
        const v = val(k), t = k.byGame ? top(k.byGame) : -1;
        out.push({ key: 'k|' + k.id, county: true, x: p[0], y: p[1], rpx: size(v), color: opts.color ? opts.color(k) : GAMES[t].c, emoji: opts.emoji ? opts.emoji(k) : GAMES[t].e, badge: opts.badge ? v : null, count: v, byGame: k.byGame, title: `${k.name} ${countyWord(k.state)}, ${k.state}: ${fmtN(v)}${opts.unit ? ' ' + opts.unit : ''}`, sub: 'Several small towns together', extra: '' });
      }
      drawBubbles(out);
      rolls = [];
      for (const [ab, p] of Object.entries(stateEls)) p.classList.toggle('hot', !!(data.rolls[ab] > 0));
      for (const [ab, v] of Object.entries(data.rolls)) {
        const st = MAP.stateBy[ab];
        if (st && v > 0) rolls.push({ x: st.c[0], y: st.c[1] + 16, text: '+' + fmtN(v) });
      }
      if (level.st) { const cs = await loadCounties(level.st); drawCounties(level.st, cs); }
      layout();
      drawPanel();
    }
    // The place list under the map for the zoomed state or county.
    function drawPanel() {
      if (!panel) return;
      if (level.kind === 'us') { panel.innerHTML = ''; return; }
      const val = opts.value || ((x) => x.total);
      const st = level.st, stName = MAP.stateBy[st] ? MAP.stateBy[st].n : st;
      const inCounty = (c) => level.kind !== 'county' || c.county === level.id;
      const cities = data.cities.filter((c) => c.state === st && inCounty(c)).sort((a, b) => val(b) - val(a));
      const counties = data.counties.filter((k) => k.state === st && (level.kind !== 'county' || k.id === level.id)).sort((a, b) => val(b) - val(a));
      const stTot = (data.states.find((s) => s.state === st) || {}).total;
      const roll = level.kind === 'state' ? data.rolls[st] || 0 : 0;
      const title = level.kind === 'county' ? `${level.name} ${countyWord(st)}, ${stName}` : stName;
      const rows = [];
      const max = Math.max(1, ...cities.map(val), ...counties.map(val), roll);
      const row = (ic, name, sub, v) => `<div class="anRow"><span class="anDot" style="background:#F3ECFC">${ic}</span><div class="nm"><div>${esc(name)}${sub ? ` <span class="anMuted">${esc(sub)}</span>` : ''}</div><div class="anTrack"><div class="anFill" style="width:${((v / max) * 100).toFixed(0)}%;background:var(--purple)"></div></div></div><span class="v">${fmtN(v)}</span></div>`;
      for (const c of cities) rows.push(row('📍', c.city, level.kind === 'state' && c.countyName ? c.countyName + ' ' + countyWord(st) : '', val(c)));
      for (const k of counties) rows.push(row('🗺️', level.kind === 'county' ? 'Other small towns' : 'Small towns in ' + k.name + ' ' + countyWord(st), '', val(k)));
      if (roll) rows.push(row('➕', 'Smaller places in ' + stName, 'below the rule, not shown by name', roll));
      panel.innerHTML = `<div class="anPlaces"><div class="anHead"><h3 style="margin:0">${esc(title)}</h3>${level.kind === 'state' && stTot ? `<span class="anMuted">${fmtN(stTot)} ${opts.unit || 'in all'} in ${esc(stName)}</span>` : ''}</div>${level.kind === 'state' ? '<p class="anMuted" style="margin:4px 0 8px">Tap a county on the map to zoom in.</p>' : ''}<div class="anBoard">${rows.join('') || '<div class="anEmpty">No place here passes the small-number rule yet.</div>'}</div></div>`;
    }
    drawTools();
    new ResizeObserver(() => layout()).observe(svg);
    return { render, zoomTo: (z) => { if (z === 'lakes' && level.kind === 'us') { tools.querySelector('[data-go="lakes"]').click(); } }, zoomState, zoomCounty, goUS, hideTip, level: () => level };
  }
  const inLakes = (list) => list.length > 0 && list.every((c) => { const p = pos(c.state, c.city || ''); return p && p[0] >= VB_LAKES[0] && p[0] <= VB_LAKES[0] + VB_LAKES[2] && p[1] >= VB_LAKES[1] && p[1] <= VB_LAKES[1] + VB_LAKES[3]; });
  const barRow = (g, label, v, max, sub) => `<div class="anRow"><span class="anDot" style="background:${g.c}">${g.e}</span><div class="nm"><div>${esc(label)}</div><div class="anTrack"><div class="anFill" style="width:${((v / Math.max(1, max)) * 100).toFixed(0)}%;background:${g.c}"></div></div></div><span class="v">${fmtN(v)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></div>`;
  const placesOf = (d) => [...d.cities.map((c) => ({ ...c, name: c.city + ', ' + c.state })), ...d.counties.map((k) => ({ ...k, name: k.name + ' ' + countyWord(k.state) + ', ' + k.state }))].sort((a, b) => b.total - a.total);

  // ---------------- live
  let view = 'live', liveMap = null, liveTimer = null, seenFeed = new Set(), liveZoomed = false;
  async function loadLive() {
    let d;
    try { d = await api('analytics.live'); setErr(''); } catch (e) { setErr(e.message); return; }
    await mapReady;
    if (!liveMap) liveMap = makeMap($('anLiveMap'), { label: 'Map of places with games open right now', panel: $('anLivePlaces'), badge: true, unit: 'open' });
    $('anTotal').textContent = fmtN(d.total);
    $('anAsOf').textContent = 'Counts as of ' + fmtTime(d.asOf) + '. Updates every 30 seconds.';
    $('anChips').innerHTML = GAMES.map((g, i) => `<span class="anChip"><span class="anDot" style="background:${g.c}">${g.e}</span>${g.n} <span class="anNum">${fmtN(d.byGame[i])}</span></span>`).join('');
    await liveMap.render(d);
    if (!liveZoomed && inLakes([...d.cities, ...d.counties])) { liveZoomed = true; liveMap.zoomTo('lakes'); }
    $('anLiveOther').textContent = d.other ? fmtN(d.other) + ' more open outside the US or in a place the network could not name.' : '';
    const busy = placesOf(d).slice(0, 6);
    $('anBusy').innerHTML = busy.length ? busy.map((c) => barRow(GAMES[top(c.byGame)], c.name, c.total, busy[0].total, 'open')).join('') : '<div class="anEmpty">No place has 3 or more games open right now.</div>';
    const gsum = d.byGame.reduce((a, b) => a + b, 0) || 1, gmax = Math.max(1, ...d.byGame);
    $('anGames').innerHTML = GAMES.map((g, i) => ({ g, v: d.byGame[i] })).sort((a, b) => b.v - a.v).map(({ g, v }) => barRow(g, g.n, v, gmax, Math.round((v / gsum) * 100) + '%')).join('');
    $('anFeed').innerHTML = d.feed.length ? d.feed.map((f) => {
      const g = GAMES[GI[f.game]] || GAMES[0], key = f.t + f.city + f.state, fresh = !seenFeed.has(key);
      seenFeed.add(key);
      return `<div class="it${fresh && seenFeed.size > d.feed.length ? ' new' : ''}"><span class="t">${fmtTime(f.t)}</span><span class="anDot" style="background:${g.c}">${g.e}</span><span class="c">${esc(f.city)}, ${esc(f.state)}</span><span class="anNum" style="font-weight:900;color:var(--deep)">${fmtN(f.n)}</span></div>`;
    }).join('') : '<div class="anEmpty">No city passed 3 open games in the last 30 minutes.</div>';
  }
  function startLive() { stopLive(); loadLive(); liveTimer = setInterval(() => { if (!document.hidden && view === 'live' && !root.closest('[hidden]')) loadLive(); }, 30000); }
  function stopLive() { if (liveTimer) clearInterval(liveTimer); liveTimer = null; }

  // ---------------- history
  let range = 7, H = null, histMap = null, hourCap = 24, playing = null, histZoomed = false;
  function capData(cap) {
    if (cap >= 24) return H;
    const sum = (arr) => (arr ? arr.slice(0, cap).reduce((a, b) => a + b, 0) : 0);
    const cities = H.cities.map((c) => ({ ...c, total: sum(H.cityHours[c.state + '|' + c.city]) })).filter((c) => c.total > 0);
    const counties = H.counties.map((k) => ({ ...k, total: sum(H.countyHours[k.id]) })).filter((k) => k.total > 0);
    const rolls = {};
    for (const [st, hrs] of Object.entries(H.stateHours)) { const v = sum(hrs); if (v) rolls[st] = v; }
    return { cities, counties, rolls, states: H.states };
  }
  function drawHistMap() { return histMap.render(capData(hourCap)); }
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  const change = (a, b) => { const p = pct(a, b); if (p == null) return ''; const up = p >= 0; return `<span class="anChange ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(p)}%</span> vs the ${range === 365 ? '12 months' : range + ' days'} before`; };
  async function loadHistory() {
    stopReplay();
    try { H = await api('analytics.history', { range }); setErr(''); } catch (e) { setErr(e.message); return; }
    await mapReady;
    if (!histMap) histMap = makeMap($('anHistMap'), { label: 'Map of plays by place', panel: $('anHistPlaces'), unit: 'plays', extra: (c) => (c.minutes != null && hourCap >= 24 ? fmtN(c.minutes) + ' minutes played' : '') });
    hourCap = 24; $('anHour').value = 23; $('anHourLbl').textContent = 'All day';
    $('anReplayRow').hidden = range > 30;
    await drawHistMap();
    if (!histZoomed && inLakes([...H.cities, ...H.counties])) { histZoomed = true; histMap.zoomTo('lakes'); }
    const lbl = RANGE_LABEL[range];
    const places = H.cityCount + H.counties.length;
    $('anKpis').innerHTML = [
      ['Plays', fmtN(H.plays), H.prev ? change(H.plays, H.prev.plays) : lbl],
      ['Minutes played', fmtN(H.minutes), H.prev ? change(H.minutes, H.prev.minutes) : 'about ' + fmtN(H.minutes / 60) + ' hours'],
      ['Minutes per play', H.minutesPerPlay.toFixed(1), 'from play-length ranges'],
      ['Places', places + (places === 1 ? ' place' : ' places'), H.stateCount + (H.stateCount === 1 ? ' state' : ' states')],
      ['Home Screen app', H.appShare + '%', 'of plays'],
    ].map(([l, n, s]) => `<div class="anKpi"><div class="l">${l}</div><div class="n">${n}</div><div class="s">${s}</div></div>`).join('');
    drawTrend();
    if (range === 1) {
      $('anOtTitle').textContent = 'Plays by hour today';
      $('anOverTime').innerHTML = stackCols(H.hoursGame.map((r, h) => (h <= H.todayHour ? r : null)), H.hoursGame.map((_, h) => (h % 3 === 0 ? fmtHour(h) : '')), 'Plays by hour today');
    } else {
      const wk = range >= 60;
      $('anOtTitle').textContent = wk ? 'Plays per week by game' : 'Plays per day by game';
      const rows = wk ? weekly(H.perDay, (a, b) => a.map((v, i) => v + b[i]), () => [0, 0, 0, 0, 0]) : { vals: H.perDay, labels: H.days };
      const labs = wk ? rows.labels.map((d, i) => (i % (range === 365 ? 8 : 2) === 0 ? fmtDay(d) : '')) : H.days.map((d, i) => (i % (range === 7 ? 1 : 5) === 0 || i === H.days.length - 1 ? (range === 7 ? wkDay(d) : fmtDay(d)) : ''));
      $('anOverTime').innerHTML = stackCols(rows.vals, labs, wk ? 'Plays per week by game' : 'Plays per day by game');
    }
    $('anOtLegend').innerHTML = GAMES.map((g) => `<span><i style="background:${g.c}"></i>${g.n}</span>`).join('');
    $('anHours').innerHTML = hourCols(H.hours.map((v) => v / range));
    const gmax = Math.max(1, ...H.byGame);
    $('anHGames').innerHTML = GAMES.map((g, i) => ({ g, v: H.byGame[i], m: H.avgMinutes[i] })).sort((a, b) => b.v - a.v).map(({ g, v, m }) => barRow(g, g.n, v, gmax, m ? m.toFixed(1) + ' min each' : '')).join('');
    const bl = ['Under 2 min', '2 to 5', '5 to 15', '15 plus'], bc = ['#C9B8EA', '#A98BE0', '#8C61D8', '#7138D1'], bm = Math.max(1, ...H.buckets);
    $('anLen').innerHTML = '<div class="anBoard">' + H.buckets.map((v, i) => `<div class="anRow" style="grid-template-columns:96px minmax(0,1fr) auto"><span style="font-size:13px">${bl[i]}</span><div class="anTrack" style="margin:0;height:14px"><div class="anFill" style="width:${((v / bm) * 100).toFixed(0)}%;background:${bc[i]}"></div></div><span class="v">${fmtN(v)}</span></div>`).join('') + '</div>';
    const hp = H.appShare;
    $('anSplit').innerHTML = H.plays ? `<div class="anSplit" role="img" aria-label="${hp} percent Home Screen app, ${100 - hp} percent browser"><div style="width:${hp}%;background:var(--purple)">${hp >= 12 ? '📲 App ' + hp + '%' : ''}</div><div style="width:${100 - hp}%;background:var(--blue)">${100 - hp >= 12 ? '🌐 Browser ' + (100 - hp) + '%' : ''}</div></div><p>Home Screen app means the parent saved Mojialand to the Home Screen.</p>` : '<div class="anEmpty">No plays yet.</div>';
    const all = placesOf(H);
    const tp = all.slice(0, 8);
    $('anTPlays').innerHTML = tp.length ? `<table><thead><tr><th>Place</th><th>Top game</th><th class="r">Plays</th></tr></thead><tbody>${tp.map((c) => { const g = GAMES[top(c.byGame)]; return `<tr><td>${esc(c.name)}</td><td>${g.e} ${g.n}</td><td class="r">${fmtN(c.total)}</td></tr>`; }).join('')}</tbody></table>` : '<div class="anEmpty">No place passed 5 plays in a day yet.</div>';
    const tm = all.slice().sort((a, b) => b.minutes - a.minutes).slice(0, 8);
    $('anTMins').innerHTML = tm.length ? `<table><thead><tr><th>Place</th><th class="r">Minutes</th><th class="r">Per play</th></tr></thead><tbody>${tm.map((c) => `<tr><td>${esc(c.name)}</td><td class="r">${fmtN(c.minutes)}</td><td class="r">${(c.minutes / Math.max(1, c.total)).toFixed(1)}</td></tr>`).join('')}</tbody></table>` : '<div class="anEmpty">No place passed 5 plays in a day yet.</div>';
    $('anHistSub').textContent = (range === 1 ? 'Today so far.' : 'The ' + RANGE_LABEL[range] + '.') + ' Bubble size shows plays. Color shows the favorite game in that place.' + (H.other ? ' ' + fmtN(H.other) + ' plays came from outside the US or an unnamed place.' : '');
  }
  // groups daily values into 7-day weeks, ending with the latest day
  function weekly(vals, add, zero) {
    const out = [], labels = [];
    for (let end = vals.length; end > 0; end -= 7) {
      const start = Math.max(0, end - 7);
      let acc = zero();
      for (let i = start; i < end; i++) acc = add(acc, vals[i]);
      out.unshift(acc);
      labels.unshift(H.days[start]);
    }
    return { vals: out, labels };
  }
  function drawTrend() {
    $('anTrendCard').hidden = range === 1;
    if (range === 1) return;
    const wk = range >= 60;
    const num = (a, b) => a + b;
    const cur = wk ? weekly(H.perDay.map((r) => r.reduce(num, 0)), num, () => 0) : { vals: H.perDay.map((r) => r.reduce(num, 0)), labels: H.days };
    const curM = wk ? weekly(H.perDayMinutes, num, () => 0) : { vals: H.perDayMinutes, labels: H.days };
    let prevP = null, prevM = null;
    if (H.prev) {
      const grp = (arr) => { if (!wk) return arr; const out = []; for (let end = arr.length; end > 0; end -= 7) { let s = 0; for (let i = Math.max(0, end - 7); i < end; i++) s += arr[i]; out.unshift(s); } return out; };
      prevP = grp(H.prev.perDay); prevM = grp(H.prev.perDayMinutes);
    }
    $('anTrendPlaysT').textContent = wk ? 'Plays per week' : 'Plays per day';
    $('anTrendMinsT').textContent = wk ? 'Minutes played per week' : 'Minutes played per day';
    const step = range === 7 ? 1 : range === 30 ? 5 : range === 60 ? 2 : range === 90 ? 3 : 8;
    const labs = cur.labels.map((d, i) => (i % step === 0 || i === cur.labels.length - 1 ? (range === 7 ? wkDay(d) : range === 365 ? fmtMonth(d) : fmtDay(d)) : ''));
    $('anTrendPlays').innerHTML = lineChart(cur.vals, prevP, labs, cur.labels, 'Plays over time', '#7138D1');
    $('anTrendMins').innerHTML = lineChart(curM.vals, prevM, labs, curM.labels, 'Minutes played over time', '#FF5FA2');
    $('anTrendLegend').innerHTML = '<span><i style="background:#7138D1"></i>' + RANGE_LABEL[range] + '</span>' + (H.prev ? '<span><i style="background:#fff;border:2px dashed #6B6180"></i>the period before</span>' : '<span>No earlier period to compare yet</span>');
  }
  function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function ticks(m) { if (m <= 5) return m; const p = Math.pow(10, Math.floor(Math.log10(m))); return Math.round(m / p) === 2 ? 4 : 5; }
  function axis(m, y, L, W, R) { const tk = ticks(m); let s = ''; for (let k = 0; k <= tk; k++) { const v = (m * k) / tk, yy = y(v); s += `<line class="anGridL" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="anAxis" x="${L - 6}" y="${yy + 3}" text-anchor="end">${fmtN(v)}</text>`; } return s; }
  function lineChart(vals, prev, labels, days, aria, color) {
    const W = 560, Hh = 210, L = 44, R = 12, T = 14, B = 28, n = vals.length;
    const m = niceMax(Math.max(1, ...vals, ...(prev || [])));
    const x = (i) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1)), y = (v) => T + (Hh - T - B) * (1 - v / m);
    const pts = (arr) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    let s = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${aria}">` + axis(m, y, L, W, R);
    s += `<polygon points="${x(0)},${y(0)} ${pts(vals)} ${x(n - 1)},${y(0)}" fill="${color}" fill-opacity=".12"/>`;
    if (prev && prev.length === n) s += `<polyline class="anPrev" points="${pts(prev)}" fill="none" stroke="#6B6180" stroke-width="2" stroke-dasharray="5 4" stroke-opacity=".7"/>`;
    s += `<polyline class="anCur" points="${pts(vals)}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    s += `<circle cx="${x(n - 1)}" cy="${y(vals[n - 1] || 0)}" r="5" fill="${color}" stroke="#fff" stroke-width="2"/>`;
    vals.forEach((v, i) => { s += `<rect x="${x(i) - (W - L - R) / Math.max(1, n) / 2}" y="${T}" width="${(W - L - R) / Math.max(1, n)}" height="${Hh - T - B}" fill="transparent"><title>${days[i] ? fmtDay(days[i]) : ''}: ${fmtN(v)}${prev && prev[i] != null ? ' (before: ' + fmtN(prev[i]) + ')' : ''}</title></rect>`; });
    labels.forEach((lb, i) => { if (lb) s += `<text class="anAxis" x="${x(i)}" y="${Hh - 10}" text-anchor="middle">${lb}</text>`; });
    return s + '</svg>';
  }
  function stackCols(rows, labels, aria) {
    const W = 560, Hh = 220, L = 40, R = 10, T = 10, B = 28, n = rows.length;
    const m = niceMax(Math.max(1, ...rows.map((r) => (r ? r.reduce((a, b) => a + b, 0) : 0))));
    const bw = (W - L - R) / n, y = (v) => T + (Hh - T - B) * (1 - v / m);
    let s = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${aria}">` + axis(m, y, L, W, R);
    rows.forEach((r, i) => {
      const x = L + i * bw + bw * 0.15, w = bw * 0.7;
      if (r) { let acc = 0; r.forEach((v, j) => { if (v <= 0) return; const y0 = y(acc), y1 = y(acc + v); s += `<rect x="${x}" y="${y1}" width="${w}" height="${Math.max(0, y0 - y1)}" fill="${GAMES[j].c}"><title>${GAMES[j].n}: ${fmtN(v)}</title></rect>`; acc += v; }); }
      if (labels[i]) s += `<text class="anAxis" x="${L + i * bw + bw / 2}" y="${Hh - 10}" text-anchor="middle">${labels[i]}</text>`;
    });
    return s + '</svg>';
  }
  function hourCols(vals) {
    const W = 560, Hh = 200, L = 40, R = 10, T = 14, B = 28, m = niceMax(Math.max(1, ...vals)), bw = (W - L - R) / 24, y = (v) => T + (Hh - T - B) * (1 - v / m);
    const peak = vals.indexOf(Math.max(...vals));
    let s = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Average plays by hour of the day">` + axis(m, y, L, W, R);
    vals.forEach((v, h) => { s += `<rect x="${L + h * bw + bw * 0.15}" y="${y(v)}" width="${bw * 0.7}" height="${y(0) - y(v)}" rx="3" fill="${h === peak && v > 0 ? '#7138D1' : '#C9B8EA'}"><title>${fmtHour(h)}: ${v.toFixed(1)} plays a day</title></rect>`; if (h % 3 === 0) s += `<text class="anAxis" x="${L + h * bw + bw / 2}" y="${Hh - 10}" text-anchor="middle">${fmtHour(h)}</text>`; });
    if (vals[peak] > 0) s += `<text class="anAxis" x="${L + peak * bw + bw / 2}" y="${y(vals[peak]) - 4}" text-anchor="middle" style="fill:#5122A5;font-weight:900">Peak</text>`;
    return s + '</svg>';
  }
  function stopReplay() { if (playing) { clearInterval(playing); playing = null; $('anPlay').textContent = '▶ Replay the day'; } }
  $('anPlay').addEventListener('click', () => {
    if (!H) return;
    if (playing) { stopReplay(); return; }
    let h = 5;
    $('anPlay').textContent = '❚❚ Pause';
    const tick = () => {
      hourCap = h + 1; $('anHour').value = h; $('anHourLbl').textContent = 'By ' + fmtHour((h + 1) % 24);
      drawHistMap(); h++;
      if (h > 23) { stopReplay(); hourCap = 24; $('anHourLbl').textContent = 'All day'; $('anHour').value = 23; drawHistMap(); }
    };
    tick();
    playing = setInterval(tick, reduce ? 900 : 650);
  });
  $('anHour').addEventListener('input', (e) => { if (!H) return; stopReplay(); const h = +e.target.value; hourCap = h >= 23 ? 24 : h + 1; $('anHourLbl').textContent = hourCap >= 24 ? 'All day' : 'By ' + fmtHour(hourCap); drawHistMap(); });
  $('anRanges').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $('anRanges').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); range = +b.dataset.r; loadHistory(); });

  // ---------------- campaigns
  let C = [], sel = 0;
  const linkBase = () => (location.hostname === 'mojialand.com' || location.hostname === 'www.mojialand.com' ? 'https://mojialand.com' : location.origin) + '/?c=';
  const qr = (url, cell) => { try { const q = window.qrcode(0, 'M'); q.addData(url); q.make(); return q.createDataURL(cell || 3, 2); } catch (e) { return ''; } };
  async function loadCampaigns(data) {
    let d = data;
    if (!d) { try { d = await api('campaigns.list'); setErr(''); } catch (e) { setErr(e.message); return; } }
    await mapReady;
    C = d.campaigns.map((c, i) => ({ ...c, color: CC[(d.campaigns.length - 1 - i) % CC.length] }));
    if (sel >= C.length) sel = 0;
    $('anCamps').innerHTML = C.length ? C.map((c, i) => `<button type="button" class="anCamp${c.active ? '' : ' off'}" data-i="${i}" aria-pressed="${i === sel}"><img alt="QR code for ${esc(c.label)}" src="${qr(linkBase() + c.label, 3)}"><span style="display:grid;gap:3px;min-width:0"><span class="nm"><span class="anTag" style="background:${c.color}"></span>${esc(c.name)}</span><code>?c=${esc(c.label)}</code><span class="anMuted">${fmtN(c.open)} opens · ${fmtN(c.pass48 + c.forever)} passes · since ${fmtDay(c.start)}${c.active ? '' : ' · paused'}</span></span></button>`).join('') : '<div class="anEmpty">No campaigns yet. Make one below, then print its QR cards.</div>';
    $('anBoardC').hidden = !C.length;
    $('anCompareCard').hidden = !C.length;
    if (C.length) { renderBoard(); renderCompare(); }
  }
  function renderBoard() {
    const c = C[sel], b = $('anBoardC'), bought = c.pass48 + c.forever;
    const pctO = (v) => (c.open ? Math.round((v / c.open) * 100) + '%' : '0%');
    const link = linkBase() + c.label;
    const placeRows = [...c.cities.map((x) => ({ name: x.city + ', ' + x.state, sub: x.countyName ? x.countyName + ' ' + countyWord(x.state) : '', n: x.n, ic: '📍' })), ...c.counties.map((x) => ({ name: 'Small towns in ' + x.name + ' ' + countyWord(x.state) + ', ' + x.state, sub: '', n: x.n, ic: '🗺️' })), ...Object.entries(c.rolls).map(([st, v]) => ({ name: 'Smaller places, ' + st, sub: '', n: v, ic: '➕' }))].sort((a, b) => b.n - a.n);
    const pmax = Math.max(1, ...placeRows.map((r) => r.n));
    b.innerHTML = `<div class="anHead"><div style="min-width:0"><h2><span class="anTag" style="background:${c.color}"></span>${esc(c.name)}</h2><p>${c.note ? esc(c.note) + ' · ' : ''}Started ${fmtDay(c.start)}${c.active ? '' : ' · paused, new scans count nothing'}</p></div>
      <div class="row"><button type="button" class="secondary" id="anPrintC">Print QR cards</button><button type="button" class="secondary" id="anCopyC">Copy link</button><button type="button" class="${c.active ? 'danger' : 'secondary'}" id="anPause">${c.active ? 'Pause' : 'Resume'}</button></div></div>
      <div class="anLinkbox"><img alt="QR code" src="${qr(link, 4)}"><div style="display:grid;gap:4px;min-width:0"><span class="anMuted">QR code opens</span><code>${esc(link)}</code><span class="anMuted" id="anCopyOk"></span></div></div>
      <div class="anFunnel">
        <div class="anStep"><div class="l">QR opens</div><div class="n">${fmtN(c.open)}</div><div class="s">first open per device</div></div>
        <div class="anStep"><div class="l">Played a game</div><div class="n">${fmtN(c.play)}</div><div class="s">${pctO(c.play)} of opens</div></div>
        <div class="anStep"><div class="l">Gift codes used</div><div class="n">${fmtN(c.gift)}</div><div class="s">${pctO(c.gift)} of opens</div></div>
        <div class="anStep"><div class="l">Passes bought</div><div class="n">${fmtN(bought)}</div><div class="s">${c.pass48} 48-hour, ${c.forever} Forever · ${pctO(bought)}</div></div>
        <div class="anStep"><div class="l">Open to purchase</div><div class="n">${c.avgDays == null ? '-' : c.avgDays.toFixed(1)}</div><div class="s">days, average</div></div>
      </div>
      <div class="anGrid2" style="align-items:start">
        <div style="display:grid;gap:8px;min-width:0"><h3>Where the cards traveled</h3><div class="anMap" id="anCampMap"></div><div id="anCampPlaces"></div></div>
        <div style="display:grid;gap:8px;min-width:0"><h3>Opens per day</h3><div class="anChart">${campCols(c)}</div>
          <h3 style="margin-top:6px">Places reached</h3><div class="anBoard">${placeRows.length ? placeRows.map((r) => `<div class="anRow"><span class="anDot" style="background:${r.ic === '➕' ? '#F3ECFC' : c.color}">${r.ic}</span><div class="nm"><div>${esc(r.name)}${r.sub ? ` <span class="anMuted">${esc(r.sub)}</span>` : ''}</div><div class="anTrack"><div class="anFill" style="width:${((r.n / pmax) * 100).toFixed(0)}%;background:${c.color}"></div></div></div><span class="v">${fmtN(r.n)}</span></div>`).join('') : '<div class="anEmpty">No opens yet. Print the QR cards and hand them out.</div>'}</div></div>
      </div>`;
    const m = makeMap($('anCampMap'), { label: 'Map of places reached by this campaign', panel: $('anCampPlaces'), badge: true, unit: 'opens', value: (x) => x.n, color: () => c.color, emoji: () => '📍' });
    m.render({ cities: c.cities, counties: c.counties, rolls: c.rolls, states: [] }).then(() => { if (inLakes([...c.cities, ...c.counties])) m.zoomTo('lakes'); });
    $('anCopyC').addEventListener('click', async () => { let ok = false; try { await navigator.clipboard.writeText(link); ok = true; } catch (e) {} $('anCopyOk').textContent = ok ? 'Link copied.' : 'Copy failed. Select the link above.'; });
    $('anPause').addEventListener('click', async (e) => { e.target.disabled = true; try { loadCampaigns(await api('campaigns.active', { label: c.label, active: !c.active })); } catch (err) { setErr(err.message); e.target.disabled = false; } });
    $('anPrintC').addEventListener('click', () => printCards(c, link));
  }
  function printCards(c, link) {
    const host = link.replace(/^https?:\/\//, '');
    const img = qr(link, 6);
    const card = `<div class="bc camp"><div class="l"><img src="/logo/logo-3d-1000.webp" alt="Mojialand"><b>Emoji games for kids 3 and up</b><small>No ads. No accounts. Nothing collected from your child. Scan to play free.</small></div><div class="r"><img src="${img}" alt=""><code>${esc(host)}</code></div></div>`;
    document.getElementById('sheet').innerHTML = new Array(10).fill(card).join('');
    window.print();
  }
  function campCols(c) {
    const W = 420, Hh = 170, L = 34, R = 8, T = 10, B = 26, v = c.daily.map((x) => x.n), n = Math.max(1, v.length);
    const m = niceMax(Math.max(1, ...v)), bw = (W - L - R) / n, y = (x) => T + (Hh - T - B) * (1 - x / m);
    let s = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Opens per day">` + axis(m, y, L, W, R);
    c.daily.forEach((x, i) => { s += `<rect x="${L + i * bw + bw * 0.15}" y="${y(x.n)}" width="${bw * 0.7}" height="${y(0) - y(x.n)}" rx="3" fill="${c.color}"><title>${fmtDay(x.d)}: ${x.n} opens</title></rect>`; if (i === 0 || i === n - 1 || n <= 7) s += `<text class="anAxis" x="${L + i * bw + bw / 2}" y="${Hh - 8}" text-anchor="middle">${fmtDay(x.d)}</text>`; });
    return s + '</svg>';
  }
  function renderCompare() {
    $('anCompare').innerHTML = `<table><thead><tr><th>Campaign</th><th class="r">Opens</th><th class="r">Played</th><th class="r">Gift codes</th><th class="r">Passes</th><th class="r">Open to pass</th></tr></thead><tbody>${C.map((c) => { const b = c.pass48 + c.forever; return `<tr><td><span class="anTag" style="background:${c.color}"></span>${esc(c.name)}</td><td class="r">${fmtN(c.open)}</td><td class="r">${fmtN(c.play)}</td><td class="r">${fmtN(c.gift)}</td><td class="r">${fmtN(b)}</td><td class="r">${c.open ? ((b / c.open) * 100).toFixed(1) + '%' : '-'}</td></tr>`; }).join('')}</tbody></table>`;
  }
  $('anCamps').addEventListener('click', (e) => { const b = e.target.closest('.anCamp'); if (!b) return; sel = +b.dataset.i; $('anCamps').querySelectorAll('.anCamp').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderBoard(); });
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  let labelTouched = false;
  function updPrev() { const l = $('anLabel').value.trim() || 'your-label'; $('anLinkPrev').textContent = linkBase() + l; $('anQrPrev').src = qr(linkBase() + l, 3); }
  $('anName').addEventListener('input', () => { if (!labelTouched) $('anLabel').value = slug($('anName').value); updPrev(); });
  $('anLabel').addEventListener('input', () => { labelTouched = true; const v = $('anLabel').value.toLowerCase().replace(/[^a-z0-9-]/g, ''); if (v !== $('anLabel').value) $('anLabel').value = v; updPrev(); });
  $('anMake').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('anMakeErr'), btn = $('anMakeBtn');
    err.textContent = '';
    btn.disabled = true;
    try {
      const d = await api('campaigns.create', { name: $('anName').value, label: $('anLabel').value, note: $('anNote').value });
      const made = $('anLabel').value.trim();
      $('anMake').reset(); labelTouched = false; updPrev();
      sel = Math.max(0, d.campaigns.findIndex((c) => c.label === made));
      await loadCampaigns(d);
      $('anBoardC').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false;
  });
  updPrev();

  // ---------------- views
  function showView(v) {
    view = v;
    $('anViews').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v)));
    $('anLive').hidden = v !== 'live'; $('anHistory').hidden = v !== 'history'; $('anCampaigns').hidden = v !== 'campaigns';
    stopReplay();
    if (v === 'live') startLive(); else stopLive();
    if (v === 'history') loadHistory();
    if (v === 'campaigns') loadCampaigns();
  }
  $('anViews').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.v); });
  window.MojiAnalytics = { show: () => showView(view), hide: () => { stopLive(); stopReplay(); } };
})();
