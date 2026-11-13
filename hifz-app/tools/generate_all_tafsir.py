#!/usr/bin/env python3
"""Génération automatique des 240 fiches Tafsir & Méditation -> data/tafsir.js

Pipeline (chaque étape est reprenable après une interruption) :

  1. Métadonnées des 240 Rub' : lues dans data/quran-data.js (la source de l'application,
     api.quran.com) -> versets de début/fin, sourates, pages du Mushaf de Médine, Hizb, Juz'.
  2. Index des pages : les grands tafsirs de TAFSIR/ (Ibn Ashur, Al-Jalalayn, Al-Talkhis…) sont des
     PDF SCANNÉS, sans couche texte : pypdf/pdfplumber n'en extraient rien. Le script échantillonne
     donc une page sur INDEX_STEP, demande à Claude (vision) quels versets elle commente, et garde
     le résultat dans tools/.tafsir_cache/page_index.json. Coût unique, puis réutilisé.
  3. Génération pas à pas : pour chaque Rub', les pages concernées de chaque ouvrage sont découpées
     en un petit PDF et envoyées à Claude avec un prompt strict ; la réponse est contrainte par un
     schéma JSON (structured outputs) puis validée. Chaque fiche validée est écrite aussitôt dans
     tools/temp_tafsir_progress.json : une relance reprend aux Rub' manquants.
  4. Export : data/tafsir.js au format attendu par js/tafsir.js
     (window.TAFSIR_DATA = { schema, entries: [...] }).

Usage :
  python tools/generate_all_tafsir.py --check          # vérifie l'environnement, sans appel API
  python tools/generate_all_tafsir.py                  # index + génération + export, Rub' 121-240 par défaut
  python tools/generate_all_tafsir.py --rubs 1-8       # autres Rub'
  python tools/generate_all_tafsir.py --dry-run        # pages retenues par Rub', sans générer
  python tools/generate_all_tafsir.py --export-only --export-partial
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

try:
    import anthropic
    import pymupdf
    from dotenv import load_dotenv
    from PIL import Image
except ImportError as e:
    sys.exit(f"Dépendance manquante ({e.name}). Installez-les : pip install -r tools/requirements.txt")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

APP_DIR = Path(__file__).resolve().parent.parent          # hifz-app/
TAFSIR_DIR = APP_DIR / "TAFSIR"
QURAN_DATA = APP_DIR / "data" / "quran-data.js"
OUTPUT_JS = APP_DIR / "data" / "tafsir.js"
PROGRESS_FILE = APP_DIR / "tools" / "temp_tafsir_progress.json"
CACHE_DIR = APP_DIR / "tools" / ".tafsir_cache"
INDEX_FILE = CACHE_DIR / "page_index.json"
UPLOADS_FILE = CACHE_DIR / "uploads.json"

load_dotenv(APP_DIR / ".env")
load_dotenv()  # .env du répertoire courant, si présent

MODEL = os.getenv("TAFSIR_MODEL", "claude-opus-5-5")
EFFORT = os.getenv("TAFSIR_EFFORT", "high")                # low | medium | high | xhigh | max
INDEX_MODEL = os.getenv("TAFSIR_INDEX_MODEL", "claude-opus-5-5")
INDEX_STEP = int(os.getenv("TAFSIR_INDEX_STEP", "6"))      # une page échantillonnée sur N
INDEX_WORKERS = int(os.getenv("TAFSIR_INDEX_WORKERS", "6"))
USE_FALLBACKS = os.getenv("TAFSIR_FALLBACKS", "1") == "1"  # repli serveur en cas de refus
MAX_TOKENS = 32000
DEFAULT_RUBS = "121-240"                                   # seconde moitié : Al-Kahf 18:75 -> An-Nas
# Vision : ~largeur x hauteur / 750 jetons par image (jusqu'à ~4800 en haute résolution).
# 800 px de large en niveaux de gris ≈ 1200 jetons par page scannée.
IMG_MAX_WIDTH = int(os.getenv("TAFSIR_IMG_WIDTH", "800"))
IMG_QUALITY = int(os.getenv("TAFSIR_IMG_QUALITY", "68"))
MAX_REQUEST_B64 = 28 * 1024 * 1024                         # la limite API est 32 Mo par requête

SCHEMA_ID = "hifz-tafsir/1"
CARDS = ("context", "tradition", "language", "tazkiya")
KINDS = ("hadith", "athar", "qisas", "citation", "israiliyyat")


@dataclass(frozen=True)
class Book:
    key: str
    pattern: str        # glob dans TAFSIR/ (plusieurs fichiers = plusieurs tomes, triés par nom)
    title: str
    mode: str           # 'indexed' : suit l'ordre du Mushaf, on envoie les pages du Rub'
                        # 'static'  : ouvrage thématique court, envoyé en entier (mis en cache)
    role: str           # carte(s) que l'ouvrage alimente, rappelé au modèle
    max_pages: int = 0  # plafond de pages par Rub' (mode 'indexed')


BOOKS = [
    Book("ibn_ashur", "تفسير_التحرير_والتنوير_ابن_عاشور_*.pdf",
         "Al-Tahrir wa al-Tanwir — Muhammad al-Tahir Ibn Ashur", "indexed",
         "language (balagha) en priorité, aussi context et tradition", 60),
    Book("jalalayn", "تفسير الجلالين*.pdf",
         "Tafsir al-Jalalayn — Jalal al-Din al-Mahalli et Jalal al-Din al-Suyuti (manuscrit annoté)", "indexed",
         "context (sens littéral, asbab al-nuzul)", 10),
    Book("talkhis", "التلخيص_في_تفسير_القران_العظيم_*.pdf",
         "Al-Talkhis fi Tafsir al-Qur'an al-'Azim", "indexed",
         "context et tradition", 16),
    Book("zubda", "تفسير_زبدة_المعاني*.pdf",
         "Zubdat al-Ma'ani — Pr. Muhammad Abu Zayd Abu Zayd", "indexed",
         "context", 8),
    Book("tadabbur", "تفسير القرآن الكريم وتدبره*.pdf",
         "Tafsir al-Qur'an al-Karim wa Tadabburuh", "indexed",
         "tazkiya (tadabbur) et context", 10),
    Book("hajj", "شرح تفسير آيات الحج.pdf",
         "Sharh Tafsir Ayat al-Hajj", "indexed",
         "context et tradition (versets du pèlerinage)", 12),
    Book("ibn_taymiyya", "فصل في تزكية النفس*.pdf",
         "Fasl fi Tazkiyat al-Nafs — Ibn Taymiyya", "static", "tazkiya"),
    Book("ibn_saadi", "الفوائد_المستنبطة_من_القصص_القرآنية*.pdf",
         "Al-Fawa'id al-Mustanbata min al-Qisas al-Qur'aniyya, d'après le Tafsir d'Ibn Sa'di", "static",
         "tazkiya et tradition (qisas)"),
]
# Non utilisés automatiquement (thématiques et volumineux, ou hors sujet pour les fiches) :
# Tafsir al-Tabi'in (étude de méthodologie, 2 vol.), Manhaj al-Islam fi Tazkiyat al-Nafs (704 p.),
# Ta'wil Mushkil al-Qur'an (14945.pdf en est un doublon), Rasa'il Sufiyya, Tazkiyat al-Nafs 'inda
# al-Muhtasib, 'Ulum al-Qur'an, Adab / Maharat tadris al-Qur'an. Ajoutez une entrée Book pour les inclure.


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    """Écriture atomique : un arrêt brutal ne laisse jamais un fichier à moitié écrit."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# 1. Métadonnées du Coran et des 240 Rub'
# ---------------------------------------------------------------------------

class Quran:
    """Index global des 6236 versets (0-based) construit depuis data/quran-data.js."""

    def __init__(self, path: Path):
        raw = path.read_text(encoding="utf-8")
        m = re.search(r"window\.QURAN_DATA\s*=\s*(\{.*\})\s*;?\s*$", raw, re.S)
        if not m:
            raise SystemExit(f"Format inattendu : {path}")
        d = json.loads(m.group(1))
        self.surahs = d["surahs"]          # [arabe, translittération, français, nb versets, type]
        self.text, self.pages, self.rubs = d["text"], d["pages"], d["rubs"]
        self.surah_of, self.ayah_of, self.offset = [], [], []
        for s, info in enumerate(self.surahs, start=1):
            self.offset.append(len(self.surah_of))
            for a in range(1, info[3] + 1):
                self.surah_of.append(s)
                self.ayah_of.append(a)
        n = len(self.surah_of)
        if not (n == len(self.text) == len(self.pages) == len(self.rubs) == 6236):
            raise SystemExit("quran-data.js incohérent (6236 versets attendus).")

    def verse(self, surah: int, ayah: int) -> int | None:
        if 1 <= surah <= 114 and 1 <= ayah <= self.surahs[surah - 1][3]:
            return self.offset[surah - 1] + ayah - 1
        return None

    def key(self, v: int) -> str:
        return f"{self.surah_of[v]}:{self.ayah_of[v]}"

    def rub_metadata(self) -> dict[int, dict]:
        """Table stricte des 240 Rub' : versets, sourates, pages du Mushaf de Médine, Hizb, Juz'."""
        bounds: dict[int, list[int]] = {}
        for v, r in enumerate(self.rubs):
            bounds.setdefault(r, [v, v])[1] = v
        if sorted(bounds) != list(range(1, 241)):
            raise SystemExit("quran-data.js : les 240 Rub' ne sont pas tous présents.")
        meta = {}
        for r, (a, b) in bounds.items():
            segments = []  # une entrée par sourate traversée
            for v in range(a, b + 1):
                s = self.surah_of[v]
                if segments and segments[-1]["surah"] == s:
                    segments[-1]["to"] = self.ayah_of[v]
                else:
                    segments.append({"surah": s, "name": self.surahs[s - 1][1], "name_ar": self.surahs[s - 1][0],
                                     "from": self.ayah_of[v], "to": self.ayah_of[v]})
            p1, p2 = self.pages[a], self.pages[b]
            ref = " ; ".join(f"{x['name']} {x['surah']}:{x['from']}-{x['to']}" for x in segments)
            meta[r] = {
                "rub": r, "hizb": (r + 3) // 4, "juz": (r + 7) // 8,
                "first": a, "last": b, "start": self.key(a), "end": self.key(b),
                "segments": segments, "page_start": p1, "page_end": p2,
                "reference": f"{ref} · p. {p1}" + (f"-{p2}" if p2 != p1 else ""),
            }
        return meta


# ---------------------------------------------------------------------------
# PDF : rendu des pages scannées
# ---------------------------------------------------------------------------

def book_files(book: Book) -> list[Path]:
    return sorted(TAFSIR_DIR.glob(book.pattern))


def page_jpeg(page, dpi: int) -> bytes:
    """Rendu en niveaux de gris : le texte reste net, le poids est divisé par ~3."""
    return page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY).tobytes("jpeg", jpg_quality=72)


def page_image(page) -> bytes:
    """Page scannée -> JPEG compact pour la vision (Pillow) : niveaux de gris, largeur <= IMG_MAX_WIDTH, ratio conservé."""
    width = min(IMG_MAX_WIDTH, round(page.rect.width * 100 / 72))  # jamais plus large qu'un rendu à 100 dpi
    pix = page.get_pixmap(dpi=round(72 * 2 * width / page.rect.width),  # rendu à 2x, puis réduction Lanczos
                          colorspace=pymupdf.csGRAY, alpha=False)
    img = Image.frombytes("L", (pix.width, pix.height), pix.samples).convert("L")
    img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, "JPEG", quality=IMG_QUALITY, optimize=True)
    return buf.getvalue()


def compact_pdf(path: Path, pages: list[int], dpi: int) -> bytes:
    """Nouveau PDF ne contenant que `pages`, rééchantillonnées (les scans d'origine pèsent jusqu'à 600 Ko/page)."""
    out = pymupdf.open()
    with pymupdf.open(path) as src:
        for p in pages:
            pg = src[p]
            new = out.new_page(width=pg.rect.width, height=pg.rect.height)
            new.insert_image(new.rect, stream=page_jpeg(pg, dpi))
    data = out.tobytes(garbage=3, deflate=True)
    out.close()
    return data


# ---------------------------------------------------------------------------
# 2. Index des pages des tafsirs scannés
# ---------------------------------------------------------------------------

PROBE_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "surah": {"type": "integer"},
        "first_ayah": {"type": "integer"},
        "last_ayah": {"type": "integer"},
    },
    "required": ["found", "surah", "first_ayah", "last_ayah"],
    "additionalProperties": False,
}

PROBE_PROMPT = (
    "Cette image est une page scannée d'un livre de tafsir (exégèse du Coran) en arabe. "
    "Identifie les versets coraniques que cette page commente dans son texte principal : appuie-toi sur "
    "l'en-tête courant (nom de sourate, numéros de versets) et sur les citations coraniques commentées "
    "(ignore les gloses marginales et les versets cités en simple appui d'une autre sourate). "
    "Donne le numéro de la sourate (1 à 114) et le premier et le dernier verset commentés sur la page. "
    "Page de titre, introduction, table des matières, page illisible ou sans verset identifiable : "
    "found=false et 0 pour les nombres."
)


class PageIndex:
    """Pour chaque fichier : {page échantillonnée: [verset global min, max] ou None}."""

    def __init__(self, client: anthropic.Anthropic, quran: Quran):
        self.client, self.quran = client, quran
        self.data = load_json(INDEX_FILE, {})

    def _probe(self, jpeg: bytes) -> list[int] | None:
        resp = self.client.messages.create(
            model=INDEX_MODEL,
            max_tokens=4000,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": PROBE_SCHEMA}},
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                             "data": base64.standard_b64encode(jpeg).decode()}},
                {"type": "text", "text": PROBE_PROMPT},
            ]}],
        )
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            r = json.loads(text) if resp.stop_reason == "end_turn" else None
        except json.JSONDecodeError:
            r = None
        if not r:
            return None
        if not r["found"]:
            return None
        a, b = sorted((r["first_ayah"], r["last_ayah"]))
        va, vb = self.quran.verse(r["surah"], max(a, 1)), self.quran.verse(r["surah"], b)
        return [va, vb] if va is not None and vb is not None else None

    def build(self, books: list[Book], min_verse: int = 0) -> None:
        """Échantillonne une page sur INDEX_STEP pour chaque tome ; reprend là où il s'était arrêté.
        Les pages qui précèdent min_verse (premier verset des Rub' demandés) ne sont pas identifiées."""
        try:
            self._build(books, min_verse)
        except anthropic.AuthenticationError:
            raise Stop("Clé API invalide : vérifiez ANTHROPIC_API_KEY dans .env.")
        except anthropic.APIError as e:  # pages déjà identifiées : sauvegardées par lot
            raise Stop(f"Indexation interrompue ({type(e).__name__} : {getattr(e, 'message', e)}).")

    @staticmethod
    def _floor(probes: dict, min_verse: int) -> int:
        """Page sous laquelle l'échantillonnage est inutile : la 2e plus haute page entièrement avant min_verse
        (deux lectures concordantes, pour ne pas s'arrêter sur une page aberrante)."""
        low = sorted(int(p) for p, v in probes.items() if v and v[1] < min_verse)
        return low[-2] if min_verse > 0 and len(low) >= 2 else -1

    def _build(self, books: list[Book], min_verse: int) -> None:
        for book in books:
            for path in book_files(book):
                with pymupdf.open(path) as doc:
                    n = doc.page_count
                    entry = self.data.setdefault(path.name, {"pages": n, "step": INDEX_STEP, "probes": {}})
                    probes = entry["probes"]
                    # de la fin du tome vers le début : un tome qui précède la plage coûte un seul lot
                    todo = [p for p in reversed(range(0, n, INDEX_STEP))
                            if str(p) not in probes and p > self._floor(probes, min_verse)]
                    if not todo:
                        continue
                    log(f"Index {book.key} / {path.name} : jusqu'à {len(todo)} pages à identifier (sur {n})")
                    done = 0
                    with ThreadPoolExecutor(INDEX_WORKERS) as pool:
                        while todo:
                            batch, todo = todo[:INDEX_WORKERS * 4], todo[INDEX_WORKERS * 4:]
                            # pymupdf n'est pas thread-safe : rendu ici (pendant que les appels déjà
                            # soumis s'exécutent), appels API en parallèle
                            futures = [(p, pool.submit(self._probe, page_image(doc[p]))) for p in batch]
                            for p, fut in futures:
                                probes[str(p)] = fut.result()
                            save_json(INDEX_FILE, self.data)
                            done += len(batch)
                            floor = self._floor(probes, min_verse)
                            todo = [p for p in todo if p > floor]
                            log(f"  … {done} identifiées" + ("" if todo else " (terminé)"))

    def pages_for(self, path: Path, first: int, last: int) -> list[int]:
        """Pages du tome qui commentent les versets globaux [first, last] (marge d'un pas de part et d'autre)."""
        entry = self.data.get(path.name)
        if not entry:
            return []
        n, step = entry["pages"], entry["step"]
        samples = sorted((int(p), v) for p, v in entry["probes"].items() if v)
        # écarte les lectures aberrantes (page d'appui citant une autre sourate, erreur de lecture) :
        # un échantillon plus bas que ses deux voisins, ou plus haut que les deux, n'est pas fiable
        clean = [s for i, s in enumerate(samples)
                 if not (0 < i < len(samples) - 1 and
                         (s[1][0] < samples[i - 1][1][0] and s[1][0] < samples[i + 1][1][0] or
                          s[1][0] > samples[i - 1][1][0] and s[1][0] > samples[i + 1][1][0]))]
        if not clean or max(v[1] for _, v in clean) < first or min(v[0] for _, v in clean) > last:
            return []  # ce tome ne couvre pas le passage
        before = [p for p, v in clean if v[1] < first]
        after = [p for p, v in clean if v[0] > last]
        start = max(before) + 1 if before else max(0, clean[0][0] - step)
        end = min(after) - 1 if after else min(n - 1, clean[-1][0] + step)
        return list(range(start, end + 1)) if end >= start else []


# ---------------------------------------------------------------------------
# 3. Prompt système et schéma de sortie
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """Rôle : spécialiste des sciences du Coran (tafsir, hadith, balagha, tazkiya), pédagogue francophone.
Tâche : fiche d'étude d'UN Rub' pour une application de mémorisation, tirée EXCLUSIVEMENT des pages scannées jointes (ouvrages arabes). Pages hors passage : ignorées.

Fidélité (absolue) :
1. Rien hors des pages jointes : aucun hadith, athar, récit, explication, jugement ou référence ajouté de mémoire.
2. Rien pour une carte -> []. Carte vide > carte inventée.
3. source = ouvrage, tome, page imprimée si visible (« Al-Tahrir wa al-Tanwir, t. 3, p. 300 »).
4. Hadith : attribution et grade tels que la source les donne, sinon « non précisé ». hadith = parole du Prophète ﷺ ; athar = Compagnon ou Tabi'i ; isra'iliyyat signalées.
5. Ouvrage de tazkiya ne citant pas ces versets : seulement si le thème correspond clairement, en précisant que le rapprochement vient de la fiche.
6. Scans : texte principal seulement ; notes marginales manuscrites (Jalalayn) trop petites ou douteuses -> ignorées. Mot illisible -> ne pas deviner.

Sortie : un objet JSON de type Fiche, rien d'autre.
type Item = {
  title: string; verses: string;  // "18:83" | "18:83-98"
  arabic: string;                 // arabe cité (verset, hadith, mot étudié), jamais dans text
  text: string; source: string;
  practice: string;               // tazkiya : application concrète pour la semaine, 1 phrase ; sinon ""
  kind: "" | "hadith" | "athar" | "qisas" | "citation" | "israiliyyat";  // tradition seulement
  grade: string;                  // hadith seulement
};
type Fiche = {
  schema: "hifz-tafsir/1"; rub: number; reference: string; sources: string[];
  context: Item[];    // asbab al-nuzul, période mecquoise/médinoise, sens général (Jalalayn + autres) ; début de sourate -> ses thèmes
  tradition: Item[];  // hadiths, athar, qisas, citations des commentateurs
  language: Item[];   // Ibn Ashur d'abord : tournure (arabic), sens littéral, pourquoi ce choix (ordre, ellipse, emphase, iltifat, rime…), apport au sens
  tazkiya: Item[];    // leçons spirituelles tirées par les documents
  glossary: { term: string; definition: string }[];  // tout terme [[…]] peu courant
};
Couverture : tout le Rub', 2-6 items par carte si possible, plus utiles d'abord.
Style : français simple pour non-arabisant, phrases courtes, paragraphes séparés par \\n\\n, translittération simple (« rahma »), notions expliquées. Termes techniques en [[ ]] ([[Iltifat]], [[Sabab al-Nuzul]]). Champ sans objet : ""."""

ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "verses": {"type": "string"},
        "arabic": {"type": "string"},
        "text": {"type": "string"},
        "practice": {"type": "string"},
        "source": {"type": "string"},
        "kind": {"type": "string", "enum": ["", *KINDS]},
        "grade": {"type": "string"},
    },
    "required": ["title", "verses", "arabic", "text", "practice", "source", "kind", "grade"],
    "additionalProperties": False,
}

ENTRY_SCHEMA = {
    "type": "object",
    "properties": {
        "schema": {"type": "string", "enum": [SCHEMA_ID]},
        "rub": {"type": "integer"},
        "reference": {"type": "string"},
        "sources": {"type": "array", "items": {"type": "string"}},
        **{card: {"type": "array", "items": ITEM_SCHEMA} for card in CARDS},
        "glossary": {"type": "array", "items": {
            "type": "object",
            "properties": {"term": {"type": "string"}, "definition": {"type": "string"}},
            "required": ["term", "definition"],
            "additionalProperties": False,
        }},
    },
    "required": ["schema", "rub", "reference", "sources", *CARDS, "glossary"],
    "additionalProperties": False,
}


def clean_entry(raw: dict, meta: dict) -> dict:
    """Même validation que clean() dans js/tafsir.js : champs vides retirés, au moins une carte remplie."""
    def s(v, limit):
        return v.strip()[:limit] if isinstance(v, str) else ""

    out = {"schema": SCHEMA_ID, "rub": meta["rub"], "reference": meta["reference"],
           "sources": [x for x in (s(v, 200) for v in raw.get("sources", [])) if x][:20],
           "generatedAt": now_iso(), "model": MODEL}
    for card in CARDS:
        items = []
        for it in raw.get(card, []):
            o = {f: s(it.get(f), 6000) for f in ITEM_SCHEMA["properties"]}
            o = {k: v for k, v in o.items() if v}
            if o.get("text") or o.get("arabic") or o.get("title"):
                items.append(o)
        out[card] = items[:30]
    out["glossary"] = [g for g in ({"term": s(x.get("term"), 60), "definition": s(x.get("definition"), 600)}
                                   for x in raw.get("glossary", [])) if g["term"] and g["definition"]][:60]
    if not any(out[c] for c in CARDS):
        raise ValueError("aucune des quatre cartes ne contient de donnée")
    return out


# ---------------------------------------------------------------------------
# Documents envoyés à l'API
# ---------------------------------------------------------------------------

class Documents:
    def __init__(self, client: anthropic.Anthropic, index: PageIndex):
        self.client, self.index = client, index
        self.uploads = load_json(UPLOADS_FILE, {})

    def static_blocks(self) -> list[dict]:
        """Ouvrages thématiques envoyés en entier via la Files API (téléversés une seule fois)."""
        blocks = []
        for book in (b for b in BOOKS if b.mode == "static"):
            for path in book_files(book):
                fid = self.uploads.get(path.name)
                if not fid:
                    with pymupdf.open(path) as doc:
                        n = doc.page_count
                    log(f"Téléversement de {path.name} ({n} pages)…")
                    data = compact_pdf(path, list(range(n)), 110)
                    fid = self.client.files.upload(file=(f"{book.key}.pdf", data, "application/pdf")).id
                    self.uploads[path.name] = fid
                    save_json(UPLOADS_FILE, self.uploads)
                blocks.append({"type": "document", "source": {"type": "file", "file_id": fid},
                               "title": book.title,
                               "context": f"Ouvrage thématique complet, utile pour : {book.role}."})
        if blocks:  # tout ce qui précède est identique d'un Rub' à l'autre -> mis en cache
            blocks[-1]["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
        return blocks

    def forget_uploads(self) -> None:
        self.uploads = {}
        save_json(UPLOADS_FILE, self.uploads)

    def selection(self, meta: dict) -> list[tuple[Book, Path, list[int]]]:
        sel = []
        for book in (b for b in BOOKS if b.mode == "indexed"):
            for path in book_files(book):
                pages = self.index.pages_for(path, meta["first"], meta["last"])
                if pages:
                    if len(pages) > book.max_pages:
                        log(f"  ⚠ {book.key}/{path.name} : {len(pages)} pages, limitées à {book.max_pages}")
                        pages = pages[:book.max_pages]
                    sel.append((book, path, pages))
        return sel

    def rub_blocks(self, meta: dict) -> list[dict]:
        """Pages du Rub' en images compactes (page_image) plutôt qu'en PDF : coût vision maîtrisé page par page."""
        blocks, size = [], 0
        for book, path, pages in self.selection(meta):
            tome = re.search(r"(\d+|[١-٩])\.pdf$", path.name)
            blocks.append({"type": "text",
                           "text": f"## {book.title}" + (f" — tome {tome.group(1)}" if tome else "")
                                   + f"\nPDF « {path.name} », p. {pages[0] + 1}-{pages[-1] + 1}. Utile pour : {book.role}."})
            with pymupdf.open(path) as doc:
                for p in pages:
                    data = base64.standard_b64encode(page_image(doc[p])).decode()
                    size += len(data)
                    blocks.append({"type": "text", "text": f"[p. {p + 1}]"})
                    blocks.append({"type": "image",
                                   "source": {"type": "base64", "media_type": "image/jpeg", "data": data}})
        if size > MAX_REQUEST_B64:
            raise ValueError(f"images trop volumineuses pour une requête ({size // 2**20} Mo)")
        return blocks


def user_text(meta: dict, quran: Quran) -> str:
    scope = "\n".join(
        f"- Sourate {x['name']} (n° {x['surah']}, {x['name_ar']}) : versets {x['from']} à {x['to']}"
        + (" — début de la sourate" if x["from"] == 1 else "")
        + (" — fin de la sourate" if x["to"] == quran.surahs[x["surah"] - 1][3] else "")
        for x in meta["segments"])
    verses = "\n".join(f"({quran.key(v)}) {quran.text[v]}" for v in range(meta["first"], meta["last"] + 1))
    return f"""## Passage ciblé : Rub' {meta['rub']} (Hizb {meta['hizb']}, Juz' {meta['juz']}), pages {meta['page_start']} à {meta['page_end']} du Mushaf de Médine
{scope}
Référence : {meta['reference']} ({meta['last'] - meta['first'] + 1} versets)

Texte du passage (pour repérer les bons passages dans les documents) :
{verses}

Rédige la fiche du Rub' {meta['rub']} ("rub": {meta['rub']}, "schema": "{SCHEMA_ID}") à partir des documents joints."""


# ---------------------------------------------------------------------------
# 3 bis. Génération d'une fiche
# ---------------------------------------------------------------------------

class Stop(Exception):
    """Erreur qui impose d'arrêter le script (réseau, quota, configuration) : la progression est déjà sauvée."""


def generate(client: anthropic.Anthropic, docs: Documents, quran: Quran, meta: dict) -> tuple[dict, dict]:
    content = docs.static_blocks() + docs.rub_blocks(meta) + [{"type": "text", "text": user_text(meta, quran)}]
    params = dict(
        model=MODEL, max_tokens=MAX_TOKENS,
        # préfixe figé (système + ouvrages statiques) : relu depuis le cache à 0,1x le prix d'entrée
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
        thinking={"type": "adaptive"},
        output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": ENTRY_SCHEMA}},
        messages=[{"role": "user", "content": content}],
    )
    if USE_FALLBACKS:
        params.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    with client.beta.messages.stream(**params) as stream:
        msg = stream.get_final_message()

    if msg.stop_reason == "refusal":
        raise ValueError(f"refus du modèle ({getattr(msg.stop_details, 'category', None)})")
    if msg.stop_reason == "max_tokens":
        raise ValueError("réponse tronquée (max_tokens atteint)")
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    entry = clean_entry(json.loads(text), meta)
    u = msg.usage
    usage = {"input": u.input_tokens, "output": u.output_tokens,
             "cache_read": u.cache_read_input_tokens or 0, "cache_write": u.cache_creation_input_tokens or 0}
    return entry, usage


def run_generation(client, docs: Documents, quran: Quran, metas: dict, rubs: list[int], progress: dict) -> None:
    entries, failed = progress["entries"], progress["failed"]
    todo = [r for r in rubs if str(r) not in entries]
    log(f"{len(entries)} fiches déjà validées ; {len(todo)} à générer.")
    for i, r in enumerate(todo, 1):
        meta = metas[r]
        log(f"Rub' {r} ({i}/{len(todo)}) — {meta['reference']}")
        for attempt in (1, 2):
            try:
                t0 = time.time()
                entry, usage = generate(client, docs, quran, meta)
            except (ValueError, json.JSONDecodeError) as e:      # fiche invalide : on réessaie une fois
                log(f"  ✗ tentative {attempt} : {e}")
                failed[str(r)] = str(e)
                continue
            except anthropic.AuthenticationError:
                raise Stop("Clé API invalide : vérifiez ANTHROPIC_API_KEY dans .env.")
            except anthropic.BadRequestError as e:
                if "file" in str(e.message).lower() and docs.uploads:  # fichier téléversé expiré ou supprimé
                    log("  Fichiers téléversés introuvables : nouveau téléversement.")
                    docs.forget_uploads()
                    continue
                raise Stop(f"Requête refusée par l'API : {e.message}")
            except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError) as e:
                raise Stop(f"Erreur réseau ou quota après plusieurs essais ({type(e).__name__}).")
            except anthropic.APIError as e:  # modèle inconnu, droits insuffisants, requête trop lourde…
                raise Stop(f"{type(e).__name__} : {getattr(e, 'message', e)}")
            entries[str(r)] = entry
            failed.pop(str(r), None)
            totals = progress.setdefault("usage", {})
            for k, v in usage.items():
                totals[k] = totals.get(k, 0) + v
            progress["updated_at"] = now_iso()
            save_json(PROGRESS_FILE, progress)  # point de reprise : la fiche est acquise
            n = {c: len(entry[c]) for c in CARDS}
            log(f"  ✓ {n} · {usage['input']} jetons lus + {usage['cache_read']} en cache "
                f"(+{usage['cache_write']} mis en cache), {usage['output']} écrits · "
                f"{time.time() - t0:.0f} s")
            break
        else:
            save_json(PROGRESS_FILE, progress)
            log(f"  Rub' {r} ignoré pour l'instant (sera retenté à la prochaine exécution).")


# ---------------------------------------------------------------------------
# 4. Export
# ---------------------------------------------------------------------------

def export(progress: dict, partial: bool, rubs: list[int]) -> bool:
    entries = progress["entries"]
    missing = [r for r in rubs if str(r) not in entries]  # complétude jugée sur la plage demandée
    if missing and not partial:
        log(f"Export différé : {len(missing)} Rub' manquants ({fmt_ranges(missing)}). "
            "Relancez le script, ou utilisez --export-partial.")
        return False
    data = {"schema": SCHEMA_ID, "exportedAt": now_iso(),
            "entries": [entries[k] for k in sorted(entries, key=int)]}
    if OUTPUT_JS.exists():
        OUTPUT_JS.replace(OUTPUT_JS.with_suffix(".js.bak"))
    OUTPUT_JS.write_text(
        "/* Fiches Tafsir & Méditation — générées par tools/generate_all_tafsir.py à partir des PDF de TAFSIR/.\n"
        " * Format : voir js/tafsir.js. Chargé en <script> classique : aucune requête réseau, pas de CORS. */\n"
        f"window.TAFSIR_DATA = {json.dumps(data, ensure_ascii=False, indent=2)};\n", encoding="utf-8")
    log(f"✓ {OUTPUT_JS.relative_to(APP_DIR)} écrit : {len(data['entries'])} fiches"
        + (f" (manquants : {fmt_ranges(missing)})" if missing else ""))
    return True


def fmt_ranges(nums: list[int]) -> str:
    out, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f"{nums[i]}-{nums[j]}")
        i = j + 1
    return ", ".join(out)


def parse_rubs(spec: str | None) -> list[int]:
    spec = spec or DEFAULT_RUBS
    rubs = set()
    for part in spec.split(","):
        a, _, b = part.strip().partition("-")
        rubs.update(range(int(a), int(b or a) + 1))
    if not rubs <= set(range(1, 241)):
        raise SystemExit("--rubs : valeurs entre 1 et 240.")
    return sorted(rubs)


# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

def check(quran: Quran) -> None:
    print(f"Modèle : {MODEL} (effort {EFFORT}) · index : {INDEX_MODEL}, 1 page sur {INDEX_STEP}")
    print(f"Clé API : {'trouvée' if os.getenv('ANTHROPIC_API_KEY') else 'ABSENTE (ANTHROPIC_API_KEY dans .env)'}")
    print(f"Coran : {len(quran.text)} versets, 240 Rub'")
    to_probe = 0
    for book in BOOKS:
        files = book_files(book)
        if not files:
            print(f"  ✗ {book.key} : aucun fichier « {book.pattern} »")
        for f in files:
            with pymupdf.open(f) as doc:
                n = doc.page_count
            if book.mode == "indexed":
                to_probe += len(range(0, n, INDEX_STEP))
            print(f"  ✓ {book.key:13} {book.mode:8} {n:5} p.  {f.name}")
    done = sum(len(e["probes"]) for e in load_json(INDEX_FILE, {}).values())
    print(f"Index : {done}/{to_probe} pages échantillonnées identifiées")
    progress = load_json(PROGRESS_FILE, {"entries": {}})
    print(f"Progression : {len(progress['entries'])}/240 fiches validées")


def main() -> None:
    ap = argparse.ArgumentParser(description="Génère data/tafsir.js (240 fiches) à partir des PDF de TAFSIR/.")
    ap.add_argument("--rubs", default=DEFAULT_RUBS, help=f"plage, ex. 1-8,121 (défaut : {DEFAULT_RUBS})")
    ap.add_argument("--check", action="store_true", help="vérifie l'environnement, sans appel API")
    ap.add_argument("--dry-run", action="store_true", help="affiche les pages retenues par Rub', sans générer")
    ap.add_argument("--export-only", action="store_true", help="exporte data/tafsir.js depuis la progression")
    ap.add_argument("--export-partial", action="store_true", help="exporte même s'il manque des Rub'")
    ap.add_argument("--metadata", action="store_true", help="écrit tools/rub_metadata.json et quitte")
    args = ap.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # console Windows : arabe et symboles
    quran = Quran(QURAN_DATA)
    metas = quran.rub_metadata()
    rubs = parse_rubs(args.rubs)
    progress = load_json(PROGRESS_FILE, {"schema": SCHEMA_ID, "entries": {}, "failed": {}})
    progress.setdefault("failed", {})

    if args.metadata:
        save_json(APP_DIR / "tools" / "rub_metadata.json", list(metas.values()))
        return log("tools/rub_metadata.json écrit.")
    if args.check:
        return check(quran)
    if args.export_only:
        export(progress, args.export_partial, rubs)
        return

    if not os.getenv("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY absente : créez hifz-app/.env (voir tools/.env.example).")
    client = anthropic.Anthropic(max_retries=6, timeout=900)
    index = PageIndex(client, quran)
    docs = Documents(client, index)

    try:
        index.build([b for b in BOOKS if b.mode == "indexed"], min_verse=min(metas[r]["first"] for r in rubs))
        if args.dry_run:
            for r in rubs:
                sel = docs.selection(metas[r])
                print(f"Rub' {r:3} {metas[r]['reference']}")
                for book, path, pages in sel:
                    print(f"      {book.key:10} {path.name[-12:]:>12}  p. {pages[0] + 1}-{pages[-1] + 1} ({len(pages)})")
            return
        run_generation(client, docs, quran, metas, rubs, progress)
    except Stop as e:
        log(f"Arrêt : {e}")
        log("Progression sauvegardée ; relancez la même commande pour reprendre.")
        sys.exit(1)
    except KeyboardInterrupt:
        log("Interrompu. Progression sauvegardée ; relancez la même commande pour reprendre.")
        sys.exit(130)

    if progress["failed"]:
        log(f"Rub' en échec : {fmt_ranges(sorted(map(int, progress['failed'])))} — relancez pour les retenter.")
    export(progress, args.export_partial, rubs)


if __name__ == "__main__":
    main()
