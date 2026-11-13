/* Utilitaires : dates locales (YYYY-MM-DD), formatage, échappement HTML. */
'use strict';

const Dt = (() => {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const utc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };

  // ?date=2026-10-12 dans l'URL permet de simuler une autre date (tests).
  const override = new URLSearchParams(location.search).get('date');
  const today = () => (override && /^\d{4}-\d{2}-\d{2}$/.test(override) ? override : fmt(new Date()));

  const add = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
  const diff = (a, b) => Math.round((utc(b) - utc(a)) / 86400000); // b - a en jours
  const dow = (s) => parse(s).getDay(); // 0 = dimanche
  const max = (a, b) => (a > b ? a : b);
  const human = (s, opts = { weekday: 'long', day: 'numeric', month: 'long' }) =>
    parse(s).toLocaleDateString('fr-FR', opts);
  const short = (s) => human(s, { day: 'numeric', month: 'short', year: 'numeric' });
  const monthLabel = (s) => human(s, { month: 'long', year: 'numeric' });
  let hijriFmt = null;
  try { hijriFmt = new Intl.DateTimeFormat('fr-FR-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { /* non supporté */ }
  const hijri = (s) => (hijriFmt ? hijriFmt.format(parse(s)) : '');
  const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  return { fmt, parse, today, add, diff, dow, max, human, short, monthLabel, hijri, DAY_NAMES, isOverridden: !!override };
})();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const arNum = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
const pct = (v, digits = 1) => `${(v * 100).toFixed(digits).replace('.', ',')} %`;
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function toast(msg, kind = 'info', ms = 3200) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}
