// Mojialand admin: Analytics tab (Live, History, Campaigns).
// Reads counts from admin-api. The server already folds small places into
// their state, so this page never sees a city below the small-number rule.
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
  const wkDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
  const top = (by) => by.indexOf(Math.max(...by));
  const sv = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); return e; };
  const shield = '<span aria-hidden="true">🛡️</span>';

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
      <h2>Where kids play right now</h2>
      <div class="anMap" id="anLiveMap"></div>
      <div class="anLegend" data-legend></div>
      <p class="anMuted" id="anLiveOther"></p>
    </div>
    <div class="anGrid3">
      <div class="anCard anBoard"><h3>Busiest cities right now</h3><div class="anBoard" id="anBusy"></div></div>
      <div class="anCard anBoard"><h3>Latest active cities</h3><div class="anFeed" id="anFeed"></div></div>
      <div class="anCard anBoard"><h3>Games right now</h3><div class="anBoard" id="anGames"></div></div>
    </div>
    <div class="anPrivacy">${shield}<span><b>Counts only.</b> No names, devices, IP addresses or play sessions. The live view runs 5 minutes behind. A city shows once 3 or more games are open there; smaller counts show as a number on the state.</span></div>
  </section>

  <section id="anHistory" hidden style="display:grid;gap:16px">
    <div class="anSeg" role="group" aria-label="Time range" id="anRanges">
      <button type="button" data-r="1" aria-pressed="false">Today</button>
      <button type="button" data-r="7" aria-pressed="true">7 days</button>
      <button type="button" data-r="30" aria-pressed="false">30 days</button>
    </div>
    <div class="anKpis" id="anKpis"></div>
    <div class="anCard" style="display:grid;gap:10px">
      <h2>Plays by city</h2>
      <p id="anHistSub">Bubble size shows plays. Color shows the favorite game in that city.</p>
      <div class="anMap" id="anHistMap"></div>
      <div class="anLegend" data-legend></div>
      <div class="anReplay">
        <button type="button" class="secondary" id="anPlay">▶ Replay the day</button>
        <input type="range" id="anHour" min="0" max="23" value="23" aria-label="Hour of the day">
        <span class="hr" id="anHourLbl">All day</span>
      </div>
    </div>
    <div class="anGrid2">
      <div class="anCard"><h3 id="anOtTitle">Plays per day</h3><div class="anChart" id="anOverTime"></div><div class="anLegend" id="anOtLegend"></div></div>
      <div class="anCard"><h3>Busiest hours (Michigan time)</h3><div class="anChart" id="anHours"></div></div>
    </div>
    <div class="anGrid2">
      <div class="anCard anBoard"><h3>Games by plays</h3><div class="anBoard" id="anHGames"></div></div>
      <div class="anCard"><h3>How long each play lasts</h3><div id="anLen"></div><h3 style="margin-top:14px">Home Screen app or browser</h3><div id="anSplit"></div></div>
    </div>
    <div class="anGrid2">
      <div class="anCard"><h3>Top cities by plays</h3><div class="anTable" id="anTPlays"></div></div>
      <div class="anCard"><h3>Top cities by minutes played</h3><div class="anTable" id="anTMins"></div></div>
    </div>
    <div class="anPrivacy">${shield}<span><b>Totals by the hour, never by the person.</b> A city shows on days with 5 or more plays. Smaller counts roll into the state. Minutes come from ranges (under 2, 2 to 5, 5 to 15, 15 plus), so no single play is timed.</span></div>
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
    <div class="anPrivacy">${shield}<span><b>Campaigns count events, never people.</b> The first open from a QR code counts once, then the label leaves the address bar. The device keeps only the event label for 7 days to credit a later play, gift code or pass. Cities under 5 opens show as their state.</span></div>
  </section>
  <p class="anMuted" id="anCredit"></p>`;

  const legend = GAMES.map((g) => `<span><i style="background:${g.c}"></i>${g.e} ${g.n}</span>`).join('') + '<span><i style="background:#fff;border:2px solid #D9CCEE"></i>+N = smaller places, shown by state</span>';
  root.querySelectorAll('[data-legend]').forEach((el) => { el.innerHTML = legend; });
  const setErr = (m) => { $('anErr').textContent = m || ''; };

  // ---------------- map
  let MAP = null;
  const mapReady = fetch('/admin/usmap.json', { credentials: 'same-origin' }).then((r) => r.json()).then((m) => {
    MAP = m;
    MAP.stateBy = Object.fromEntries(m.states.map((s) => [s.ab, s]));
    $('anCredit').textContent = m.attribution || '';
  });
  const VB_US = [0, 0, 975, 610];
  const VB_LAKES = [560, 110, 250, 156];
  function pos(state, city) {
    const p = city && MAP.cities[state + '|' + city];
    if (p) return p;
    const s = MAP.stateBy[state];
    return s ? s.c : null;
  }

  function makeMap(wrap, label) {
    wrap.innerHTML = '';
    const svg = sv('svg', { viewBox: VB_US.join(' '), role: 'img', 'aria-label': label });
    const gS = sv('g'), gR = sv('g'), gL = sv('g'), gB = sv('g');
    const stateEls = {};
    for (const s of MAP.states) { const p = sv('path', { d: s.d, class: 'anState' }); gS.appendChild(p); stateEls[s.ab] = p; }
    svg.append(gS, gR, gL, gB);
    wrap.appendChild(svg);
    const tools = document.createElement('div');
    tools.className = 'anTools';
    tools.innerHTML = '<div class="anSeg" role="group" aria-label="Map area"><button type="button" data-z="us" aria-pressed="true">Whole US</button><button type="button" data-z="lakes" aria-pressed="false">Great Lakes</button></div>';
    wrap.appendChild(tools);
    const tip = document.createElement('div');
    tip.className = 'anTip';
    tip.hidden = true;
    wrap.appendChild(tip);
    let vb = VB_US.slice(), items = [], rolls = [];
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
    function zoomTo(z) {
      tools.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === z)));
      setVB(z === 'lakes' ? VB_LAKES : VB_US);
    }
    tools.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) zoomTo(b.dataset.z); });
    const hideTip = () => { tip.hidden = true; };
    function showTip(it) {
      const rows = it.byGame ? GAMES.map((g, i) => (it.byGame[i] ? `<div class="r"><span>${g.e} ${g.n}</span><span class="anNum">${fmtN(it.byGame[i])}</span></div>` : '')).join('') : '';
      tip.innerHTML = `<b>${esc(it.title)}</b>${rows}${it.extra ? `<div class="r" style="margin-top:4px;opacity:.8"><span>${esc(it.extra)}</span></div>` : ''}`;
      tip.hidden = false;
      const wr = wrap.getBoundingClientRect(), n = nodes.get(it.key), br = n.getBoundingClientRect();
      let x = br.left - wr.left + br.width / 2 + 12, y = br.top - wr.top - 8;
      if (x + tip.offsetWidth > wr.width - 8) x = br.left - wr.left - tip.offsetWidth - 12 + br.width / 2;
      x = Math.max(8, x); y = Math.max(8, Math.min(y, wr.height - tip.offsetHeight - 8));
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    wrap.addEventListener('pointerleave', hideTip);
    svg.addEventListener('click', (e) => { if (!e.target.closest('.anBub')) hideTip(); });
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
    function render(newItems, rollMap) {
      const keep = new Set(newItems.map((i) => i.key));
      for (const [k, n] of nodes) if (!keep.has(k)) { n.remove(); nodes.delete(k); }
      let idx = 0;
      for (const it of newItems) {
        let n = nodes.get(it.key);
        const r = it.rpx;
        if (!n) {
          n = sv('g', { class: 'anBub', tabindex: '0', role: 'button' });
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
      rolls = [];
      for (const [ab, p] of Object.entries(stateEls)) p.classList.toggle('hot', !!(rollMap && rollMap[ab] > 0));
      for (const [ab, v] of Object.entries(rollMap || {})) {
        const st = MAP.stateBy[ab];
        if (st && v > 0) rolls.push({ x: st.c[0], y: st.c[1] + 16, text: '+' + fmtN(v) });
      }
      layout();
    }
    new ResizeObserver(() => layout()).observe(svg);
    return { render, zoomTo, hideTip };
  }
  function cityItems(list, sizeOf, maxV, extra) {
    const out = [];
    for (const c of list) {
      const p = pos(c.state, c.city);
      if (!p) continue;
      const v = sizeOf(c);
      const t = top(c.byGame);
      out.push({ key: c.state + '|' + c.city, x: p[0], y: p[1], rpx: 10 + 14 * Math.sqrt(v / Math.max(1, maxV)), color: GAMES[t].c, emoji: GAMES[t].e, count: v, byGame: c.byGame, title: `${c.city}, ${c.state}: ${fmtN(v)}`, ...(extra ? extra(c) : {}) });
    }
    return out;
  }
  const inLakes = (items) => items.length > 0 && items.every((it) => it.x >= VB_LAKES[0] && it.x <= VB_LAKES[0] + VB_LAKES[2] && it.y >= VB_LAKES[1] && it.y <= VB_LAKES[1] + VB_LAKES[3]);
  const barRow = (g, label, v, max, sub) => `<div class="anRow"><span class="anDot" style="background:${g.c}">${g.e}</span><div class="nm"><div>${esc(label)}</div><div class="anTrack"><div class="anFill" style="width:${((v / Math.max(1, max)) * 100).toFixed(0)}%;background:${g.c}"></div></div></div><span class="v">${fmtN(v)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></div>`;

  // ---------------- live
  let view = 'live', liveMap = null, liveTimer = null, seenFeed = new Set(), liveZoomed = false;
  async function loadLive() {
    let d;
    try { d = await api('analytics.live'); setErr(''); } catch (e) { setErr(e.message); return; }
    await mapReady;
    if (!liveMap) liveMap = makeMap($('anLiveMap'), 'Map of cities with games open right now');
    $('anTotal').textContent = fmtN(d.total);
    $('anAsOf').textContent = 'Counts as of ' + fmtTime(d.asOf) + '. Updates every 30 seconds.';
    $('anChips').innerHTML = GAMES.map((g, i) => `<span class="anChip"><span class="anDot" style="background:${g.c}">${g.e}</span>${g.n} <span class="anNum">${fmtN(d.byGame[i])}</span></span>`).join('');
    const maxT = Math.max(1, ...d.cities.map((c) => c.total));
    const items = cityItems(d.cities, (c) => c.total, maxT).map((it) => ({ ...it, badge: it.count, title: it.title + ' open' }));
    liveMap.render(items, d.rolls);
    if (!liveZoomed && inLakes(items)) { liveZoomed = true; liveMap.zoomTo('lakes'); }
    $('anLiveOther').textContent = d.other ? fmtN(d.other) + ' more open outside the US or in a place the network could not name.' : '';
    const busy = d.cities.slice(0, 6);
    $('anBusy').innerHTML = busy.length ? busy.map((c) => barRow(GAMES[top(c.byGame)], c.city + ', ' + c.state, c.total, busy[0].total, 'open')).join('') : '<div class="anEmpty">No city has 3 or more games open right now.</div>';
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
  function replayItems(cap) {
    const sum = (arr) => arr.slice(0, cap).reduce((a, b) => a + b, 0);
    const list = [];
    for (const c of H.cities) {
      const hrs = H.cityHours[c.state + '|' + c.city];
      const v = hrs ? sum(hrs) : 0;
      if (v > 0) list.push({ ...c, total: v });
    }
    const rolls = {};
    for (const [st, hrs] of Object.entries(H.stateHours)) { const v = sum(hrs); if (v) rolls[st] = v; }
    return { list, rolls };
  }
  function drawHistMap() {
    const maxAll = Math.max(1, ...H.cities.map((c) => c.total));
    let list = H.cities, rolls = H.rolls;
    if (hourCap < 24) { const r = replayItems(hourCap); list = r.list; rolls = r.rolls; }
    const items = cityItems(list, (c) => c.total, maxAll, (c) => ({ title: `${c.city}, ${c.state}: ${fmtN(c.total)} plays`, extra: c.minutes != null && hourCap >= 24 ? fmtN(c.minutes) + ' minutes played' : '' }));
    histMap.render(items, rolls);
    if (!histZoomed && inLakes(items)) { histZoomed = true; histMap.zoomTo('lakes'); }
  }
  async function loadHistory() {
    stopReplay();
    try { H = await api('analytics.history', { range }); setErr(''); } catch (e) { setErr(e.message); return; }
    await mapReady;
    if (!histMap) histMap = makeMap($('anHistMap'), 'Map of plays by city');
    hourCap = 24; $('anHour').value = 23; $('anHourLbl').textContent = 'All day';
    drawHistMap();
    const lbl = range === 1 ? 'today' : 'last ' + range + ' days';
    $('anKpis').innerHTML = [
      ['Plays', fmtN(H.plays), lbl],
      ['Minutes played', fmtN(H.minutes), 'about ' + fmtN(H.minutes / 60) + ' hours'],
      ['Minutes per play', H.minutesPerPlay.toFixed(1), 'from play-length ranges'],
      ['Places', H.cityCount + (H.cityCount === 1 ? ' city' : ' cities'), H.stateCount + (H.stateCount === 1 ? ' state' : ' states')],
      ['Home Screen app', H.appShare + '%', 'of plays'],
    ].map(([l, n, s]) => `<div class="anKpi"><div class="l">${l}</div><div class="n">${n}</div><div class="s">${s}</div></div>`).join('');
    if (range === 1) {
      $('anOtTitle').textContent = 'Plays by hour today';
      $('anOverTime').innerHTML = stackCols(H.hoursGame.map((r, h) => (h <= H.todayHour ? r : null)), H.hoursGame.map((_, h) => (h % 3 === 0 ? fmtHour(h) : '')), 'Plays by hour today');
    } else {
      $('anOtTitle').textContent = 'Plays per day';
      const step = range === 7 ? 1 : 5;
      $('anOverTime').innerHTML = stackCols(H.perDay, H.days.map((d, i) => (i % step === 0 || i === H.days.length - 1 ? (range === 7 ? wkDay(d) : fmtDay(d)) : '')), 'Plays per day by game');
    }
    $('anOtLegend').innerHTML = GAMES.map((g) => `<span><i style="background:${g.c}"></i>${g.n}</span>`).join('');
    $('anHours').innerHTML = hourCols(H.hours.map((v) => v / range));
    const gmax = Math.max(1, ...H.byGame);
    $('anHGames').innerHTML = GAMES.map((g, i) => ({ g, v: H.byGame[i], m: H.avgMinutes[i] })).sort((a, b) => b.v - a.v).map(({ g, v, m }) => barRow(g, g.n, v, gmax, m ? m.toFixed(1) + ' min each' : '')).join('');
    const bl = ['Under 2 min', '2 to 5', '5 to 15', '15 plus'], bc = ['#C9B8EA', '#A98BE0', '#8C61D8', '#7138D1'], bm = Math.max(1, ...H.buckets);
    $('anLen').innerHTML = '<div class="anBoard">' + H.buckets.map((v, i) => `<div class="anRow" style="grid-template-columns:96px minmax(0,1fr) auto"><span style="font-size:13px">${bl[i]}</span><div class="anTrack" style="margin:0;height:14px"><div class="anFill" style="width:${((v / bm) * 100).toFixed(0)}%;background:${bc[i]}"></div></div><span class="v">${fmtN(v)}</span></div>`).join('') + '</div>';
    const hp = H.appShare;
    $('anSplit').innerHTML = H.plays ? `<div class="anSplit" role="img" aria-label="${hp} percent Home Screen app, ${100 - hp} percent browser"><div style="width:${hp}%;background:var(--purple)">${hp >= 12 ? '📲 App ' + hp + '%' : ''}</div><div style="width:${100 - hp}%;background:var(--blue)">${100 - hp >= 12 ? '🌐 Browser ' + (100 - hp) + '%' : ''}</div></div><p>Home Screen app means the parent saved Mojialand to the Home Screen.</p>` : '<div class="anEmpty">No plays yet.</div>';
    const tp = H.cities.slice(0, 8);
    $('anTPlays').innerHTML = tp.length ? `<table><thead><tr><th>City</th><th>Top game</th><th class="r">Plays</th></tr></thead><tbody>${tp.map((c) => { const g = GAMES[top(c.byGame)]; return `<tr><td>${esc(c.city)}, ${esc(c.state)}</td><td>${g.e} ${g.n}</td><td class="r">${fmtN(c.total)}</td></tr>`; }).join('')}</tbody></table>` : '<div class="anEmpty">No city passed 5 plays in a day yet.</div>';
    const tm = H.cities.slice().sort((a, b) => b.minutes - a.minutes).slice(0, 8);
    $('anTMins').innerHTML = tm.length ? `<table><thead><tr><th>City</th><th class="r">Minutes</th><th class="r">Per play</th></tr></thead><tbody>${tm.map((c) => `<tr><td>${esc(c.city)}, ${esc(c.state)}</td><td class="r">${fmtN(c.minutes)}</td><td class="r">${(c.minutes / Math.max(1, c.total)).toFixed(1)}</td></tr>`).join('')}</tbody></table>` : '<div class="anEmpty">No city passed 5 plays in a day yet.</div>';
    $('anHistSub').textContent = (range === 1 ? 'Today so far.' : 'Last ' + range + ' days.') + ' Bubble size shows plays. Color shows the favorite game in that city.' + (H.other ? ' ' + fmtN(H.other) + ' plays came from outside the US or an unnamed place.' : '');
  }
  function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function ticks(m) { if (m <= 5) return m; const p = Math.pow(10, Math.floor(Math.log10(m))); return Math.round(m / p) === 2 ? 4 : 5; }
  function axis(m, y, L, W, R) { const tk = ticks(m); let s = ''; for (let k = 0; k <= tk; k++) { const v = (m * k) / tk, yy = y(v); s += `<line class="anGridL" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="anAxis" x="${L - 6}" y="${yy + 3}" text-anchor="end">${fmtN(v)}</text>`; } return s; }
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
    const pct = (v) => (c.open ? Math.round((v / c.open) * 100) + '%' : '0%');
    const link = linkBase() + c.label;
    b.innerHTML = `<div class="anHead"><div style="min-width:0"><h2><span class="anTag" style="background:${c.color}"></span>${esc(c.name)}</h2><p>${c.note ? esc(c.note) + ' · ' : ''}Started ${fmtDay(c.start)}${c.active ? '' : ' · paused, new scans count nothing'}</p></div>
      <div class="row"><button type="button" class="secondary" id="anPrintC">Print QR cards</button><button type="button" class="secondary" id="anCopyC">Copy link</button><button type="button" class="${c.active ? 'danger' : 'secondary'}" id="anPause">${c.active ? 'Pause' : 'Resume'}</button></div></div>
      <div class="anLinkbox"><img alt="QR code" src="${qr(link, 4)}"><div style="display:grid;gap:4px;min-width:0"><span class="anMuted">QR code opens</span><code>${esc(link)}</code><span class="anMuted" id="anCopyOk"></span></div></div>
      <div class="anFunnel">
        <div class="anStep"><div class="l">QR opens</div><div class="n">${fmtN(c.open)}</div><div class="s">first open per device</div></div>
        <div class="anStep"><div class="l">Played a game</div><div class="n">${fmtN(c.play)}</div><div class="s">${pct(c.play)} of opens</div></div>
        <div class="anStep"><div class="l">Gift codes used</div><div class="n">${fmtN(c.gift)}</div><div class="s">${pct(c.gift)} of opens</div></div>
        <div class="anStep"><div class="l">Passes bought</div><div class="n">${fmtN(bought)}</div><div class="s">${c.pass48} 48-hour, ${c.forever} Forever · ${pct(bought)}</div></div>
        <div class="anStep"><div class="l">Open to purchase</div><div class="n">${c.avgDays == null ? '-' : c.avgDays.toFixed(1)}</div><div class="s">days, average</div></div>
      </div>
      <div class="anGrid2" style="align-items:start">
        <div style="display:grid;gap:8px;min-width:0"><h3>Where the cards traveled</h3><div class="anMap" id="anCampMap"></div></div>
        <div style="display:grid;gap:8px;min-width:0"><h3>Opens per day</h3><div class="anChart">${campCols(c)}</div>
          <h3 style="margin-top:6px">Cities reached</h3><div class="anBoard">${c.cities.length || Object.keys(c.rolls).length ? c.cities.map((x) => `<div class="anRow"><span class="anDot" style="background:${c.color}">📍</span><div class="nm"><div>${esc(x.city)}, ${esc(x.state)}</div><div class="anTrack"><div class="anFill" style="width:${((x.n / c.cities[0].n) * 100).toFixed(0)}%;background:${c.color}"></div></div></div><span class="v">${fmtN(x.n)}</span></div>`).join('') + Object.entries(c.rolls).sort((a, b) => b[1] - a[1]).map(([st, v]) => `<div class="anRow"><span class="anDot" style="background:#F3ECFC">🗺️</span><div class="nm"><div>Smaller places, ${esc(st)}</div></div><span class="v">${fmtN(v)}</span></div>`).join('') : '<div class="anEmpty">No opens yet. Print the QR cards and hand them out.</div>'}</div></div>
      </div>`;
    const m = makeMap($('anCampMap'), 'Map of cities reached by this campaign');
    const maxN = Math.max(1, ...c.cities.map((x) => x.n));
    const items = [];
    for (const x of c.cities) { const p = pos(x.state, x.city); if (p) items.push({ key: x.state + '|' + x.city, x: p[0], y: p[1], rpx: 9 + 13 * Math.sqrt(x.n / maxN), color: c.color, emoji: '📍', badge: x.n, count: x.n, title: `${x.city}, ${x.state}: ${fmtN(x.n)} opens` }); }
    m.render(items, c.rolls);
    if (inLakes(items)) m.zoomTo('lakes');
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
