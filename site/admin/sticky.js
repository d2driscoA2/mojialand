// Release 1.5 admin sticky bars on phones (Danny, October 16, 2026: build now, demo first).
// Phones only (760 px wide or less). Three patterns for the demo; staging shows a switch in the header.
//   a: main tabs pin to the top, the section's own row (Passes tabs, Analytics time range) pins under them.
//   b: only the section's own row pins to the top.
//   c: main tabs stay at the top of the page; the section's own row floats at the bottom once scrolled past.
// Device storage only (mojia.adminSticky, the demo choice). No network.
(function () {
  const STAGING = /displayedux\.com$|netlify\.app$|localhost|127\.0\.0\.1/.test(location.hostname);
  const KEY = 'mojia.adminSticky';
  const MODES = ['a', 'b', 'c'];
  const DEFAULT = 'a';
  let mode = DEFAULT;
  if (STAGING) { try { const m = localStorage.getItem(KEY); if (MODES.includes(m)) mode = m; } catch (e) { /* storage off: default */ } }
  const root = document.documentElement;
  const tabs = document.getElementById('tabs');
  const ROW_IDS = ['pTabs', 'anRanges', 'anWRanges'];
  const rows = () => ROW_IDS.map((id) => document.getElementById(id)).filter(Boolean);

  // The main tabs' height, so pattern a pins the section row right under them.
  function measure() { if (tabs) root.style.setProperty('--tabsH', tabs.offsetHeight + 'px'); }
  if (tabs && 'ResizeObserver' in window) new ResizeObserver(measure).observe(tabs);
  window.addEventListener('resize', measure);

  // Pattern c: a marker before each row; once the marker scrolls above the screen, the row floats at the bottom.
  const markers = new Map();
  function setupFloat() {
    rows().forEach((row) => {
      if (markers.has(row)) return;
      row.classList.add('stickRow');
      const mk = document.createElement('div');
      mk.className = 'stickMark';
      mk.setAttribute('aria-hidden', 'true');
      row.parentNode.insertBefore(mk, row);
      markers.set(row, mk);
      if ('IntersectionObserver' in window) new IntersectionObserver(() => check(row)).observe(mk);
    });
  }

  // Floats the row when its marker sits above the screen (pattern c only).
  function check(row) {
    const mk = markers.get(row); if (!mk) return;
    const float = root.dataset.sticky === 'c' && mk.offsetParent !== null && mk.getBoundingClientRect().top < 0;
    if (float && !row.classList.contains('floating')) mk.style.height = row.offsetHeight + 'px';
    if (!float) mk.style.height = '';
    row.classList.toggle('floating', float);
  }
  let ticking = false;
  window.addEventListener('scroll', () => { if (ticking || root.dataset.sticky !== 'c') return; ticking = true; requestAnimationFrame(() => { ticking = false; rows().forEach(check); }); }, { passive: true });

  function apply(m) {
    mode = m;
    root.dataset.sticky = m;
    rows().forEach(check);
    document.querySelectorAll('#stickyDemo button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
    measure();
  }

  // Staging only: the demo switch next to the ADMIN · STAGING tag.
  if (STAGING) {
    const env = document.getElementById('envTag');
    if (env) {
      const box = document.createElement('div');
      box.id = 'stickyDemo';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Sticky bar demo');
      box.innerHTML = '<span>Sticky</span>' + MODES.map((m) => '<button type="button" data-m="' + m + '" aria-pressed="false">' + m.toUpperCase() + '</button>').join('');
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        try { localStorage.setItem(KEY, b.dataset.m); } catch (x) { /* storage off */ }
        apply(b.dataset.m);
      });
      env.parentNode.insertBefore(box, env);
    }
  }

  setupFloat();
  apply(mode);
  // Analytics builds its rows when it loads; pick them up then.
  const obs = new MutationObserver(() => { if (rows().some((r) => !markers.has(r))) setupFloat(); });
  const an = document.getElementById('anRoot') || document.body;
  obs.observe(an, { childList: true, subtree: false });
  window.mojiaSticky = { apply, mode: () => mode };
})();
