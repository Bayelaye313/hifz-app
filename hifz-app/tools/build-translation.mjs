// Génère data/quran-fr.js : traduction française (Muhammad Hamidullah) depuis l'API Quran.com (v4).
// Usage : node tools/build-translation.mjs   (depuis le dossier hifz-app)
import { writeFile } from 'node:fs/promises';

const API = 'https://api.quran.com/api/v4';
const TRANSLATION = 31; // Muhammad Hamidullah
const get = async (url) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error('Échec : ' + url);
};

// Retire les appels de notes (<sup foot_note=…>1</sup>) et toute autre balise
const clean = (s) => s.replace(/<sup[^>]*>.*?<\/sup>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const { chapters } = await get(`${API}/chapters`);
const fr = [];
for (const c of chapters) {
  const { translations } = await get(`${API}/quran/translations/${TRANSLATION}?chapter_number=${c.id}`);
  if (translations.length !== c.verses_count) throw new Error(`Sourate ${c.id} : ${translations.length} versets au lieu de ${c.verses_count}`);
  fr.push(...translations.map((t) => clean(t.text)));
}
if (fr.length !== 6236) throw new Error('Nombre de versets inattendu : ' + fr.length);

const out = `/* Traduction française du Coran — Muhammad Hamidullah.
   Source : api.quran.com (v4). Généré par tools/build-translation.mjs */
window.QURAN_FR = ${JSON.stringify(fr)};
`;
await writeFile(new URL('../data/quran-fr.js', import.meta.url), out, 'utf8');
console.log(`OK : ${fr.length} versets, ${(out.length / 1024).toFixed(0)} Ko`);
