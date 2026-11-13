/* Lecteur audio verset par verset (fichiers EveryAyah), avec répétitions, chaînage et pauses de récitation.
 * Modes :
 *   verse  : chaque verset N fois, puis le suivant
 *   chain  : chaque verset N fois, puis reprise depuis le début du passage jusqu'à ce verset (ربط, liaison)
 *   range  : le passage entier N fois
 */
'use strict';

const Player = (() => {
  const RECITERS = [
    ['Husary_Muallim_128kbps', 'Al-Husary — Mu\'allim (pédagogique, lent)'],
    ['Husary_128kbps', 'Mahmoud Khalil Al-Husary'],
    ['Minshawy_Murattal_128kbps', 'Al-Minshawi (Murattal)'],
    ['Alafasy_128kbps', 'Mishary Rashid Alafasy'],
    ['Abdul_Basit_Murattal_192kbps', 'Abdul Basit (Murattal)'],
    ['MaherAlMuaiqly128kbps', 'Maher Al-Muaiqly'],
    ['Abdurrahmaan_As-Sudais_192kbps', 'Abdurrahman As-Sudais'],
    ['Yasser_Ad-Dussary_128kbps', 'Yasser Ad-Dussary'],
    ['Ghamadi_40kbps', 'Saad Al-Ghamdi'],
  ];

  const audio = new Audio();
  audio.preload = 'auto';
  const preloader = new Audio();
  preloader.preload = 'auto';

  let verses = [];   // indices de versets du passage
  let list = [];     // file de lecture : [{ v, k, n, pass }]
  let pos = 0;
  let playing = false;
  let timer = null;
  let opts = { reciter: RECITERS[0][0], mode: 'verse', repeat: 5, loops: 1, gap: '1', rate: 1 };
  let listener = () => {};

  const url = (v) => `https://everyayah.com/data/${opts.reciter}/${Q.audioFile(v)}.mp3`;

  function build() {
    const pass = [];
    const n = Math.max(1, opts.repeat | 0);
    if (opts.mode === 'range') {
      for (let k = 1; k <= n; k++) verses.forEach((v) => pass.push({ v, k, n }));
    } else {
      verses.forEach((v, idx) => {
        for (let k = 1; k <= n; k++) pass.push({ v, k, n });
        if (opts.mode === 'chain' && idx > 0) verses.slice(0, idx + 1).forEach((w) => pass.push({ v: w, k: 0, n: 0, link: true }));
      });
    }
    const loops = +opts.loops || 1; // 0 = infini (géré en bouclant)
    list = [];
    for (let p = 1; p <= Math.max(1, loops); p++) pass.forEach((e) => list.push({ ...e, pass: p }));
  }

  function emit(extra = {}) {
    listener({ playing, entry: list[pos] || null, pos, total: list.length, ...extra });
  }

  function playCurrent() {
    clearTimeout(timer);
    const e = list[pos];
    if (!e) return stop();
    const src = url(e.v);
    if (audio.src !== src) audio.src = src;
    else audio.currentTime = 0;
    audio.playbackRate = +opts.rate || 1;
    audio.play().catch((err) => { if (err.name !== 'AbortError') { playing = false; emit({ error: 'Lecture impossible (connexion internet requise pour l\'audio).' }); } });
    const next = list[pos + 1];
    if (next && next.v !== e.v) preloader.src = url(next.v);
    emit();
  }

  function gapMs() {
    if (opts.gap === 'echo') return ((audio.duration || 3) / (+opts.rate || 1)) * 1000 + 400;
    return (+opts.gap || 0) * 1000;
  }

  audio.addEventListener('ended', () => {
    if (!playing) return;
    const wait = gapMs();
    pos++;
    if (pos >= list.length) {
      if (+opts.loops === 0) pos = 0; else { stop(true); return; }
    }
    emit({ waiting: wait > 0 });
    timer = setTimeout(playCurrent, wait);
  });
  audio.addEventListener('error', () => {
    if (!playing) return;
    playing = false;
    emit({ error: 'Audio indisponible : vérifiez votre connexion internet.' });
  });

  function load(ranges, o = {}) {
    stop();
    verses = [];
    for (const [a, b] of ranges) for (let v = a; v <= b; v++) verses.push(v);
    opts = { ...opts, ...o };
    build();
    pos = 0;
    emit();
  }

  function setOpts(o) {
    const current = list[pos]?.v;
    opts = { ...opts, ...o };
    const wasPlaying = playing;
    pause();
    build();
    pos = Math.max(0, list.findIndex((e) => e.v === current && e.k <= 1));
    if (wasPlaying) play(); else emit();
  }

  function play() {
    if (!list.length) return;
    playing = true;
    playCurrent();
  }
  function pause() {
    playing = false;
    clearTimeout(timer);
    audio.pause();
    emit();
  }
  function stop(finished = false) {
    playing = false;
    clearTimeout(timer);
    audio.pause();
    if (finished) pos = 0;
    emit({ finished });
  }
  const toggle = () => (playing ? pause() : play());

  function jumpVerse(dir) {
    if (!list.length) return;
    const cur = list[pos]?.v;
    let i = pos;
    if (dir > 0) { while (i < list.length && list[i].v === cur) i++; }
    else {
      while (i > 0 && list[i].v === cur) i--;
      const prev = list[i]?.v;
      while (i > 0 && list[i - 1].v === prev) i--;
    }
    pos = clamp(i, 0, list.length - 1);
    playing ? playCurrent() : emit();
  }

  function playFrom(v) {
    const i = list.findIndex((e) => e.v === v && !e.link);
    if (i < 0) return;
    pos = i;
    play();
  }

  return {
    RECITERS, load, setOpts, play, pause, stop, toggle, playFrom,
    next: () => jumpVerse(1), prev: () => jumpVerse(-1),
    onChange: (fn) => { listener = fn; },
    get playing() { return playing; },
    get loaded() { return list.length > 0; },
    get opts() { return opts; },
  };
})();
