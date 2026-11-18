#!/usr/bin/env python3
"""Build lines.csv from the game code: every line Share Party and Feelings Faces say.
Run: python3 tools/voice/extract_lines.py site/play/index.html tools/voice/lines.csv
Columns: game, type, text, file. type picks the voice setting (see make.py)."""
import csv, re, sys

src = open(sys.argv[1], encoding="utf-8").read()
rows = []
def add(game, typ, text):
    if not any(r[0] == game and r[2] == text for r in rows):
        rows.append((game, typ, text))

# ---------- Feelings Faces ----------
a = src.index("FEELINGS FACES (Release 1.3)")
b = src.index("{ if(beatScene && text === beatScene.event)", a)
block = src[a:b]
feel = dict(re.findall(r'(\w+):\s*\{ e:"[^"]*", name:"(\w+)"', block))
pos = re.search(r'POS = \[(.*?)\]', src[a:]).group(1).replace('"', '').split(',')
def fld(p, k):
    m = re.search(k + r'\s*:\s*"((?:[^"\\]|\\.)*)"', p)
    return m.group(1).replace('\\"', '"') if m else None
scenes = re.split(r'\n\s*\{ key:"', block)[1:]
for p in scenes:
    name, fk = fld(p, "name"), fld(p, "feel")
    add("feelings", "base", fld(p, "setup"))
    add("feelings", "base", fld(p, "event"))
    add("feelings", "base", f"How does {name} feel? Tap the face.")
    add("feelings", "base", f"How does {name} feel?")
    add("feelings", "cheer" if fk in pos else "base", f"Yes. {name} feels {feel[fk].lower()} because {fld(p, 'cause')}.")
    add("feelings", "soft", f"Hmm. Watch {name} again.")
    add("feelings", "command", fld(p, "ask"))
    done = fld(p, "done") or (f"Hooray! You celebrated with {name}." if fk in pos else f"You helped {name} feel better.")
    add("feelings", "cheer", done)
for k, n in feel.items():
    add("feelings", "base", n + ".")
for t in ["Breathe in.", "And out.", "Bunny helps pick them up."]:
    add("feelings", "base", t)
for t in ["Thank you, Cow!", "Thank you, Bunny!", "You know so many feelings. And you are a great helper!"]:
    add("feelings", "cheer", t)

# ---------- Share Party ----------
WORD = ["zero", "one", "two", "three", "four"]
NAMES = dict(re.findall(r'(\w+):"([^"]+)"', re.search(r'const NAMES = \{(.*?)\};', src).group(1)))
lv = src[src.index("const LEVELS = ["):src.index("LEVELS.forEach(L=>")]
for pm in re.finditer(r'\{n:(\d), label:"[^"]*", stages:\[(.*?)\]\}', lv):
    who = WORD[int(pm.group(1))] + " friends"
    for si, st in enumerate(re.findall(r'\{(mode:.*?)\}', pm.group(2))):
        g = lambda k: (re.search(k + r':"([^"]*)"', st) or [None, None])[1]
        first = si == 0
        if g("mode") == "deal":
            nm = g("name")
            if "pre:" in st:
                add("share", "command", f"Some friends already have {nm}! Share so everyone gets the same.")
            else:
                add("share", "command", f"Share the {nm} with {who}!" if first else f"Now share the {nm}!")
        else:
            nm = NAMES[g("food")]
            gd = g("guides") or "line"
            how = "Snap it into pieces!" if g("mode") == "break" else {"line": "Cut on the dotted line!", "dots": "Cut from dot to dot!"}.get(gd, "Cut it into equal pieces!")
            add("share", "command", (f"Share the {nm} with {who}! " if first else f"Now the {nm}! ") + how)
for t in ["Now give everyone a piece!", "Now give each friend a piece!", "Hmm, is that fair? Put one back in the bowl!"]:
    add("share", "command", t)
add("share", "soft", "Hmm, is that fair?")
add("share", "soft", "One is left! Let's break it so everyone gets the same.")
add("share", "soft", "Some are left! Let's break them so everyone gets the same.")
for t in ["Fair! Everyone got the same!", "Fair share! Everyone got the same!", "Hooray! You shared it all!"]:
    add("share", "cheer", t)

# ---------- Mojialand core ----------
add("core", "command", "All done for now! Can you please find a grown-up?")

def slug(t):
    s = re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")
    return s[:48].rstrip("-")
seen = set()
with open(sys.argv[2], "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["game", "type", "text", "file"])
    for game, typ, text in rows:
        f = slug(text); n = 2
        while (game, f) in seen:
            f = slug(text)[:44] + f"-{n}"; n += 1
        seen.add((game, f))
        w.writerow([game, typ, text, f])
print(len(rows), "lines:", sum(r[0] == "feelings" for r in rows), "feelings,", sum(r[0] == "share" for r in rows), "share")
