/* Récitation interactive à l'aveugle : le texte est masqué et se dévoile au fil de la récitation au micro.
 *
 * Reconnaissance : Web Speech API (SpeechRecognition / webkitSpeechRecognition), arabe, continue, résultats intermédiaires.
 * Correspondance : texte du Mushaf et transcription passent par la même normalisation (normalizeArabic), puis
 * chaque mot est réduit à un squelette (skeleton). Un pointeur avance sur les mots du passage par correspondance
 * glissante (voir align) : souple sur le mot attendu, stricte et confirmée pour tout saut en avant.
 */
'use strict';

const Voice = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const LANGS = [
    ['ar-SA', 'Arabe — Arabie saoudite'], ['ar-EG', 'Arabe — Égypte'], ['ar-BH', 'Arabe — Bahreïn'],
    ['ar-AE', 'Arabe — Émirats'], ['ar-JO', 'Arabe — Jordanie'], ['ar-MA', 'Arabe — Maroc'],
  ];
  const SILENCE_MS = 5000;
  const FLASH_MS = 2500;
  const LOOKAHEAD = 10;    // recalage : mots devant le pointeur où l'on accepte un saut
  const RESYNC_AFTER = 3;  // mots non reconnus d'affilée avant de chercher plus loin dans le passage
  const BACKTRACK = 12;    // une phrase déjà dite qu'on répète ne doit pas faire avancer
  const CARRY = 3;         // mots non consommés en fin de résultat, réessayés avec le résultat suivant

  /* ---------- Normalisation de l'arabe ---------- */

  /* Normalisation agressive, appliquée au texte du Mushaf ET à la transcription du micro. */
  function normalizeArabic(text) {
    return String(text).normalize('NFC')
      // tashkeel (fatha, damma, kasra, sukun, shadda, tanwin), alif suscrit, signes de pause (ۖ ۗ ۚ ۛ ۘ ۙ ۜ), tatweel
      .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
      .replace(/[ٱأإآ]/g, 'ا') // ٱ أ إ آ → ا
      .replace(/ى/g, 'ي') // ى → ي
      .replace(/ؤ/g, 'و') // ؤ → و
      .replace(/ئ/g, 'ي') // ئ → ي
      .replace(/ء/g, '') // ء
      .replace(/ة/g, 'ه') // ta marbuta ≡ ha final
      .replace(/[^ء-ي\s]/g, '') // ponctuation, chiffres, caractères latins
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Squelette d'un mot pour la comparaison : en plus, sans alif (le rasm Uthmani l'omet souvent :
     ٱلْعَـٰلَمِينَ, ٱلصَّلَوٰةَ) et sans lettres répétées d'un madd prolongé (« الرحيييم »). */
  const skeleton = (word) => normalizeArabic(word).replace(/\s/g, '').replace(/(.)\1{2,}/g, '$1').replace(/ا/g, '');
  const norm = skeleton;

  /* Lettres isolées (Huruf muqatta'at) : la reconnaissance renvoie le NOM des lettres
     (« ألف لام ميم », « حا ميم », « كاف ها يا عين صاد », « نون ») là où le Mushaf écrit الٓمٓ, حمٓ, كٓهيعٓصٓ, نٓ.
     Clés déjà normalisées (normalizeArabic) : راء → را, هاء → ها, etc. */
  const LETTER_NAMES = {
    'الف': 'ا', 'لام': 'ل', 'ميم': 'م', 'را': 'ر', 'صاد': 'ص', 'كاف': 'ك', 'ها': 'ه',
    'يا': 'ي', 'عين': 'ع', 'طا': 'ط', 'سين': 'س', 'حا': 'ح', 'قاف': 'ق', 'نون': 'ن',
  };
  const SOLO_LETTERS = new Set(['صاد', 'قاف', 'نون']); // sourates 38, 50 et 68 s'ouvrent sur une lettre seule

  function mergeLetterNames(raw) {
    const out = [];
    for (let i = 0; i < raw.length;) {
      let j = i;
      while (j < raw.length && LETTER_NAMES[raw[j]]) j++;
      const run = raw.slice(i, j);
      if (run.length >= 2 || (run.length === 1 && SOLO_LETTERS.has(run[0]))) {
        out.push(run.map((t) => LETTER_NAMES[t]).join(''));
        i = j;
      } else {
        out.push(raw[i]);
        i++;
      }
    }
    return out;
  }

  const tokenize = (text) => mergeLetterNames(normalizeArabic(text).split(' ').filter(Boolean)).map(skeleton).filter(Boolean);
  // Isti'adha et basmala dites avant de commencer : ignorées tant que rien n'a été reconnu
  const STARTERS = new Set(tokenize('أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم'));

  /* ---------- Similarité ---------- */

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  /* Souple : pour le mot attendu (1 à 3 lettres d'écart selon la longueur). */
  function tolerant(t, w) {
    if (t === w) return true;
    if (Math.min(t.length, w.length) <= 2) return false;
    const L = Math.max(t.length, w.length);
    const allowed = L <= 4 ? 1 : L <= 7 ? 2 : 3;
    return lev(t, w, allowed) <= allowed;
  }
  /* Stricte : pour justifier un saut en avant (identique, ou 1 lettre d'écart sur un mot long). */
  const strict = (t, w) => t === w || (Math.min(t.length, w.length) >= 4 && lev(t, w, 1) <= 1);

  /* Le mot entendu tokens[i] correspond-il au mot écrit words[j] ? Gère aussi :
     - deux mots entendus pour un mot écrit (« يا أيها » → يَـٰٓأَيُّهَا),
     - un mot entendu pour deux mots écrits (mots collés par la transcription).
     Retourne le nombre de mots entendus (ti) et écrits (wj) consommés. */
  function matchAt(tokens, i, j, sim) {
    if (i >= tokens.length || j < 0 || j >= words.length) return null;
    const t = tokens[i], w = words[j].n;
    if (sim(t, w)) return { ti: 1, wj: 1 };
    if (i + 1 < tokens.length && sim(t + tokens[i + 1], w)) return { ti: 2, wj: 1 };
    if (t.length >= 4 && j + 1 < words.length && sim(t, w + words[j + 1].n)) return { ti: 1, wj: 2 };
    return null;
  }

  /* Le mot entendu suivant confirme-t-il la position j ? */
  function confirmed(tokens, i, j) {
    if (j >= words.length) return true; // fin du passage
    if (i >= tokens.length) return false; // pas encore de preuve : on attend la suite
    return !!matchAt(tokens, i, j, tolerant);
  }

  /* Répétition d'une phrase déjà dite (on reprend le début du verset pour se relancer) ? */
  function isRepeat(tokens, i, p) {
    for (let b = Math.max(0, p - BACKTRACK); b < p; b++) {
      const m = matchAt(tokens, i, b, strict);
      if (!m) continue;
      const next = i + m.ti;
      if (next >= tokens.length ? b >= p - 3 : matchAt(tokens, next, b + m.wj, tolerant)) return true;
    }
    return false;
  }

  /* Recherche lointaine d'une séquence de 3 mots entendus à partir de tokens[i0], au-delà de la fenêtre. */
  function findSequence(tokens, i0, from) {
    for (let q = from; q < words.length; q++) {
      let ti = i0, wj = q, n = 0;
      while (n < 3) {
        const m = matchAt(tokens, ti, wj, n === 0 ? strict : tolerant);
        if (!m) break;
        ti += m.ti; wj += m.wj; n++;
      }
      if (n === 3) return { start: q };
    }
    return null;
  }

  /* ---------- État ---------- */
  let words = [];            // [{ el, v, n, deco:[el], cls }]
  let verseStart = new Map();
  let root = null, passageKey = null;
  let opts = { mode: 'anchor', lang: 'ar-SA' };
  let rec = null, listening = false, wantListen = false;
  let committed = 0, pos = 0;
  let resState = [], tokenCount = [], finalFlags = [], carry = [];
  let missCommitted = new Set(), missLive = new Set(), hints = new Set();
  let lastHeard = 0, waiting = false, activeVerse = null, flashUntil = new Map();
  let liveText = '', message = '', finished = false;
  let lastScrollKey = null, ticker = null;
  const hooks = { onStart: () => {}, onFinish: () => {} };

  /* Correspondance glissante des mots entendus sur le passage, à partir de la position `base`.
   * 1. Le mot attendu (comparaison souple)                → avance, jamais de rouge.
   * 2. Le mot d'après (un mot avalé par la transcription) → avance ; le mot sauté n'est rouge que s'il fait
   *                                                          plus de 2 lettres (« و », « في », « من » sont
   *                                                          souvent omis par la reconnaissance).
   * 3. Plus loin, jusqu'à LOOKAHEAD mots (saut volontaire) → seulement si correspondance stricte ET confirmée
   *                                                          par le mot entendu suivant ; mots sautés en rouge.
   * 4. Sinon le mot est ignoré (autre verset, bruit). Après RESYNC_AFTER mots ignorés d'affilée, on cherche une
   *    séquence de 3 mots plus loin dans le passage (saut d'un passage entier).
   * Une phrase déjà récitée qu'on répète ne provoque jamais de saut. */
  function align(tokens, base) {
    let p = base, i = 0, used = 0, unmatched = 0;
    let started = base > 0;
    const misses = [];
    // Le mot reconnu commence en `at` et couvre `wj` mots écrits : seuls les mots AVANT lui sont manqués.
    const advance = (at, wj, ti, quietShort = false) => {
      for (let k = p; k < at; k++) if (!(quietShort && words[k].n.length <= 2)) misses.push(k);
      p = at + wj;
      i = ti;
      used = i;
      unmatched = 0;
      started = true;
    };
    while (i < tokens.length && p < words.length) {
      const t = tokens[i];
      if (!started && STARTERS.has(t) && !matchAt(tokens, i, p, tolerant)) { i++; used = i; continue; }

      // 1. mot attendu
      let m = matchAt(tokens, i, p, tolerant);
      if (m) { advance(p, m.wj, i + m.ti); continue; }

      // 2. un mot avalé
      m = t.length >= 3 ? matchAt(tokens, i, p + 1, tolerant) : null;
      if (m && (i + m.ti >= tokens.length || confirmed(tokens, i + m.ti, p + 1 + m.wj)) && !isRepeat(tokens, i, p)) {
        advance(p + 1, m.wj, i + m.ti, true);
        continue;
      }

      // 3. recalage en avant dans la fenêtre
      let jumped = false;
      for (let j = p + 2; j <= Math.min(words.length - 1, p + LOOKAHEAD); j++) {
        m = matchAt(tokens, i, j, strict);
        if (!m || !confirmed(tokens, i + m.ti, j + m.wj)) continue;
        if (!isRepeat(tokens, i, p)) { advance(j, m.wj, i + m.ti); jumped = true; }
        break;
      }
      if (jumped) continue;

      // 4. mot ignoré ; resynchronisation lointaine si l'on est perdu
      unmatched++;
      if (unmatched >= RESYNC_AFTER) {
        const i0 = i - RESYNC_AFTER + 1;
        const r = findSequence(tokens, i0, p + LOOKAHEAD + 1);
        if (r && !isRepeat(tokens, i0, p)) { advance(r.start, 0, i0); continue; }
      }
      i++;
    }
    // mots entendus en fin de résultat sans preuve suffisante : réessayés avec le résultat suivant
    return { pos: p, misses, rest: tokens.slice(Math.max(used, tokens.length - CARRY)) };
  }

  function feed(i, text, isFinal) {
    const toks = tokenize(text);
    tokenCount[i] = toks.length;
    finalFlags[i] = isFinal;
    if (!resState[i]) { resState[i] = { base: committed, skip: 0, carry }; carry = []; }
    const st = resState[i];
    const r = align(st.carry.concat(toks.slice(st.skip)), st.base);
    if (isFinal) {
      committed = Math.max(committed, r.pos);
      r.misses.forEach((k) => missCommitted.add(k));
      carry = r.pos >= committed ? r.rest : [];
      missLive = new Set();
      pos = committed;
      liveText = '';
    } else {
      pos = Math.max(committed, r.pos);
      missLive = new Set(r.misses); // jamais affiché en rouge tant que le résultat n'est pas définitif
      liveText = text;
    }
    paint();
    if (pos >= words.length && words.length) finish();
    updatePanel();
  }

  function onResult(e) {
    lastHeard = Date.now();
    setWaiting(false);
    for (let i = e.resultIndex; i < e.results.length; i++) feed(i, e.results[i][0].transcript, e.results[i].isFinal);
  }

  /* ---------- Affichage ---------- */
  function paint() {
    if (!root || !words.length) return;
    const now = Date.now();
    const lastV = pos > 0 ? words[pos - 1].v : null;
    if (lastV !== activeVerse) {
      if (activeVerse !== null) flashUntil.set(activeVerse, now + FLASH_MS);
      activeVerse = lastV;
    }
    if (opts.mode === 'flash' && flashUntil.size) ensureTicker(); // fait s'estomper les versets déjà dits
    const flash = opts.mode === 'flash';
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      let on = k < pos;
      if (on && flash && !finished) on = w.v === activeVerse || (flashUntil.get(w.v) || 0) > now;
      let cls = 'w';
      if (on) cls += ' on';
      if (k < pos && hints.has(k)) cls += ' hint';
      else if (k < pos && missCommitted.has(k)) cls += ' miss';
      if (k === pos && !finished) cls += ' next';
      if (cls !== w.cls) {
        w.el.className = cls;
        w.deco.forEach((d) => { d.className = on ? 'w on' : 'w'; });
        w.cls = cls;
      }
    }
    scrollToCurrent();
  }

  function scrollToCurrent() {
    const w = words[Math.min(pos, words.length - 1)];
    if (!w || (!listening && !wantListen)) return;
    const key = `${w.v}:${Math.round(w.el.offsetTop / 20)}`; // nouveau verset ou nouvelle ligne
    if (key === lastScrollKey) return;
    lastScrollKey = key;
    w.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function setWaiting(b) {
    if (b === waiting) return;
    waiting = b;
    updatePanel();
  }

  function stats() {
    const verses = [...verseStart.keys()];
    const curV = words[Math.min(pos, words.length - 1)]?.v;
    let miss = 0;
    missCommitted.forEach((k) => { if (k < pos && !hints.has(k)) miss++; });
    return { total: words.length, pos, verseIdx: Math.max(1, verses.indexOf(curV) + 1), verses: verses.length, hints: hints.size, miss };
  }

  function suggestedGrade(s) {
    const errors = s.hints + Math.ceil(s.miss / 3); // les mots non détectés sont souvent des erreurs de reconnaissance
    return errors === 0 ? 4 : errors <= 2 ? 3 : errors / Math.max(1, s.total) > 0.25 ? 1 : 2;
  }

  function updatePanel() {
    const btn = document.getElementById('micBtn');
    if (!btn) return;
    btn.classList.toggle('listening', listening || wantListen);
    btn.classList.toggle('waiting', waiting && (listening || wantListen));
    btn.querySelector('.mic-label').textContent = listening || wantListen ? 'Arrêter le micro' : finished ? 'Réciter à nouveau' : pos > 0 ? 'Reprendre la récitation' : 'Démarrer la récitation au micro';
    const s = stats();
    const prog = document.getElementById('vProgress');
    if (prog) {
      prog.innerHTML = `Verset <b>${s.verseIdx}</b> / ${s.verses} · <b>${s.pos}</b> / ${s.total} mots`
        + (s.hints ? ` · <span class="warn">${plural(s.hints, 'aide', 'aides')}</span>` : '')
        + (s.miss ? ` · <span class="neg">${plural(s.miss, 'mot non détecté', 'mots non détectés')}</span>` : '');
    }
    const bar = document.getElementById('vBar');
    if (bar) bar.style.width = `${s.total ? (100 * s.pos) / s.total : 0}%`;
    const st = document.getElementById('vStatus');
    if (st) {
      st.textContent = message || (finished ? 'Récitation terminée.'
        : waiting && (listening || wantListen) ? 'En attente de la suite…'
          : listening ? 'À l\'écoute…' : wantListen ? 'Connexion au micro…' : '');
      st.className = message ? 'neg' : '';
    }
    const live = document.getElementById('vLive');
    if (live) live.textContent = liveText ? liveText.split(/\s+/).slice(-10).join(' ') : '';
    const sum = document.getElementById('vSummary');
    if (sum) {
      if (finished) {
        const g = suggestedGrade(s);
        sum.hidden = false;
        sum.innerHTML = `${s.hints || s.miss ? '' : 'Récitation fluide, sans aide. '}Note suggérée : <span class="badge g${g}">${Engine.GRADES[g].label}</span>
          <span class="muted small">(${plural(s.hints, 'aide', 'aides')}, ${plural(s.miss, 'mot non détecté', 'mots non détectés')})</span>
          <button type="button" class="btn sm" data-act="voice-grade">Noter cette récitation</button>`;
      } else sum.hidden = true;
    }
  }

  function tick() {
    const now = Date.now();
    if ((listening || wantListen) && now - lastHeard > SILENCE_MS) setWaiting(true);
    if (opts.mode === 'flash' && [...flashUntil.values()].some((t) => t > now - 500)) paint();
    if (!listening && !wantListen && !(opts.mode === 'flash' && [...flashUntil.values()].some((t) => t > now))) {
      clearInterval(ticker); ticker = null;
    }
  }
  const ensureTicker = () => { if (!ticker) ticker = setInterval(tick, 400); };

  /* ---------- Micro ---------- */
  function resetSession() { resState = []; tokenCount = []; finalFlags = []; carry = []; }
  /* Les mots déjà entendus dans les résultats en cours ne comptent plus : la suite part de `p`. */
  function rebase(p) { carry = []; tokenCount.forEach((n, i) => { resState[i] = { base: p, skip: n || 0, carry: [] }; }); }

  function start() {
    message = '';
    if (!SR) { message = 'Reconnaissance vocale non disponible dans ce navigateur : utilisez Chrome ou Edge.'; updatePanel(); return; }
    if (finished) restart();
    hooks.onStart();
    wantListen = true;
    lastHeard = Date.now();
    resetSession();
    rec = new SR();
    rec.lang = opts.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = onResult;
    rec.onstart = () => { listening = true; lastHeard = Date.now(); updatePanel(); };
    rec.onspeechstart = () => { lastHeard = Date.now(); setWaiting(false); };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      wantListen = false;
      message = {
        'not-allowed': 'Accès au micro refusé : autorisez le micro pour cette page (icône à gauche de l\'adresse).',
        'service-not-allowed': 'Le navigateur bloque la reconnaissance vocale pour cette page.',
        network: 'Service de reconnaissance injoignable : une connexion internet est nécessaire.',
        'audio-capture': 'Aucun micro détecté.',
        'language-not-supported': `Langue ${opts.lang} non prise en charge : choisissez une autre variante d'arabe.`,
      }[e.error] || `Erreur du micro : ${e.error}`;
      updatePanel();
    };
    rec.onend = () => {
      listening = false;
      committed = pos; // les résultats intermédiaires non finalisés sont conservés
      missLive.forEach((k) => missCommitted.add(k));
      missLive = new Set();
      resetSession();
      // Chrome coupe la session après un long silence : on relance tant que l'utilisateur n'a pas arrêté
      if (wantListen && !finished) setTimeout(() => { if (wantListen) try { rec.start(); } catch (err) { /* déjà démarré */ } }, 250);
      updatePanel();
    };
    try { rec.start(); } catch (err) { message = 'Impossible de démarrer le micro.'; wantListen = false; }
    ensureTicker();
    updatePanel();
  }

  function stop() {
    wantListen = false;
    setWaiting(false);
    if (rec) { try { rec.stop(); } catch (err) { /* déjà arrêté */ } }
    liveText = '';
    updatePanel();
  }
  const toggle = () => (wantListen ? stop() : start());

  function finish() {
    if (finished) return;
    finished = true;
    stop();
    paint();
    const s = stats();
    hooks.onFinish({ ...s, grade: suggestedGrade(s) });
    updatePanel();
  }

  /* « Besoin d'aide » : dévoile uniquement le mot suivant et repart de là. */
  function hint() {
    if (!words.length || pos >= words.length) return;
    hints.add(pos);
    const newPos = pos + 1;
    committed = newPos;
    pos = newPos;
    rebase(newPos);
    missLive = new Set();
    lastHeard = Date.now();
    setWaiting(false);
    const w = words[pos - 1];
    paint();
    w.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (pos >= words.length) finish();
    updatePanel();
  }

  /* Reprend la récitation au début d'un verset donné. */
  function jumpTo(v) {
    if (!verseStart.has(v)) return;
    const p = verseStart.get(v);
    committed = pos = p;
    [missCommitted, hints].forEach((set) => set.forEach((k) => { if (k >= p) set.delete(k); }));
    missLive = new Set();
    rebase(p);
    finished = false;
    paint();
    updatePanel();
  }

  function restart() {
    committed = pos = 0;
    missCommitted = new Set(); missLive = new Set(); hints = new Set();
    flashUntil = new Map(); activeVerse = null; finished = false; liveText = ''; lastScrollKey = null;
    rebase(0);
    paint();
    updatePanel();
    root?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /* Rattache le module au texte affiché (appelé après chaque rendu de l'Atelier). */
  function mount(el, key) {
    root = el;
    const list = [];
    verseStart = new Map();
    el.querySelectorAll('.v').forEach((vEl) => {
      const v = +vEl.dataset.v;
      vEl.querySelectorAll('.w').forEach((wEl) => {
        const n = norm(wEl.textContent);
        if (!n) { // signe isolé (pause, ۞) : suit le mot qui le précède
          if (list.length) list[list.length - 1].deco.push(wEl); else wEl.className = 'w on';
          return;
        }
        if (!verseStart.has(v)) verseStart.set(v, list.length);
        list.push({ el: wEl, v, n, deco: [], cls: null });
      });
    });
    words = list;
    if (key !== passageKey) { passageKey = key; stop(); resetSession(); restart(); }
    else paint();
    updatePanel();
  }

  function unmount() {
    if (wantListen) stop();
    root = null;
  }

  function configure(o) {
    const langChanged = o.lang && o.lang !== opts.lang;
    opts = { ...opts, ...o };
    if (langChanged && wantListen) { stop(); setTimeout(start, 300); }
    paint();
  }

  function panelHTML() {
    const seg = (m, label) => `<button type="button" data-act="voice-mode" data-m="${m}" class="${opts.mode === m ? 'on' : ''}">${label}</button>`;
    return `<section class="voice-panel card" id="voicePanel" aria-label="Récitation au micro">
      <div class="vp-main">
        <button type="button" class="mic-btn" id="micBtn" data-act="voice-listen">
          <span class="mic-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg></span>
          <span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="mic-label">Démarrer la récitation au micro</span>
        </button>
        <div class="vp-side">
          <div class="seg" role="group" aria-label="Mode d'affichage">${seg('flash', 'Mode Flash')}${seg('anchor', 'Mode Ancrage')}</div>
          <p class="muted small">${opts.mode === 'flash' ? 'Le texte n\'apparaît que pendant que vous le dites, puis s\'estompe.' : 'Le texte se dévoile définitivement au fil de votre récitation.'}</p>
          <select data-change="voice-lang" aria-label="Variante d'arabe">${LANGS.map(([v, l]) => `<option value="${v}" ${opts.lang === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
      </div>
      <div class="vp-progress"><div id="vBar"></div></div>
      <div class="vp-status"><span id="vProgress"></span><span id="vStatus"></span></div>
      <p class="vp-live" id="vLive" dir="rtl" lang="ar" aria-live="polite"></p>
      <div class="alert ok" id="vSummary" hidden></div>
      <div class="actions">
        <button type="button" class="btn" data-act="voice-hint">Besoin d'aide · mot suivant <kbd>H</kbd></button>
        <button type="button" class="btn ghost" data-act="voice-restart">Recommencer</button>
        <button type="button" class="btn ghost" data-act="voice-close">Quitter le mode micro</button>
      </div>
      ${SR ? '<p class="muted small">Cliquez un verset puis « Reprendre ici » pour repartir d\'un endroit précis. La reconnaissance vocale de Chrome et d\'Edge passe par les serveurs du navigateur : une connexion internet est nécessaire.</p>'
        : '<p class="alert">Ce navigateur ne propose pas la reconnaissance vocale : ouvrez l\'application dans Chrome ou Edge. Vous pouvez tout de même réciter et dévoiler mot à mot avec « Besoin d\'aide ».</p>'}
    </section>`;
  }

  return {
    supported: !!SR, LANGS, mount, unmount, configure, panelHTML, toggle, start, stop, hint, restart, jumpTo,
    hooks, get listening() { return wantListen; },
    _simulate: (text, isFinal = false, index = 0) => feed(index, text, isFinal), // tests
    normalizeArabic, _norm: skeleton, _tokenize: tokenize,
  };
})();
