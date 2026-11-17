#!/bin/zsh
# Finish raw takes into small web files: trim silence, 10% slower (pitch unchanged), even loudness, mono, AAC 64k.
# Run: zsh finish.sh work    Writes work/takes/<game>/<file>__s<seed>.m4a. Skips files already finished.
set -u
W=${1:-work}
n=0
for f in $W/raw/*/*.wav(N); do
  g=$(basename $(dirname $f)); b=$(basename $f .wav); o=$W/takes/$g/$b.m4a
  [[ -s $o && $o -nt $f ]] && continue
  mkdir -p $W/takes/$g
  ffmpeg -loglevel error -y -i $f -af "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,atempo=0.9,loudnorm=I=-16:TP=-1.5,apad=pad_dur=0.15" -ac 1 -ar 44100 -c:a aac -b:a 64k $o && n=$((n+1))
done
echo "finished $n takes"
