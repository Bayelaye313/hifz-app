/* Moteur : planning dynamique + révision ancrée (Qarib / Ba'id / Grand Examen).
 *
 * Boîtes d'ancrage (système de Leitner adapté au Coran), par Rub' entièrement mémorisé :
 *   boîte 0  Qarib       : révisé chaque jour pendant 7 jours, puis 1re révision lointaine au 8e jour
 *   boîte 1  Fragile     : revient dans 3 jours
 *   boîte 2  En cours    : revient dans 7 jours
 *   boîte 3  Ancré       : revient dans 14 jours
 *   boîte 4  Ancré+      : revient dans 30 jours
 *   boîte 5  Solide      : revient dans 60 jours
 *   boîte 6  Maîtrisé    : revient dans 120 jours
 *
 * Notes de récitation : 4 = Parfait (100 %), 3 = Bon (1–2 hésitations), 2 = Fragile (erreurs, blocages), 1 = Oublié.
 */
'use strict';

const Engine = (() => {
  const INTERVALS = [8, 3, 7, 14, 30, 60, 120];
  const BOX_NAMES = ['Qarib', 'Fragile', 'En cours', 'Ancré', 'Ancré+', 'Solide', 'Maîtrisé'];
  const GRADES = {
    4: { label: 'Parfait', hint: '100 %, sans hésitation' },
    3: { label: 'Bon', hint: '1–2 hésitations' },
    2: { label: 'Fragile', hint: 'erreurs ou blocages' },
    1: { label: 'Oublié', hint: 'à réapprendre' },
  };
  const QARIB_DAYS = 7;
  const EXAM_DAYS = 30;
  const MASTERED_BOX = 3;

  /* ---------- Mémorisation ---------- */

  function memBits(state) {
    const bits = new Uint8Array(Q.N);
    for (const l of state.lessons) for (const [a, b] of l.ranges) bits.fill(1, a, b + 1);
    return bits;
  }

  const isStudyDay = (state, d) => state.settings.studyDays.includes(Dt.dow(d));

  /* Parcours de mémorisation :
   *   forward  : Al-Fatiha → An-Nas (ordre du Mushaf)
   *   backward : An-Nas → Al-Baqarah, Rub' par Rub' en remontant (Juz' 30 d'abord)
   *   half2    : du début du Hizb 31 (Al-Kahf 75, milieu exact du Coran) jusqu'à An-Nas,
   *              puis du Hizb 1 au Hizb 30 */
  const ORDERS = {
    forward: { label: 'Ordre standard', desc: 'Du début à la fin : Al-Fatiha → An-Nas.' },
    backward: { label: 'Ordre inversé', desc: "Du Juz' 30 / Hizb 60 en remontant : An-Nas → Al-Baqarah." },
    half2: { label: 'Deuxième moitié', desc: 'Du Hizb 31 (Al-Kahf 75, puis Maryam) jusqu\'à An-Nas, puis Hizb 1 → 30.' },
  };
  const HALF_RUB = 121; // premier Rub' du Hizb 31

  /* Rang d'un Rub' dans la séquence d'apprentissage du parcours (1 = appris en premier). */
  function rubRank(order, r) {
    if (order === 'backward') return 241 - r;
    if (order === 'half2') return r >= HALF_RUB ? r - HALF_RUB + 1 : r + 240 - HALF_RUB + 1;
    return r;
  }

  /* Comparateur « ordre chronologique d'apprentissage » : date de mémorisation, puis rang dans le parcours. */
  const byLearning = (state) => (x, y) => {
    const fx = state.rubs[x]?.first || '9999', fy = state.rubs[y]?.first || '9999';
    return fx < fy ? -1 : fx > fy ? 1 : rubRank(state.settings.order, x) - rubRank(state.settings.order, y);
  };

  /* Fusionne des plages données dans l'ordre d'apprentissage : les plages contiguës forment un bloc
     (lu dans le sens du Mushaf), et les blocs restent dans l'ordre où ils ont été appris. */
  function mergeChrono(ranges) {
    const blocks = [];
    for (const [a, b] of ranges) {
      const blk = blocks.find(([x, y]) => a <= y + 1 && b >= x - 1);
      if (blk) { blk[0] = Math.min(blk[0], a); blk[1] = Math.max(blk[1], b); }
      else blocks.push([a, b]);
    }
    return blocks;
  }

  /* Découpe ce qui reste à apprendre en leçons quotidiennes, selon l'unité (Rub' ou page),
     le volume et le parcours choisis. Les versets déjà mémorisés sont ignorés, si bien qu'un
     changement de réglage en cours de route repart exactement où l'on en est. */
  function remainingLessons(settings, bits) {
    const total = settings.unit === 'rub' ? 240 : 604;
    const rangeOf = settings.unit === 'rub' ? Q.rubRange : Q.pageRange;
    const units = [];
    for (let u = 1; u <= total; u++) {
      const [a, b] = rangeOf[u];
      let pending = false;
      for (let v = a; v <= b && !pending; v++) if (!bits[v]) pending = true;
      if (pending) units.push(u);
    }
    // Chaque segment est découpé séparément : une leçon ne chevauche jamais le passage An-Nas → Al-Fatiha.
    let segments = [units];
    if (settings.order === 'backward') units.reverse();
    else if (settings.order === 'half2') {
      const pivot = Q.rubRange[HALF_RUB][0];
      const i = units.findIndex((u) => rangeOf[u][0] >= pivot);
      if (i > 0) segments = [units.slice(i), units.slice(0, i)];
    }

    const k = Math.max(1, settings.amount | 0);
    const lessons = [];
    for (const seg of segments) for (let i = 0; i < seg.length; i += k) {
      const group = seg.slice(i, i + k);
      let lo = Infinity, hi = -1;
      for (const u of group) { lo = Math.min(lo, rangeOf[u][0]); hi = Math.max(hi, rangeOf[u][1]); }
      const ranges = [];
      let start = -1;
      for (let v = lo; v <= hi; v++) {
        if (!bits[v]) { if (start < 0) start = v; }
        else if (start >= 0) { ranges.push([start, v - 1]); start = -1; }
      }
      if (start >= 0) ranges.push([start, hi]);
      lessons.push({ ranges });
    }
    return lessons;
  }

  /* Toutes les leçons validées un jour donné, fusionnées (on peut en valider plusieurs par jour). */
  function lessonOn(state, d) {
    const list = state.lessons.filter((l) => !l.prior && l.date === d);
    if (!list.length) return undefined;
    return { ranges: mergeChrono(list.flatMap((l) => l.ranges)), count: list.length, date: d };
  }

  /* Projette les leçons restantes sur le calendrier : une leçon par jour d'étude,
     aucune nouvelle leçon les jours de révision (week-end). Les leçons validées en avance
     raccourcissent d'autant la projection. */
  function projection(state, today, remaining) {
    let d = Dt.max(today, state.settings.startDate);
    if (d === today && lessonOn(state, today)) d = Dt.add(d, 1);
    const schedule = [];
    for (const lesson of remaining) {
      while (!isStudyDay(state, d)) d = Dt.add(d, 1);
      schedule.push({ date: d, lesson });
      d = Dt.add(d, 1);
    }
    const lastDone = state.lessons.filter((l) => !l.prior).map((l) => l.date).sort().pop() || null;
    return { schedule, end: schedule.length ? schedule[schedule.length - 1].date : lastDone };
  }

  function rebaseline(state, today) {
    const remaining = remainingLessons(state.settings, memBits(state));
    state.baseline = { end: projection(state, today, remaining).end, setAt: today };
  }

  /* Situation du jour */
  function todayInfo(state, today, remaining) {
    const s = state.settings;
    const done = lessonOn(state, today);
    if (!remaining.length && !done) return { kind: 'complete' };
    if (today < s.startDate) return { kind: 'before' };
    if (!isStudyDay(state, today)) return { kind: 'review', lesson: done || null, next: remaining[0] || null };
    if (done) return { kind: 'study', lesson: done, validated: true, next: remaining[0] || null };
    return { kind: 'study', lesson: remaining[0], validated: false };
  }

  function newRubState(date) {
    return { box: 0, due: Dt.add(date, INTERVALS[0]), memorizedAt: date, first: date, reviews: 0, lapses: 0, hist: [] };
  }

  /* Valide la leçon du jour : les versets passent en « mémorisés » ; tout Rub' désormais
     complet entre en phase Qarib (boîte 0). */
  function validateLesson(state, today, lesson) {
    const entry = { id: uid(), date: today, ranges: lesson.ranges.map((r) => r.slice()), createdRubs: [] };
    state.lessons.push(entry);
    const bits = memBits(state);
    for (const r of Q.rubsOf(entry.ranges)) {
      if (state.rubs[r]) continue;
      const [a, b] = Q.rubRange[r];
      let full = true;
      for (let v = a; v <= b && full; v++) if (!bits[v]) full = false;
      if (full) { state.rubs[r] = newRubState(today); entry.createdRubs.push(r); }
    }
    markActive(state, today);
    return entry;
  }

  /* Annule la dernière leçon validée aujourd'hui. */
  function undoLesson(state, today) {
    const idx = state.lessons.findLastIndex((l) => !l.prior && l.date === today);
    if (idx < 0) return false;
    const [entry] = state.lessons.splice(idx, 1);
    for (const r of entry.createdRubs || []) delete state.rubs[r];
    return true;
  }

  /* Marque des sourates déjà connues avant le programme : elles entrent directement
     en boîte 2 avec des échéances étalées sur 14 jours pour éviter un pic de révision. */
  function markPrior(state, today, fromSurah, toSurah) {
    const a = Q.surahStart[fromSurah], b = Q.surahStart[toSurah] + Q.ayahCount(toSurah) - 1;
    const bits = memBits(state);
    const ranges = [];
    let start = -1;
    for (let v = a; v <= b; v++) {
      if (!bits[v]) { if (start < 0) start = v; }
      else if (start >= 0) { ranges.push([start, v - 1]); start = -1; }
    }
    if (start >= 0) ranges.push([start, b]);
    if (!ranges.length) return 0;
    const past = Dt.add(today, -(QARIB_DAYS + 1));
    state.lessons.push({ id: uid(), date: past, ranges, prior: true, createdRubs: [] });
    const all = memBits(state);
    let n = 0;
    for (const r of Q.rubsOf(ranges)) {
      if (state.rubs[r]) continue;
      const [x, y] = Q.rubRange[r];
      let full = true;
      for (let v = x; v <= y && full; v++) if (!all[v]) full = false;
      if (!full) continue;
      state.rubs[r] = { box: 2, due: Dt.add(today, 1 + (n % 14)), memorizedAt: past, first: past, reviews: 0, lapses: 0, hist: [] };
      n++;
    }
    return n;
  }

  /* ---------- Révision ---------- */

  const day = (state, d) => (state.daily[d] ||= { qarib: {}, graded: {}, ctx: {}, snap: {}, extra: 0 });

  /* Qarib : tout ce qui a été mémorisé durant les 7 derniers jours (hors aujourd'hui),
     plus les Rub' « oubliés » remis en réapprentissage. */
  function qaribItems(state, today) {
    const items = [];
    const covered = new Set();
    for (const l of state.lessons) {
      if (l.prior) continue;
      const age = Dt.diff(l.date, today);
      if (age < 1 || age > QARIB_DAYS) continue;
      items.push({ id: 'L' + l.id, ranges: l.ranges, title: Q.describeAll(l.ranges), sub: `${Q.pagesOf(l.ranges)} · appris ${age === 1 ? 'hier' : `il y a ${age} jours`}`, age });
      Q.rubsOf(l.ranges).forEach((r) => covered.add(r));
    }
    for (const [r, rs] of Object.entries(state.rubs)) {
      if (!rs.relearnAt || covered.has(+r)) continue;
      const age = Dt.diff(rs.relearnAt, today);
      if (age < 1 || age > QARIB_DAYS || rs.box !== 0) continue;
      items.push({ id: 'R' + r, ranges: [Q.rubRange[r]], title: `Réapprentissage · Rub' ${r}`, sub: `${Q.describe(Q.rubRange[r])} · ${Q.pagesOf([Q.rubRange[r]])}`, age });
    }
    items.sort((x, y) => y.age - x.age);
    const done = day(state, today).qarib;
    items.forEach((it) => { it.done = !!done[it.id]; });
    return items;
  }

  function autoCap(state) {
    const n = Object.keys(state.rubs).length;
    return clamp(Math.ceil(n / 30), 2, 8);
  }
  const baidCap = (state) => (state.settings.baidCap === 'auto' ? autoCap(state) : +state.settings.baidCap);

  /* Ba'id : Rub' arrivés à échéance (donc forcément déjà mémorisés), triés par retard, fragilité,
     puis ordre chronologique d'apprentissage ; limités par la charge quotidienne. */
  function baidItems(state, today, exclude = new Set()) {
    const dd = state.daily[today] || { graded: {}, ctx: {}, extra: 0 };
    // une récitation au micro notée compte comme la révision Ba'id du jour
    const doneToday = Object.keys(dd.graded || {}).filter((r) => dd.ctx[r] === 'baid' || dd.ctx[r] === 'voice').map(Number);
    const learned = byLearning(state);
    const due = Object.entries(state.rubs)
      .map(([r, rs]) => ({ r: +r, rs }))
      .filter(({ r, rs }) => rs.due <= today && !exclude.has(r) && !doneToday.includes(r) && !(rs.box === 0 && Dt.diff(rs.memorizedAt, today) <= QARIB_DAYS))
      .sort((x, y) => (x.rs.due < y.rs.due ? -1 : x.rs.due > y.rs.due ? 1 : x.rs.box - y.rs.box || learned(x.r, y.r)));
    const cap = baidCap(state) + (dd.extra || 0);
    const slots = Math.max(0, cap - doneToday.length);
    const pending = due.slice(0, slots);
    return {
      pending: pending.map(({ r, rs }) => ({ r, rs, overdue: Dt.diff(rs.due, today) })),
      done: doneToday.map((r) => ({ r, rs: state.rubs[r], grade: dd.graded[r] })),
      backlog: due.length - pending.length,
      cap,
    };
  }

  /* Grand Examen (jours de révision) : tous les Rub' travaillés dans les 30 derniers jours, dans l'ordre
     où ils ont été appris. `ranges` ne contient que la partie réellement mémorisée du Rub' : un Rub'
     partiel (leçons à la page, début de parcours en milieu de Coran) n'entraîne jamais de récitation
     de versets pas encore appris. */
  function examItems(state, today) {
    const seen = new Map(); // rub -> [date de 1re leçon dans la fenêtre, rang dans le parcours]
    const lessons = state.lessons.filter((l) => !l.prior).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    for (const l of lessons) {
      const age = Dt.diff(l.date, today);
      if (age >= 1 && age <= EXAM_DAYS) Q.rubsOf(l.ranges).forEach((r) => { if (!seen.has(r)) seen.set(r, [l.date, rubRank(state.settings.order, r)]); });
    }
    const bits = memBits(state);
    const dd = state.daily[today] || { graded: {}, ctx: {} };
    return [...seen.entries()]
      .sort(([, [da, ra]], [, [db, rb]]) => (da < db ? -1 : da > db ? 1 : ra - rb))
      .map(([r]) => {
        const [a, b] = Q.rubRange[r];
        const ranges = [];
        let start = -1;
        for (let v = a; v <= b; v++) {
          if (bits[v]) { if (start < 0) start = v; }
          else if (start >= 0) { ranges.push([start, v - 1]); start = -1; }
        }
        if (start >= 0) ranges.push([start, b]);
        return { r, rs: state.rubs[r] || null, ranges, grade: dd.ctx?.[r] === 'exam' ? dd.graded[r] : null };
      });
  }

  function applyGrade(rs, g, today) {
    if (g === 1) {
      rs.box = 0; rs.memorizedAt = today; rs.relearnAt = today; rs.lapses++;
    } else if (rs.box === 0) {
      rs.box = { 4: 3, 3: 2, 2: 1 }[g];
      delete rs.relearnAt;
    } else if (g === 4) rs.box = Math.min(6, rs.box + 1);
    else if (g === 2) rs.box = Math.max(1, rs.box - 1);
    rs.due = Dt.add(today, INTERVALS[rs.box]);
  }

  /* Note un Rub' (contexte 'baid', 'exam' ou 'voice'). Une nouvelle note le même jour remplace la précédente. */
  function grade(state, r, g, today, ctx) {
    const dd = day(state, today);
    const rs = state.rubs[r];
    if (rs) {
      if (dd.snap[r]) Object.assign(rs, JSON.parse(JSON.stringify(dd.snap[r])));
      else dd.snap[r] = JSON.parse(JSON.stringify(rs));
      if (!('relearnAt' in dd.snap[r])) delete rs.relearnAt;
      rs.reviews++;
      // Pendant les 7 jours de Qarib, l'examen et le micro ne font que confirmer — sauf oubli, qui relance
      // l'apprentissage. À l'échéance (passage en Ba'id), la note s'applique normalement.
      const inQarib = rs.box === 0 && today < rs.due;
      if (!((ctx === 'exam' || ctx === 'voice') && inQarib && g !== 1)) applyGrade(rs, g, today);
      rs.hist.push([today, g]);
      if (rs.hist.length > 30) rs.hist.shift();
    }
    dd.graded[r] = g;
    dd.ctx[r] = ctx;
    markActive(state, today);
  }

  function toggleQarib(state, today, id) {
    const q = day(state, today).qarib;
    if (q[id]) delete q[id]; else q[id] = true;
    markActive(state, today);
  }

  function markActive(state, d) {
    state.activity[d] = true;
    state.bestStreak = Math.max(state.bestStreak || 0, streak(state, d));
  }

  function streak(state, today) {
    let d = state.activity[today] ? today : Dt.add(today, -1);
    let n = 0;
    while (state.activity[d]) { n++; d = Dt.add(d, -1); }
    return n;
  }

  /* ---------- Statistiques & statut des pages ---------- */

  function pageStatus(state, bits, today) {
    const status = new Array(605).fill('none');
    for (let p = 1; p <= 604; p++) {
      const [a, b] = Q.pageRange[p];
      let m = 0;
      for (let v = a; v <= b; v++) m += bits[v];
      if (!m) continue;
      if (m < b - a + 1) { status[p] = 'review'; continue; }
      let ok = true;
      for (const r of Q.rubsOfPage[p]) {
        const rs = state.rubs[r];
        if (!rs) { ok = false; break; }
        if (rs.box < MASTERED_BOX || rs.due <= today) { ok = false; break; }
      }
      status[p] = ok ? 'mastered' : 'review';
    }
    return status;
  }

  function stats(state, bits, today) {
    let verses = 0, pagesEq = 0;
    for (let v = 0; v < Q.N; v++) if (bits[v]) { verses++; pagesEq += Q.pageWeight[v]; }
    const rubsDone = Object.keys(state.rubs).length;
    let juzDone = 0;
    for (let j = 1; j <= 30; j++) {
      let all = true;
      for (let r = (j - 1) * 8 + 1; r <= j * 8; r++) if (!state.rubs[r]) { all = false; break; }
      if (all) juzDone++;
    }
    const mastered = Object.values(state.rubs).filter((rs) => rs.box >= MASTERED_BOX && rs.due > today).length;
    return {
      verses, pagesEq, ratio: pagesEq / 604, rubsDone, juzDone, mastered,
      streak: streak(state, today), best: Math.max(state.bestStreak || 0, streak(state, today)),
    };
  }

  /* Notes attachées à des versets d'un ensemble de plages */
  function notesIn(state, ranges) {
    return state.notes.filter((n) => !n.resolved && ranges.some(([a, b]) => n.v >= a && n.v <= b));
  }

  return {
    INTERVALS, BOX_NAMES, GRADES, QARIB_DAYS, EXAM_DAYS, MASTERED_BOX, ORDERS, HALF_RUB,
    memBits, rubRank, mergeChrono, isStudyDay, remainingLessons, projection, rebaseline, todayInfo, lessonOn,
    validateLesson, undoLesson, markPrior, qaribItems, baidItems, baidCap, examItems,
    grade, toggleQarib, markActive, streak, pageStatus, stats, notesIn, day,
  };
})();
