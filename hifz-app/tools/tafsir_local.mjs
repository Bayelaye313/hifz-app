#!/usr/bin/env node
/* Génération locale des fiches Tafsir, sans API : boucle « prompt → Claude Project → réponse JSON ».
 *
 * Le prompt est celui de l'application (fonction prompt() de js/tafsir.js, exécutée telle quelle avec js/quran.js) :
 * il reste identique à celui du bouton 🎯 de l'Atelier.
 *
 * Boucle type (une commande par Rub') :
 *   node tools/tafsir_local.mjs next      # copie le prompt du prochain Rub' manquant dans le presse-papiers
 *   … coller dans le Claude Project (qui contient les PDF), copier la réponse JSON …
 *   node tools/tafsir_local.mjs paste     # valide la réponse du presse-papiers, l'injecte dans data/tafsir.js,
 *                                         # puis copie aussitôt le prompt du Rub' suivant
 *
 * Autres commandes :
 *   node tools/tafsir_local.mjs status              # Rub' faits / manquants
 *   node tools/tafsir_local.mjs prompt 130          # copie le prompt d'un Rub' précis
 *   node tools/tafsir_local.mjs prompts 122-240     # écrit tous les prompts dans tools/prompts/
 *   node tools/tafsir_local.mjs ingest              # injecte tous les .json/.txt déposés dans tools/responses/inbox/
 * Option : --range 121-240 (plage suivie par next / status, défaut 121-240).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => path.join(APP, ...p);
const TAFSIR_JS = P('data', 'tafsir.js');
const PROMPTS_DIR = P('tools', 'prompts');
const RESP_DIR = P('tools', 'responses');
const INBOX = path.join(RESP_DIR, 'inbox');
const SCHEMA = 'hifz-tafsir/1';
const CARDS = ['context', 'tradition', 'language', 'tazkiya'];
const KINDS = new Set(['hadith', 'athar', 'qisas', 'citation', 'israiliyyat']);

/* ---------- Prompt : code de l'application exécuté hors navigateur ---------- */

function loadApp() {
  const ctx = vm.createContext({ window: {}, console });
  vm.runInContext(fs.readFileSync(P('data', 'quran-data.js'), 'utf8'), ctx);
  vm.runInContext(`${fs.readFileSync(P('js', 'quran.js'), 'utf8')}\nglobalThis.Q = Q;`, ctx);
  const src = fs.readFileSync(P('js', 'tafsir.js'), 'utf8');
  const start = src.indexOf('function prompt(r) {');
  const end = src.indexOf('\n  }\n', start);
  if (start < 0 || end < 0) throw new Error('fonction prompt() introuvable dans js/tafsir.js');
  vm.runInContext(`const SCHEMA = ${JSON.stringify(SCHEMA)};\n${src.slice(start, end + 4)}\nglobalThis.prompt = prompt;`, ctx);
  return ctx;
}
let app;
const promptFor = (r) => (app ||= loadApp()).prompt(r);

/* ---------- Presse-papiers (Windows, via PowerShell, en UTF-8) ---------- */

const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${cmd}`], { encoding: 'utf8', maxBuffer: 64 << 20 });

function copyFile(file) {
  ps(`Get-Content -Raw -Encoding UTF8 -LiteralPath '${file.replace(/'/g, "''")}' | Set-Clipboard`);
}
const readClipboard = () => ps('Get-Clipboard -Raw');

/* ---------- data/tafsir.js ---------- */

function readTafsir() {
  const raw = fs.readFileSync(TAFSIR_JS, 'utf8');
  const m = /window\.TAFSIR_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(raw);
  if (!m) throw new Error('data/tafsir.js : window.TAFSIR_DATA introuvable');
  let data;
  try { data = JSON.parse(m[1]); } catch {
    if (/^\{\s*schema:\s*'hifz-tafsir\/1',\s*entries:\s*\[\]\s*\}$/.test(m[1])) data = { schema: SCHEMA, entries: [] };
    else throw new Error('data/tafsir.js : contenu non JSON, format non reconnu');
  }
  return { header: raw.slice(0, m.index), entries: new Map(data.entries.map((e) => [e.rub, e])) };
}

function writeTafsir({ header, entries }) {
  const data = { schema: SCHEMA, entries: [...entries.keys()].sort((a, b) => a - b).map((r) => entries.get(r)) };
  const tmp = `${TAFSIR_JS}.tmp`;
  fs.writeFileSync(tmp, `${header}window.TAFSIR_DATA = ${JSON.stringify(data, null, 1)};\n`, 'utf8');
  fs.renameSync(tmp, TAFSIR_JS); // écriture atomique
}

/* ---------- Lecture et validation d'une réponse ---------- */

/* Même tolérance que l'Atelier : bloc ```json, texte autour, fiche seule, tableau ou { entries:[…] }. */
function parseResponse(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try { data = JSON.parse(t); } catch {
    const a = t.search(/[{[]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a < 0 || b <= a) throw new Error('aucun objet JSON trouvé (le presse-papiers contient-il bien la réponse ?)');
    try { data = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error(`JSON invalide : ${e.message}`); }
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [data];
  if (!list.length) throw new Error('aucune fiche dans la réponse');
  return list;
}

function validate(e) {
  const errs = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['la fiche doit être un objet JSON'];
  if (!Number.isInteger(e.rub) || e.rub < 1 || e.rub > 240) errs.push(`rub invalide : ${JSON.stringify(e.rub)}`);
  if (e.schema && e.schema !== SCHEMA) errs.push(`schema inattendu : ${e.schema}`);
  if (!CARDS.some((k) => Array.isArray(e[k]) && e[k].length)) errs.push('les quatre cartes sont vides');
  for (const k of CARDS) {
    if (e[k] !== undefined && !Array.isArray(e[k])) { errs.push(`${k} doit être un tableau`); continue; }
    (e[k] || []).forEach((it, i) => {
      if (!it || typeof it !== 'object' || !(it.text || it.arabic || it.title)) errs.push(`${k}[${i}] vide`);
      else if (k === 'tradition' && !KINDS.has(it.kind)) errs.push(`tradition[${i}].kind = ${JSON.stringify(it.kind)}`);
      else if (k === 'tazkiya' && !it.practice) errs.push(`tazkiya[${i}] sans « practice »`);
    });
  }
  (e.glossary || []).forEach((g, i) => { if (!g?.term || !g?.definition) errs.push(`glossary[${i}] incomplet`); });
  return errs;
}

/* Valide tout avant d'écrire quoi que ce soit ; une fiche existante du même Rub' est remplacée (pas de doublon). */
function inject(text, label) {
  const list = parseResponse(text);
  const problems = list.map((e) => [e?.rub, validate(e)]).filter(([, errs]) => errs.length);
  if (problems.length) {
    throw new Error(`${label} rejeté :\n${problems.map(([r, errs]) => `  Rub' ${r} : ${errs.join(' ; ')}`).join('\n')}`);
  }
  const store = readTafsir();
  fs.mkdirSync(RESP_DIR, { recursive: true });
  const done = [];
  for (const e of list) {
    const { importedAt, ...entry } = e; // eslint-disable-line no-unused-vars
    entry.schema = SCHEMA;
    done.push(`${entry.rub}${store.entries.has(entry.rub) ? ' (remplacé)' : ''}`);
    store.entries.set(entry.rub, entry);
    fs.writeFileSync(path.join(RESP_DIR, `rub_${String(entry.rub).padStart(3, '0')}.json`), JSON.stringify(entry, null, 2), 'utf8');
  }
  writeTafsir(store);
  const n = list.map((e) => CARDS.map((k) => (e[k] || []).length).join('/')).join(', ');
  console.log(`✓ ${label} : Rub' ${done.join(', ')} injecté(s) dans data/tafsir.js (cartes ${n})`);
  return list.map((e) => e.rub);
}

/* ---------- Commandes ---------- */

function parseRange(spec) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map((x) => parseInt(x, 10));
    for (let r = a; r <= (b || a); r++) out.add(r);
  }
  const rubs = [...out].sort((x, y) => x - y);
  if (!rubs.length || rubs.some((r) => !(r >= 1 && r <= 240))) throw new Error(`plage invalide : ${spec} (1 à 240)`);
  return rubs;
}

function writePrompt(r) {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  const file = path.join(PROMPTS_DIR, `rub_${String(r).padStart(3, '0')}.txt`);
  fs.writeFileSync(file, promptFor(r), 'utf8');
  return file;
}

function copyPrompt(r) {
  const file = writePrompt(r);
  copyFile(file);
  console.log(`📋 Prompt du Rub' ${r} copié dans le presse-papiers (${path.relative(APP, file)}).`);
  console.log('   Collez-le dans votre Claude Project, copiez la réponse JSON, puis : node tools/tafsir_local.mjs paste');
}

function nextMissing(range) {
  const have = readTafsir().entries;
  return range.find((r) => !have.has(r));
}

function status(range) {
  const have = readTafsir().entries;
  const missing = range.filter((r) => !have.has(r));
  console.log(`${range.length - missing.length}/${range.length} Rub' faits dans ${range[0]}-${range[range.length - 1]}`
    + ` (${have.size} fiches au total dans data/tafsir.js).`);
  if (missing.length) console.log(`Manquants : ${compact(missing)}`);
}

const compact = (nums) => nums.reduce((acc, n) => {
  const last = acc[acc.length - 1];
  if (last && n === last[1] + 1) last[1] = n; else acc.push([n, n]);
  return acc;
}, []).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');

function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--range');
  const range = parseRange(ri >= 0 ? args.splice(ri, 2)[1] : '121-240');
  const [cmd = 'status', arg] = args;

  switch (cmd) {
    case 'status':
      return status(range);
    case 'next': {
      const r = nextMissing(range);
      return r ? copyPrompt(r) : console.log('Tous les Rub\' de la plage sont faits.');
    }
    case 'prompt':
      return copyPrompt(parseRange(arg)[0]);
    case 'prompts': {
      const rubs = arg ? parseRange(arg) : range;
      rubs.forEach(writePrompt);
      return console.log(`${rubs.length} prompts écrits dans ${path.relative(APP, PROMPTS_DIR)}/`);
    }
    case 'paste': {
      inject(readClipboard(), 'Presse-papiers');
      const r = nextMissing(range);
      return r ? copyPrompt(r) : (console.log('🎉 Tous les Rub\' de la plage sont faits.'), status(range));
    }
    case 'ingest': {
      fs.mkdirSync(path.join(INBOX, 'done'), { recursive: true });
      const files = fs.readdirSync(INBOX).filter((f) => /\.(json|txt)$/i.test(f)).sort();
      if (!files.length) return console.log(`Aucun fichier dans ${path.relative(APP, INBOX)}/`);
      let failed = 0;
      for (const f of files) {
        try {
          inject(fs.readFileSync(path.join(INBOX, f), 'utf8'), f);
          fs.renameSync(path.join(INBOX, f), path.join(INBOX, 'done', f));
        } catch (e) { failed++; console.error(`✗ ${e.message}`); }
      }
      status(range);
      if (failed) process.exitCode = 1;
      return;
    }
    default:
      console.log('Commandes : status | next | paste | prompt <rub> | prompts [plage] | ingest   (option --range 121-240)');
      process.exitCode = 1;
  }
}

try { main(); } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
