/* Tafsir & Méditation : fiches par Rub' (4 cartes de savoir + méditations personnelles),
 * glossaire avec infobulles, prompt d'extraction pour un Claude Project, import / export JSON.
 *
 * Sources des fiches, par ordre de priorité croissante :
 *   1. data/tafsir.js   : window.TAFSIR_DATA = { schema, entries:[...] } (fichier livré avec l'app, modifiable)
 *   2. IndexedDB        : fiches importées depuis l'interface (collées ou fichier tafsir.json)
 * IndexedDB plutôt que localStorage : 240 fiches détaillées dépasseraient vite le quota de 5 Mo.
 *
 * Format d'une fiche (voir aussi prompt()) :
 *   { rub, reference, sources:[], context:[item], tradition:[item], language:[item], tazkiya:[item],
 *     glossary:[{ term, definition }] }
 *   item = { title?, verses?, arabic?, text, practice?, source?, kind?, grade? }
 *   Dans les textes, [[Terme]] ou [[Terme|texte affiché]] crée une infobulle. */
'use strict';

const Tafsir = (() => {
  const SCHEMA = 'hifz-tafsir/1';

  const CARDS = [
    { key: 'context', icon: '📜', title: 'Contexte & Révélation', ar: 'أسباب النزول', basis: "Sabab al-Nuzul · d'après Al-Jalalayn et le tafsir des Tabi'in" },
    { key: 'tradition', icon: '📚', title: 'Fondements traditionnels', ar: 'الحديث والقصص', basis: 'Hadiths liés aux versets, Qisas des Prophètes, paroles des grands commentateurs' },
    { key: 'language', icon: '🔍', title: 'Subtilités & secrets de la langue', ar: 'البلاغة', basis: "Balagha et choix des mots · d'après Al-Tahrir wa al-Tanwir d'Ibn Ashur" },
    { key: 'tazkiya', icon: '🌱', title: "Purification de l'âme", ar: 'تزكية النفس', basis: "Tazkiyat al-Nafs · leçons d'Ibn Taymiyyah et d'Ibn Sa'di pour le quotidien" },
  ];

  const KINDS = { hadith: 'Hadith', athar: 'Athar', qisas: 'Récit prophétique', citation: 'Commentateur', israiliyyat: "Isra'iliyyat" };

  /* Glossaire de base : termes techniques expliqués simplement (les fiches peuvent en ajouter).
     3e valeur = true : terme ambigu (« Hasan » dans Al-Hasan al-Basri, « Sahih » dans Sahih al-Bukhari…),
     infobulle seulement s'il est balisé [[…]] ou affiché comme degré d'authenticité. */
  const BASE_GLOSSARY = [
    ["I'jaz", "Inimitabilité du Coran : le défi lancé aux hommes d'en produire l'équivalent, et le caractère miraculeux de son style comme de son contenu."],
    ['Balagha', "Rhétorique arabe : l'art d'adapter la parole à la situation pour qu'elle touche juste — clarté, concision, force des images, musicalité."],
    ['Iltifat', "Changement soudain de personne grammaticale (de « Il » à « Tu », de « Nous » à « Il »…). Il réveille l'attention et crée un effet de proximité ou de majesté."],
    ['Emphase', "Procédé d'insistance (particules inna, la-, serment, répétition…) qui renforce une affirmation, souvent face au doute ou au déni de l'auditeur."],
    ["Ta'kid", "Corroboration, emphase : tout ce qui renforce une affirmation (inna, lam de corroboration, nûn d'insistance, serment, répétition)."],
    ["Taqdim wa ta'khir", "Inversion de l'ordre habituel des mots : on place en tête ce que l'on veut souligner ou réserver (« C'est Toi [seul] que nous adorons »)."],
    ['Hadhf', "Ellipse : omission volontaire d'un mot que le contexte permet de deviner. Le style devient plus dense et invite l'auditeur à compléter, donc à réfléchir."],
    ['Ellipse', "Omission volontaire d'un mot que le contexte permet de deviner (en arabe : hadhf)."],
    ['Istifham', "Question rhétorique : une interrogation qui n'attend pas de réponse mais sert à affirmer, blâmer, s'étonner ou pousser à réfléchir."],
    ['Tashbih', "Comparaison explicite (« comme… ») qui rend une idée abstraite concrète et visible."],
    ["Isti'ara", 'Métaphore : une image empruntée directement, sans outil de comparaison.'],
    ['Kinaya', "Allusion : désigner une réalité par ce qui l'accompagne, par pudeur, par délicatesse ou pour frapper l'imagination."],
    ['Majaz', "Sens figuré, par opposition au sens propre (haqiqa)."],
    ['Qasam', "Serment divin (« Par le soleil… ») : il attire l'attention sur la grandeur de ce par quoi Allah jure et appuie ce qui suit."],
    ['Fasila', 'Rime de fin de verset : son choix sert à la fois la musicalité et le sens.'],
    ['Munasaba', "Lien de cohérence entre un verset et ce qui l'entoure, ou entre deux sourates qui se suivent."],
    ['Sabab al-Nuzul', 'Circonstance ou événement à l\'occasion duquel un ou plusieurs versets ont été révélés (pluriel : Asbab al-Nuzul).'],
    ['Asbab al-Nuzul', 'Circonstances de la révélation : événements ou questions à l\'occasion desquels des versets ont été révélés.'],
    ['Makki', "Révélé avant l'Hégire (période mecquoise) : surtout la foi, l'au-delà et les récits des prophètes.", true],
    ['Madani', "Révélé après l'Hégire (période médinoise) : souvent la législation et l'organisation de la communauté.", true],
    ['Naskh', "Abrogation : remplacement d'une disposition légale par une autre, révélée plus tard."],
    ['Tafsir', 'Exégèse : explication du sens des versets.'],
    ["Tafsir bil-Ma'thur", "Exégèse par la transmission : expliquer le Coran par le Coran, la Sunna, et les paroles des Compagnons et des Tabi'in."],
    ["Tabi'in", 'La génération qui a suivi les Compagnons et appris directement d\'eux (Mujahid, Qatada, Al-Hasan al-Basri…).'],
    ['Sahaba', 'Les Compagnons du Prophète ﷺ.'],
    ['Hadith', 'Parole, acte ou approbation rapportés du Prophète ﷺ.'],
    ['Athar', "Parole ou avis rapporté d'un Compagnon ou d'un Tabi'i (et non du Prophète ﷺ lui-même)."],
    ['Sahih', 'Hadith authentique : chaîne continue de transmetteurs fiables et précis, sans anomalie ni défaut caché.', true],
    ['Hasan', 'Hadith « bon » : accepté comme preuve, mais un transmetteur a une mémoire un peu moins précise que pour le sahih.', true],
    ["Da'if", "Hadith faible : une condition d'authenticité manque ; il ne sert pas de preuve pour établir une règle.", true],
    ['Isnad', "Chaîne des transmetteurs d'un hadith, de celui qui le rapporte jusqu'au Prophète ﷺ."],
    ['Qisas', 'Récits coraniques, en particulier ceux des prophètes.'],
    ["Isra'iliyyat", 'Récits issus des traditions juives et chrétiennes, rapportés par certains commentateurs : à lire avec prudence, ils ne fondent ni croyance ni règle.'],
    ['Tazkiyat al-Nafs', "Purification de l'âme : la débarrasser de ses défauts (orgueil, envie, ostentation…) et l'orner de vertus."],
    ['Tazkiya', "Purification de l'âme et croissance dans le bien."],
    ['Nafs', "L'âme, le « moi » avec ses désirs : le Coran décrit l'âme qui incite au mal, celle qui se blâme et celle qui est apaisée."],
    ['Taqwa', "Conscience vigilante d'Allah qui pousse à se préserver de ce qui Lui déplaît."],
    ['Ikhlas', 'Sincérité : accomplir ses actes pour Allah seul, sans chercher le regard des gens.'],
    ['Ihsan', "Excellence : adorer Allah comme si on Le voyait ; et si on ne Le voit pas, Lui nous voit."],
    ['Tawakkul', "Confiance totale en Allah, après avoir pris les moyens."],
    ['Sabr', 'Patience et constance : dans l\'obéissance, face aux épreuves, et face aux tentations.'],
    ['Shukr', 'Gratitude envers Allah, par le cœur, la langue et les actes.'],
    ['Dhikr', "Rappel et évocation d'Allah, par le cœur et par la langue."],
    ['Tadabbur', 'Méditation attentive des versets pour en saisir le sens et y conformer sa vie.'],
    ['Tawhid', "Unicité d'Allah : Lui seul crée, Lui seul mérite l'adoration, Ses noms et attributs sont sans pareil."],
    ['Mutashabih', 'Selon le contexte : verset au sens non évident, ou (en mémorisation) verset très proche d\'un autre par sa formulation.'],
    ['Madd', "Allongement d'une voyelle dans la récitation."],
  ];

  /* ---------- Normalisation & glossaire ---------- */

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’'ʿʾ‘`]/g, '').replace(/[\s-]+/g, ' ').trim().toLowerCase();
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // l'apostrophe, l'espace et le tiret sont tolérés sous toutes leurs formes
  const termPattern = (t) => t.split('').map((c) => (/['’ʿʾ‘`]/.test(c) ? "['’ʿʾ‘`]?" : /[\s-]/.test(c) ? '[\\s-]' : reEsc(c))).join('');

  function glossaryFor(entry) {
    const map = new Map(BASE_GLOSSARY.map(([t, d, explicit]) => [norm(t), { term: t, definition: d, explicit }]));
    for (const g of entry?.glossary || []) map.set(norm(g.term), g);
    const terms = [...map.values()].filter((g) => !g.explicit).map((g) => g.term).sort((a, b) => b.length - a.length);
    const re = new RegExp(`\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]|(?<![\\p{L}\\p{M}])(${terms.map(termPattern).join('|')})(?![\\p{L}\\p{M}])`, 'giu');
    return { map, re };
  }

  const termHTML = (display, term, gloss) => {
    const g = gloss.map.get(norm(term));
    return g ? `<span class="term" tabindex="0" data-term="${esc(g.term)}" data-tip="${esc(g.definition)}">${esc(display)}</span>` : esc(display);
  };

  /* Texte → HTML échappé, avec infobulles : [[Terme]] toujours, termes connus à leur 1re apparition dans la carte. */
  function rich(raw, seen, gloss) {
    const s = String(raw ?? '');
    let out = '', last = 0;
    for (const m of s.matchAll(gloss.re)) {
      out += esc(s.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) { seen.add(norm(m[1])); out += termHTML(m[2] || m[1], m[1], gloss); continue; }
      const k = norm(m[3]);
      if (seen.has(k)) out += esc(m[3]);
      else { seen.add(k); out += termHTML(m[3], m[3], gloss); }
    }
    return out + esc(s.slice(last));
  }
  const paras = (raw, seen, gloss) => String(raw || '').split(/\n\s*\n/).filter((p) => p.trim())
    .map((p) => `<p>${rich(p.trim(), seen, gloss).replace(/\n/g, '<br>')}</p>`).join('');

  /* ---------- Rendu des 4 cartes ---------- */

  function gradeClass(g) {
    const n = norm(g);
    if (/sahih|authentique/.test(n)) return 'g-ok';
    if (/hasan|bon/.test(n)) return 'g-mid';
    if (/daif|faible|mawdu|forge|munkar/.test(n)) return 'g-bad';
    return '';
  }

  function itemHTML(it, seen, gloss) {
    return `<article class="t-item">
      ${it.kind || it.title || it.verses ? `<header>
        ${it.kind ? `<span class="badge t-kind">${esc(KINDS[it.kind] || it.kind)}</span>` : ''}
        ${it.title ? `<strong>${rich(it.title, seen, gloss)}</strong>` : ''}
        ${it.verses ? `<span class="chip">${esc(it.verses)}</span>` : ''}
      </header>` : ''}
      ${it.arabic ? `<p class="t-ar" dir="rtl" lang="ar">${esc(it.arabic)}</p>` : ''}
      ${paras(it.text, seen, gloss)}
      ${it.practice ? `<p class="t-practice"><b>À vivre cette semaine</b>${rich(it.practice, seen, gloss)}</p>` : ''}
      ${it.grade || it.source ? `<footer class="t-src">
        ${it.grade ? `<span class="badge ${gradeClass(it.grade)}">${termHTML(it.grade, it.grade, gloss)}</span>` : ''}
        ${it.source ? `<cite>${esc(it.source)}</cite>` : ''}
      </footer>` : ''}
    </article>`;
  }

  function cardsHTML(entry) {
    const gloss = glossaryFor(entry);
    return CARDS.map((c) => {
      const items = entry?.[c.key] || [];
      const seen = new Set();
      return `<section class="tcard t-${c.key}" aria-labelledby="tc-${c.key}">
        <header class="tcard-h">
          <span class="t-icon" aria-hidden="true">${c.icon}</span>
          <div><h3 id="tc-${c.key}">${esc(c.title)} <span class="ar">${c.ar}</span></h3>
            <p class="muted small">${rich(c.basis, seen, gloss)}</p></div>
          ${items.length ? `<span class="count">${items.length}</span>` : ''}
        </header>
        ${items.length ? `<div class="t-items">${items.map((it) => itemHTML(it, seen, gloss)).join('')}</div>`
          : `<p class="empty">${entry ? 'Vos sources ne contiennent rien de spécifique à ce Rub\' pour cette carte.' : 'Pas encore de fiche pour ce Rub\'. Générez le prompt 🎯, puis collez ici la réponse de votre Claude Project.'}</p>`}
      </section>`;
    }).join('');
  }

  /* ---------- Infobulles (une seule bulle flottante, souris, clavier et toucher) ---------- */

  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.id = 'tafsirTip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  let tipFor = null;

  function showTip(el) {
    tipFor = el;
    tip.innerHTML = `<b>${esc(el.dataset.term)}</b>${esc(el.dataset.tip)}`;
    tip.hidden = false;
    el.setAttribute('aria-describedby', tip.id);
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8)}px`;
    tip.style.top = `${r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8}px`;
  }
  function hideTip() {
    tipFor?.removeAttribute('aria-describedby');
    tipFor = null;
    tip.hidden = true;
  }
  document.addEventListener('mouseover', (e) => { const t = e.target.closest?.('.term'); if (t && t !== tipFor) showTip(t); else if (!t && tipFor) hideTip(); });
  document.addEventListener('focusin', (e) => { const t = e.target.closest?.('.term'); if (t) showTip(t); else if (tipFor) hideTip(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tipFor) hideTip(); });
  window.addEventListener('scroll', () => tipFor && hideTip(), { passive: true });

  /* ---------- Prompt d'extraction pour un Claude Project ---------- */

  function prompt(r) {
    const [a, b] = Q.rubRange[r];
    const surahs = [];
    for (let v = a; v <= b; v++) {
      const s = Q.surahOf[v], last = surahs[surahs.length - 1];
      if (last && last.s === s) last.to = Q.ayahOf[v];
      else surahs.push({ s, from: Q.ayahOf[v], to: Q.ayahOf[v] });
    }
    const scope = surahs.map(({ s, from, to }) => `- Sourate ${Q.surahName(s)} (n° ${s}, ${Q.surahAr(s)}) : versets ${from} à ${to}${from === 1 ? ' — début de la sourate' : ''}${to === Q.ayahCount(s) ? ' — fin de la sourate' : ''}`).join('\n');
    const refs = surahs.map(({ s, from, to }) => `${s}:${from}-${to}`).join(', ');
    const text = [];
    for (let v = a; v <= b; v++) text.push(`(${Q.key(v)}) ${Q.text(v)}`);
    const starts = surahs.some((x) => x.from === 1);

    return `Tu es un spécialiste des sciences du Coran (tafsir, hadith, balagha, tazkiya) et un pédagogue francophone.
Ta mission : extraire de MES DOCUMENTS (les PDF de ce projet : Al-Tahrir wa al-Tanwir d'Ibn Ashur, Tafsir al-Jalalayn, ouvrages de tafsir des Tabi'in, écrits d'Ibn Taymiyyah, Tafsir d'Ibn Sa'di, ouvrages de Tazkiyat al-Nafs, etc.) une fiche d'étude pour UN Rub' précis du Coran, et la rendre sous forme d'un objet JSON strict.

## Passage ciblé : Rub' ${r} (Hizb ${Q.hizbOfRub(r)}, Juz' ${Q.juzOfRub(r)}), ${Q.pagesOf([[a, b]])} du Mushaf de Médine
${scope}
Références : ${refs} (${b - a + 1} versets)

Texte du passage (pour repérer les bons passages dans les PDF) :
${text.join('\n')}

## Règles impératives
1. N'utilise QUE le contenu des documents du projet. N'invente rien, ne complète pas de mémoire. Si une carte n'a rien dans les documents pour ce passage, renvoie un tableau vide [].
2. Chaque élément indique sa source dans "source" : ouvrage, auteur, tome et page quand ils sont visibles (ex. « Al-Tahrir wa al-Tanwir, Ibn Ashur, t. 16, p. 12 »).
3. Hadiths : n'attribue au Prophète ﷺ que ce qui figure dans les documents, avec sa référence (recueil et numéro si indiqués). "grade" = le jugement d'authenticité tel que donné par la source (Sahih, Hasan, Da'if…) ; s'il n'est pas indiqué, mets "non précisé". Distingue hadith (parole du Prophète ﷺ) et athar (parole d'un Compagnon ou d'un Tabi'i). Signale les récits isra'iliyyat avec "kind": "israiliyyat".
4. Couvre l'ensemble du Rub', pas seulement ses premiers versets. Entre 2 et 6 éléments par carte, les plus utiles d'abord. Précise toujours les versets concernés dans "verses" au format "sourate:verset" ou "sourate:début-fin" (ex. "18:83-98").
5. Rédaction : français fluide et accessible à un lecteur qui ne maîtrise pas l'arabe classique. Phrases courtes, paragraphes séparés par une ligne vide (\\n\\n). Translittération simple (ex. « rahma »). Explique chaque notion au lieu de la supposer connue.
6. Termes techniques arabes incontournables : entoure-les de doubles crochets, ex. [[Iltifat]], [[Balagha]], [[Sabab al-Nuzul]]. Pour tout terme qui n'est pas parmi les plus courants, ajoute une définition simple dans "glossary".
7. Le texte arabe cité (verset, hadith, mot étudié) va dans "arabic", jamais mélangé au texte français.

## Contenu attendu par carte
- "context" (📜 Contexte & Révélation) : circonstances de la révélation (asbab al-nuzul), période mecquoise/médinoise, situation des musulmans à ce moment, explications d'Al-Jalalayn et des Tabi'in (Mujahid, Qatada, Al-Hasan…).${starts ? ' Le passage contient le début d\'une sourate : ajoute un élément sur le contexte général et les grands thèmes de cette sourate.' : ''}
- "tradition" (📚 Fondements traditionnels) : hadiths adossés aux versets ("kind": "hadith"), paroles des Compagnons et Tabi'in ("athar"), récits des Prophètes liés au passage ("qisas"), citations clés des grands commentateurs ("citation").
- "language" (🔍 Subtilités de la langue) : d'après Ibn Ashur en priorité. Pour chaque subtilité : le mot ou la tournure en arabe ("arabic"), sa traduction littérale, puis en termes simples pourquoi ce choix plutôt qu'un autre (choix d'un mot, ordre des mots, ellipse, emphase, changement de personne, rime de fin de verset…) et ce que cela ajoute au sens.
- "tazkiya" (🌱 Purification de l'âme) : leçons spirituelles d'Ibn Taymiyyah et d'Ibn Sa'di tirées de ces versets ; "practice" = une application concrète et réaliste pour la semaine (une phrase).

## Format de sortie
Réponds UNIQUEMENT par l'objet JSON ci-dessous, sans texte avant ni après, sans bloc de code. JSON valide : guillemets doubles, aucune virgule finale, guillemets internes échappés (\\").

{
  "schema": "${SCHEMA}",
  "rub": ${r},
  "reference": "${Q.describe([a, b]).replace(/"/g, '')}",
  "sources": ["ouvrages effectivement utilisés"],
  "context": [
    { "title": "…", "verses": "${surahs[0].s}:${surahs[0].from}-${surahs[0].to}", "text": "…", "source": "…" }
  ],
  "tradition": [
    { "kind": "hadith | athar | qisas | citation | israiliyyat", "title": "…", "verses": "…", "arabic": "texte arabe ou chaîne vide", "text": "traduction et explication", "grade": "Sahih | Hasan | Da'if | non précisé (hadiths seulement)", "source": "…" }
  ],
  "language": [
    { "title": "…", "verses": "…", "arabic": "le mot ou la tournure", "text": "explication simple", "source": "…" }
  ],
  "tazkiya": [
    { "title": "…", "verses": "…", "text": "la leçon", "practice": "application concrète", "source": "…" }
  ],
  "glossary": [
    { "term": "…", "definition": "définition simple en français" }
  ]
}`;
  }

  /* ---------- Import / validation ---------- */

  const str = (v, max = 6000) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
  const ITEM_FIELDS = ['title', 'verses', 'arabic', 'text', 'practice', 'source', 'kind', 'grade'];

  function cleanItem(it) {
    if (typeof it === 'string') it = { text: it };
    if (!it || typeof it !== 'object') return null;
    const o = {};
    for (const f of ITEM_FIELDS) { const v = str(it[f]); if (v) o[f] = v; }
    if (o.kind) o.kind = norm(o.kind).replace(/\s/g, '');
    return o.text || o.arabic || o.title ? o : null;
  }

  function clean(e, fallbackRub) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('Fiche invalide : un objet JSON est attendu.');
    const rub = parseInt(e.rub ?? fallbackRub, 10);
    if (!(rub >= 1 && rub <= 240)) throw new Error('Champ « rub » manquant ou hors limites (1 à 240).');
    const out = {
      schema: SCHEMA, rub,
      reference: str(e.reference, 200),
      sources: (Array.isArray(e.sources) ? e.sources : []).map((s) => str(s, 200)).filter(Boolean).slice(0, 20),
      importedAt: new Date().toISOString(),
    };
    for (const { key } of CARDS) {
      const v = e[key];
      out[key] = (Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : []).map(cleanItem).filter(Boolean).slice(0, 30);
    }
    out.glossary = (Array.isArray(e.glossary) ? e.glossary : [])
      .map((g) => ({ term: str(g?.term, 60), definition: str(g?.definition, 600) }))
      .filter((g) => g.term && g.definition).slice(0, 60);
    if (!CARDS.some(({ key }) => out[key].length)) throw new Error(`Rub' ${rub} : aucune des quatre cartes ne contient de donnée.`);
    return out;
  }

  /* Tolère un bloc ```json, du texte autour, et plusieurs formes : fiche seule, tableau, { entries:[…] } ou { "121": {…} }. */
  function parse(text, fallbackRub) {
    let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let data;
    try { data = JSON.parse(t); } catch (err) {
      const a = t.search(/[{[]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
      if (a < 0 || b <= a) throw new Error('Aucun objet JSON trouvé dans le texte.');
      try { data = JSON.parse(t.slice(a, b + 1)); } catch (e2) { throw new Error(`JSON invalide : ${e2.message}`); }
    }
    let list;
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data?.entries)) list = data.entries;
    else if (data && ('rub' in data || CARDS.some(({ key }) => key in data))) return [clean(data, fallbackRub)];
    else if (data && typeof data === 'object') list = Object.entries(data).map(([k, v]) => ({ rub: k, ...v }));
    else throw new Error('Format non reconnu.');
    if (!list.length) throw new Error('Le fichier ne contient aucune fiche.');
    return list.map((e) => clean(e));
  }

  /* ---------- Stockage (fiches livrées + IndexedDB) ---------- */

  const entries = new Map();   // rub -> fiche affichée
  const bundled = new Map();   // rub -> fiche de data/tafsir.js
  const imported = new Set();  // rubs provenant d'IndexedDB
  let db = null;

  const idb = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });

  for (const e of window.TAFSIR_DATA?.entries || []) {
    try { const c = clean(e); bundled.set(c.rub, c); entries.set(c.rub, c); } catch (err) { console.warn('data/tafsir.js :', err.message); }
  }

  const ready = (async () => {
    try {
      const rq = indexedDB.open('hifz', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('tafsir', { keyPath: 'rub' });
      db = await idb(rq);
      const all = await idb(db.transaction('tafsir').objectStore('tafsir').getAll());
      for (const e of all) { entries.set(e.rub, e); imported.add(e.rub); }
    } catch (err) {
      console.warn('IndexedDB indisponible : les fiches importées ne seront pas conservées.', err);
    }
  })();

  async function put(list) {
    for (const e of list) { entries.set(e.rub, e); imported.add(e.rub); }
    if (!db) return false;
    const tx = db.transaction('tafsir', 'readwrite');
    list.forEach((e) => tx.objectStore('tafsir').put(e));
    await done(tx);
    return true;
  }

  async function remove(r) {
    imported.delete(r);
    if (bundled.has(r)) entries.set(r, bundled.get(r)); else entries.delete(r);
    if (!db) return;
    const tx = db.transaction('tafsir', 'readwrite');
    tx.objectStore('tafsir').delete(r);
    await done(tx);
  }

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* format 'json' : tafsir.json réimportable ; format 'js' : à déposer tel quel dans data/tafsir.js */
  function exportAll(format = 'json') {
    const data = { schema: SCHEMA, exportedAt: new Date().toISOString(), entries: [...entries.values()].sort((x, y) => x.rub - y.rub) };
    const json = JSON.stringify(data, null, 2);
    if (format === 'js') download('tafsir.js', `/* Fiches Tafsir & Méditation (généré par Hifz). */\nwindow.TAFSIR_DATA = ${json};\n`, 'text/javascript');
    else download(`tafsir-${Dt.today()}.json`, json, 'application/json');
    return data.entries.length;
  }

  return {
    SCHEMA, CARDS, ready, prompt, parse, put, remove, exportAll, cardsHTML,
    get: (r) => entries.get(r) || null,
    has: (r) => entries.has(r),
    isImported: (r) => imported.has(r),
    count: () => entries.size,
    persistent: () => !!db,
  };
})();
