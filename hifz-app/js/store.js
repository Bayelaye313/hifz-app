/* Persistance locale (localStorage) avec sauvegarde automatique, export / import JSON. */
'use strict';

const Store = (() => {
  const KEY = 'hifz.state.v1';

  const defaults = () => ({
    version: 1,
    settings: null,      // { startDate, unit, amount, order:'forward'|'backward'|'half2', studyDays, baidCap }
    baseline: null,      // { end, setAt } : date de fin prévue lors de la dernière planification
    lessons: [],         // [{ id, date, ranges:[[a,b]], prior?, createdRubs:[] }]
    rubs: {},            // rub -> { box, due, memorizedAt, first, relearnAt?, reviews, lapses, hist:[[date,grade]] }
    daily: {},           // date -> { qarib:{id:true}, graded:{rub:grade}, ctx:{rub:'baid'|'exam'}, snap:{rub:state}, extra:n }
    notes: [],           // [{ id, v, type, text, link, date, resolved }]
    activity: {},        // date -> true (jour actif, pour la série)
    recitations: [],     // [{ date, ranges, grade, hints, miss, words, rubs:[] }] : récitations au micro notées
    meditations: {},     // rub -> { text, updated } : « Mes méditations » (onglet Tafsir de l'Atelier)
                         // (les fiches de tafsir elles-mêmes, volumineuses, sont dans IndexedDB : voir tafsir.js)
    bestStreak: 0,
    ui: {
      theme: 'auto', reciter: 'Husary_Muallim_128kbps', font: 'Amiri Quran', fontSize: 30,
      mode: 'verse', repeat: 5, loops: 1, gap: '1', rate: 1, autoscroll: true,
    },
  });

  const ORDERS = ['forward', 'backward', 'half2'];

  // Complète une sauvegarde (ancienne version ou import) : parcours absent ou inconnu → ordre standard.
  function normalize(data) {
    const base = defaults();
    const out = { ...base, ...data, ui: { ...base.ui, ...(data.ui || {}) } };
    if (out.settings && !ORDERS.includes(out.settings.order)) out.settings = { ...out.settings, order: 'forward' };
    return out;
  }

  function load() {
    const base = defaults();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return base;
      return normalize(JSON.parse(raw));
    } catch (e) {
      console.error(e);
      return base;
    }
  }

  let lastError = 0;
  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      if (Date.now() - lastError > 10000) { toast('Sauvegarde locale impossible : exportez vos données (Réglages).', 'error', 6000); lastError = Date.now(); }
    }
  }

  function exportJSON(state) {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hifz-sauvegarde-${Dt.today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function parseImport(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.lessons) || typeof data.rubs !== 'object') {
      throw new Error('Fichier de sauvegarde invalide');
    }
    return normalize(data);
  }

  const reset = () => localStorage.removeItem(KEY);

  return { load, save, exportJSON, parseImport, reset, defaults };
})();
