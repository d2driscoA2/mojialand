#!/usr/bin/env python3
"""Build one listening page per game with every take, for Danny to pick.
Run: python3 pickpage.py lines.csv work <game> page.html "<title>"
Take 1 is the default pick. Danny taps a different take to change a pick, then taps Copy my changes and pastes the text into the chat."""
import base64, csv, glob, html, json, os, sys

lines, work, game, out, title = sys.argv[1:6]
rows = [r for r in csv.DictReader(open(lines, encoding="utf-8")) if r["game"] == game]
data = []
for i, r in enumerate(rows, 1):
    takes = sorted(glob.glob(os.path.join(work, "takes", game, r["file"] + "__s*.m4a")),
                   key=lambda p: int(p.rsplit("__s", 1)[1][:-4]))
    data.append({"n": i, "f": r["file"], "t": r["text"], "type": r["type"],
                 "k": [[int(p.rsplit("__s", 1)[1][:-4]), base64.b64encode(open(p, "rb").read()).decode()] for p in takes]})
page = """<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TITLE</title>
<style>body{font-family:Nunito,system-ui,sans-serif;background:#FFF8E8;color:#30254A;padding:16px;max-width:640px;margin:auto}h1{color:#5122A5;font-size:22px}
.row{background:#fff;border-radius:18px;padding:12px;margin:10px 0;box-shadow:0 4px 12px rgba(0,0,0,.08)}.t{font-weight:800;margin-bottom:8px}.n{color:#7138D1;margin-right:6px}
.b{display:flex;gap:8px}button{flex:1;border:2px solid #EDE6FB;background:#fff;border-radius:14px;padding:12px;font:inherit;font-weight:800;color:#5122A5}
button.pick{border-color:#7138D1;background:#7138D1;color:#fff}button.p{outline:4px solid #FFC83D}
.bar{position:sticky;top:0;background:#FFF8E8;padding:8px 0;display:flex;gap:8px;z-index:2}.bar button{background:#5122A5;color:#fff;border-color:#5122A5}
#out{white-space:pre-wrap;background:#fff;border-radius:14px;padding:10px;font-size:13px;display:none}</style></head><body>
<h1>TITLE</h1><p>Tap a take to hear it. A tap also makes that take the pick (purple). Take A starts as the pick. Done? Tap Copy my changes, then paste into the chat.</p>
<p id="err" style="color:#c0392b;font-weight:800"></p>
<div class="bar"><button id="all">Play all picks</button><button id="copy">Copy my changes</button></div><div id="out"></div><div id="list"></div>
<script>
var D=DATA, G="GAME", pick={}, a=document.createElement('audio'); a.setAttribute('playsinline',''); document.body.appendChild(a); var q=[];
function el(t,c,x){var e=document.createElement(t); if(c)e.className=c; if(x!=null)e.textContent=x; return e}
D.forEach(function(r){ pick[r.f]=r.k.length?r.k[0][0]:null; var row=el('div','row'), t=el('div','t'); t.appendChild(el('span','n',r.n+'.')); t.appendChild(document.createTextNode(r.t)); row.appendChild(t);
  var b=el('div','b'); r.k.forEach(function(k,i){ var x=el('button',i?'':'pick','Take '+'ABC'[i]); x.dataset.f=r.f; x.dataset.s=k[0]; x.dataset.src='data:audio/mp4;base64,'+k[1];
    x.onclick=function(){ q=[]; pick[r.f]=k[0]; b.querySelectorAll('button').forEach(function(y){y.classList.toggle('pick',y===x)}); play(x) }; b.appendChild(x) });
  row.appendChild(b); document.getElementById('list').appendChild(row) });
function play(x){ document.querySelectorAll('.p').forEach(function(y){y.classList.remove('p')}); x.classList.add('p'); a.src=x.dataset.src; var p=a.play(); if(p&&p.catch)p.catch(function(e){document.getElementById('err').textContent='Sound blocked: '+e.name}) }
a.onended=function(){ document.querySelectorAll('.p').forEach(function(y){y.classList.remove('p')}); if(q.length) setTimeout(function(){ var x=q.shift(); x.scrollIntoView({block:'center'}); play(x) },400) };
document.getElementById('all').onclick=function(){ q=[].slice.call(document.querySelectorAll('button.pick')).filter(function(x){return x.dataset.src}); if(q.length) play(q.shift()) };
document.getElementById('copy').onclick=function(){ var ch=D.filter(function(r){return r.k.length && pick[r.f]!==r.k[0][0]}).map(function(r){return G+','+r.f+','+pick[r.f]});
  var txt=ch.length?('Voice picks '+G+':\\n'+ch.join('\\n')):('Voice picks '+G+': no changes, take A everywhere'); var o=document.getElementById('out'); o.style.display='block'; o.textContent=txt;
  if(navigator.clipboard) navigator.clipboard.writeText(txt).then(function(){ o.textContent=txt+'\\n\\nCopied.' },function(){ o.textContent=txt+'\\n\\nSelect this text and copy it.' }) };
</script></body></html>"""
page = page.replace("TITLE", html.escape(title)).replace("GAME", game).replace("DATA", json.dumps(data))
open(out, "w", encoding="utf-8").write(page)
print(out, len(data), "lines", sum(len(d["k"]) for d in data), "takes", f"{os.path.getsize(out)/1e6:.1f} MB")
