// Release 1.5 admin sticky bars on phones (Danny, October 16, 2026: pattern A after the staging demo).
// Phones only (760 px wide or less): the main admin tabs pin to the top, and the section's own row
// (Passes tabs, Analytics time ranges) pins right under them. No storage, no network.
(function () {
  const root = document.documentElement;
  const tabs = document.getElementById('tabs');
  const ROW_IDS = ['pTabs', 'anRanges', 'anWRanges'];
  function mark() { ROW_IDS.forEach((id) => { const r = document.getElementById(id); if (r) r.classList.add('stickRow'); }); }
  // The main tabs' height, so the section row pins right under them.
  function measure() { if (tabs) root.style.setProperty('--tabsH', tabs.offsetHeight + 'px'); }
  if (tabs && 'ResizeObserver' in window) new ResizeObserver(measure).observe(tabs);
  window.addEventListener('resize', measure);
  root.dataset.sticky = 'a';
  mark();
  measure();
  // Analytics builds its rows when it loads; pick them up then.
  const an = document.getElementById('anRoot');
  if (an) new MutationObserver(mark).observe(an, { childList: true });
})();
