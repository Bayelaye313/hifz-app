// Génère data/quran-data.js à partir de l'API Quran.com (v4).
// Usage : node tools/build-data.mjs   (depuis le dossier hifz-app)
import { writeFile } from 'node:fs/promises';

const API = 'https://api.quran.com/api/v4';
const get = async (url) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error('Échec : ' + url);
};

const { chapters } = await get(`${API}/chapters?language=fr`);
const { verses: textVerses } = await get(`${API}/quran/verses/uthmani`);
const text = new Map(textVerses.map((v) => [v.verse_key, v.text_uthmani]));

const meta = new Map();
async function loadChapter(ch) {
  let page = 1;
  while (page) {
    const r = await get(`${API}/verses/by_chapter/${ch.id}?per_page=50&page=${page}&fields=page_number,rub_el_hizb_number`);
    for (const v of r.verses) meta.set(v.verse_key, [v.page_number, v.rub_el_hizb_number]);
    page = r.pagination.next_page;
  }
}
const queue = [...chapters];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) await loadChapter(queue.shift());
}));

const surahs = chapters.map((c) => [c.name_arabic, c.name_simple, c.translated_name.name, c.verses_count, c.revelation_place]);
const pages = [], rubs = [], texts = [];
for (const c of chapters) {
  for (let a = 1; a <= c.verses_count; a++) {
    const key = `${c.id}:${a}`;
    const m = meta.get(key);
    if (!m || !text.has(key)) throw new Error('Verset manquant ' + key);
    pages.push(m[0]); rubs.push(m[1]); texts.push(text.get(key));
  }
}
if (texts.length !== 6236) throw new Error('Nombre de versets inattendu : ' + texts.length);
if (Math.max(...pages) !== 604 || Math.max(...rubs) !== 240) throw new Error('Découpage inattendu');

const out = `/* Données coraniques — texte Uthmani, pages (Mushaf Madani 604 p.) et Rub' al-Hizb.
   Source : api.quran.com (v4). Généré par tools/build-data.mjs */
window.QURAN_DATA = ${JSON.stringify({ surahs, pages, rubs, text: texts })};
`;
await writeFile(new URL('../data/quran-data.js', import.meta.url), out, 'utf8');
console.log(`OK : ${texts.length} versets, ${surahs.length} sourates, ${(out.length / 1024).toFixed(0)} Ko`);
