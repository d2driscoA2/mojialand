#!/usr/bin/env python3
"""Check: every line the games say has a voice file, and no take looks broken.
Run: python3 check.py site/play/index.html lines.csv work site/audio
1. Re-reads the game code and lists any line missing from lines.csv (a game changed).
2. Lists any line in lines.csv with no file in site/audio.
3. Flags takes far longer than the text needs (the model sometimes repeats or babbles)."""
import csv, os, subprocess, sys, tempfile, glob

game, lines, work, dest = sys.argv[1:5]
here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mktemp(suffix=".csv")
subprocess.run([sys.executable, os.path.join(here, "extract_lines.py"), game, tmp], check=True, capture_output=True)
now = {(r["game"], r["text"]) for r in csv.DictReader(open(tmp, encoding="utf-8"))}
rows = list(csv.DictReader(open(lines, encoding="utf-8")))
have = {(r["game"], r["text"]) for r in rows}
bad = 0
for g, t in sorted(now - have): print("NEW LINE, not in lines.csv:", g, t); bad += 1
for g, t in sorted(have - now): print("old line, no longer in the game:", g, t)
for r in rows:
    if not os.path.exists(os.path.join(dest, r["game"], r["file"] + ".m4a")):
        print("NO FILE:", r["game"], r["text"]); bad += 1
def dur(p):
    o = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], capture_output=True, text=True).stdout
    return float(o or 0)
for r in rows:
    limit = 1.2 + len(r["text"]) / 9.0
    for p in glob.glob(os.path.join(work, "takes", r["game"], r["file"] + "__s*.m4a")):
        d = dur(p)
        if d > limit or d < 0.3:
            print(f"CHECK BY EAR ({d:.1f} s): {r['game']} {os.path.basename(p)}  {r['text']}")
print("problems:", bad)
sys.exit(1 if bad else 0)
