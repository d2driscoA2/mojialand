# Mojialand voice pipeline

Makes the game voice from text, on Danny's Mac, with free open models. Nothing here deploys: Netlify publishes site/ only.
Voice rules and locked settings: Mojialand-Brand.md section 11. Decisions: claude/Mojialand-Voice-Decisions.md.

Setup lives in ~/Claude/mojialand-voice (kokoro-env, cb-env, seeds/am_puck.wav, hf/).

1. python3 extract_lines.py ../../site/play/index.html lines.csv      (every line the games say)
2. make_takes.py lines.csv work [game]   with cb-env and HF_HOME=~/Claude/mojialand-voice/hf   (2 takes per line, 3 for commands)
3. zsh finish.sh work              (trim, 10% slower, -16 LUFS, mono, AAC 64k)
4. python3 pickpage.py lines.csv work <game> page.html "<title>"   (listening page; publish as a hosted page, the Claude app file preview plays no sound)
5. Danny picks; save his pasted changes as picks.csv
6. python3 apply_picks.py lines.csv picks.csv work ../../site/audio   (files plus site/audio/voice.json, the text to file map)
7. python3 check.py ../../site/play/index.html lines.csv work ../../site/audio

Types in lines.csv: cheer, soft (wrong answers, gentle guidance), command (3 takes, Danny picks), base.
