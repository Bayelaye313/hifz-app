/* Index du Coran : versets (0..6235), sourates, pages (1..604), Rub' (1..240), Hizb (1..60), Juz' (1..30). */
'use strict';

const Q = (() => {
  const D = window.QURAN_DATA;
  const N = D.text.length; // 6236
  const surahOf = new Uint8Array(N);
  const ayahOf = new Uint16Array(N);
  const surahStart = [0]; // surahStart[s] = index du verset s:1
  let i = 0;
  D.surahs.forEach((s, si) => {
    surahStart[si + 1] = i;
    for (let a = 1; a <= s[3]; a++) { surahOf[i] = si + 1; ayahOf[i] = a; i++; }
  });

  // Plages [premier, dernier] verset par page et par Rub'
  const pageRange = [], rubRange = [];
  const chars = new Float64Array(N), pageChars = new Float64Array(605);
  for (let v = 0; v < N; v++) {
    const p = D.pages[v], r = D.rubs[v];
    if (!pageRange[p]) pageRange[p] = [v, v]; else pageRange[p][1] = v;
    if (!rubRange[r]) rubRange[r] = [v, v]; else rubRange[r][1] = v;
    chars[v] = D.text[v].length;
    pageChars[p] += chars[v];
  }
  // Poids d'un verset en « pages » (part de la page qu'il occupe)
  const pageWeight = new Float64Array(N);
  for (let v = 0; v < N; v++) pageWeight[v] = chars[v] / pageChars[D.pages[v]];

  const rubsOfPage = []; // Rub' présents sur une page
  for (let p = 1; p <= 604; p++) {
    const [a, b] = pageRange[p];
    rubsOfPage[p] = [...new Set(D.rubs.slice(a, b + 1))];
  }
  const juzOfRub = (r) => Math.ceil(r / 8);
  const hizbOfRub = (r) => Math.ceil(r / 4);
  const juzOfPage = (p) => juzOfRub(D.rubs[pageRange[p][0]]);
  const rubPages = (r) => [D.pages[rubRange[r][0]], D.pages[rubRange[r][1]]];
  const juzRange = (j) => [rubRange[(j - 1) * 8 + 1][0], rubRange[j * 8][1]];

  const surahName = (s) => D.surahs[s - 1][1];
  const surahAr = (s) => D.surahs[s - 1][0];
  const surahFr = (s) => D.surahs[s - 1][2];
  const ayahCount = (s) => D.surahs[s - 1][3];
  const key = (v) => `${surahOf[v]}:${ayahOf[v]}`;
  const index = (k) => {
    const m = /^\s*(\d{1,3})\s*[:.]\s*(\d{1,3})\s*$/.exec(k || '');
    if (!m) return -1;
    const s = +m[1], a = +m[2];
    if (s < 1 || s > 114 || a < 1 || a > ayahCount(s)) return -1;
    return surahStart[s] + a - 1;
  };
  const label = (v) => `${surahName(surahOf[v])} ${ayahOf[v]}`;
  const audioFile = (v) => String(surahOf[v]).padStart(3, '0') + String(ayahOf[v]).padStart(3, '0');

  // Description lisible d'une plage de versets
  function describe([a, b]) {
    const sa = surahOf[a], sb = surahOf[b];
    if (sa === sb) {
      if (ayahOf[a] === 1 && ayahOf[b] === ayahCount(sa)) return `Sourate ${surahName(sa)} (entière)`;
      return `Sourate ${surahName(sa)}, v. ${ayahOf[a]} → ${ayahOf[b]}`;
    }
    return `${surahName(sa)} ${ayahOf[a]} → ${surahName(sb)} ${ayahOf[b]}`;
  }
  const describeAll = (ranges) => ranges.map(describe).join(' · ');
  function pagesOf(ranges) {
    const first = D.pages[ranges[0][0]], last = D.pages[ranges[ranges.length - 1][1]];
    return first === last ? `p. ${first}` : `p. ${first}–${last}`;
  }
  function rubsOf(ranges) {
    const set = new Set();
    for (const [a, b] of ranges) for (let v = a; v <= b; v++) set.add(D.rubs[v]);
    return [...set].sort((x, y) => x - y);
  }
  const verseCount = (ranges) => ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
  const pageAmount = (ranges) => ranges.reduce((n, [a, b]) => { for (let v = a; v <= b; v++) n += pageWeight[v]; return n; }, 0);
  const rubLabel = (r) => `Rub' ${r} · Hizb ${hizbOfRub(r)} · Juz' ${juzOfRub(r)}`;

  return {
    N, D, surahOf, ayahOf, surahStart, pageRange, rubRange, pageWeight, rubsOfPage,
    juzOfRub, hizbOfRub, juzOfPage, rubPages, juzRange,
    surahName, surahAr, surahFr, ayahCount, key, index, label, audioFile,
    describe, describeAll, pagesOf, rubsOf, verseCount, pageAmount, rubLabel,
    text: (v) => D.text[v], fr: (v) => window.QURAN_FR?.[v] || '', page: (v) => D.pages[v], rub: (v) => D.rubs[v],
  };
})();
