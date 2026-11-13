/* Interface : routeur par hash, vues (Aujourd'hui, Atelier, Mushaf, Planning, Notes, Réglages). */
'use strict';

let S = Store.load();
const TODAY = Dt.today();
const view = document.getElementById('view');
let route = 'today';

const atelier = {
  ranges: null, title: '', sub: '', mask: 'none', voice: false, lastRecitation: null,
  revealed: new Set(), marks: new Map(), playingV: null, menuV: null,
  tab: S.ui.atelierTab === 'tafsir' ? 'tafsir' : 'text', tafsirRub: null,
};

const save = () => Store.save(S);
const commit = () => { save(); render(); };

/* ---------- Helpers d'affichage ---------- */

const UNIT_LABEL = { rub: "Rub'", page: 'page' };
const NOTE_TYPES = { mutashabih: 'Mutashabih', difficile: 'Difficile', tajwid: 'Tajwid', autre: 'Autre' };

function objective(ranges) {
  return ranges.map(([a, b]) => {
    const sa = Q.surahOf[a], sb = Q.surahOf[b];
    if (sa === sb) {
      const name = esc(Q.surahName(sa));
      if (Q.ayahOf[a] === 1 && Q.ayahOf[b] === Q.ayahCount(sa)) return `la sourate <b>${name}</b> en entier`;
      return `du verset <b>${Q.ayahOf[a]}</b> au verset <b>${Q.ayahOf[b]}</b> de la sourate <b>${name}</b>`;
    }
    return `de <b>${esc(Q.surahName(sa))} ${Q.ayahOf[a]}</b> à <b>${esc(Q.surahName(sb))} ${Q.ayahOf[b]}</b>`;
  }).join(', puis ');
}

function lessonMeta(ranges) {
  const rubs = Q.rubsOf(ranges);
  const rubTxt = rubs.length === 1 ? Q.rubLabel(rubs[0]) : `Rub' ${rubs[0]}–${rubs[rubs.length - 1]} · Juz' ${Q.juzOfRub(rubs[0])}`;
  return `
    <span class="chip">${Q.pagesOf(ranges)}</span>
    <span class="chip">${rubTxt}</span>
    <span class="chip">${plural(Q.verseCount(ranges), 'verset', 'versets')}</span>
    <span class="chip">≈ ${Q.pageAmount(ranges).toFixed(1).replace('.', ',')} page(s)</span>`;
}

const boxBadge = (rs) => `<span class="badge box-${rs.box}" title="Intervalle : ${Engine.INTERVALS[rs.box]} j">${Engine.BOX_NAMES[rs.box]}</span>`;

function gradeButtons(r, ctx, current = null) {
  return `<div class="grades" role="group" aria-label="Évaluer la récitation">${[4, 3, 2, 1].map((g) => `
    <button type="button" class="grade g${g} ${current === g ? 'on' : ''}" data-act="grade" data-r="${r}" data-g="${g}" data-ctx="${ctx}" title="${Engine.GRADES[g].hint}">${Engine.GRADES[g].label}</button>`).join('')}
  </div>`;
}

function ring(ratio) {
  const R = 34, C = 2 * Math.PI * R;
  return `<svg class="ring" viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="${R}" class="ring-bg"/>
    <circle cx="40" cy="40" r="${R}" class="ring-fg" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - ratio)}"/>
  </svg>`;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h2v18H5zm3 1h10l-2 4 2 4H8z"/></svg>',
};

/* ---------- Contexte calculé ---------- */

function computeCtx() {
  const bits = Engine.memBits(S);
  const remaining = Engine.remainingLessons(S.settings, bits);
  const info = Engine.todayInfo(S, TODAY, remaining);
  const proj = Engine.projection(S, TODAY, remaining);
  const stats = Engine.stats(S, bits, TODAY);
  const doneCount = S.lessons.filter((l) => !l.prior).length;
  return { bits, remaining, info, proj, stats, doneCount };
}

/* ---------- Vue : configuration du plan ---------- */

function planForm(s, isSetup) {
  const days = s.studyDays;
  const order = [1, 2, 3, 4, 5, 6, 0];
  return `
  <form class="plan-form" data-form="plan">
    <label>Date de début
      <input type="date" name="startDate" value="${s.startDate}" required>
    </label>
    <fieldset>
      <legend>Parcours de mémorisation</legend>
      <div class="paths" role="radiogroup">${Object.entries(Engine.ORDERS).map(([k, o]) => `
        <label class="path"><input type="radio" name="order" value="${k}" ${(s.order || 'forward') === k ? 'checked' : ''}><span><b>${esc(o.label)}</b><small>${esc(o.desc)}</small></span></label>`).join('')}
      </div>
      ${isSetup ? '' : '<p class="muted small">Changer de parcours conserve tout ce qui est déjà mémorisé : seule la suite du planning est réordonnée.</p>'}
    </fieldset>
    <fieldset>
      <legend>Volume quotidien de nouvelle mémorisation</legend>
      <div class="volume">
        <input type="number" name="amount" min="1" max="${s.unit === 'rub' ? 8 : 20}" value="${s.amount}" required aria-label="Quantité">
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="unit" value="rub" ${s.unit === 'rub' ? 'checked' : ''}><span>Rub' / jour</span></label>
          <label><input type="radio" name="unit" value="page" ${s.unit === 'page' ? 'checked' : ''}><span>Page(s) / jour</span></label>
        </div>
      </div>
      <p class="muted small">1 Rub' ≈ 2,5 pages. Les leçons suivent les frontières officielles des 240 Rub' ou des 604 pages.</p>
    </fieldset>
    <fieldset>
      <legend>Jours de nouvelle mémorisation</legend>
      <div class="days">${order.map((d) => `
        <label class="day"><input type="checkbox" name="studyDays" value="${d}" ${days.includes(d) ? 'checked' : ''}><span>${Dt.DAY_NAMES[d].slice(0, 3)}</span></label>`).join('')}
      </div>
      <p class="muted small">Les jours non cochés (par défaut samedi et dimanche) sont consacrés à la révision : Grand Examen + Ba'id. Aucune leçon n'y est planifiée, mais vous pouvez y valider une leçon bonus si vous le souhaitez.</p>
    </fieldset>
    <label>Charge maximale de révision lointaine (Ba'id) par jour
      <select name="baidCap">
        <option value="auto" ${s.baidCap === 'auto' ? 'selected' : ''}>Automatique (s'adapte au volume mémorisé, 2 à 8 Rub')</option>
        ${[2, 3, 4, 6, 8, 10, 12, 16].map((n) => `<option value="${n}" ${String(s.baidCap) === String(n) ? 'selected' : ''}>${n} Rub' (${(n / 8).toString().replace('.', ',')} Juz')</option>`).join('')}
      </select>
    </label>
    <div class="preview" id="planPreview"></div>
    <div class="actions">
      <button class="btn primary" type="submit">${isSetup ? 'Générer mon programme' : 'Recalculer le planning'}</button>
    </div>
  </form>`;
}

function readPlanForm(form) {
  const fd = new FormData(form);
  const unit = fd.get('unit');
  return {
    startDate: fd.get('startDate'),
    unit,
    amount: clamp(parseInt(fd.get('amount'), 10) || 1, 1, unit === 'rub' ? 8 : 20),
    order: Engine.ORDERS[fd.get('order')] ? fd.get('order') : 'forward',
    studyDays: fd.getAll('studyDays').map(Number),
    baidCap: fd.get('baidCap'),
  };
}

function updatePlanPreview(form) {
  const box = form.querySelector('#planPreview');
  if (!box) return;
  const s = readPlanForm(form);
  if (!s.studyDays.length) { box.innerHTML = '<p class="warn">Choisissez au moins un jour de mémorisation.</p>'; return; }
  const tmp = { ...S, settings: s };
  const remaining = Engine.remainingLessons(s, Engine.memBits(tmp));
  const proj = Engine.projection(tmp, TODAY, remaining);
  const start = Dt.max(TODAY, s.startDate);
  const months = proj.end ? (Dt.diff(start, proj.end) / 30.44).toFixed(1).replace('.', ',') : '0';
  box.innerHTML = proj.end ? `
    <div><strong>${remaining.length}</strong><span>leçons restantes</span></div>
    <div><strong>${Dt.short(proj.end)}</strong><span>fin estimée (Khatm)</span></div>
    <div><strong>${months}</strong><span>mois</span></div>
    <div><strong>${s.studyDays.length} / 7</strong><span>jours d'apprentissage</span></div>
    <p class="preview-first">Jour 1 : <b>${esc(Q.describeAll(remaining[0].ranges))}</b> · ${Q.pagesOf(remaining[0].ranges)}</p>` : '<p>Tout est déjà mémorisé.</p>';
}

function renderSetup() {
  const s = S.settings || { startDate: TODAY, unit: 'rub', amount: 1, order: 'forward', studyDays: [1, 2, 3, 4, 5], baidCap: 'auto' };
  return `
  <section class="setup">
    <p class="eyebrow">بِسْمِ ٱللَّهِ</p>
    <h1>Construisons votre programme de Hifz</h1>
    <p class="lead">Une nouvelle portion chaque jour d'étude, la révision proche (Qarib) des 7 derniers jours, une révision lointaine (Ba'id) à intervalles espacés, et un Grand Examen chaque week-end.</p>
    <div class="card">${planForm(s, true)}</div>
  </section>`;
}

/* ---------- Vue : Aujourd'hui ---------- */

function renderHero(c) {
  const { info, proj, remaining, doneCount } = c;
  const hijri = Dt.hijri(TODAY);
  const date = `<p class="hero-date">${esc(Dt.human(TODAY))}${hijri ? ` · <span>${esc(hijri)}</span>` : ''}${Dt.isOverridden ? ' <span class="badge box-1">date simulée</span>' : ''}</p>`;
  const total = doneCount + remaining.length;

  if (info.kind === 'complete') {
    return `<section class="hero complete">${date}
      <p class="eyebrow">Khatm al-Qur'an</p>
      <h1>Ma sha Allah, tout le Coran est mémorisé.</h1>
      <p class="lead">Le travail continue désormais dans la révision : suivez le Ba'id chaque jour et le Grand Examen chaque week-end.</p></section>`;
  }
  if (info.kind === 'before') {
    const first = remaining[0];
    return `<section class="hero">${date}
      <p class="eyebrow">Programme à venir</p>
      <h1>Début le ${esc(Dt.human(S.settings.startDate))}</h1>
      <p class="lead">Première leçon : ${objective(first.ranges)}.</p>
      <div class="chips">${lessonMeta(first.ranges)}</div>
      <div class="actions"><button class="btn" data-act="open-ranges" data-ranges='${JSON.stringify(first.ranges)}' data-title="Première leçon">Prendre de l'avance dans l'Atelier</button></div>
    </section>`;
  }
  if (info.kind === 'review') {
    const extra = info.lesson;
    const bonus = info.next;
    return `<section class="hero exam">${date}
      <p class="eyebrow">Jour de révision${extra ? ` · ${plural(extra.count, 'leçon bonus validée', 'leçons bonus validées')}` : ''}</p>
      <h1>Mode Grand Examen</h1>
      <p class="lead">Récitez d'une seule traite tous les Rub' accumulés ce mois-ci, puis évaluez chacun. Les résultats alimentent directement l'algorithme d'ancrage.</p>
      ${extra ? `<p class="alert ok">${ICON.check} Mémorisé en plus aujourd'hui : ${esc(Q.describeAll(extra.ranges))} · ${Q.pagesOf(extra.ranges)}</p>` : ''}
      ${bonus ? `<div class="bonus">
        <div><strong>Optionnel : avancer aussi aujourd'hui</strong>
          <span class="muted small">Faites d'abord l'examen. Leçon suivante : ${esc(Q.describeAll(bonus.ranges))} · ${Q.pagesOf(bonus.ranges)}</span></div>
        <div class="actions">
          <button class="btn sm ghost" data-act="open-ranges" data-ranges='${JSON.stringify(bonus.ranges)}' data-title="Leçon bonus du week-end">L'étudier dans l'Atelier</button>
          <button class="btn sm primary" data-act="validate-more">+ Valider cette leçon</button>
          ${extra ? '<button class="btn sm ghost" data-act="undo-lesson">Annuler la dernière</button>' : ''}
        </div>
      </div>` : ''}
    </section>`;
  }
  const l = info.lesson;
  const notes = Engine.notesIn(S, l.ranges);
  if (info.validated) {
    const next = proj.schedule[0];
    const bonus = info.next;
    return `<section class="hero done">${date}
      <p class="eyebrow">${l.count > 1 ? `${l.count} leçons validées aujourd'hui` : 'Leçon validée'} · ${doneCount} / ${total}</p>
      <h1>${ICON.check} Apprentissage du jour validé</h1>
      <p class="lead">Vous avez mémorisé ${objective(l.ranges)}. Barak Allahu fik.</p>
      <div class="chips">${lessonMeta(l.ranges)}</div>
      ${bonus ? `<div class="bonus">
        <div><strong>Vous avez de l'élan ? Continuez.</strong>
          <span class="muted small">Leçon suivante : ${esc(Q.describeAll(bonus.ranges))} · ${Q.pagesOf(bonus.ranges)}</span></div>
        <div class="actions">
          <button class="btn sm ghost" data-act="open-ranges" data-ranges='${JSON.stringify(bonus.ranges)}' data-title="Leçon suivante (bonus)">L'étudier dans l'Atelier</button>
          <button class="btn sm primary" data-act="validate-more">+ Valider aussi cette leçon</button>
        </div>
      </div>` : ''}
      ${next ? `<p class="muted">Prochaine leçon : <b>${esc(Dt.human(next.date))}</b> — ${esc(Q.describeAll(next.lesson.ranges))}</p>` : ''}
      <div class="actions">
        <button class="btn" data-act="open-ranges" data-ranges='${JSON.stringify(l.ranges)}' data-title="Leçons du jour">Réécouter dans l'Atelier</button>
        <button class="btn ghost" data-act="undo-lesson">${l.count > 1 ? 'Annuler la dernière validation' : 'Annuler la validation'}</button>
      </div>
    </section>`;
  }
  return `<section class="hero">${date}
    <p class="eyebrow">Nouvelle mémorisation · leçon ${doneCount + 1} / ${total}</p>
    <h1>Aujourd'hui : mémoriser ${objective(l.ranges)}</h1>
    <div class="chips">${lessonMeta(l.ranges)}</div>
    ${notes.length ? `<p class="alert">${ICON.flag} ${plural(notes.length, 'note', 'notes')} sur ce passage : ${notes.map((n) => `<a href="#notes" data-act="goto-note" data-v="${n.v}">${Q.key(n.v)}</a>`).join(', ')}</p>` : ''}
    <div class="actions">
      <button class="btn" data-act="open-lesson">Ouvrir dans l'Atelier</button>
      <button class="btn primary big" data-act="validate">${ICON.check} Valider l'apprentissage du jour</button>
    </div>
  </section>`;
}

function renderStats(c) {
  const { stats, proj } = c;
  let delta = '';
  if (S.baseline?.end && proj.end) {
    const d = Dt.diff(S.baseline.end, proj.end);
    delta = d > 0 ? `<span class="neg">${plural(d, 'jour', 'jours')} de retard</span>` : d < 0 ? `<span class="pos">${plural(-d, 'jour', 'jours')} d'avance</span>` : '<span class="pos">dans les temps</span>';
  }
  return `<section class="stats" aria-label="Progression">
    <div class="stat ring-stat">${ring(stats.ratio)}<div><strong>${pct(stats.ratio)}</strong><span>du Coran mémorisé</span></div></div>
    <div class="stat"><strong>${stats.pagesEq.toFixed(1).replace('.', ',')}<small> / 604</small></strong><span>pages</span></div>
    <div class="stat"><strong>${stats.rubsDone}<small> / 240</small></strong><span>Rub' complets · ${stats.juzDone} Juz'</span></div>
    <div class="stat"><strong>${stats.streak} 🔥</strong><span>jours consécutifs · record ${stats.best}</span></div>
    <div class="stat"><strong>${proj.end ? Dt.short(proj.end) : '—'}</strong><span>fin projetée ${delta ? '· ' + delta : ''}</span></div>
  </section>`;
}

function renderQarib(items) {
  const done = items.filter((i) => i.done).length;
  return `<section class="card">
    <header class="card-h"><div><h2>Qarib <span class="ar">قريب</span></h2><p class="muted small">Révision proche obligatoire : tout ce qui a été appris ces 7 derniers jours.</p></div>
      <span class="count ${items.length && done === items.length ? 'ok' : ''}">${done}/${items.length}</span></header>
    ${items.length ? `<ul class="list">${items.map((it) => `
      <li class="item ${it.done ? 'is-done' : ''}">
        <label class="check"><input type="checkbox" data-act="qarib" data-id="${it.id}" ${it.done ? 'checked' : ''}><span></span></label>
        <div class="item-body"><strong>${esc(it.title)}</strong><span class="muted small">${esc(it.sub)}</span></div>
        <button class="btn sm ghost" data-act="open-ranges" data-ranges='${JSON.stringify(it.ranges)}' data-title="Qarib">Ouvrir</button>
      </li>`).join('')}</ul>` : '<p class="empty">Rien à revoir pour l\'instant : le Qarib se remplit dès votre première leçon validée.</p>'}
    ${items.length > 1 ? `<div class="card-f"><button class="btn sm" data-act="open-ranges" data-ranges='${JSON.stringify(Engine.mergeChrono(items.flatMap((i) => i.ranges)))}' data-title="Qarib — 7 derniers jours" data-mask="all">Tout réciter d'une traite (texte masqué)</button></div>` : ''}
  </section>`;
}

function renderBaid(b, isReviewDay) {
  const nextDue = Object.values(S.rubs).map((rs) => rs.due).filter((d) => d > TODAY).sort()[0];
  return `<section class="card">
    <header class="card-h"><div><h2>Ba'id <span class="ar">بعيد</span></h2><p class="muted small">Révision lointaine espacée${isReviewDay ? ' (hors Rub\' de l\'examen)' : ''} · charge du jour : ${b.cap} Rub'</p></div>
      <span class="count ${b.pending.length === 0 && b.done.length ? 'ok' : ''}">${b.done.length}/${b.done.length + b.pending.length}</span></header>
    ${b.pending.length || b.done.length ? `<ul class="list">
      ${b.pending.map(({ r, rs, overdue }) => `
        <li class="item">
          <div class="item-body"><strong>Rub' ${r} ${boxBadge(rs)}</strong>
            <span class="muted small">${esc(Q.describe(Q.rubRange[r]))} · ${Q.pagesOf([Q.rubRange[r]])}${overdue > 0 ? ` · <span class="neg">${overdue} j de retard</span>` : ''}</span>
            ${gradeButtons(r, 'baid')}</div>
          <button class="btn sm ghost" data-act="open-rub" data-r="${r}">Ouvrir</button>
        </li>`).join('')}
      ${b.done.map(({ r, rs, grade }) => `
        <li class="item is-done">
          <div class="item-body"><strong>Rub' ${r} <span class="badge g${grade}">${Engine.GRADES[grade].label}</span></strong>
            <span class="muted small">Revient le ${esc(Dt.short(rs.due))} · ${Engine.BOX_NAMES[rs.box]}</span>
            <details class="regrade"><summary>Modifier</summary>${gradeButtons(r, 'baid', grade)}</details></div>
        </li>`).join('')}
    </ul>` : `<p class="empty">Aucun Rub' à échéance aujourd'hui.${nextDue ? ` Prochaine échéance : ${esc(Dt.short(nextDue))}.` : ''}</p>`}
    <div class="card-f">
      ${b.backlog > 0 ? `<span class="muted small">+ ${b.backlog} en attente (reportés)</span>` : '<span></span>'}
      ${b.backlog > 0 ? '<button class="btn sm" data-act="more-baid">Réviser 2 Rub\' de plus</button>' : ''}
    </div>
  </section>`;
}

function renderExam(items) {
  const graded = items.filter((i) => i.grade);
  const all = Engine.mergeChrono(items.flatMap((i) => i.ranges));
  const avg = graded.length ? graded.reduce((s, i) => s + i.grade, 0) / graded.length : 0;
  return `<section class="card exam-card">
    <header class="card-h"><div><h2>Grand Examen <span class="ar">الاختبار</span></h2>
      <p class="muted small">${items.length ? `${plural(items.length, 'Rub\'', 'Rub\'')} travaillés ces 30 derniers jours · ${Q.pagesOf(all)} · à réciter d'une seule traite` : ''}</p></div>
      <span class="count ${items.length && graded.length === items.length ? 'ok' : ''}">${graded.length}/${items.length}</span></header>
    ${items.length ? `
      <div class="actions"><button class="btn primary" data-act="open-ranges" data-ranges='${JSON.stringify(all)}' data-title="Grand Examen" data-mask="all">Commencer la récitation continue (texte masqué)</button></div>
      ${graded.length === items.length ? `<p class="alert ok">${ICON.check} Examen terminé — moyenne ${avg.toFixed(1).replace('.', ',')} / 4. ${avg >= 3.5 ? 'Excellent ancrage.' : avg >= 2.5 ? 'Bon travail : les Rub\' fragiles reviendront plus vite.' : 'Les Rub\' fragiles ont été replacés en révision rapprochée.'}</p>` : ''}
      <ul class="list">${items.map(({ r, rs, ranges, grade }) => `
        <li class="item ${grade ? 'is-done' : ''}">
          <div class="item-body"><strong>Rub' ${r} ${rs ? boxBadge(rs) : '<span class="badge">partiel</span>'}</strong>
            <span class="muted small">${esc(Q.describeAll(ranges))} · ${Q.pagesOf(ranges)}</span>
            ${gradeButtons(r, 'exam', grade)}</div>
          <button class="btn sm ghost" data-act="open-ranges" data-ranges='${JSON.stringify(ranges)}' data-title="${esc(Q.rubLabel(r))}">Ouvrir</button>
        </li>`).join('')}</ul>`
      : '<p class="empty">Aucun Rub\' appris ces 30 derniers jours : profitez-en pour avancer le Ba\'id.</p>'}
  </section>`;
}

function renderNotesCard(rangesToday) {
  const alerts = Engine.notesIn(S, rangesToday);
  const todays = S.notes.filter((n) => n.date === TODAY);
  const shown = [...new Map([...alerts, ...todays].map((n) => [n.id, n])).values()];
  return `<section class="card">
    <header class="card-h"><div><h2>Notes &amp; Alertes</h2><p class="muted small">Marquez les Mutashabihat et passages délicats rencontrés aujourd'hui.</p></div>
      <span class="count">${shown.length}</span></header>
    <form class="quick-note" data-form="quick-note">
      <input name="vk" placeholder="2:48" required pattern="\\d{1,3}:\\d{1,3}" aria-label="Verset">
      <select name="type" aria-label="Type">${Object.entries(NOTE_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <input name="text" placeholder="Ex. : ressemble à 2:123 (ordre inversé)" aria-label="Note">
      <button class="btn sm primary">Ajouter</button>
    </form>
    ${shown.length ? `<ul class="list">${shown.map(noteItem).join('')}</ul>` : '<p class="empty">Aucune alerte pour vos passages du jour.</p>'}
    <div class="card-f"><a href="#notes" class="small">Toutes les notes (${S.notes.length}) →</a></div>
  </section>`;
}

function noteItem(n, full = false) {
  const links = (n.link || '').split(/[ ,;]+/).map(Q.index).filter((i) => i >= 0);
  return `<li class="item note ${n.resolved ? 'is-done' : ''}">
    <div class="item-body">
      <strong><span class="badge t-${n.type}">${NOTE_TYPES[n.type] || n.type}</span> ${Q.key(n.v)} · ${esc(Q.label(n.v))}</strong>
      ${n.text ? `<span>${esc(n.text)}</span>` : ''}
      ${full ? `<p class="ar-quote" lang="ar" dir="rtl">${esc(Q.text(n.v))} <span class="num">﴿${arNum(Q.ayahOf[n.v])}﴾</span></p>
        ${links.map((i) => `<p class="ar-quote twin" lang="ar" dir="rtl"><span class="muted small" dir="ltr">${Q.key(i)}</span> ${esc(Q.text(i))}</p>`).join('')}`
        : links.length ? `<span class="muted small">Similaire à ${links.map(Q.key).join(', ')}</span>` : ''}
    </div>
    <div class="item-actions">
      <button class="btn sm ghost" data-act="open-verse" data-v="${n.v}">Voir</button>
      ${full ? `<button class="btn sm ghost" data-act="edit-note" data-id="${n.id}">Modifier</button>
      <button class="btn sm ghost" data-act="resolve-note" data-id="${n.id}">${n.resolved ? 'Rouvrir' : 'Résolue'}</button>
      <button class="btn sm ghost danger" data-act="delete-note" data-id="${n.id}">Supprimer</button>` : ''}
    </div>
  </li>`;
}

function renderToday() {
  const c = computeCtx();
  const isReview = c.info.kind === 'review';
  const exam = isReview ? Engine.examItems(S, TODAY) : [];
  const baid = Engine.baidItems(S, TODAY, new Set(exam.map((e) => e.r)));
  const qarib = isReview ? [] : Engine.qaribItems(S, TODAY);
  const rangesToday = [
    ...(c.info.lesson ? c.info.lesson.ranges : []),
    ...qarib.flatMap((q) => q.ranges),
    ...baid.pending.map((b) => Q.rubRange[b.r]),
    ...exam.flatMap((e) => e.ranges),
  ];
  return `${renderHero(c)}${renderStats(c)}
    ${isReview ? renderExam(exam) : ''}
    <div class="cards">
      ${isReview ? '' : renderQarib(qarib)}
      ${renderBaid(baid, isReview)}
      ${renderNotesCard(rangesToday)}
    </div>`;
}

/* ---------- Vue : Atelier ---------- */

function defaultPassage() {
  const c = computeCtx();
  if (c.info.lesson) return { ranges: c.info.lesson.ranges, title: c.info.validated ? 'Leçon du jour (validée)' : 'Leçon du jour' };
  if (c.info.kind === 'review') {
    const ex = Engine.examItems(S, TODAY);
    if (ex.length) return { ranges: Engine.mergeChrono(ex.flatMap((e) => e.ranges)), title: 'Grand Examen', mask: 'all' };
  }
  if (c.remaining.length) return { ranges: c.remaining[0].ranges, title: 'Prochaine leçon' };
  return { ranges: [Q.pageRange[1]], title: 'Page 1' };
}

function openPassage(ranges, title, mask = 'none') {
  atelier.ranges = ranges;
  atelier.title = title;
  atelier.sub = `${Q.describeAll(ranges)} · ${Q.pagesOf(ranges)}`;
  atelier.mask = mask;
  atelier.revealed = new Set();
  atelier.marks = new Map();
  atelier.playingV = null;
  atelier.tafsirRub = null;
  Player.load(ranges, playerOpts());
  if (location.hash !== '#atelier') location.hash = '#atelier';
  else render();
  window.scrollTo({ top: 0 });
}

const playerOpts = () => ({ reciter: S.ui.reciter, mode: S.ui.mode, repeat: S.ui.repeat, loops: S.ui.loops, gap: S.ui.gap, rate: S.ui.rate });

function verseHTML(v) {
  const words = Q.text(v).split(/\s+/).filter(Boolean).map((w) => `<span class="w">${esc(w)}</span>`).join(' ');
  const hasNote = S.notes.some((n) => n.v === v && !n.resolved);
  const masked = !atelier.voice && atelier.mask !== 'none' && !atelier.revealed.has(v);
  const mark = atelier.marks.get(v);
  return `<span class="v${masked ? ' masked' : ''}${atelier.mask === 'first' ? ' first' : ''}${hasNote ? ' has-note' : ''}${mark ? ' mark-' + mark : ''}${atelier.playingV === v ? ' playing' : ''}" data-v="${v}" tabindex="0">${words} <span class="num">﴿${arNum(Q.ayahOf[v])}﴾</span></span> `;
}

function passageHTML(ranges) {
  let html = '';
  let page = null;
  for (const [a, b] of ranges) {
    if (html) html += '<div class="gap-sep">…</div>';
    for (let v = a; v <= b; v++) {
      const p = Q.page(v);
      if (p !== page) {
        if (page !== null || v === a) html += `<div class="page-sep"><span>صفحة ${arNum(p)} · page ${p} · Rub' ${Q.rub(v)}</span></div>`;
        page = p;
      }
      if (Q.ayahOf[v] === 1) {
        const s = Q.surahOf[v];
        html += `<div class="surah-head"><span class="ar">سُورَةُ ${esc(Q.surahAr(s))}</span><small>${esc(Q.surahName(s))} · ${esc(Q.surahFr(s))} · ${Q.ayahCount(s)} versets</small></div>`;
        if (s !== 1 && s !== 9) html += '<div class="basmala">بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ</div>';
      }
      html += verseHTML(v);
    }
  }
  return html;
}

function tallyHTML() {
  const ok = [...atelier.marks.values()].filter((m) => m === 'ok').length;
  const err = atelier.marks.size - ok;
  if (!atelier.marks.size) return '<span class="muted small">Auto-correction : cliquez un verset masqué pour le révéler, puis marquez-le Juste ou Erreur.</span>';
  const total = atelier.ranges ? Q.verseCount(atelier.ranges) : 1;
  const g = err === 0 ? 4 : err <= 2 ? 3 : err / total > 0.4 ? 1 : 2;
  return `<span class="tally"><b class="pos">✓ ${ok}</b> <b class="neg">✗ ${err}</b> → note suggérée : <span class="badge g${g}">${Engine.GRADES[g].label}</span></span>
    <button class="btn sm ghost" data-act="reset-marks">Réinitialiser</button>`;
}

function renderAtelier() {
  if (!atelier.ranges) {
    const d = defaultPassage();
    atelier.ranges = d.ranges; atelier.title = d.title; atelier.mask = d.mask || 'none';
    atelier.sub = `${Q.describeAll(d.ranges)} · ${Q.pagesOf(d.ranges)}`;
    Player.load(d.ranges, playerOpts());
  }
  const surahOpts = Q.D.surahs.map((s, i) => `<option value="${i + 1}">${i + 1}. ${esc(s[1])}</option>`).join('');
  return `
  <section class="atelier">
    <header class="atelier-h">
      <div>
        <p class="eyebrow">Atelier de mémorisation</p>
        <h1>${esc(atelier.title)}</h1>
        <p class="muted">${esc(atelier.sub)}</p>
      </div>
      <form class="picker" data-form="pick">
        <select name="type" aria-label="Type de passage">
          <option value="lesson">Leçon du jour</option>
          <option value="rub">Rub'</option>
          <option value="page">Page</option>
          <option value="surah">Sourate</option>
          <option value="juz">Juz'</option>
        </select>
        <input name="n" type="number" min="1" max="604" value="1" aria-label="Numéro" list="surahList">
        <datalist id="surahList">${surahOpts}</datalist>
        <button class="btn sm">Ouvrir</button>
      </form>
    </header>

    <div class="seg atelier-tabs" role="tablist" aria-label="Mode de l'Atelier">
      <button type="button" role="tab" aria-selected="${atelier.tab === 'text'}" class="${atelier.tab === 'text' ? 'on' : ''}" data-act="atelier-tab" data-tab="text">📖 Mémorisation</button>
      <button type="button" role="tab" aria-selected="${atelier.tab === 'tafsir'}" class="${atelier.tab === 'tafsir' ? 'on' : ''}" data-act="atelier-tab" data-tab="tafsir">🕯 Tafsir &amp; Méditation</button>
    </div>
    ${atelier.tab === 'tafsir' ? renderTafsir() : `
    <div class="toolbar" role="toolbar" aria-label="Outils de masquage">
      <button type="button" class="btn sm ${atelier.voice ? 'primary' : ''}" data-act="voice-toggle" aria-pressed="${atelier.voice}">🎙 Récitation au micro</button>
      <div class="seg tools" ${atelier.voice ? 'hidden' : ''}>
        <button type="button" data-act="mask" data-mode="none" class="${atelier.mask === 'none' ? 'on' : ''}">Tout afficher</button>
        <button type="button" data-act="mask" data-mode="all" class="${atelier.mask === 'all' ? 'on' : ''}">Masquer tout</button>
        <button type="button" data-act="mask" data-mode="first" class="${atelier.mask === 'first' ? 'on' : ''}">1er mot seulement</button>
      </div>
      <button type="button" class="btn sm" data-act="reveal-next" ${atelier.mask === 'none' || atelier.voice ? 'hidden' : ''}>Révéler le suivant <kbd>R</kbd></button>
      <div class="font-tools">
        <select data-change="font" aria-label="Police arabe">
          ${['Amiri Quran', 'Scheherazade New', 'Amiri'].map((f) => `<option ${S.ui.font === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
        <button type="button" class="btn sm ghost" data-act="font-size" data-d="-2" aria-label="Réduire le texte">A−</button>
        <button type="button" class="btn sm ghost" data-act="font-size" data-d="2" aria-label="Agrandir le texte">A+</button>
      </div>
    </div>
    ${atelier.voice ? Voice.panelHTML() : `<div class="tally-row" id="tally">${tallyHTML()}</div>`}

    <article class="mushaf${atelier.voice ? ' voice-mode' : ''}" id="mushafText" dir="rtl" lang="ar" style="--qfont:'${S.ui.font}';--qsize:${S.ui.fontSize}px">
      ${passageHTML(atelier.ranges)}
    </article>
    <p class="muted small center">Raccourcis : <kbd>Espace</kbd> ${atelier.voice ? 'micro marche/arrêt · <kbd>H</kbd> mot suivant' : 'lecture/pause'} · <kbd>M</kbd> masquer/afficher · <kbd>R</kbd> révéler le suivant · <kbd>←</kbd>/<kbd>→</kbd> verset suivant/précédent</p>`}
  </section>`;
}

/* ---------- Atelier : Tafsir & Méditation (fiches par Rub') ---------- */

function renderTafsir() {
  const rubs = Q.rubsOf(atelier.ranges);
  if (!rubs.includes(atelier.tafsirRub)) atelier.tafsirRub = rubs[0];
  const r = atelier.tafsirRub;
  const e = Tafsir.get(r);
  const range = Q.rubRange[r];
  const med = S.meditations[r];
  const status = e
    ? `Fiche ${Tafsir.isImported(r) ? 'importée' : 'livrée (data/tafsir.js)'}${e.importedAt ? ` le ${esc(Dt.short(e.importedAt.slice(0, 10)))}` : ''}${e.sources?.length ? ` · ${esc(e.sources.join(', '))}` : ''}`
    : 'Aucune fiche pour ce Rub\'';
  return `<div class="tafsir">
    <div class="card tafsir-head">
      ${rubs.length > 1 ? `<div class="seg rub-tabs" role="tablist" aria-label="Rub' du passage">${rubs.map((x) => `
        <button type="button" role="tab" aria-selected="${x === r}" class="${x === r ? 'on' : ''}" data-act="tafsir-rub" data-r="${x}">Rub' ${x}${Tafsir.has(x) ? ' <i class="dot" aria-label="fiche disponible"></i>' : ''}</button>`).join('')}
      </div>` : ''}
      <div class="tafsir-id">
        <div>
          <p class="eyebrow">Rub' ${r} · Hizb ${Q.hizbOfRub(r)} · Juz' ${Q.juzOfRub(r)}</p>
          <h2>${esc(Q.describe(range))}</h2>
          <p class="muted small">${Q.pagesOf([range])} · ${plural(Q.verseCount([range]), 'verset', 'versets')} · ${status}</p>
        </div>
        <button type="button" class="btn primary magic" data-act="tafsir-prompt">🎯 Générer le prompt d'extraction IA pour ce Rub'</button>
      </div>
      <details class="tafsir-intake" ${e ? '' : 'open'}>
        <summary>Intégrer la réponse de votre Claude Project</summary>
        <ol class="steps muted small">
          <li>Cliquez sur 🎯 : le prompt (sourate, versets exacts, texte arabe, format JSON attendu) est copié.</li>
          <li>Collez-le dans votre Claude Project contenant vos PDF (Ibn Ashur, Al-Jalalayn, Ibn Sa'di…).</li>
          <li>Collez la réponse JSON ci-dessous, ou importez un fichier tafsir.json (une ou plusieurs fiches).</li>
        </ol>
        <form data-form="tafsir-import" class="tafsir-form">
          <textarea name="json" rows="5" spellcheck="false" placeholder='{ "rub": ${r}, "context": [ … ], "tradition": [ … ], "language": [ … ], "tazkiya": [ … ] }' aria-label="Réponse JSON"></textarea>
          <div class="actions">
            <button class="btn sm primary">Intégrer la fiche</button>
            <label class="btn sm">Importer tafsir.json<input type="file" accept="application/json,.json" data-change="tafsir-file" hidden></label>
            <button type="button" class="btn sm ghost" data-act="tafsir-export" data-format="json" ${Tafsir.count() ? '' : 'disabled'}>Exporter (${Tafsir.count()})</button>
            <button type="button" class="btn sm ghost" data-act="tafsir-export" data-format="js" ${Tafsir.count() ? '' : 'disabled'} title="Fichier à déposer dans data/ pour livrer vos fiches avec l'application">Exporter en data/tafsir.js</button>
            ${Tafsir.isImported(r) ? '<button type="button" class="btn sm ghost danger" data-act="tafsir-clear">Effacer cette fiche</button>' : ''}
          </div>
        </form>
      </details>
    </div>
    <div class="tafsir-grid">
      ${Tafsir.cardsHTML(e)}
      <section class="tcard t-med" aria-labelledby="tc-med">
        <header class="tcard-h">
          <span class="t-icon" aria-hidden="true">📝</span>
          <div><h3 id="tc-med">Mes méditations <span class="ar">تدبّر</span></h3>
            <p class="muted small">Vos réflexions sur le Rub' ${r}, enregistrées automatiquement sur cet appareil et incluses dans l'export de sauvegarde.</p></div>
        </header>
        <textarea class="med-text" rows="7" data-change="meditation" data-r="${r}" placeholder="Ce que ces versets me disent aujourd'hui, une résolution, un lien avec un autre passage…">${esc(med?.text || '')}</textarea>
        <p class="muted small" id="medStatus">${med ? `Dernière modification : ${esc(Dt.short(med.updated))}` : ''}</p>
      </section>
    </div>
  </div>`;
}

/* Copie dans le presse-papier ; repli sur la sélection manuelle si l'API est refusée. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* repli ci-dessous */ }
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

/* Hydrate l'interface à partir d'un JSON (texte collé ou fichier tafsir.json). */
async function importTafsir(text, fallbackRub) {
  try {
    const list = Tafsir.parse(text, fallbackRub);
    const persisted = await Tafsir.put(list);
    if (list.length === 1) atelier.tafsirRub = Q.rubsOf(atelier.ranges).includes(list[0].rub) ? list[0].rub : atelier.tafsirRub;
    render();
    const which = list.length === 1 ? `Fiche du Rub' ${list[0].rub} intégrée` : `${list.length} fiches intégrées (Rub' ${list.map((e) => e.rub).join(', ')})`;
    toast(persisted ? `${which}.` : `${which}, mais ce navigateur ne permet pas de la conserver : exportez-la.`, persisted ? 'ok' : 'error', 5000);
    if (list.length === 1 && !Q.rubsOf(atelier.ranges).includes(list[0].rub)) toast(`Ouvrez le Rub' ${list[0].rub} pour l'afficher.`, 'info', 5000);
    return true;
  } catch (err) {
    toast(err.message, 'error', 6000);
    return false;
  }
}

function refreshVerse(v) {
  const el = document.querySelector(`.v[data-v="${v}"]`);
  if (el) el.outerHTML = verseHTML(v);
  const t = document.getElementById('tally');
  if (t) t.innerHTML = tallyHTML();
  mountVoice();
}

/* Rattache la récitation au micro au texte affiché (ou la coupe hors de l'Atelier). */
function mountVoice() {
  const el = document.getElementById('mushafText');
  if (route === 'atelier' && atelier.voice && el) Voice.mount(el, JSON.stringify(atelier.ranges));
  else Voice.unmount();
}

function openVerseMenu(v, anchor) {
  const menu = document.getElementById('verseMenu');
  const masked = atelier.mask !== 'none' && !atelier.revealed.has(v);
  atelier.menuV = v;
  menu.innerHTML = `
    <div class="vm-title">${Q.key(v)} · ${esc(Q.label(v))} · p. ${Q.page(v)}</div>
    ${Q.fr(v) ? `<p class="vm-fr" lang="fr">${esc(Q.fr(v))}</p>` : ''}
    ${atelier.voice ? '<button data-act="vm-voice-jump">🎙 Reprendre la récitation ici</button>' : ''}
    <button data-act="vm-play">${ICON.play} Écouter à partir d'ici</button>
    ${atelier.mask !== 'none' && !atelier.voice ? `<button data-act="vm-toggle">${masked ? 'Révéler' : 'Masquer'} ce verset</button>
    <div class="vm-row"><button data-act="vm-mark" data-m="ok" class="pos">✓ Juste</button><button data-act="vm-mark" data-m="err" class="neg">✗ Erreur</button></div>` : ''}
    <button data-act="vm-note">${ICON.flag} Ajouter une note / Mutashabih</button>`;
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = clamp(r.left + r.width / 2 - mw / 2, 8, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 90) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
const closeVerseMenu = () => { document.getElementById('verseMenu').hidden = true; atelier.menuV = null; };

/* ---------- Notation d'une récitation au micro (alimente le Ba'id) ---------- */

/* Rub' concernés par le passage récité : seuls les Rub' déjà mémorisés peuvent recevoir une note ;
   ils sont cochés d'office si la récitation en couvre au moins la moitié. */
function recitationRubs(ranges) {
  return Q.rubsOf(ranges).map((r) => {
    const [a, b] = Q.rubRange[r];
    let covered = 0;
    for (const [x, y] of ranges) covered += Math.max(0, Math.min(b, y) - Math.max(a, x) + 1);
    const coverage = covered / (b - a + 1);
    return { r, coverage, memorized: !!S.rubs[r], checked: !!S.rubs[r] && coverage >= 0.5 };
  });
}

function openRecitationGrade(rec) {
  const dlg = document.getElementById('gradeDialog');
  const rubs = recitationRubs(rec.ranges);
  const any = rubs.some((x) => x.memorized);
  document.getElementById('gradeBody').innerHTML = `
    <p class="muted">${esc(rec.title)} · ${esc(Q.describeAll(rec.ranges))}</p>
    <p class="vp-status"><span><b>${rec.total}</b> mots · <span class="${rec.hints ? 'warn' : 'pos'}">${plural(rec.hints, 'aide', 'aides')}</span> · <span class="${rec.miss ? 'neg' : 'pos'}">${plural(rec.miss, 'mot non détecté', 'mots non détectés')}</span></span>
      <span>Note suggérée : <span class="badge g${rec.grade}">${Engine.GRADES[rec.grade].label}</span></span></p>
    <fieldset class="rub-pick"><legend>Rub' à noter dans le Ba'id</legend>
      ${rubs.map(({ r, coverage, memorized, checked }) => `
        <label class="inline ${memorized ? '' : 'muted'}"><input type="checkbox" name="rub" value="${r}" ${checked ? 'checked' : ''} ${memorized ? '' : 'disabled'}>
          Rub' ${r} <span class="small">· ${Math.round(coverage * 100)} % récité${memorized ? ` · ${Engine.BOX_NAMES[S.rubs[r].box]}, revient le ${Dt.short(S.rubs[r].due)}` : ' · pas encore mémorisé'}</span></label>`).join('')}
      ${any ? '' : '<p class="small muted">Aucun de ces Rub\' n\'est encore validé : la note sera seulement ajoutée à l\'historique.</p>'}
    </fieldset>`;
  dlg.querySelectorAll('.grades button').forEach((b) => b.classList.toggle('suggested', +b.value === rec.grade));
  if (!dlg.open) dlg.showModal();
  dlg.querySelector(`.grades button[value="${rec.grade}"]`)?.focus();
}

document.getElementById('gradeForm').addEventListener('submit', (e) => {
  const g = +e.submitter?.value;
  const rec = atelier.lastRecitation;
  if (!rec || !(g >= 1 && g <= 4)) return;
  const rubs = [...e.target.querySelectorAll('input[name="rub"]:checked')].map((i) => +i.value);
  rubs.forEach((r) => Engine.grade(S, r, g, TODAY, 'voice'));
  S.recitations.push({ date: TODAY, ranges: rec.ranges, grade: g, hints: rec.hints, miss: rec.miss, words: rec.total, rubs });
  if (S.recitations.length > 300) S.recitations.splice(0, S.recitations.length - 300);
  Engine.markActive(S, TODAY);
  save();
  const next = rubs.map((r) => `Rub' ${r} → ${Dt.short(S.rubs[r].due)}`).join(' · ');
  toast(rubs.length ? `${Engine.GRADES[g].label} enregistré · ${next}` : `Récitation enregistrée (${Engine.GRADES[g].label}).`, g >= 3 ? 'ok' : 'info', 5000);
});

/* ---------- Barre audio ---------- */

function renderAudiobar() {
  const bar = document.getElementById('audiobar');
  const show = !!S.settings && ((route === 'atelier' && !atelier.voice) || Player.playing);
  bar.hidden = !show;
  document.body.classList.toggle('has-audiobar', show);
  if (!show || bar.dataset.ready) return;
  const u = S.ui;
  const sel = (name, options, value) => `<select data-change="audio" data-k="${name}" aria-label="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(value) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  bar.innerHTML = `<div class="ab-inner">
    <div class="ab-main">
      <button class="icon-btn" data-act="ab-prev" aria-label="Verset précédent">${ICON.prev}</button>
      <button class="icon-btn play" data-act="ab-toggle" id="abPlay" aria-label="Lecture">${ICON.play}</button>
      <button class="icon-btn" data-act="ab-next" aria-label="Verset suivant">${ICON.next}</button>
      <div class="ab-info" id="abInfo"><strong>—</strong><span>Prêt</span></div>
    </div>
    <div class="ab-opts">
      ${sel('reciter', Player.RECITERS, u.reciter)}
      ${sel('mode', [['verse', 'Verset par verset'], ['chain', 'Chaînage (ربط)'], ['range', 'Passage entier']], u.mode)}
      ${sel('repeat', [1, 3, 5, 7, 10, 15, 20].map((n) => [n, `${n}× / verset`]), u.repeat)}
      ${sel('loops', [[1, 'Passage 1×'], [2, 'Passage 2×'], [3, 'Passage 3×'], [5, 'Passage 5×'], [0, 'Passage en boucle ∞']], u.loops)}
      ${sel('gap', [['0', 'Sans pause'], ['1', 'Pause 1 s'], ['2', 'Pause 2 s'], ['4', 'Pause 4 s'], ['echo', 'Pause = durée du verset (répéter)']], u.gap)}
      ${sel('rate', [[0.75, 'Vitesse 0,75×'], [1, 'Vitesse 1×'], [1.25, 'Vitesse 1,25×'], [1.5, 'Vitesse 1,5×']], u.rate)}
    </div>
  </div>`;
  bar.dataset.ready = '1';
}

Player.onChange(({ playing, entry, error, waiting, finished }) => {
  const btn = document.getElementById('abPlay');
  if (btn) { btn.innerHTML = playing ? ICON.pause : ICON.play; btn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture'); }
  const info = document.getElementById('abInfo');
  if (info) {
    if (error) info.innerHTML = `<strong>Erreur</strong><span class="neg">${esc(error)}</span>`;
    else if (finished) info.innerHTML = '<strong>Terminé</strong><span>Passage écouté en entier</span>';
    else if (entry) {
      const rep = entry.link ? 'liaison' : `répétition ${entry.k}/${entry.n}`;
      info.innerHTML = `<strong>${Q.key(entry.v)} · ${esc(Q.label(entry.v))}</strong><span>${rep}${+S.ui.loops !== 1 ? ` · tour ${entry.pass}` : ''}${waiting ? ' · à vous…' : ''}</span>`;
    }
  }
  const v = playing && entry ? entry.v : null;
  if (v !== atelier.playingV) {
    document.querySelectorAll('.v.playing').forEach((el) => el.classList.remove('playing'));
    atelier.playingV = v;
    if (v !== null) {
      const el = document.querySelector(`.v[data-v="${v}"]`);
      if (el) { el.classList.add('playing'); if (S.ui.autoscroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  }
  if (!playing && route !== 'atelier') renderAudiobar();
});

/* ---------- Vue : Mushaf ---------- */

function renderMushaf() {
  const bits = Engine.memBits(S);
  const status = Engine.pageStatus(S, bits, TODAY);
  const count = { mastered: 0, review: 0, none: 0 };
  for (let p = 1; p <= 604; p++) count[status[p]]++;
  const STATUS = { mastered: 'Maîtrisé', review: 'À réviser / en consolidation', none: 'Non appris' };
  const c = computeCtx();
  const current = new Set();
  if (c.info.lesson && !c.info.validated) c.info.lesson.ranges.forEach(([a, b]) => { for (let p = Q.page(a); p <= Q.page(b); p++) current.add(p); });
  let rows = '';
  let p = 1;
  for (let j = 1; j <= 30; j++) {
    let cells = '';
    while (p <= 604 && Q.juzOfPage(p) === j) {
      const [a] = Q.pageRange[p];
      cells += `<button class="cell s-${status[p]}${current.has(p) ? ' current' : ''}" data-act="open-page" data-p="${p}" title="Page ${p} · ${esc(Q.label(a))} · Rub' ${Q.rub(a)} · ${STATUS[status[p]]}">${p}</button>`;
      p++;
    }
    rows += `<div class="juz-row"><span class="juz-label">Juz' ${j}</span><div class="cells">${cells}</div></div>`;
  }
  const rubCells = Array.from({ length: 240 }, (_, i) => {
    const r = i + 1, rs = S.rubs[r];
    const cls = rs ? `b${rs.box}${rs.due <= TODAY && !(rs.box === 0) ? ' due' : ''}` : 'b-none';
    const tip = rs ? `Rub' ${r} · ${Engine.BOX_NAMES[rs.box]} · prochaine révision ${Dt.short(rs.due)} · ${rs.reviews} révisions` : `Rub' ${r} · non mémorisé`;
    return `<button class="rcell ${cls}" data-act="open-rub" data-r="${r}" title="${esc(tip)}"></button>`;
  }).join('');
  return `<section>
    <header class="section-h"><p class="eyebrow">Suivi visuel</p><h1>Le Mushaf — 604 pages</h1></header>
    <div class="legend">
      <span><i class="sw s-mastered"></i>Maîtrisé <b>${count.mastered}</b></span>
      <span><i class="sw s-review"></i>À réviser <b>${count.review}</b></span>
      <span><i class="sw s-none"></i>Non appris <b>${count.none}</b></span>
      <span><i class="sw current-sw"></i>Leçon du jour</span>
    </div>
    <p class="muted small">Vert : tous les Rub' de la page ont passé la révision à 2 semaines et ne sont pas échus. Jaune : appris mais en consolidation (Qarib) ou à réviser. Cliquez une page pour l'ouvrir dans l'Atelier.</p>
    <div class="mushaf-grid card">${rows}</div>
    <header class="section-h"><h2>Ancrage des 240 Rub'</h2></header>
    <div class="legend">${Engine.BOX_NAMES.map((n, i) => `<span><i class="sw rb b${i}"></i>${n} (${i === 0 ? 'quotidien' : Engine.INTERVALS[i] + ' j'})</span>`).join('')}<span><i class="sw rb due"></i>Échu</span></div>
    <div class="rub-grid card">${rubCells}</div>
  </section>`;
}

/* ---------- Vue : Planning ---------- */

function renderPlanning() {
  const c = computeCtx();
  const s = S.settings;
  const sched = new Map(c.proj.schedule.map((e) => [e.date, e.lesson]));
  const end = Dt.max(c.proj.end || TODAY, TODAY);
  const months = new Map();
  let missed = 0;
  for (let d = s.startDate; d <= end; d = Dt.add(d, 1)) {
    const study = Engine.isStudyDay(S, d);
    let type, content = '', status = '', cls = '';
    const done = Engine.lessonOn(S, d);
    if (done) {
      type = 'Mémorisation'; content = Q.describeAll(done.ranges) + ' · ' + Q.pagesOf(done.ranges); status = '✓ Validé'; cls = 'done';
    } else if (!study) {
      type = 'Révision'; content = 'Grand Examen + Ba\'id';
      const dd = S.daily[d];
      status = d < TODAY ? (dd && Object.keys(dd.graded).length ? '✓ Fait' : '—') : d === TODAY ? 'Aujourd\'hui' : '';
      cls = 'rev';
    } else if (sched.has(d)) {
      const l = sched.get(d);
      type = 'Mémorisation'; content = Q.describeAll(l.ranges) + ' · ' + Q.pagesOf(l.ranges); status = d === TODAY ? 'Aujourd\'hui' : 'Prévu';
    } else if (d < TODAY) {
      type = 'Mémorisation'; content = 'Aucune leçon validée'; status = 'Manqué'; cls = 'missed'; missed++;
    } else continue;
    const key = d.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(`<tr class="${cls}${d === TODAY ? ' today' : ''}"><td>${esc(Dt.human(d, { weekday: 'short', day: 'numeric', month: 'short' }))}</td><td><span class="badge ${cls === 'rev' ? 'box-3' : 'box-2'}">${type}</span></td><td>${esc(content)}</td><td>${status}</td></tr>`);
  }
  const curMonth = TODAY.slice(0, 7);
  const nextMonth = Dt.add(TODAY, 31).slice(0, 7);
  const delta = S.baseline?.end && c.proj.end ? Dt.diff(S.baseline.end, c.proj.end) : 0;
  return `<section>
    <header class="section-h"><p class="eyebrow">Planning dynamique</p><h1>Calendrier de progression</h1></header>
    <div class="stats">
      <div class="stat"><strong>${esc(Dt.short(s.startDate))}</strong><span>début · ${esc(Engine.ORDERS[s.order]?.label || '')}</span></div>
      <div class="stat"><strong>${s.amount} ${UNIT_LABEL[s.unit]}${s.amount > 1 ? 's' : ''}</strong><span>par jour d'étude · ${s.studyDays.length} j/sem.</span></div>
      <div class="stat"><strong>${c.doneCount} / ${c.doneCount + c.remaining.length}</strong><span>leçons validées</span></div>
      <div class="stat"><strong>${c.proj.end ? esc(Dt.short(c.proj.end)) : '—'}</strong><span>fin projetée ${delta > 0 ? `<span class="neg">(+${delta} j)</span>` : delta < 0 ? `<span class="pos">(${delta} j)</span>` : ''}</span></div>
      <div class="stat"><strong>${missed}</strong><span>jours d'étude manqués</span></div>
    </div>
    <p class="muted small">Le planning se recalcule chaque jour : une journée manquée décale simplement la suite, sans jamais sauter de passage. Prévision initiale : ${S.baseline?.end ? esc(Dt.short(S.baseline.end)) : '—'}.</p>
    ${[...months.entries()].map(([k, rows]) => `
      <details class="month card" ${k === curMonth || k === nextMonth ? 'open' : ''}>
        <summary><span>${esc(Dt.monthLabel(k + '-01'))}</span><span class="muted small">${rows.length} jours</span></summary>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Contenu</th><th>Statut</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
      </details>`).join('')}
  </section>`;
}

/* ---------- Vue : Notes ---------- */

let noteFilter = 'open';
let noteSearch = '';
function renderNotes() {
  const list = S.notes
    .filter((n) => (noteFilter === 'resolved' ? n.resolved : noteFilter === 'open' ? !n.resolved : n.type === noteFilter && !n.resolved))
    .filter((n) => !noteSearch || `${Q.key(n.v)} ${Q.label(n.v)} ${n.text} ${n.link}`.toLowerCase().includes(noteSearch.toLowerCase()))
    .sort((a, b) => a.v - b.v);
  const chips = [['open', 'Ouvertes'], ...Object.entries(NOTE_TYPES), ['resolved', 'Résolues']];
  return `<section>
    <header class="section-h row"><div><p class="eyebrow">Mutashabihat &amp; passages délicats</p><h1>Notes et Alertes</h1></div>
      <button class="btn primary" data-act="new-note">Nouvelle note</button></header>
    <div class="filters">
      <div class="seg">${chips.map(([k, l]) => `<button type="button" data-act="note-filter" data-f="${k}" class="${noteFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <input type="search" placeholder="Rechercher…" value="${esc(noteSearch)}" data-change="note-search" aria-label="Rechercher une note">
    </div>
    ${list.length ? `<ul class="list notes-list">${list.map((n) => noteItem(n, true)).join('')}</ul>` : '<p class="empty card">Aucune note. Dans l\'Atelier, cliquez sur un verset puis « Ajouter une note » pour marquer un Mutashabih : les versets similaires s\'affichent alors côte à côte ici.</p>'}
  </section>`;
}

function openNoteDialog(v = null, note = null) {
  const dlg = document.getElementById('noteDialog');
  const f = document.getElementById('noteForm');
  f.reset();
  dlg.dataset.editId = note ? note.id : '';
  f.vk.value = note ? Q.key(note.v) : v !== null ? Q.key(v) : '';
  if (note) { f.type.value = note.type; f.link.value = note.link || ''; f.text.value = note.text || ''; }
  updateNotePreview();
  closeVerseMenu();
  dlg.showModal();
}
function updateNotePreview() {
  const f = document.getElementById('noteForm');
  const i = Q.index(f.vk.value);
  document.getElementById('notePreview').textContent = i >= 0 ? Q.text(i) : '';
}

function addNote({ vk, type, text, link }) {
  const v = Q.index(vk);
  if (v < 0) { toast('Référence de verset invalide (format sourate:verset).', 'error'); return false; }
  S.notes.push({ id: uid(), v, type, text: text.trim(), link: (link || '').trim(), date: TODAY, resolved: false });
  Engine.markActive(S, TODAY);
  return true;
}

/* ---------- Vue : Réglages ---------- */

function renderSettings() {
  const u = S.ui;
  const surahOpts = (sel) => Q.D.surahs.map((s, i) => `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${i + 1}. ${esc(s[1])}</option>`).join('');
  return `<section>
    <header class="section-h"><p class="eyebrow">Réglages</p><h1>Programme &amp; préférences</h1></header>
    <div class="cards two">
      <div class="card"><h2>Plan de mémorisation</h2>
        <p class="muted small">Modifier le volume ou les jours recalcule uniquement ce qui reste à apprendre ; votre progression est conservée.</p>
        ${planForm(S.settings, false)}</div>
      <div class="stack">
        <div class="card"><h2>Lecture &amp; affichage</h2>
          <label>Récitateur par défaut
            <select data-change="pref" data-k="reciter">${Player.RECITERS.map(([v, l]) => `<option value="${v}" ${u.reciter === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>Police coranique
            <select data-change="pref" data-k="font">${['Amiri Quran', 'Scheherazade New', 'Amiri'].map((f) => `<option ${u.font === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
          <label>Taille du texte : <span id="fsVal">${u.fontSize}px</span>
            <input type="range" min="20" max="56" step="2" value="${u.fontSize}" data-change="pref" data-k="fontSize"></label>
          <label>Thème
            <select data-change="pref" data-k="theme">
              <option value="auto" ${u.theme === 'auto' ? 'selected' : ''}>Automatique (système)</option>
              <option value="light" ${u.theme === 'light' ? 'selected' : ''}>Clair</option>
              <option value="dark" ${u.theme === 'dark' ? 'selected' : ''}>Sombre (nuit / Fajr)</option>
            </select></label>
          <label class="inline"><input type="checkbox" data-change="pref" data-k="autoscroll" ${u.autoscroll ? 'checked' : ''}> Suivre le verset récité (défilement automatique)</label>
        </div>
        <div class="card"><h2>Déjà mémorisé avant le programme</h2>
          <p class="muted small">Ajoutez les sourates que vous connaissez déjà : elles sortent du planning et entrent directement dans la révision Ba'id (échéances étalées sur 14 jours).</p>
          <form class="grid-2" data-form="prior">
            <label>De la sourate<select name="from">${surahOpts(78)}</select></label>
            <label>à la sourate<select name="to">${surahOpts(114)}</select></label>
            <button class="btn">Marquer comme mémorisé</button>
          </form>
        </div>
        <div class="card"><h2>Données</h2>
          <p class="muted small">Tout est sauvegardé automatiquement dans ce navigateur (localStorage). Exportez régulièrement une copie de sécurité.</p>
          <div class="actions">
            <button class="btn" data-act="export">Exporter (.json)</button>
            <label class="btn">Importer<input type="file" accept="application/json,.json" data-change="import" hidden></label>
            <button class="btn ghost danger" data-act="reset">Tout réinitialiser</button>
          </div>
          <p class="muted small">Astuce test : ajoutez <code>?date=2026-10-11</code> à l'adresse pour simuler une autre date.</p>
        </div>
      </div>
    </div>
  </section>`;
}

/* ---------- Rendu & routage ---------- */

function applyTheme() {
  const t = S.ui.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  document.getElementById('themeBtn').innerHTML = t === 'dark' ? ICON.moon : t === 'light' ? ICON.sun : ICON.auto;
}

function render() {
  applyTheme();
  closeVerseMenu();
  const setup = !S.settings;
  document.getElementById('nav').hidden = setup;
  if (setup) {
    view.innerHTML = renderSetup();
  } else {
    const views = { today: renderToday, atelier: renderAtelier, mushaf: renderMushaf, planning: renderPlanning, notes: renderNotes, settings: renderSettings };
    view.innerHTML = (views[route] || renderToday)();
  }
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === route));
  const form = view.querySelector('form[data-form="plan"]');
  if (form) updatePlanPreview(form);
  renderAudiobar();
  mountVoice();
}

function onRoute() {
  const r = location.hash.slice(1) || 'today';
  route = r;
  render();
  view.focus({ preventScroll: true });
}

/* ---------- Actions ---------- */

const actions = {
  validate() {
    const c = computeCtx();
    if (c.info.kind !== 'study' || c.info.validated) return;
    const before = Engine.stats(S, c.bits, TODAY);
    const entry = Engine.validateLesson(S, TODAY, c.info.lesson);
    save();
    const after = Engine.stats(S, Engine.memBits(S), TODAY);
    if (entry.createdRubs.length) toast(`Rub' ${entry.createdRubs.join(', ')} complété${entry.createdRubs.length > 1 ? 's' : ''} : entrée en phase Qarib (7 jours).`, 'ok', 4500);
    if (after.juzDone > before.juzDone) toast(`Juz' complet ! ${after.juzDone} / 30 — Allahumma barik.`, 'ok', 6000);
    else toast(`Leçon validée · ${pct(after.ratio)} du Coran · série : ${after.streak} j`, 'ok');
    render();
  },
  'validate-more'() {
    const c = computeCtx();
    const allowed = (c.info.kind === 'study' && c.info.validated) || c.info.kind === 'review';
    if (!allowed || !c.info.next) return;
    const entry = Engine.validateLesson(S, TODAY, c.info.next);
    save();
    const after = Engine.stats(S, Engine.memBits(S), TODAY);
    if (entry.createdRubs.length) toast(`Rub' ${entry.createdRubs.join(', ')} complété${entry.createdRubs.length > 1 ? 's' : ''} : entrée en phase Qarib (7 jours).`, 'ok', 4500);
    if (after.juzDone > c.stats.juzDone) toast(`Juz' complet ! ${after.juzDone} / 30 — Allahumma barik.`, 'ok', 6000);
    toast(`Leçon supplémentaire validée · ${pct(after.ratio)} du Coran · le planning avance d'un jour d'étude.`, 'ok');
    render();
  },
  'undo-lesson'() {
    if (!confirm("Annuler la dernière leçon validée aujourd'hui ?")) return;
    Engine.undoLesson(S, TODAY);
    commit();
  },
  'open-lesson'() {
    const c = computeCtx();
    if (c.info.lesson) openPassage(c.info.lesson.ranges, 'Leçon du jour');
  },
  'open-ranges'(el) { openPassage(JSON.parse(el.dataset.ranges), el.dataset.title || 'Passage', el.dataset.mask || 'none'); },
  'open-rub'(el) { const r = +el.dataset.r; openPassage([Q.rubRange[r]], Q.rubLabel(r)); },
  'open-page'(el) { const p = +el.dataset.p; openPassage([Q.pageRange[p]], `Page ${p}`); },
  'open-verse'(el) {
    const v = +el.dataset.v;
    openPassage([Q.pageRange[Q.page(v)]], `Page ${Q.page(v)}`);
    setTimeout(() => document.querySelector(`.v[data-v="${v}"]`)?.scrollIntoView({ block: 'center' }), 50);
  },
  'goto-note'(el) { noteFilter = 'open'; noteSearch = Q.key(+el.dataset.v); },
  qarib(el) { Engine.toggleQarib(S, TODAY, el.dataset.id); commit(); },
  grade(el) {
    const r = +el.dataset.r, g = +el.dataset.g;
    Engine.grade(S, r, g, TODAY, el.dataset.ctx);
    const rs = S.rubs[r];
    if (rs) toast(g === 1 ? `Rub' ${r} : retour en apprentissage (Qarib 7 jours).` : `Rub' ${r} · ${Engine.GRADES[g].label} → revient le ${Dt.short(rs.due)}`, g >= 3 ? 'ok' : 'info');
    commit();
  },
  'more-baid'() { Engine.day(S, TODAY).extra += 2; commit(); },
  mask(el) {
    atelier.mask = el.dataset.mode;
    atelier.revealed = new Set();
    render();
  },
  'reveal-next'() {
    if (atelier.mask === 'none') return;
    const el = [...document.querySelectorAll('.v.masked')][0];
    if (!el) { toast('Tous les versets sont révélés.'); return; }
    const v = +el.dataset.v;
    atelier.revealed.add(v);
    refreshVerse(v);
    document.querySelector(`.v[data-v="${v}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
  'reset-marks'() { atelier.marks = new Map(); render(); },
  'font-size'(el) { S.ui.fontSize = clamp(S.ui.fontSize + +el.dataset.d, 18, 60); save(); document.getElementById('mushafText')?.style.setProperty('--qsize', `${S.ui.fontSize}px`); },
  'vm-play'() { const v = atelier.menuV; closeVerseMenu(); Player.playFrom(v); renderAudiobar(); },
  'vm-toggle'() {
    const v = atelier.menuV;
    if (atelier.revealed.has(v)) atelier.revealed.delete(v); else atelier.revealed.add(v);
    closeVerseMenu(); refreshVerse(v);
  },
  'vm-mark'(el) {
    const v = atelier.menuV;
    atelier.marks.set(v, el.dataset.m);
    atelier.revealed.add(v);
    closeVerseMenu(); refreshVerse(v);
  },
  'vm-note'() { openNoteDialog(atelier.menuV); },
  'vm-voice-jump'() { const v = atelier.menuV; closeVerseMenu(); Voice.jumpTo(v); toast(`Reprise au verset ${Q.key(v)}.`); },
  'voice-toggle'() {
    atelier.voice = !atelier.voice;
    if (atelier.voice) Player.pause();
    else Voice.stop();
    render();
  },
  'atelier-tab'(el) {
    atelier.tab = el.dataset.tab;
    S.ui.atelierTab = atelier.tab; save();
    if (atelier.tab === 'tafsir' && atelier.voice) { atelier.voice = false; Voice.stop(); }
    render();
  },
  'tafsir-rub'(el) { atelier.tafsirRub = +el.dataset.r; render(); },
  async 'tafsir-prompt'() {
    const r = atelier.tafsirRub;
    const text = Tafsir.prompt(r);
    if (await copyText(text)) { toast(`Prompt du Rub' ${r} copié : collez-le dans votre Claude Project.`, 'ok', 4500); return; }
    const dlg = document.getElementById('promptDialog');
    dlg.querySelector('textarea').value = text;
    dlg.showModal();
    dlg.querySelector('textarea').select();
  },
  'tafsir-export'(el) {
    const n = Tafsir.exportAll(el.dataset.format);
    toast(el.dataset.format === 'js' ? `${plural(n, 'fiche exportée', 'fiches exportées')} : placez tafsir.js dans le dossier data/ (remplace l'existant).` : `${plural(n, 'fiche exportée', 'fiches exportées')}.`, 'ok', 5000);
  },
  async 'tafsir-clear'() {
    const r = atelier.tafsirRub;
    if (!confirm(`Effacer la fiche importée du Rub' ${r} ? Vos méditations sont conservées.`)) return;
    await Tafsir.remove(r);
    render();
  },
  'voice-close'() { atelier.voice = false; Voice.stop(); render(); },
  'voice-listen'() { Voice.toggle(); },
  'voice-hint'() { Voice.hint(); },
  'voice-restart'() { Voice.restart(); },
  'voice-grade'() { if (atelier.lastRecitation) openRecitationGrade(atelier.lastRecitation); },
  'voice-mode'(el) {
    S.ui.voiceMode = el.dataset.m; save();
    Voice.configure({ mode: S.ui.voiceMode });
    const panel = document.getElementById('voicePanel');
    panel?.querySelectorAll('[data-act="voice-mode"]').forEach((b) => b.classList.toggle('on', b.dataset.m === S.ui.voiceMode));
    const help = panel?.querySelector('.vp-side .muted');
    if (help) help.textContent = S.ui.voiceMode === 'flash' ? "Le texte n'apparaît que pendant que vous le dites, puis s'estompe." : 'Le texte se dévoile définitivement au fil de votre récitation.';
  },
  'ab-toggle'() { Player.toggle(); },
  'ab-prev'() { Player.prev(); },
  'ab-next'() { Player.next(); },
  'new-note'() { openNoteDialog(); },
  'edit-note'(el) { openNoteDialog(null, S.notes.find((n) => n.id === el.dataset.id)); },
  'resolve-note'(el) { const n = S.notes.find((x) => x.id === el.dataset.id); n.resolved = !n.resolved; commit(); },
  'delete-note'(el) { if (confirm('Supprimer cette note ?')) { S.notes = S.notes.filter((n) => n.id !== el.dataset.id); commit(); } },
  'note-filter'(el) { noteFilter = el.dataset.f; render(); },
  export() { Store.exportJSON(S); },
  reset() {
    if (!confirm('Effacer TOUTE la progression, les notes et le planning ?')) return;
    if (!confirm('Dernière confirmation : cette action est irréversible. Pensez à exporter avant.')) return;
    Store.reset(); S = Store.load(); atelier.ranges = null; Player.stop(); location.hash = '#today'; render();
  },
};

document.addEventListener('click', (e) => {
  const verse = e.target.closest('.mushaf .v');
  const actEl = e.target.closest('[data-act]');
  if (actEl) {
    const fn = actions[actEl.dataset.act];
    if (fn) { if (actEl.tagName !== 'A' && actEl.type !== 'checkbox') e.preventDefault(); fn(actEl, e); return; }
  }
  if (verse) {
    const v = +verse.dataset.v;
    if (!atelier.voice && atelier.mask !== 'none' && !atelier.revealed.has(v)) { atelier.revealed.add(v); refreshVerse(v); return; }
    openVerseMenu(v, verse);
    return;
  }
  if (!e.target.closest('#verseMenu')) closeVerseMenu();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const kind = el.dataset.change;
  if (el.closest('form[data-form="plan"]')) {
    const form = el.closest('form');
    if (el.name === 'unit') form.amount.max = el.value === 'rub' ? 8 : 20;
    updatePlanPreview(form);
    return;
  }
  if (kind === 'audio') {
    const k = el.dataset.k;
    S.ui[k] = ['repeat', 'loops', 'rate'].includes(k) ? +el.value : el.value;
    save();
    Player.setOpts(playerOpts());
  } else if (kind === 'voice-lang') {
    S.ui.voiceLang = el.value; save();
    Voice.configure({ lang: el.value });
  } else if (kind === 'font') {
    S.ui.font = el.value; save();
    document.getElementById('mushafText')?.style.setProperty('--qfont', `'${el.value}'`);
  } else if (kind === 'pref') {
    const k = el.dataset.k;
    S.ui[k] = el.type === 'checkbox' ? el.checked : k === 'fontSize' ? +el.value : el.value;
    save();
    if (k === 'reciter') { const bar = document.getElementById('audiobar'); delete bar.dataset.ready; Player.setOpts(playerOpts()); }
    applyTheme();
  } else if (kind === 'tafsir-file') {
    const file = el.files[0];
    if (file) file.text().then((txt) => importTafsir(txt, atelier.tafsirRub));
  } else if (kind === 'import') {
    const file = el.files[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const data = Store.parseImport(txt);
        if (!confirm('Remplacer la progression actuelle par cette sauvegarde ?')) return;
        S = data; atelier.ranges = null; delete document.getElementById('audiobar').dataset.ready;
        commit(); toast('Sauvegarde importée.', 'ok');
      } catch (err) { toast(err.message, 'error'); }
    });
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.closest('form[data-form="plan"]') && el.name === 'amount') updatePlanPreview(el.closest('form'));
  if (el.dataset.change === 'note-search') {
    noteSearch = el.value;
    const pos = el.selectionStart;
    render();
    const input = view.querySelector('[data-change="note-search"]');
    input.focus(); input.setSelectionRange(pos, pos);
  }
  if (el.dataset.k === 'fontSize') { const out = document.getElementById('fsVal'); if (out) out.textContent = `${el.value}px`; }
  if (el.name === 'vk' && el.form?.id === 'noteForm') updateNotePreview();
  if (el.dataset.change === 'meditation') {
    const r = el.dataset.r;
    if (el.value.trim()) S.meditations[r] = { text: el.value, updated: TODAY };
    else delete S.meditations[r];
    clearTimeout(meditationTimer);
    meditationTimer = setTimeout(() => {
      save();
      const st = document.getElementById('medStatus');
      if (st) st.textContent = S.meditations[r] ? '✓ Enregistré' : '';
    }, 500);
  }
});
let meditationTimer = 0;

document.addEventListener('submit', (e) => {
  const form = e.target;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  if (kind === 'plan') {
    const s = readPlanForm(form);
    if (!s.studyDays.length) { toast('Choisissez au moins un jour de mémorisation.', 'error'); return; }
    const first = !S.settings;
    if (!first && !confirm('Recalculer le planning restant avec ces réglages ? Votre progression est conservée.')) return;
    S.settings = s;
    Engine.rebaseline(S, TODAY);
    atelier.ranges = null; // l'Atelier (et le micro) rechargent la leçon attendue par le nouveau parcours
    save();
    toast(first ? 'Programme généré. Bismillah !' : 'Planning recalculé.', 'ok');
    location.hash = '#today';
    render();
  } else if (kind === 'tafsir-import') {
    if (!form.json.value.trim()) { toast('Collez d\'abord la réponse JSON.', 'error'); return; }
    importTafsir(form.json.value, atelier.tafsirRub);
  } else if (kind === 'quick-note') {
    const fd = Object.fromEntries(new FormData(form));
    if (addNote({ ...fd, link: '' })) { commit(); toast('Note ajoutée.', 'ok'); }
  } else if (kind === 'prior') {
    let a = +form.from.value, b = +form.to.value;
    if (a > b) [a, b] = [b, a];
    const n = Engine.markPrior(S, TODAY, a, b);
    Engine.rebaseline(S, TODAY);
    commit();
    toast(`${Q.surahName(a)} → ${Q.surahName(b)} marquées comme mémorisées (${plural(n, 'Rub\' complet', 'Rub\' complets')} en révision).`, 'ok', 5000);
  } else if (kind === 'pick') {
    const type = form.type.value;
    const n = parseInt(form.n.value, 10) || 1;
    if (type === 'lesson') { atelier.ranges = null; openPassage(defaultPassage().ranges, defaultPassage().title); return; }
    const max = { rub: 240, page: 604, surah: 114, juz: 30 }[type];
    const k = clamp(n, 1, max);
    if (type === 'rub') openPassage([Q.rubRange[k]], Q.rubLabel(k));
    if (type === 'page') openPassage([Q.pageRange[k]], `Page ${k}`);
    if (type === 'surah') openPassage([[Q.surahStart[k], Q.surahStart[k] + Q.ayahCount(k) - 1]], `Sourate ${Q.surahName(k)}`);
    if (type === 'juz') openPassage([Q.juzRange(k)], `Juz' ${k}`);
  }
});

document.getElementById('noteForm').addEventListener('submit', (e) => {
  const dlg = document.getElementById('noteDialog');
  if (e.submitter?.value !== 'save') return;
  const fd = Object.fromEntries(new FormData(e.target));
  const editId = dlg.dataset.editId;
  if (editId) {
    const n = S.notes.find((x) => x.id === editId);
    const v = Q.index(fd.vk);
    if (v < 0) { e.preventDefault(); toast('Référence invalide.', 'error'); return; }
    Object.assign(n, { v, type: fd.type, text: fd.text.trim(), link: fd.link.trim() });
  } else if (!addNote(fd)) { e.preventDefault(); return; }
  save();
  if (route === 'atelier' && atelier.ranges) refreshVerse(Q.index(fd.vk)); else render();
  toast('Note enregistrée.', 'ok');
});

document.getElementById('themeBtn').addEventListener('click', () => {
  S.ui.theme = { auto: 'light', light: 'dark', dark: 'auto' }[S.ui.theme] || 'auto';
  save();
  applyTheme();
  toast(`Thème : ${{ auto: 'automatique', light: 'clair', dark: 'sombre' }[S.ui.theme]}`);
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') return closeVerseMenu();
  if (route !== 'atelier' || atelier.tab === 'tafsir') return;
  if (e.key === ' ') { e.preventDefault(); if (atelier.voice) Voice.toggle(); else Player.toggle(); }
  else if (atelier.voice && e.key.toLowerCase() === 'h') Voice.hint();
  else if (e.key === 'ArrowRight') Player.prev(); // texte RTL : la flèche droite recule
  else if (e.key === 'ArrowLeft') Player.next();
  else if (e.key.toLowerCase() === 'm') actions.mask({ dataset: { mode: atelier.mask === 'none' ? 'all' : 'none' } });
  else if (e.key.toLowerCase() === 'r') actions['reveal-next']();
});

window.addEventListener('hashchange', onRoute);
window.addEventListener('scroll', closeVerseMenu, { passive: true });
window.addEventListener('beforeunload', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

Voice.configure({ mode: S.ui.voiceMode || 'anchor', lang: S.ui.voiceLang || 'ar-SA' });
Voice.hooks.onStart = () => Player.pause(); // l'audio du récitateur ne doit pas être capté par le micro
Voice.hooks.onFinish = (r) => { // fin du passage : le micro est coupé, on demande la note d'ancrage
  atelier.lastRecitation = { ...r, ranges: atelier.ranges, title: atelier.title };
  openRecitationGrade(atelier.lastRecitation);
};

onRoute();
// les fiches importées (IndexedDB) arrivent en différé : on rafraîchit l'onglet Tafsir s'il est affiché
Tafsir.ready.then(() => { if (route === 'atelier' && atelier.tab === 'tafsir' && !document.activeElement?.matches('textarea')) render(); });
