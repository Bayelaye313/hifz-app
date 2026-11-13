import json, re, sys
src, target = sys.argv[1], sys.argv[2]
CARDS = ('context', 'tradition', 'language', 'tazkiya')
KINDS = {'hadith', 'athar', 'qisas', 'citation', 'israiliyyat'}

def validate(e):
    errs = []
    rub = e.get('rub')
    if not isinstance(rub, int) or not 1 <= rub <= 240: errs.append(f"rub invalide : {rub!r}")
    if e.get('schema', 'hifz-tafsir/1') != 'hifz-tafsir/1': errs.append(f"schema inattendu : {e.get('schema')}")
    if not any(isinstance(e.get(k), list) and e[k] for k in CARDS): errs.append("aucune carte remplie")
    for k in CARDS:
        for i, it in enumerate(e.get(k, [])):
            if not isinstance(it, dict) or not (it.get('text') or it.get('arabic') or it.get('title')):
                errs.append(f"{k}[{i}] vide")
            if k == 'tradition' and it.get('kind') not in KINDS: errs.append(f"tradition[{i}].kind = {it.get('kind')!r}")
            if k == 'tazkiya' and not it.get('practice'): errs.append(f"tazkiya[{i}] sans practice")
    for i, g in enumerate(e.get('glossary', [])):
        if not (g.get('term') and g.get('definition')): errs.append(f"glossary[{i}] incomplet")
    return errs

data = json.load(open(src, encoding='utf-8'))
new = data['entries'] if isinstance(data, dict) and 'entries' in data else (data if isinstance(data, list) else [data])
bad = {e.get('rub'): validate(e) for e in new}
bad = {r: v for r, v in bad.items() if v}
if bad: sys.exit(f"Validation échouée : {bad}")

raw = open(target, encoding='utf-8').read()
m = re.search(r"window\.TAFSIR_DATA\s*=\s*(\{.*\})\s*;?\s*$", raw, re.S)
header = raw[:m.start()]
body = m.group(1)
try: cur = json.loads(body)
except json.JSONDecodeError:  # objet JS littéral (clés non quotées) : seul le cas vide est géré
    if re.fullmatch(r"\{\s*schema:\s*'hifz-tafsir/1',\s*entries:\s*\[\]\s*\}", body): cur = {'schema': 'hifz-tafsir/1', 'entries': []}
    else: sys.exit("Format de data/tafsir.js non reconnu")
by_rub = {e['rub']: e for e in cur.get('entries', [])}
replaced = [e['rub'] for e in new if e['rub'] in by_rub]
for e in new:
    e = {k: v for k, v in e.items() if k != 'importedAt'}
    e['schema'] = 'hifz-tafsir/1'
    by_rub[e['rub']] = e
out = {'schema': 'hifz-tafsir/1', 'entries': [by_rub[r] for r in sorted(by_rub)]}
open(target, 'w', encoding='utf-8', newline='\n').write(header + 'window.TAFSIR_DATA = ' + json.dumps(out, ensure_ascii=False, indent=1) + ';\n')
print(f"OK : {len(new)} fiche(s) injectée(s), remplacées : {replaced}, total : {sorted(by_rub)}")
