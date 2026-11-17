#!/usr/bin/env python3
"""Copy the picked take of every line into the site, and write the text-to-file map the game reads.
Run: python3 apply_picks.py lines.csv picks.csv work site/audio
picks.csv rows: game,file,seed (only the changes; every other line uses its first take)."""
import csv, glob, json, os, shutil, sys

lines, picks, work, dest = sys.argv[1:5]
chosen = {}
if os.path.exists(picks):
    for row in csv.reader(open(picks, encoding="utf-8")):
        if len(row) == 3 and row[2].strip().isdigit():
            chosen[(row[0].strip(), row[1].strip())] = int(row[2])
voice, missing = {}, []
for r in csv.DictReader(open(lines, encoding="utf-8")):
    takes = glob.glob(os.path.join(work, "takes", r["game"], r["file"] + "__s*.m4a"))
    seeds = sorted(int(p.rsplit("__s", 1)[1][:-4]) for p in takes)
    if not seeds:
        missing.append(r["text"]); continue
    s = chosen.get((r["game"], r["file"]), seeds[0] if r["type"] != "command" else 11)
    if s not in seeds:
        missing.append(r["text"] + f" (take s{s})"); continue
    os.makedirs(os.path.join(dest, r["game"]), exist_ok=True)
    shutil.copyfile(os.path.join(work, "takes", r["game"], f'{r["file"]}__s{s}.m4a'), os.path.join(dest, r["game"], r["file"] + ".m4a"))
    voice.setdefault(r["game"], {})[r["text"]] = r["file"]
json.dump(voice, open(os.path.join(dest, "voice.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0, sort_keys=True)
print(sum(len(v) for v in voice.values()), "files placed,", len(missing), "missing")
for m in missing: print("  missing:", m)
