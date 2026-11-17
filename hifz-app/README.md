# Hifz — programme de mémorisation du Coran

Application web locale, sans installation : **double-cliquez sur `index.html`** (Chrome, Edge ou Firefox).
La progression est sauvegardée automatiquement dans le navigateur (localStorage). Pensez à exporter une copie de temps en temps (Réglages → Exporter).

## Déploiement sur Netlify

Le fichier `netlify.toml` à la racine du dépôt configure Netlify pour publier `hifz-app/`, qui contient `index.html` et les ressources statiques. Aucun build ni installation de dépendances n'est nécessaire.

- Texte Uthmani, pagination Madani (604 p.) et découpage des 240 Rub' : intégrés dans `data/quran-data.js` (fonctionne hors-ligne).
- Traduction française (Muhammad Hamidullah) : affichée en cliquant sur un verset, intégrée dans `data/quran-fr.js` (hors-ligne, générée par `node tools/build-translation.mjs`).
- Audio verset par verset : EveryAyah.com (connexion internet requise).
- Pour tester un autre jour : `index.html?date=2026-10-17`.

## Structure

```
index.html            page unique (SPA, routes par #hash)
css/styles.css        thème clair / sombre, typographie arabe (Amiri Quran, Scheherazade New)
data/quran-data.js    6 236 versets + page + Rub' (généré par tools/build-data.mjs)
data/quran-fr.js      traduction française Hamidullah (générée par tools/build-translation.mjs)
js/util.js            dates locales, formatage
js/quran.js           index : sourates, pages, Rub', Hizb, Juz'
js/store.js           sauvegarde localStorage, export / import JSON
js/engine.js          planning dynamique + algorithme de révision
js/player.js          lecteur audio (répétitions, chaînage, pauses)
js/voice.js           récitation à l'aveugle au micro (Web Speech API)
js/tafsir.js          onglet Tafsir & Méditation : fiches par Rub', glossaire, prompt d'extraction IA
data/tafsir.js        fiches de tafsir livrées avec l'app (vide par défaut)
js/app.js             interface : Aujourd'hui, Atelier, Mushaf, Planning, Notes, Réglages
tools/build-data.mjs  régénère les données depuis api.quran.com (node tools/build-data.mjs)
```

## Planning

1. Ce qui reste à apprendre est découpé selon l'unité choisie (Rub' ou page) et le volume (ex. 1 Rub'/jour), dans l'ordre du Mushaf ou à l'envers (Juz' 'Amma d'abord).
2. Chaque jour d'étude (lundi–vendredi par défaut) reçoit une leçon ; les autres jours sont **réservés à la révision**.
3. Le planning est recalculé chaque jour à partir de ce qui est réellement validé : un jour manqué décale la suite, rien n'est sauté. La date de fin projetée est comparée à la prévision initiale (avance / retard).

## Algorithme de révision (Muraja'ah)

Chaque Rub' entièrement mémorisé entre dans une **boîte d'ancrage** (système de Leitner) :

| Boîte | Nom | Revient dans |
|---|---|---|
| 0 | Qarib | tous les jours pendant 7 jours |
| 1 | Fragile | 3 jours |
| 2 | En cours | 7 jours |
| 3 | Ancré | 14 jours |
| 4 | Ancré+ | 30 jours |
| 5 | Solide | 60 jours |
| 6 | Maîtrisé | 120 jours |

- **Qarib** : les leçons des 7 derniers jours sont à relire chaque jour (liste à cocher).
- **Ba'id** : au 8e jour, le Rub' arrive dans la révision lointaine. Vous le récitez de mémoire et le notez :
  - *Parfait (100 %)* → boîte suivante (après le Qarib : directement 14 jours, puis 30, 60, 120)
  - *Bon (1–2 hésitations)* → même intervalle
  - *Fragile* → boîte précédente (intervalle plus court)
  - *Oublié* → retour en boîte 0 : 7 jours de Qarib à nouveau
- La charge Ba'id quotidienne est plafonnée (auto : 2 à 8 Rub' selon le volume mémorisé). Les Rub' échus en surplus sont reportés au lendemain, du plus en retard au plus fragile.
- **Grand Examen** (jours de révision) : tous les Rub' travaillés dans les 30 derniers jours, à réciter d'une seule traite, puis noter un par un. Ces notes alimentent le même algorithme.
- **Mushaf** : vert = tous les Rub' de la page sont en boîte ≥ 3 et pas encore à réviser ; jaune = appris mais en consolidation ou à réviser ; gris = pas encore appris.

## Tafsir & Méditation

Atelier → onglet **🕯 Tafsir & Méditation**. Pour chaque Rub' du passage ouvert : 4 cartes (📜 Contexte & Révélation, 📚 Fondements traditionnels, 🔍 Subtilités de la langue, 🌱 Purification de l'âme) et 📝 **Mes méditations** (texte libre, sauvegardé automatiquement par Rub' et inclus dans l'export).
Les termes techniques (Iltifat, Balagha, Sabab al-Nuzul…) affichent une définition au survol ou au focus clavier.

L'application ne lit pas vos PDF : elle prépare le travail pour un **Claude Project** qui les contient.
1. **🎯 Générer le prompt d'extraction IA pour ce Rub'** : copie un prompt avec la sourate, les versets exacts, le texte arabe du Rub' et le format JSON attendu.
2. Collez-le dans le Claude Project, puis collez sa réponse dans « Intégrer la réponse » (ou importez un `tafsir.json` contenant une ou plusieurs fiches).
3. Les fiches sont conservées dans le navigateur (IndexedDB). **Exporter en data/tafsir.js** produit un fichier à déposer dans `data/` pour les livrer avec l'application.

Le prompt interdit à l'IA d'inventer : chaque élément doit citer sa source (ouvrage, tome, page) et une carte sans matière dans les PDF reste vide. Vérifiez néanmoins les références des hadiths avant de vous y appuyer.

## Récitation à l'aveugle au micro

Atelier → **🎙 Récitation au micro** (Chrome ou Edge, connexion internet requise pour la reconnaissance vocale).

- Le texte est remplacé par des lignes vides ; seuls les numéros de versets restent visibles.
- Reconnaissance : `SpeechRecognition` en arabe (`ar-SA` par défaut, variante modifiable), `continuous = true`, `interimResults = true`. Chrome coupe la session après un long silence : elle est relancée automatiquement.
- Normalisation (`normalizeArabic`, appliquée au Mushaf ET au micro) : suppression du tashkeel, des signes de pause et de l'alif suscrit, Alif unifiés (أ إ آ ٱ → ا), ة ≡ ه, ى → ي, hamza unifiée, ponctuation et doubles espaces retirés. Pour comparer, chaque mot est ensuite réduit à un squelette sans alif (le rasm Uthmani l'omet souvent).
- Correspondance glissante :
  1. le mot attendu est comparé avec souplesse (1 à 3 lettres d'écart) → affiché normalement, jamais en rouge ;
  2. un mot avalé par la reconnaissance est toléré (les petits mots « و », « في », « من » ne passent pas en rouge) ;
  3. un saut jusqu'à 10 mots en avant n'est accepté que si la correspondance est stricte ET confirmée par le mot entendu suivant ; les mots sautés passent en rouge ;
  4. un autre verset récité ou une phrase répétée ne fait jamais avancer le pointeur ; après 3 mots non reconnus, une séquence de 3 mots est cherchée plus loin dans le passage (saut d'un passage entier) ;
  5. le rouge n'est appliqué qu'aux résultats définitifs de la reconnaissance (pas aux résultats intermédiaires, qui changent).
- L'isti'adha et la basmala dites avant de commencer sont ignorées.
- **Mode Ancrage** : le texte se dévoile définitivement. **Mode Flash** : seul le verset en cours est visible, les précédents s'estompent après 2,5 s.
- Silence de plus de 5 s : le bouton micro clignote. **Besoin d'aide** (touche H) dévoile uniquement le mot suivant. Clic sur un verset → « Reprendre la récitation ici ».
- Lettres isolées : les noms de lettres dictés (« ألف لام ميم », « حا ميم », « كاف ها يا عين صاد », « نون », « قاف »…) sont recomposés avant comparaison (الٓمٓ, حمٓ, كٓهيعٓصٓ, نٓ, قٓ). Les lettres répétées d'un madd prolongé sont réduites.
- En fin de passage, le micro se coupe et une fenêtre de notation s'ouvre (Parfait / Bon / Fragile / Oublié, avec une note suggérée selon les aides et les mots non détectés). Les Rub' déjà mémorisés et récités au moins à 50 % sont cochés : la note est appliquée à leur boîte d'ancrage (même règle que le Ba'id) et compte comme leur révision Ba'id du jour. Chaque récitation notée est aussi gardée dans l'historique (`recitations`, localStorage).
- Sans reconnaissance vocale (Firefox) : le bouton « Besoin d'aide » / touche H dévoile le texte mot à mot, et la notation de fin fonctionne de la même façon.
