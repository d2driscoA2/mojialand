#!/usr/bin/env python3
"""Make raw voice takes for every row of lines.csv with the locked Mojialand voice.
Run on Danny's Mac with the Chatterbox env:
  HF_HOME=~/Claude/mojialand-voice/hf ~/Claude/mojialand-voice/cb-env/bin/python make_takes.py lines.csv work [game]
Writes work/raw/<game>/<file>__s<seed>.wav. Skips takes that already exist, so a stopped run picks up where it left off.
Settings: Mojialand-Brand.md section 11."""
import csv, os, sys, time
import torch, torchaudio as ta
from chatterbox.tts import ChatterboxTTS

REF = os.path.expanduser("~/Claude/mojialand-voice/seeds/am_puck.wav")
SETTINGS = {  # type: (exaggeration, cfg_weight, temperature, seeds)
    "cheer":   (0.85, 0.4, 0.8, [7, 42]),
    "soft":    (0.5,  0.5, 0.8, [7, 42]),
    "command": (0.65, 0.5, 0.7, [11, 23, 42]),
    "base":    (0.7,  0.4, 0.8, [7, 42]),
}

def main():
    lines, out = sys.argv[1], sys.argv[2]
    only = sys.argv[3] if len(sys.argv) > 3 else None
    rows = [r for r in csv.DictReader(open(lines, encoding="utf-8")) if not only or r["game"] == only]
    todo = []
    for r in rows:
        ex, cfg, temp, seeds = SETTINGS[r["type"]]
        for s in seeds:
            path = os.path.join(out, "raw", r["game"], f'{r["file"]}__s{s}.wav')
            if not os.path.exists(path):
                todo.append((r, s, path))
    print(len(rows), "lines,", len(todo), "takes to make", flush=True)
    if not todo:
        return
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    m = ChatterboxTTS.from_pretrained(device=dev)
    t0 = time.time()
    for i, (r, s, path) in enumerate(todo, 1):
        ex, cfg, temp, _ = SETTINGS[r["type"]]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        torch.manual_seed(s)
        w = m.generate(r["text"], audio_prompt_path=REF, exaggeration=ex, cfg_weight=cfg, temperature=temp)
        ta.save(path + ".tmp.wav", w, m.sr)
        os.replace(path + ".tmp.wav", path)
        if i % 20 == 0 or i == len(todo):
            print(f"{i}/{len(todo)} takes, {time.time()-t0:.0f} s", flush=True)

if __name__ == "__main__":
    main()
