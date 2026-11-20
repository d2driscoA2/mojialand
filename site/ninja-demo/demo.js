/* Mojialand Word Ninja demo. Built from the playtest shell and demos/ninja.js. */

/* ---------- Shared shell for every demo game ---------- */
window.MOJI = (function(){
  const games = [];
  let cleanup = null, soundOn = true, voiceOn = true, ac = null;

  function audio(){ if(!ac){ try{ ac = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } if(ac && ac.state==="suspended") ac.resume(); return ac; }
  function tone(freq, dur, type, vol, when, slideTo){
    const a = audio(); if(!a || !soundOn) return;
    const t = a.currentTime + (when||0);
    const o = a.createOscillator(), g = a.createGain();
    o.type = type||"sine"; o.frequency.setValueAtTime(freq, t);
    if(slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t+dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol||0.2, t+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t+dur+0.02);
  }
  function noise(dur, vol, when, hp){
    const a = audio(); if(!a || !soundOn) return;
    const t = a.currentTime + (when||0);
    const buf = a.createBuffer(1, Math.floor(a.sampleRate*dur), a.sampleRate), d = buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*(1-i/d.length);
    const s = a.createBufferSource(); s.buffer = buf;
    const f = a.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = hp||1200;
    const g = a.createGain(); g.gain.value = vol||0.15;
    s.connect(f).connect(g).connect(a.destination); s.start(t);
  }
  const SFX = {
    tap:   ()=>tone(660,.08,"triangle",.15),
    pop:   ()=>{tone(520,.12,"sine",.25,0,1100);},
    boop:  ()=>tone(300,.18,"sine",.15,0,220),
    grow:  ()=>{[392,494,587,784].forEach((f,i)=>tone(f,.18,"triangle",.14,i*.08));},
    cheer: ()=>{[523,659,784,1047].forEach((f,i)=>tone(f,.22,"triangle",.16,i*.1)); noise(.4,.05,.1,4000);},
    whoosh:()=>noise(.35,.12,0,1800),
    splash:()=>{noise(.25,.18,0,900); tone(240,.15,"sine",.08,0,140);},
    squish:()=>{noise(.12,.12,0,600); tone(180,.1,"sine",.08,0,120);},
    drip:  ()=>tone(900,.12,"sine",.14,0,400),
    zip:   ()=>tone(300,.2,"sawtooth",.05,0,900),
    giggle:()=>{[700,820,700,860].forEach((f,i)=>tone(f,.07,"triangle",.12,i*.07));},
    thunder:()=>noise(.9,.18,0,300),
    note:  (f)=>tone(f||523,.25,"triangle",.16)
  };
  function sfx(name, arg){ try{ (SFX[name]||SFX.tap)(arg); }catch(e){} }

  /* Voice: say(text, key, game). When the Mojialand voice pipeline has made a file for this line, play it
     through the game's audio context (the same route as the real game, so the iOS silent-switch fix covers it).
     The file list comes from audio/<game>/voice.json {keys:[...]} loaded once per game. Device voice until then.
     Voice off means no voice at all. */
  window.MOJI_VOICE = window.MOJI_VOICE || {};
  const voiceBuf = {}; let voiceSrc = null, voiceSeq = 0, voiceEnd = 0;   // voiceEnd: when the current line stops (ms clock)
  function loadVoice(game){ if(MOJI_VOICE[game] !== undefined) return; MOJI_VOICE[game] = null;
    fetch("audio/" + game + "/voice.json").then(r=>r.ok ? r.json() : null).then(j=>{ MOJI_VOICE[game] = j && j.keys ? Object.fromEntries(j.keys.map(k=>[k, "audio/" + game + "/" + k + ".mp3"])) : {}; }).catch(()=>{ MOJI_VOICE[game] = {}; }); }
  function stopVoice(){ voiceEnd = 0; try{ speechSynthesis.cancel(); }catch(e){} if(voiceSrc){ try{ voiceSrc.stop(); }catch(e){} voiceSrc = null; } voiceSeq++; }
  function say(text, key, game){
    if(!voiceOn) return;
    stopVoice(); const seq = voiceSeq;
    const file = game && key && MOJI_VOICE[game] && MOJI_VOICE[game][key];
    if(file && soundOn){ const c = audio(); if(c){
      const play = buf => { if(seq !== voiceSeq || !voiceOn) return; const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination); src.start(); voiceSrc = src; voiceEnd = Date.now() + buf.duration*1000; src.onended = ()=>{ if(voiceSrc===src) voiceSrc = null; }; };
      voiceEnd = Date.now() + 1500;   // until the file is decoded, assume a short line
      if(voiceBuf[file]) play(voiceBuf[file]);
      else fetch(file).then(r=>r.arrayBuffer()).then(b=>c.decodeAudioData(b)).then(buf=>{ voiceBuf[file] = buf; play(buf); }).catch(()=>{ speak(text); });
      return; } }
    speak(text);
  }
  function preloadVoice(game, keys){ const c = audio(); if(!c || !MOJI_VOICE[game]) return; keys.forEach(k=>{ const f = MOJI_VOICE[game][k]; if(!f || voiceBuf[f]) return; fetch(f).then(r=>r.arrayBuffer()).then(x=>c.decodeAudioData(x)).then(buf=>{ voiceBuf[f] = buf; }).catch(()=>{}); }); }
  function speak(text){ if(!("speechSynthesis" in window)) return; try{ const u = new SpeechSynthesisUtterance(text); u.rate = .95; u.pitch = 1.15; voiceEnd = Date.now() + 400 + text.length*70; speechSynthesis.speak(u); }catch(e){} }
  /* Wait for the current line to finish, then a short pause, then go on. Never waits more than 8 seconds. */
  function afterVoice(cb, pad){ const wait = voiceOn ? Math.min(8000, Math.max(0, voiceEnd - Date.now())) + (pad==null ? 500 : pad) : (pad==null ? 500 : pad); return setTimeout(cb, wait); }

  /* Confetti */
  const fx = document.getElementById("fx"), ctx = fx.getContext("2d"); let bits = [], raf = 0;
  function sizeFx(){ fx.width = innerWidth*devicePixelRatio; fx.height = innerHeight*devicePixelRatio; }
  sizeFx(); addEventListener("resize", sizeFx);
  const COLORS = ["#FF5FA2","#FFC83D","#4DBCEC","#72D69A","#7138D1"];
  function confetti(x, y, n){
    if(matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    x = (x ?? innerWidth/2)*devicePixelRatio; y = (y ?? innerHeight/3)*devicePixelRatio;
    for(let i=0;i<(n||80);i++) bits.push({x,y,vx:(Math.random()-.5)*14*devicePixelRatio,vy:(-Math.random()*12-4)*devicePixelRatio,s:(4+Math.random()*5)*devicePixelRatio,c:COLORS[i%5],r:Math.random()*6,life:90+Math.random()*40});
    if(!raf) loop();
  }
  function loop(){
    ctx.clearRect(0,0,fx.width,fx.height);
    bits = bits.filter(b=>b.life-->0);
    bits.forEach(b=>{ b.vy += .45*devicePixelRatio; b.x += b.vx; b.y += b.vy; b.r += .2; ctx.save(); ctx.translate(b.x,b.y); ctx.rotate(b.r); ctx.fillStyle=b.c; ctx.fillRect(-b.s/2,-b.s/4,b.s,b.s/2); ctx.restore(); });
    raf = bits.length ? requestAnimationFrame(loop) : (ctx.clearRect(0,0,fx.width,fx.height), 0);
  }

  const api = { sfx, say, confetti, audio, home: ()=>goHome(), voiceOn: ()=>voiceOn, stopVoice, loadVoice, preloadVoice, afterVoice };

  function register(g){ games.push(g); }
  function renderHome(){
    const t = document.getElementById("tiles"); t.innerHTML = "";
    games.forEach(g=>{
      const b = document.createElement("button"); b.className = "tile"; b.type = "button";
      b.style.background = g.color; b.id = "tile-"+g.id; if(["#7138D1","#5122A5"].includes(g.color.toUpperCase())) b.style.color = "#FFFFFF";
      b.innerHTML = `<span class="e" aria-hidden="true">${g.emoji}</span><span>${g.title}</span>`;
      b.addEventListener("click", ()=>{ audio(); sfx("pop"); open(g.id); });
      t.appendChild(b);
    });
  }
  function open(id){
    const g = games.find(x=>x.id===id); if(!g) return;
    if(cleanup){ try{cleanup();}catch(e){} cleanup = null; }
    document.getElementById("gtitle").textContent = g.title;
    const stage = document.getElementById("stage"); stage.innerHTML = ""; stage.className = "g-"+g.id;
    document.getElementById("app").classList.add("playing");
    try{ cleanup = g.mount(stage, api) || null; }catch(e){ stage.innerHTML = '<p style="padding:24px;font-weight:800">This demo hit an error: '+String(e.message||e)+'</p>'; console.error(e); }
    if(g.intro) setTimeout(()=>say(g.intro), 250);
  }
  function goHome(){
    if(cleanup){ try{cleanup();}catch(e){} cleanup = null; }
    stopVoice();
    document.getElementById("stage").innerHTML = "";
    document.getElementById("app").classList.remove("playing");
  }
  document.getElementById("btn-home").addEventListener("click", ()=>{ sfx("tap"); goHome(); open("ninja"); });
  document.getElementById("btn-sound").addEventListener("click", e=>{ soundOn = !soundOn; e.currentTarget.setAttribute("aria-pressed", soundOn); e.currentTarget.textContent = soundOn ? "🔊" : "🔇"; });
  document.getElementById("btn-voice").addEventListener("click", e=>{ voiceOn = !voiceOn; e.currentTarget.setAttribute("aria-pressed", voiceOn); if(!voiceOn) stopVoice(); });
  addEventListener("load", ()=>{ renderHome(); open("ninja"); });
  return { register, open, home: goHome, api };
})();

/* ninja */
/* Word Ninja (beta 1): a spelling-first literacy game. A Mojialand ninja walks an island trail. Each stop teaches one
   word pattern with the same loop: hear it, build it from sound tiles, write it on lines, read it in a sentence.
   Pass a stop (5 of 6 words built right on the first try) and the Ninja Kitchen opens: slice fruit, make a mess.
   Skills in beta 1 (Danny's son's next three): silent e, vowel teams, two-syllable words, plus a b and d dojo.
   Coaching lines copy the IRLA questions his school uses. Saved on the device under mojia.ninja. */
(function(){
  const CSS = `
.g-ninja{background:#FFF8E8;font-family:Nunito,ui-rounded,system-ui,sans-serif;color:#30254A}
.g-ninja .nj{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0}
.g-ninja .nj-top{display:flex;align-items:center;gap:8px;padding:8px 12px;z-index:4}
.g-ninja .nj-top .b{width:46px;height:46px;border-radius:50%;border:3px solid #FFF;background:rgba(255,255,255,.85);font-size:22px;display:grid;place-items:center;cursor:pointer;padding:0;box-shadow:0 3px 10px rgba(0,0,0,.12)}
.g-ninja .nj-top .t{flex:1;text-align:center;font-weight:900;font-size:clamp(15px,4.4vw,19px);color:#5122A5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.g-ninja .nj-top .stars{font-weight:900;color:#5122A5;background:rgba(255,255,255,.85);border-radius:999px;padding:6px 10px}
/* trail */
.g-ninja .trail{flex:1;position:relative;overflow:hidden}
.g-ninja .trail svg{position:absolute;inset:0;width:100%;height:100%}
.g-ninja .stop{position:absolute;transform:translate(-50%,-50%);width:92px;border:0;background:transparent;cursor:pointer;padding:0;display:flex;flex-direction:column;align-items:center;gap:2px;font-family:inherit}
.g-ninja .stop .ic{width:64px;height:64px;border-radius:50%;background:#FFF;border:4px solid #7138D1;display:grid;place-items:center;font-size:34px;box-shadow:0 4px 12px rgba(0,0,0,.15)}
.g-ninja .stop .nm{font-weight:900;font-size:12px;color:#30254A;background:rgba(255,255,255,.9);padding:2px 8px;border-radius:999px;white-space:nowrap}
.g-ninja .stop .st{font-size:14px;letter-spacing:-2px;height:16px}
.g-ninja .stop.lock .ic{border-color:#C9C2D8;filter:grayscale(1);opacity:.7}
.g-ninja .stop.next .ic{animation:nj-pulse 1.3s ease-in-out infinite;border-color:#FFC83D}
.g-ninja .stop.soon .ic{border-style:dashed;border-color:#C9C2D8}
@keyframes nj-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
.g-ninja .hero{position:absolute;width:48px;height:54px;transform:translate(-50%,-85%);transition:left .9s ease,top .9s ease;filter:drop-shadow(0 4px 4px rgba(0,0,0,.2));pointer-events:none;z-index:3}
.g-ninja .hero.hop{animation:nj-hop .45s ease-in-out 2!important}
@keyframes nj-hop{50%{transform:translate(-50%,-115%)}}
.g-ninja .bubble{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);max-width:min(92%,440px);background:#FFF;border:3px solid #EADFF7;border-radius:20px;padding:10px 14px;font-weight:800;font-size:15px;box-shadow:0 6px 16px rgba(0,0,0,.12);z-index:4}
.g-ninja .bubble b{color:#7138D1}
/* lesson */
.g-ninja .les{flex:1;display:flex;flex-direction:column;min-height:0;padding:0 12px 10px;gap:8px}
.g-ninja .prog{display:flex;gap:5px;justify-content:center}
.g-ninja .prog i{width:26px;height:8px;border-radius:4px;background:#EADFF7}
.g-ninja .prog i.on{background:#7138D1}.g-ninja .prog i.ok{background:#72D69A}.g-ninja .prog i.miss{background:#FFC83D}
.g-ninja .card{background:#FFF;border-radius:24px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:12px;display:flex;flex-direction:column;align-items:center;gap:8px;flex:1;min-height:0;position:relative}
.g-ninja .pic{font-size:clamp(110px,30vw,220px);line-height:1.1;flex:1 1 auto;display:grid;place-items:center;min-height:0}
.g-ninja .card .pic{animation:nj-in .5s ease-out}
@keyframes nj-in{0%{transform:scale(.6);opacity:0}70%{transform:scale(1.06)}100%{transform:scale(1);opacity:1}}
.g-ninja .hear{border:0;background:#FFC83D;border-radius:999px;padding:12px 22px;font-weight:900;font-size:19px;cursor:pointer;font-family:inherit;box-shadow:0 4px 0 #E5A91F}
.g-ninja .hear.sdb{background:#FFF;color:#5122A5;border:3px solid #EADFF7;box-shadow:none;font-size:16px;padding:9px 16px}
.g-ninja .hear.sdb.dim{opacity:.4}
.g-ninja .hear.sdb.go{animation:nj-pulse 1.2s ease-in-out 3;border-color:#FFC83D;background:#FFF3C4}
.g-ninja .hears{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center}
.g-ninja .hear:active{transform:translateY(2px);box-shadow:none}
.g-ninja .boxes{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;align-content:flex-start}
.g-ninja .box{min-width:58px;height:66px;border-radius:14px;border:3px dashed #B99CF2;background:#F7F2FF;display:grid;place-items:center;font-weight:900;font-size:30px;color:#5122A5;padding:0 8px;box-sizing:border-box}
.g-ninja .box.syl{min-width:92px}
.g-ninja .box.full{border-style:solid;background:#FFF;border-color:#7138D1}
.g-ninja .box.magic{border-color:#FF5FA2;color:#FF5FA2}
.g-ninja .box.hint{color:#C9C2D8}
.g-ninja .snds{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;align-content:flex-start;padding:6px 0}
.g-ninja .snd{min-width:60px;height:64px;border-radius:16px;border:0;background:#4DBCEC;color:#FFF;font-weight:900;font-size:30px;cursor:pointer;font-family:inherit;box-shadow:0 4px 0 #2E9FD0;padding:0 12px;touch-action:manipulation}
.g-ninja .snd.v{background:#FF5FA2;box-shadow:0 4px 0 #E2468A}
.g-ninja .snd.syl{min-width:92px;font-size:26px}
.g-ninja .snd:active{transform:translateY(3px);box-shadow:none}
.g-ninja .snd.used{opacity:.25;pointer-events:none}
.g-ninja .snd.no{animation:nj-shake .4s}
@keyframes nj-shake{25%{transform:translateX(-7px)}75%{transform:translateX(7px)}}
.g-ninja .coach{min-height:40px;text-align:center;font-weight:800;color:#5122A5;font-size:15px;padding:0 6px}
.g-ninja .coach.good{color:#2E9F5E}
/* write */
.g-ninja .wrap{position:relative;width:100%;max-width:520px;flex:1;min-height:150px;max-height:300px}
.g-ninja canvas.pad{position:absolute;inset:0;width:100%;height:100%;border-radius:18px;background:#FFFDF6;border:3px solid #EADFF7;touch-action:none;cursor:crosshair}
.g-ninja .model{font-weight:900;font-size:clamp(34px,11vw,56px);color:#5122A5;letter-spacing:.06em}
.g-ninja .row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.g-ninja .btn{border:0;border-radius:999px;padding:12px 20px;font-weight:900;font-size:17px;cursor:pointer;font-family:inherit;background:#7138D1;color:#FFF;box-shadow:0 4px 0 #5122A5}
.g-ninja .btn.alt{background:#FFF;color:#5122A5;border:3px solid #EADFF7;box-shadow:none}
.g-ninja .btn.go{background:#72D69A;color:#1E4D33;box-shadow:0 4px 0 #3E9E5E}
.g-ninja .btn:active{transform:translateY(3px);box-shadow:none}
/* read */
.g-ninja .sent{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;font-size:clamp(24px,7vw,36px);font-weight:900;line-height:1.3}
.g-ninja .sent button{border:0;background:#F7F2FF;border-radius:12px;padding:4px 10px;font:inherit;color:#30254A;cursor:pointer}
.g-ninja .sent button.key{background:#FFE9A8;color:#5122A5}
.g-ninja .sent button.said{background:#D7F5E3}
/* kitchen */
.g-ninja .kit{flex:1;position:relative;overflow:hidden;background:linear-gradient(#FFF3C4,#FFF8E8 55%,#E9DFF8)}
.g-ninja .kit .wall{position:absolute;inset:0 0 44px 0;background:repeating-linear-gradient(90deg,transparent 0 58px,rgba(113,56,209,.06) 58px 60px),repeating-linear-gradient(0deg,transparent 0 38px,rgba(113,56,209,.06) 38px 40px)}
.g-ninja .kit .floor{position:absolute;left:0;right:0;bottom:0;height:44px;background:linear-gradient(#C9A06B,#A97B48);box-shadow:0 -4px 0 #E2C292 inset}
.g-ninja .kit.shake{animation:nj-shake .3s}
.g-ninja .kit.max .wall{background-color:rgba(255,95,162,.08)}
.g-ninja .food.big{font-size:70px}
.g-ninja .chunk{position:absolute;left:0;top:0;border-radius:40% 60% 50% 50%;pointer-events:none;will-change:transform;opacity:.95}
.g-ninja .rest{transition:none}
.g-ninja .pop{position:absolute;transform:translate(-50%,-50%);font-weight:900;font-size:30px;color:#FFF;-webkit-text-stroke:2px #5122A5;text-shadow:0 3px 0 #5122A5;pointer-events:none;z-index:5;animation:nj-pop .9s ease-out forwards;white-space:nowrap}
@keyframes nj-pop{0%{transform:translate(-50%,-50%) scale(.4);opacity:0}25%{transform:translate(-50%,-50%) scale(1.15);opacity:1}100%{transform:translate(-50%,-110%) scale(1);opacity:0}}
.g-ninja .meter{position:absolute;left:12px;top:52px;width:22px;height:120px;border-radius:12px;background:rgba(255,255,255,.8);border:3px solid #FFF;overflow:hidden;z-index:4}
.g-ninja .meter i{position:absolute;left:0;right:0;bottom:0;height:0;background:linear-gradient(#FF5FA2,#FFC83D);transition:height .25s}
.g-ninja .meter b{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(-90deg);font-size:10px;color:#5122A5;letter-spacing:.1em}
.g-ninja canvas.mess{position:absolute;inset:0;width:100%;height:100%}
.g-ninja .food{position:absolute;font-size:52px;transform:translate(-50%,-50%);pointer-events:none;will-change:transform}
.g-ninja .half{position:absolute;left:0;top:0;font-size:52px;pointer-events:none;overflow:hidden;width:.55em;height:1.2em;line-height:1.2em;will-change:transform}
.g-ninja .half span{display:block;width:1.1em;text-align:center}
.g-ninja .half.r span{margin-left:-.55em}
.g-ninja .blade{position:absolute;pointer-events:none;font-size:54px;transform:translate(-30%,-70%) rotate(-30deg);z-index:3;transition:transform .08s;opacity:0}
.g-ninja .kit.live .blade{opacity:1}
.g-ninja .kit-ui{position:absolute;left:0;right:0;bottom:10px;display:flex;justify-content:center;gap:10px;z-index:4}
.g-ninja .kit-score{position:absolute;top:10px;left:10px;font-weight:900;font-size:22px;color:#5122A5;background:rgba(255,255,255,.85);border-radius:999px;padding:6px 16px;z-index:4}
.g-ninja .tools{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:4}
.g-ninja .tools button{width:48px;height:48px;border-radius:50%;border:3px solid #FFF;background:rgba(255,255,255,.8);font-size:24px;cursor:pointer;padding:0}
.g-ninja .tools button.on{border-color:#7138D1;background:#FFF}
/* bd */
.g-ninja .big{font-size:clamp(90px,30vw,150px);font-weight:900;line-height:1;color:#5122A5}
.g-ninja .bd{display:flex;gap:18px}
.g-ninja .bd button{width:96px;height:96px;border-radius:24px;border:0;font-weight:900;font-size:56px;cursor:pointer;font-family:inherit;color:#FFF;box-shadow:0 5px 0 rgba(0,0,0,.2)}
.g-ninja .bd .b{background:#4DBCEC}.g-ninja .bd .d{background:#FF5FA2}
.g-ninja .bd button:active{transform:translateY(4px);box-shadow:none}
.g-ninja .trick{font-size:15px;font-weight:800;color:#5122A5;text-align:center}
.g-ninja .trick b{font-size:26px;letter-spacing:.2em}
/* done */
.g-ninja .done{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:16px;text-align:center}
.g-ninja .done .big{font-size:80px}
.g-ninja .done h2{margin:0;color:#7138D1;font-size:26px}
.g-ninja .done p{margin:0;font-weight:800;max-width:36ch}
.g-ninja .grown{position:absolute;left:8px;bottom:6px;z-index:5;display:flex;gap:6px}
.g-ninja .grown button{border:0;background:rgba(255,255,255,.75);color:#5122A5;font-size:11px;font-weight:800;padding:6px 8px;border-radius:10px;opacity:.8;cursor:pointer;font-family:inherit}

/* Nori the ninja: an original Mojialand character (dark hood, purple headband, yellow belt). Poses are CSS. */
.g-ninja .nori{display:inline-block;width:56px;height:63px;background:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2072%22%3E%3Cellipse%20cx%3D%2232%22%20cy%3D%2269%22%20rx%3D%2216%22%20ry%3D%223%22%20fill%3D%22rgba%280%2C0%2C0%2C.15%29%22%2F%3E%3Cpath%20d%3D%22M20%2044%20Q32%2040%2044%2044%20L46%2066%20Q32%2070%2018%2066Z%22%20fill%3D%22%2330254A%22%2F%3E%3Crect%20x%3D%2219%22%20y%3D%2252%22%20width%3D%2226%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23FFC83D%22%2F%3E%3Cpath%20d%3D%22M16%2046%20Q10%2052%2012%2060%22%20stroke%3D%22%2330254A%22%20stroke-width%3D%227%22%20stroke-linecap%3D%22round%22%20fill%3D%22none%22%2F%3E%3Cpath%20d%3D%22M48%2046%20Q56%2050%2058%2058%22%20stroke%3D%22%2330254A%22%20stroke-width%3D%227%22%20stroke-linecap%3D%22round%22%20fill%3D%22none%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2226%22%20r%3D%2221%22%20fill%3D%22%2330254A%22%2F%3E%3Cellipse%20cx%3D%2232%22%20cy%3D%2229%22%20rx%3D%2214%22%20ry%3D%228%22%20fill%3D%22%23FFF8E8%22%2F%3E%3Cpath%20d%3D%22M11%2020%20Q32%2014%2053%2020%20L53%2026%20Q32%2021%2011%2026Z%22%20fill%3D%22%237138D1%22%2F%3E%3Cpath%20d%3D%22M52%2021%20Q62%2018%2060%2026%20Q58%2022%2052%2025Z%22%20fill%3D%22%237138D1%22%2F%3E%3Cpath%20d%3D%22M52%2023%20Q63%2026%2058%2032%20Q58%2027%2052%2027Z%22%20fill%3D%22%235122A5%22%2F%3E%3Cellipse%20cx%3D%2226%22%20cy%3D%2229%22%20rx%3D%223.2%22%20ry%3D%224%22%20fill%3D%22%2330254A%22%2F%3E%3Cellipse%20cx%3D%2238%22%20cy%3D%2229%22%20rx%3D%223.2%22%20ry%3D%224%22%20fill%3D%22%2330254A%22%2F%3E%3Ccircle%20cx%3D%2227%22%20cy%3D%2227.5%22%20r%3D%221.2%22%20fill%3D%22%23FFF%22%2F%3E%3Ccircle%20cx%3D%2239%22%20cy%3D%2227.5%22%20r%3D%221.2%22%20fill%3D%22%23FFF%22%2F%3E%3Cpath%20d%3D%22M22%2024%20Q26%2022%2029%2024%20M35%2024%20Q38%2022%2042%2024%22%20stroke%3D%22%2330254A%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20fill%3D%22none%22%2F%3E%3C%2Fsvg%3E") no-repeat center/contain;flex:0 0 auto;transform-origin:50% 90%;animation:nj-bob 2.4s ease-in-out infinite}
.g-ninja .nori.s{width:40px;height:45px}
.g-ninja .nori.point{animation:nj-point 1.6s ease-in-out infinite}
.g-ninja .nori.cheer{animation:nj-cheer .5s ease-in-out 3}
.g-ninja .nori.think{animation:nj-think 1.2s ease-in-out 2}
@keyframes nj-bob{50%{transform:translateY(-3px)}}
@keyframes nj-point{50%{transform:rotate(-6deg) translateY(-2px)}}
@keyframes nj-cheer{40%{transform:translateY(-16px) rotate(-8deg)}80%{transform:translateY(0) rotate(6deg)}}
@keyframes nj-think{30%{transform:rotate(8deg)}70%{transform:rotate(-5deg)}}
.g-ninja .goal{display:flex;align-items:center;gap:10px;background:#FFF;border:3px solid #EADFF7;border-radius:20px;padding:6px 12px 6px 8px;box-shadow:0 3px 10px rgba(0,0,0,.06)}
.g-ninja .gtxt{flex:1;min-width:0}
.g-ninja .gsteps{display:flex;align-items:center;gap:5px;margin-bottom:2px}
.g-ninja .gsteps span{width:20px;height:20px;border-radius:50%;background:#EADFF7;color:#5122A5;font-size:12px;font-weight:900;display:grid;place-items:center}
.g-ninja .gsteps span.now{background:#7138D1;color:#FFF}.g-ninja .gsteps span.did{background:#72D69A;color:#1E4D33}
.g-ninja .gsteps b{margin-left:4px;color:#7138D1;font-size:13px}
.g-ninja .ginst{font-weight:800;font-size:15px;line-height:1.25}
.g-ninja .bubble{display:flex;align-items:center;gap:10px;text-align:left}
@media (prefers-reduced-motion:reduce){.g-ninja .stop.next .ic,.g-ninja .hero.hop,.g-ninja .snd.no,.g-ninja .nori{animation:none!important}}
`;

  /* ---------- content ---------- */
  // Each word: spelling, picture, sound parts (tiles), a short sentence. The vowel part is marked for the pink tile.
  const SKILLS = {
    e: { name:"Silent e Bridge", icon:"🌉", intro:"Silent e makes the vowel say its name. Listen: cap, cape.",
      rule:"The e at the end is quiet. It makes the vowel say its name.",
      words:[
        {w:"cake", p:"🎂", t:["c","a","k","e"], v:1, s:"The cake is on the plate."},
        {w:"bike", p:"🚲", t:["b","i","k","e"], v:1, s:"I ride my bike to the park."},
        {w:"rope", p:"🪢", t:["r","o","p","e"], v:1, s:"The rope is long and thick."},
        {w:"kite", p:"🪁", t:["k","i","t","e"], v:1, s:"My kite is up in the sky."},
        {w:"bone", p:"🦴", t:["b","o","n","e"], v:1, s:"The dog has a big bone."},
        {w:"nose", p:"👃", t:["n","o","s","e"], v:1, s:"I can smell with my nose."},
        {w:"home", p:"🏠", t:["h","o","m","e"], v:1, s:"We go home at five."},
        {w:"rose", p:"🌹", t:["r","o","s","e"], v:1, s:"The rose is red."},
        {w:"snake", p:"🐍", t:["s","n","a","k","e"], v:2, s:"The snake hid in the grass."},
        {w:"whale", p:"🐳", t:["wh","a","l","e"], v:1, s:"A whale swam by the ship."},
        {w:"grape", p:"🍇", t:["g","r","a","p","e"], v:2, s:"I ate a grape at lunch."},
        {w:"plane", p:"✈️", t:["p","l","a","n","e"], v:2, s:"The plane went up fast."},
        {w:"stone", p:"🪨", t:["s","t","o","n","e"], v:2, s:"Sam sat on a big stone."},
        {w:"game", p:"🎮", t:["g","a","m","e"], v:1, s:"We can play a game."},
        {w:"cube", p:"🧊", t:["c","u","b","e"], v:1, s:"The ice cube is cold."},
        {w:"lake", p:"🏞️", t:["l","a","k","e"], v:1, s:"We swim in the lake."}
      ] },
    vt: { name:"Vowel Team Cove", icon:"⛵", intro:"Two vowels go walking. The first one does the talking. Listen: boat, rain, tree.",
      rule:"Two vowels team up to make one sound. ai, ee, oa, oo.",
      words:[
        {w:"boat", p:"🛶", t:["b","oa","t"], v:1, s:"The boat is on the lake."},
        {w:"rain", p:"🌧️", t:["r","ai","n"], v:1, s:"The rain fell on the hut."},
        {w:"tree", p:"🌳", t:["t","r","ee"], v:2, s:"A bird sat in the tree."},
        {w:"moon", p:"🌙", t:["m","oo","n"], v:1, s:"The moon is up at night."},
        {w:"goat", p:"🐐", t:["g","oa","t"], v:1, s:"The goat ate the hat."},
        {w:"soap", p:"🧼", t:["s","oa","p"], v:1, s:"Wash with soap and water."},
        {w:"mail", p:"📬", t:["m","ai","l"], v:1, s:"The mail came at noon."},
        {w:"bee", p:"🐝", t:["b","ee"], v:1, s:"The bee is on the rose."},
        {w:"sheep", p:"🐑", t:["sh","ee","p"], v:1, s:"The sheep ate the grass."},
        {w:"boot", p:"🥾", t:["b","oo","t"], v:1, s:"My boot is in the mud."},
        {w:"coat", p:"🧥", t:["c","oa","t"], v:1, s:"Zip up your coat."},
        {w:"leaf", p:"🍃", t:["l","ea","f"], v:1, s:"The leaf fell off the tree."},
        {w:"teeth", p:"🦷", t:["t","ee","th"], v:1, s:"Brush your teeth at night."},
        {w:"snail", p:"🐌", t:["s","n","ai","l"], v:2, s:"The snail is slow."},
        {w:"train", p:"🚆", t:["t","r","ai","n"], v:2, s:"The train is fast."},
        {w:"toad", p:"🐸", t:["t","oa","d"], v:1, s:"The toad sat on a log."},
        {w:"seal", p:"🦭", t:["s","ea","l"], v:1, s:"The seal can swim."},
        {w:"feet", p:"🦶", t:["f","ee","t"], v:1, s:"My feet are wet."}
      ] },
    two: { name:"Two Syllable Peak", icon:"🏔️", intro:"Big words have parts. Clap them: rab, bit. Rabbit!",
      rule:"Split the word into two parts. Read each part, then put them together.",
      syl:true,
      words:[
        {w:"rabbit", p:"🐰", t:["rab","bit"], s:"The rabbit hops in the grass."},
        {w:"pumpkin", p:"🎃", t:["pump","kin"], s:"The pumpkin is big."},
        {w:"basket", p:"🧺", t:["bas","ket"], s:"Put the eggs in the basket."},
        {w:"muffin", p:"🧁", t:["muf","fin"], s:"I ate a muffin."},
        {w:"kitten", p:"🐱", t:["kit","ten"], s:"The kitten naps on the bed."},
        {w:"cactus", p:"🌵", t:["cac","tus"], s:"The cactus has spikes."},
        {w:"magnet", p:"🧲", t:["mag","net"], s:"The magnet picks up pins."},
        {w:"rocket", p:"🚀", t:["rock","et"], s:"The rocket went to the moon."},
        {w:"insect", p:"🐛", t:["in","sect"], s:"An insect has six legs."},
        {w:"helmet", p:"⛑️", t:["hel","met"], s:"Put on your helmet."},
        {w:"ninja", p:"🥷", t:["nin","ja"], s:"The ninja can jump high."},
        {w:"robot", p:"🤖", t:["ro","bot"], s:"The robot can talk."},
        {w:"carrot", p:"🥕", t:["car","rot"], s:"The rabbit ate a carrot."},
        {w:"hammer", p:"🔨", t:["ham","mer"], s:"Hit the nail with a hammer."},
        {w:"dragon", p:"🐉", t:["drag","on"], s:"The dragon has wings."},
        {w:"lemon", p:"🍋", t:["lem","on"], s:"The lemon is sour."},
        {w:"sunset", p:"🌇", t:["sun","set"], s:"We saw the sunset."},
        {w:"picnic", p:"🧺", t:["pic","nic"], s:"We had a picnic by the lake."}
      ] }
  };
  const DISTRACT = { e:["a","e","i","o","u","b","d","p","t","m","n","s","r","l","g"], vt:["ai","ee","oa","oo","ea","a","e","o","b","d","p","t","m","n","s"] };
  const SYL_DISTRACT = ["bat","mop","pen","sit","tub","ket","pin","ram","dog","net","rug","fox"];
  const PLACE = [ // placement words, easiest first; the first miss sets the start stop
    {w:"sun", p:"☀️", t:["s","u","n"], v:1, skill:"e"},
    {w:"ship", p:"🚢", t:["sh","i","p"], v:1, skill:"e"},
    {w:"cake", p:"🎂", t:["c","a","k","e"], v:1, skill:"e"},
    {w:"boat", p:"🛶", t:["b","oa","t"], v:1, skill:"vt"},
    {w:"rabbit", p:"🐰", t:["rab","bit"], skill:"two", syl:true}
  ];
  const BD = [ // the b and d dojo: picture, word with the first letter missing, answer
    {p:"🦇", w:"_at", a:"b"}, {p:"🐶", w:"_og", a:"d"}, {p:"🛏️", w:"_ed", a:"b"}, {p:"🦆", w:"_uck", a:"d"},
    {p:"🚌", w:"_us", a:"b"}, {p:"🚪", w:"_oor", a:"d"}, {p:"🐝", w:"_ee", a:"b"}, {p:"🎲", w:"_ice", a:"d"},
    {p:"📦", w:"_ox", a:"b"}, {p:"🥁", w:"_rum", a:"d"}, {p:"🍞", w:"_read", a:"b"}, {p:"🦌", w:"_eer", a:"d"},
    {p:"🎈", w:"_alloon", a:"b"}, {p:"🐬", w:"_olphin", a:"d"}, {p:"🍌", w:"_anana", a:"b"}, {p:"🦖", w:"_ino", a:"d"}
  ];
  const COACH = [
    "Did you look all the way through the word?",
    "Do you see any parts you know?",
    "Can you blend the sounds together?",
    "Try a different sound for those letters."
  ];
  const FOODS = ["🍉","🍎","🍊","🍋","🍌","🥝","🍓","🍇","🥕","🥦","🌽","🍅","🥑","🍑","🍍","🧁","🍩","🎂","🥚","🍕"];
  const JUICE = {"🍉":"#FF5F7E","🍎":"#FF6B6B","🍊":"#FFA447","🍋":"#FFE066","🍌":"#FFEB99","🥝":"#8FD36B","🍓":"#FF4D7D","🍇":"#9B6BE8","🥕":"#FF9A3C","🥦":"#5CB85C","🌽":"#FFD23F","🍅":"#FF5A4E","🥑":"#A3D977","🍑":"#FFB38A","🍍":"#FFD95C","🧁":"#FFB3D1","🍩":"#C98BFF","🎂":"#FFC2DD","🥚":"#FFF3B0","🍕":"#FF8A5B"};

  /* Every spoken line has a key. The Mojialand voice pipeline records these (claude/Mojialand-Ninja-Voice-Lines.csv);
     until then the device voice reads the text. Word, sound, and sentence lines are built from the word banks. */
  const LINES = {
    intro:"Word Ninja! Walk the trail. Build words, write them, read them. Then slice fruit in the kitchen.",
    "trail.welcome":"Welcome! Tap the Dojo to warm up. I will find the right trail for you.",
    "trail.soon":"The Monster Mall opens soon.", "trail.warm":"Warm up at the Dojo first.", "trail.earn":"Pass a stop to open the kitchen. You earn the mess!",
    "next.e":"Next stop: Silent e Bridge. Tap it!", "next.vt":"Next stop: Vowel Team Cove. Tap it!", "next.two":"Next stop: Two Syllable Peak. Tap it!",
    "next.bd":"Next stop: the b and d Dojo. Tap it!", "next.kitchen":"You passed every stop! The Ninja Kitchen is open. Go make a mess.",
    "dojo.intro":"Warm up time. Build each word I say. I will find your trail.",
    "dojo.start.e":"Your trail starts at Silent e Bridge.", "dojo.start.vt":"Your trail starts at Vowel Team Cove.", "dojo.start.two":"Your trail starts at Two Syllable Peak.",
    "e.intro":"Silent e Bridge! Silent e makes the vowel say its name. Listen: cap. Cape.",
    "vt.intro":"Vowel Team Cove! Two vowels go walking, and the first one does the talking. Listen: boat. Rain. Tree.",
    "two.intro":"Two Syllable Peak! Big words have parts. Clap them: rab, bit. Rabbit!",
    "step.hear":"Step one. Listen to the word.",
    "step.build":"Step two. Tap the sounds in order to build the word.",
    "step.build.syl":"Step two. Tap the two parts in order to build the word.",
    "step.trace":"Step three. Trace the word on the lines with your finger.",
    "step.copy":"Step three. Now write it by yourself. Big letters touch the top line.",
    "step.read":"Step four. Tap each word to hear it. Then read the whole sentence out loud.",
    "coach.1":"Did you look all the way through the word?", "coach.2":"Do you see any parts you know?",
    "coach.3":"Can you blend the sounds together?", "coach.4":"Try a different sound for those letters.",
    "coach.first":"First try! Ninja focus!", "coach.got":"You got it. Nice and steady.",
    "enc.1":"You've got this.", "enc.2":"One sound at a time.", "enc.3":"Ninja focus!", "enc.4":"Nice and steady.", "enc.5":"Keep going. You are doing great.",
    "write.ink":"Write the word with your finger.", "write.great":"Great writing!", "write.nice":"Nice work!",
    "write.again":"Look at the word and try once more.",
    "write.tip.big":"Make your letters bigger. Small letters sit under the dotted line.",
    "write.tip.tall":"Tall letters reach up to the top line.",
    "write.tip.base":"Keep your letters sitting on the bottom line.",
    "write.tip.close":"Keep the letters close together.",
    "read.kick":"Ninja kick! Great reading.",
    "pass.yes":"You passed! The kitchen is open.", "pass.no":"Good practice. Try the stop again. You know more than you did.",
    "bd.intro":"The b and d dojo. Make two fists with your thumbs up. Your left hand makes a b. Your right hand makes a d. b, e, d spells bed.",
    "bd.ask":"Which letter starts the word?",
    "bd.miss":"Look at the round part. b has its belly after the line. d has its belly before the line.",
    "bd.pass":"Black belt in b and d! The kitchen is open.", "bd.no":"Get eight out of ten to pass. Remember: b, e, d spells bed.",
    "kit.go":"Slice everything! Make a big mess.", "kit.1":"Ninja chop!", "kit.2":"Big mess!", "kit.3":"Keep slicing!", "kit.4":"So messy!",
    "kit.triple":"Triple slice!", "kit.max":"Maximum mess!", "kit.clean":"Squeaky clean.", "kit.end":"What a mess! Great work, ninja."
  };
  const SOUND = {a:"a", e:"eh", i:"ih", o:"aw", u:"uh", b:"buh", c:"kuh", d:"duh", f:"fff", g:"guh", h:"huh", j:"juh", k:"kuh", l:"lll", m:"mmm", n:"nnn", p:"puh", r:"rrr", s:"sss", t:"tuh", v:"vvv", w:"wuh", y:"yuh", z:"zzz",
    sh:"shh", ch:"ch", th:"th", wh:"wuh", ck:"kuh", ai:"ay", ee:"ee", oa:"oh", oo:"oo", ea:"ee"};
  const LONG = {a:"ay", i:"eye", o:"oh", u:"you", e:"ee"};
  const soundsOf = (word, longV)=> word.t.map((p,k)=> word.syl || p.length > 2 ? p : (k===word.t.length-1 && p==="e" && longV) ? "quiet e" : (longV && LONG[p] && k===word.v) ? LONG[p] : (SOUND[p] || p)).join(". ") + ". " + word.w + ".";
  const KEY = "mojia.ninja";
  const ORDER = ["dojo","e","vt","two","bd","mall","kitchen"];
  const STOPS = [
    {id:"dojo", name:"Dojo", icon:"⛩️", x:16, y:84},
    {id:"e", name:"Silent e Bridge", icon:"🌉", x:38, y:66},
    {id:"vt", name:"Vowel Team Cove", icon:"⛵", x:22, y:46},
    {id:"two", name:"Two Syllable Peak", icon:"🏔️", x:50, y:30},
    {id:"bd", name:"b and d Dojo", icon:"🥋", x:78, y:46},
    {id:"mall", name:"Monster Mall", icon:"🏬", x:84, y:18, soon:true},
    {id:"kitchen", name:"Ninja Kitchen", icon:"🔪", x:70, y:70}
  ];

  const shuffle = a => { a = a.slice(); for(let i=a.length-1;i>0;i--){ const j = Math.random()*(i+1)|0; [a[i],a[j]] = [a[j],a[i]]; } return a; };
  const pick = (a, n) => shuffle(a).slice(0, n);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function load(){ try{ const p = JSON.parse(localStorage.getItem(KEY)||"null"); if(p && p.v===1) return p; }catch(e){} return {v:1, stars:{}, placed:false, meals:0}; }

  MOJI.register({
    id:"ninja", title:"Word Ninja", emoji:"🥷", color:"#5122A5",
    intro:"Word Ninja! Walk the trail. Build words, write them, read them, then slice fruit in the kitchen.",
    mount(stage, api){
      const root = document.createElement("div"); root.className = "nj"; stage.appendChild(root);
      if(!document.getElementById("nj-css")){ const st = document.createElement("style"); st.id = "nj-css"; st.textContent = CSS; document.head.appendChild(st); }
      let S = load(), timers = [], raf = 0, cleanupFns = [];
      if(api.loadVoice) api.loadVoice("ninja");   // audio/ninja/voice.json lists the recorded lines
      const V = (key, text)=> api.say(text || LINES[key] || key, key, "ninja");   // one line, one key
      const afterV = (cb, pad)=>{ const t = api.afterVoice ? api.afterVoice(cb, pad) : setTimeout(cb, 1200 + (pad||0)); timers.push(t); return t; };
      const pose = p => { const n = root.querySelector(".goal .nori"); if(n) n.className = "nori " + p; };
      const save = ()=>{ try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} };
      const later = (f, ms)=>{ const t = setTimeout(f, ms); timers.push(t); return t; };
      const starsTotal = ()=> Object.values(S.stars).reduce((a,b)=>a+b, 0);
      const skillStar = id => S.stars[id] || 0;
      const SK_ORDER = ["e","vt","two"];
      const nextStop = ()=> !S.placed ? "dojo" : SK_ORDER.slice(Math.max(0, SK_ORDER.indexOf(S.start))).concat(["bd"]).find(id=>!skillStar(id)) || "kitchen";

      function top(title, extra){
        return `<div class="nj-top"><button type="button" class="b back" aria-label="Back to the trail">🗺️</button><span class="t">${title}</span>${extra||`<span class="stars">⭐ ${starsTotal()}</span>`}</div>`;
      }
      function show(html){ clearTimers(); root.innerHTML = html; const b = root.querySelector(".back"); if(b) b.addEventListener("click", ()=>{ api.sfx("tap"); trail(); }); }
      function clearTimers(){ timers.forEach(clearTimeout); timers = []; if(raf) cancelAnimationFrame(raf); raf = 0; cleanupFns.forEach(f=>{ try{f();}catch(e){} }); cleanupFns = []; }

      /* ---------- trail ---------- */
      function trail(){
        const nx = nextStop();
        if(api.preloadVoice) api.preloadVoice("ninja", ["trail.welcome", "next."+nx, "trail.earn", "trail.warm", "trail.soon", "dojo.intro", "e.intro", "vt.intro", "two.intro", "bd.intro", "kit.go"]);
        const path = STOPS.filter(s=>s.id!=="kitchen").map(s=>`${s.x},${s.y}`);
        show(top("Word Ninja Island") + `<div class="trail">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="njsea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#BFEAF8"/><stop offset="1" stop-color="#4DBCEC"/></linearGradient></defs>
            <rect width="100" height="100" fill="url(#njsea)"/>
            <path d="M6 95 Q0 60 14 38 Q22 10 50 6 Q80 2 94 22 Q102 50 92 72 Q84 98 50 98 Q20 100 6 95Z" fill="#9EDB8A"/>
            <path d="M12 92 Q8 62 20 42 Q28 18 50 12 Q76 8 88 26 Q96 50 86 70 Q78 92 50 92 Q24 94 12 92Z" fill="#B8E89C"/>
            <path d="M38 44 L50 20 L62 44Z" fill="#DCE6EA"/><path d="M45 30 L50 20 L55 30Z" fill="#FFF"/>
            <path d="M${path.join(" L")}" fill="none" stroke="#FFF" stroke-width="2.2" stroke-dasharray="2 2" stroke-linecap="round" opacity=".9"/>
            <path d="M${STOPS[4].x} ${STOPS[4].y} Q 80 62 ${STOPS[6].x} ${STOPS[6].y}" fill="none" stroke="#FFC83D" stroke-width="2.2" stroke-dasharray="2 2" stroke-linecap="round"/>
          </svg>
          ${STOPS.map(s=>{ const done = skillStar(s.id), lock = s.id!=="dojo" && s.id!=="kitchen" && !S.placed, soon = s.soon;
            return `<button type="button" class="stop${s.id===nx ? " next" : ""}${lock || soon ? " lock" : ""}${soon ? " soon" : ""}" data-id="${s.id}" style="left:${s.x}%;top:${s.y}%" aria-label="${s.name}">
              <span class="ic">${s.icon}</span><span class="nm">${s.name}</span><span class="st">${done ? "⭐".repeat(done) : (soon ? "soon" : "")}</span></button>`; }).join("")}
          <span class="hero nori" id="njhero"></span>
          <div class="bubble" id="njsay"></div>
          <div class="grown"><button type="button" class="reset">↺ Start over (grown-ups)</button></div>
        </div>`);
        const hero = root.querySelector("#njhero"), at = STOPS.find(s=>s.id===(S.at||"dojo"));
        hero.style.left = at.x+"%"; hero.style.top = at.y+"%";
        const sayEl = root.querySelector("#njsay");
        const msg = !S.placed ? "Welcome! Tap the <b>Dojo</b> to warm up. I will find the right trail for you."
          : nx==="kitchen" ? "You passed every stop! The <b>Ninja Kitchen</b> is open. Go make a mess." : `Next stop: <b>${STOPS.find(s=>s.id===nx).name}</b>. Tap it!`;
        sayEl.innerHTML = `<span class="nori s"></span><span>${msg}</span>`; later(()=>V(!S.placed ? "trail.welcome" : "next." + nx), 700);
        root.querySelectorAll(".stop").forEach(b=>b.addEventListener("click", ()=>{
          const id = b.dataset.id; api.audio();
          if(b.classList.contains("soon")){ api.sfx("boop"); sayEl.innerHTML = `<span class="nori s"></span><span>The <b>Monster Mall</b> opens soon.</span>`; V("trail.soon"); return; }
          if(b.classList.contains("lock")){ api.sfx("boop"); sayEl.innerHTML = `<span class="nori s"></span><span>Warm up at the <b>Dojo</b> first.</span>`; V("trail.warm"); return; }
          if(id==="kitchen" && !S.meals){ api.sfx("boop"); sayEl.innerHTML = `<span class="nori s"></span><span>Pass a stop to open the <b>Kitchen</b>. You earn the mess!</span>`; V("trail.earn"); return; }
          api.sfx("pop"); const st = STOPS.find(s=>s.id===id); hero.classList.add("hop"); hero.style.left = st.x+"%"; hero.style.top = st.y+"%"; S.at = id; save();
          later(()=>{ if(id==="dojo") placement(); else if(id==="bd") bdDojo(); else if(id==="kitchen") kitchen(); else lesson(id); }, reduced ? 50 : 900);
        }));
        root.querySelector(".reset").addEventListener("click", ()=>{ S = {v:1, stars:{}, placed:false, meals:0}; save(); api.sfx("whoosh"); trail(); });
      }

      /* ---------- lesson loop: hear, build, write, read ---------- */
      function lesson(id){
        const sk = SKILLS[id], words = pick(sk.words, 6); let i = 0, firstTry = 0, results = [];
        V(id + ".intro");
        const step = ()=>{ if(i >= words.length) return finish(); build(words[i], {syl: sk.syl, dk: id}, (ok)=>{ if(ok) firstTry++; results.push(ok); write(words[i], i < 3, ()=>{ read(words[i], ()=>{ i++; step(); }); }); }); };
        const finish = ()=>{
          const pass = firstTry >= 5, stars = firstTry >= 6 ? 3 : firstTry >= 5 ? 2 : 1;
          if(pass){ S.stars[id] = Math.max(skillStar(id), stars); S.meals = (S.meals||0) + 1; save(); api.sfx("cheer"); api.confetti(); }
          show(top(sk.name) + `<div class="done"><div class="big">${pass ? "🏆" : "💪"}</div>
            <h2>${pass ? "You passed " + sk.name + "!" : "Good practice!"}</h2>
            <p>${firstTry} of 6 words right on the first try. ${pass ? "The Ninja Kitchen is open. Go slice some fruit!" : "Get 5 of 6 to pass. Try this stop again. You know more than you did!"}</p>
            <div class="row">${pass ? `<button type="button" class="btn go kitchen">🔪 Ninja Kitchen</button>` : `<button type="button" class="btn again">Try again</button>`}<button type="button" class="btn alt tr">🗺️ Trail</button></div></div>`);
          V(pass ? "pass.yes" : "pass.no");
          const k = root.querySelector(".kitchen"); if(k) k.addEventListener("click", ()=>{ api.sfx("pop"); kitchen(); });
          const a = root.querySelector(".again"); if(a) a.addEventListener("click", ()=>{ api.sfx("pop"); lesson(id); });
          root.querySelector(".tr").addEventListener("click", ()=>{ api.sfx("tap"); trail(); });
        };
        const prog = ()=>`<div class="prog">${words.map((w,k)=>`<i class="${k<i ? (results[k] ? "ok" : "miss") : k===i ? "on" : ""}"></i>`).join("")}</div>`;
        lesson.prog = prog; lesson.title = sk.name;
        step();
      }
      /* The goal strip: Nori the ninja, the step number, and one plain instruction. Every lesson screen starts with it. */
      const STEPS = ["Hear it","Build it","Write it","Read it"];
      function goal(n, text, p){
        return `<div class="goal"><span class="nori ${p||"point"}"></span><div class="gtxt"><div class="gsteps">${STEPS.map((x,k)=>`<span class="${k<n ? "did" : k===n ? "now" : ""}">${k+1}</span>`).join("")}<b>${STEPS[n]}</b></div><div class="ginst">${text}</div></div></div>`;
      }

      function build(word, opts, done){
        const syl = !!(opts && opts.syl) || !!word.syl;
        const parts = word.t, pool = syl ? pick(SYL_DISTRACT.filter(d=>!parts.includes(d)), 2) : pick((DISTRACT[(opts && opts.dk) || "e"]).filter(d=>!parts.includes(d)), 2);
        const tiles = shuffle(parts.map((p,k)=>({p, k})).concat(pool.map(p=>({p, k:-1}))));
        let at = 0, misses = 0, first = true;
        show(top(lesson.title || "Warm up") + `<div class="les">${lesson.prog ? lesson.prog() : ""}${goal(1, syl ? "Tap the two parts in order to build the word." : "Tap the sounds in order to build the word.")}<div class="card">
          <div class="pic">${word.p}</div>
          <div class="hears"><button type="button" class="hear say">🔊 Say it again</button><button type="button" class="hear sdb dim">${syl ? "Hear the parts" : "Hear the sounds"}</button></div>
          <div class="boxes" data-parts="${parts.join("|")}">${parts.map((p,k)=>`<div class="box${syl ? " syl" : ""}${!syl && word.v===k ? " v" : ""}${!syl && p==="e" && k===parts.length-1 ? " magic" : ""}" data-k="${k}"></div>`).join("")}</div>
          <div class="coach">${syl ? "Tap the two parts in order." : "Tap the sounds in order."}</div>
          <div class="snds">${tiles.map((t,n)=>`<button type="button" class="snd${syl ? " syl" : ""}${!syl && /^[aeiou]+$/.test(t.p) ? " v" : ""}" data-n="${n}">${t.p}</button>`).join("")}</div>
        </div></div>`);
        const coach = root.querySelector(".coach"), boxes = [...root.querySelectorAll(".box")];
        if(api.preloadVoice) api.preloadVoice("ninja", ["word."+word.w, "sounds."+word.w, "sent."+word.w, "coach.1", "coach.2", "coach.first", "coach.got", "step.build", "step.build.syl", "step.trace", "step.copy", "step.read", "read.kick", "write.great", "write.nice", "write.again"].concat(word.s ? word.s.toLowerCase().replace(/[^a-z ']/g,"").split(" ").map(x=>"w."+x) : []));
        const longV = (opts && opts.dk)==="e" && parts[parts.length-1]==="e" && parts.length > 2;
        const sayParts = ()=> V("sounds." + word.w, soundsOf(word, longV));
        V("word." + word.w, word.w + "."); afterV(()=>V(syl ? "step.build.syl" : "step.build"), 500);
        root.querySelector(".hear.say").addEventListener("click", ()=>{ api.audio(); api.sfx("tap"); V("word." + word.w, word.w + "."); });
        root.querySelector(".hear.sdb").addEventListener("click", ()=>{ api.audio(); api.sfx("tap"); sayParts(); });
        root.querySelectorAll(".snd").forEach(b=>b.addEventListener("click", ()=>{
          api.audio(); const t = tiles[+b.dataset.n];
          if(t.p === parts[at]){
            b.classList.add("used"); boxes[at].textContent = t.p; boxes[at].classList.add("full"); api.sfx("pop"); at++;
            if(at === parts.length){ coach.textContent = word.w + "! " + (misses ? "You got it." : "First try!"); coach.classList.add("good"); api.sfx("grow"); pose("cheer"); V(misses ? "coach.got" : "coach.first"); afterV(()=>done(first), 600); }
            else coach.textContent = "";
          } else {
            misses++; first = false; b.classList.remove("no"); void b.offsetWidth; b.classList.add("no"); api.sfx("boop");
            const sb = root.querySelector(".hear.sdb"); sb.classList.remove("dim"); sb.classList.add("go");
            const ci = Math.min(misses, COACH.length);
            coach.textContent = COACH[ci-1]; pose("think"); V("coach." + ci); afterV(sayParts, 400);
            if(misses >= 2){ boxes[at].textContent = parts[at]; boxes[at].classList.add("hint"); }
          }
        }));
      }

      function write(word, trace, done){
        let tries = 0;
        const draw = ()=>{
          show(top(lesson.title || "Warm up") + `<div class="les">${lesson.prog ? lesson.prog() : ""}${goal(2, trace ? "Trace the word on the lines with your finger." : "Now write it by yourself. Big letters touch the top line.")}<div class="card">
            <div class="model" aria-hidden="true">${trace ? "" : word.w}</div>
            <div class="coach"></div>
            <div class="wrap"><canvas class="pad"></canvas></div>
            <div class="row"><button type="button" class="btn alt clear">Clear</button><button type="button" class="btn alt hear2">🔊</button><button type="button" class="btn go check">Done ✓</button></div>
          </div></div>`);
          const wrap = root.querySelector(".wrap"), pad = root.querySelector(".pad"), ctx = pad.getContext("2d");
          const model = document.createElement("canvas"), mctx = model.getContext("2d");
          let W = 0, H = 0, strokes = [], cur = null, lines = {};
          const size = ()=>{ const r = wrap.getBoundingClientRect(); W = Math.max(200, r.width|0); H = Math.max(120, r.height|0); pad.width = W*2; pad.height = H*2; ctx.setTransform(2,0,0,2,0,0); model.width = W; model.height = H; render(); };
          const font = ()=>{ const fs = Math.min(H*.62, W/(word.w.length*.72)); return {fs, f:`800 ${fs}px Nunito, ui-rounded, system-ui, sans-serif`}; };
          function render(){
            ctx.clearRect(0,0,W,H);
            const {fs, f} = font(); const base = H*.72, topL = base - fs*.72, mid = base - fs*.38;
            lines = {base, topL, mid, fs};
            ctx.strokeStyle = "#B99CF2"; ctx.lineWidth = 2; ctx.setLineDash([]);
            [topL, base].forEach(y=>{ ctx.beginPath(); ctx.moveTo(12,y); ctx.lineTo(W-12,y); ctx.stroke(); });
            ctx.setLineDash([6,6]); ctx.beginPath(); ctx.moveTo(12,mid); ctx.lineTo(W-12,mid); ctx.stroke(); ctx.setLineDash([]);
            ctx.font = f; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
            if(trace){ ctx.fillStyle = "rgba(81,34,165,.18)"; ctx.fillText(word.w, W/2, base); }
            mctx.clearRect(0,0,W,H); mctx.font = f; mctx.textAlign = "center"; mctx.textBaseline = "alphabetic"; mctx.fillStyle = "#000"; mctx.fillText(word.w, W/2, base);
            ctx.strokeStyle = "#30254A"; ctx.lineWidth = Math.max(4, fs*.09); ctx.lineCap = "round"; ctx.lineJoin = "round";
            strokes.forEach(s=>{ ctx.beginPath(); s.forEach((p,i)=> i ? ctx.lineTo(p[0],p[1]) : ctx.moveTo(p[0],p[1])); ctx.stroke(); });
          }
          const pt = e => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
          pad.addEventListener("pointerdown", e=>{ e.preventDefault(); pad.setPointerCapture(e.pointerId); cur = [pt(e)]; strokes.push(cur); api.audio(); });
          pad.addEventListener("pointermove", e=>{ if(!cur) return; cur.push(pt(e)); render(); });
          const up = ()=>{ if(cur && cur.length===1) cur.push([cur[0][0]+.5, cur[0][1]+.5]); cur = null; render(); };
          pad.addEventListener("pointerup", up); pad.addEventListener("pointercancel", up);
          root.querySelector(".clear").addEventListener("click", ()=>{ strokes = []; render(); api.sfx("whoosh"); });
          if(tries===0) later(()=>V(trace ? "step.trace" : "step.copy"), 300);
          root.querySelector(".hear2").addEventListener("click", ()=>{ api.audio(); V("word." + word.w, word.w + "."); });
          root.querySelector(".check").addEventListener("click", ()=>{
            api.audio(); tries++;
            const r = score(); const coach = root.querySelector(".coach");
            if(!r.ink){ coach.textContent = LINES["write.ink"]; api.sfx("boop"); V("write.ink"); return; }
            if(r.cover >= (trace ? .5 : .32) || tries >= 2){
              const k = r.cover >= .6 ? "write.great" : "write.nice"; coach.textContent = LINES[k]; coach.classList.add("good"); api.sfx("grow"); pose("cheer"); V(r.tipKey || k);
              afterV(()=>done(), 600);
            } else {
              const k = r.tipKey || "write.again"; coach.textContent = LINES[k]; api.sfx("boop"); pose("think"); V(k);
            }
          });
          function score(){
            // coverage: how much of the model word has ink within a small radius; tips: size against the lines
            const m = mctx.getImageData(0,0,W,H).data, hit = document.createElement("canvas"); hit.width = W; hit.height = H;
            const hc = hit.getContext("2d"); hc.strokeStyle = "#000"; hc.lineWidth = Math.max(10, lines.fs*.2); hc.lineCap = "round"; hc.lineJoin = "round";
            strokes.forEach(s=>{ hc.beginPath(); s.forEach((p,i)=> i ? hc.lineTo(p[0],p[1]) : hc.moveTo(p[0],p[1])); hc.stroke(); });
            const h = hc.getImageData(0,0,W,H).data; let tot = 0, cov = 0;
            for(let i=3;i<m.length;i+=4*3){ if(m[i] > 90){ tot++; if(h[i] > 40) cov++; } }
            const pts = strokes.flat(); if(pts.length < 4) return {ink:false};
            let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9; pts.forEach(p=>{ minY = Math.min(minY,p[1]); maxY = Math.max(maxY,p[1]); minX = Math.min(minX,p[0]); maxX = Math.max(maxX,p[0]); });
            let tipKey = "";
            const tall = /[bdfhklt]/.test(word.w);
            if(maxY - minY < lines.fs*.25) tipKey = "write.tip.big";
            else if(tall && minY > lines.mid - lines.fs*.05) tipKey = "write.tip.tall";
            else if(maxY > lines.base + lines.fs*.3 && !/[gjpqy]/.test(word.w)) tipKey = "write.tip.base";
            else if(maxX - minX > W*.92) tipKey = "write.tip.close";
            return {ink:true, cover: tot ? cov/tot : 0, tipKey};
          }
          size(); const ro = new ResizeObserver(size); ro.observe(wrap); cleanupFns.push(()=>ro.disconnect());
        };
        draw();
      }

      function read(word, done){
        const ws = word.s.split(" "); let said = new Set();
        show(top(lesson.title || "Warm up") + `<div class="les">${lesson.prog ? lesson.prog() : ""}${goal(3, "Tap each word to hear it. Then read the whole sentence out loud.")}<div class="card">
          <div class="pic">${word.p}</div>
          <div class="sent">${ws.map((x,k)=>`<button type="button" data-k="${k}" class="${x.replace(/[^a-z]/gi,"").toLowerCase()===word.w ? "key" : ""}">${x}</button>`).join("")}</div>
          <div class="row"><button type="button" class="btn alt all">🔊 Read it to me</button><button type="button" class="btn go did">I read it! ✓</button></div>
        </div></div>`);
        later(()=>V("step.read"), 300);
        root.querySelectorAll(".sent button").forEach(b=>b.addEventListener("click", ()=>{ api.audio(); api.sfx("tap"); const t = b.textContent.replace(/[^a-z']/gi,"").toLowerCase(); V("w." + t, t); b.classList.add("said"); said.add(b.dataset.k); }));
        root.querySelector(".all").addEventListener("click", ()=>{ api.audio(); V("sent." + word.w, word.s); });
        root.querySelector("button.did").addEventListener("click", ()=>{ api.audio(); api.sfx("cheer"); pose("cheer"); V("read.kick"); afterV(done, 500); });
      }

      /* ---------- placement (the dojo warm up) ---------- */
      function placement(){
        let i = 0, start = null; lesson.title = "Dojo warm up"; lesson.prog = null;
        V("dojo.intro");
        const step = ()=>{
          if(i >= PLACE.length || start){ const s = start || "two"; S.placed = true; S.start = s; S.at = "dojo"; save();
            const name = SKILLS[s].name; api.sfx("cheer");
            show(top("Dojo") + `<div class="done"><span class="nori cheer" style="width:90px;height:100px"></span><h2>Your trail starts at ${name}.</h2><p>${start ? "That word was tricky. We start right there." : "You built every word! We start at the top."}</p><div class="row"><button type="button" class="btn go tr">🗺️ To the trail</button></div></div>`);
            V("dojo.start." + s);
            root.querySelector(".tr").addEventListener("click", ()=>{ api.sfx("pop"); trail(); }); return; }
          const w = PLACE[i]; build(w, {syl: w.syl, dk: w.skill==="vt" ? "vt" : "e"}, ok=>{ if(!ok && !start) start = w.skill; i++; step(); });
        };
        step();
      }

      /* ---------- b and d dojo ---------- */
      function bdDojo(){
        const rounds = pick(BD, 10); let i = 0, right = 0;
        V("bd.intro");
        const step = ()=>{
          if(i >= rounds.length){ const pass = right >= 8; if(pass){ S.stars.bd = Math.max(skillStar("bd"), right >= 10 ? 3 : 2); S.meals = (S.meals||0)+1; save(); api.sfx("cheer"); api.confetti(); }
            show(top("b and d Dojo") + `<div class="done"><div class="big">${pass ? "🥋" : "💪"}</div><h2>${right} of 10!</h2><p>${pass ? "Black belt in b and d. The kitchen is open!" : "Get 8 of 10 to pass. Remember: b, e, d spells bed."}</p>
              <div class="row">${pass ? `<button type="button" class="btn go kitchen">🔪 Ninja Kitchen</button>` : `<button type="button" class="btn again">Try again</button>`}<button type="button" class="btn alt tr">🗺️ Trail</button></div></div>`);
            V(pass ? "bd.pass" : "bd.no");
            const k = root.querySelector(".kitchen"); if(k) k.addEventListener("click", ()=>kitchen());
            const a = root.querySelector(".again"); if(a) a.addEventListener("click", ()=>bdDojo());
            root.querySelector(".tr").addEventListener("click", ()=>trail()); return; }
          const r = rounds[i];
          show(top("b and d Dojo") + `<div class="les"><div class="prog">${rounds.map((x,k)=>`<i class="${k<i ? "ok" : k===i ? "on" : ""}"></i>`).join("")}</div>
            <div class="goal"><span class="nori point"></span><div class="gtxt"><div class="ginst">Which letter starts the word? Tap b or d.</div></div></div><div class="card">
            <div class="pic">${r.p}</div><div class="big">${r.w.replace("_","＿")}</div>
            <div class="coach"></div>
            <div class="bd"><button type="button" class="b" data-a="b">b</button><button type="button" class="d" data-a="d">d</button></div>
            <div class="trick">Thumbs up! Left hand is <b>b</b>, right hand is <b>d</b>. <b>bed</b></div>
          </div></div>`);
          V("w." + r.w.replace("_", r.a), r.w.replace("_", r.a) + ".");
          root.querySelectorAll(".bd button").forEach(b=>b.addEventListener("click", ()=>{
            api.audio(); const ok = b.dataset.a === r.a; const coach = root.querySelector(".coach");
            if(ok){ right++; coach.textContent = r.w.replace("_", r.a) + "!"; coach.classList.add("good"); api.sfx("pop"); root.querySelector(".big").textContent = r.w.replace("_", r.a); i++; afterV(step, 400); }
            else { coach.textContent = LINES["bd.miss"]; api.sfx("boop"); pose("think"); V("bd.miss"); root.querySelectorAll(".bd button").forEach(x=>x.disabled = true); afterV(()=>{ i++; step(); }, 700); }
          }));
        };
        step();
      }

      /* ---------- the kitchen: slice, splat, mess ---------- */
      function kitchen(){
        S.meals = Math.max(0, (S.meals||0) - 1); save();
        show(top("Ninja Kitchen", `<span class="stars">⏱️ <span id="njt">45</span></span>`) + `<div class="kit">
          <div class="wall"></div>
          <canvas class="mess"></canvas>
          <div class="floor"></div>
          <div class="kit-score"><span id="njc">0</span> sliced</div>
          <div class="meter" aria-label="Mess meter"><i></i><b>MESS</b></div>
          <div class="tools"><button type="button" class="on" data-t="🗡️">🗡️</button><button type="button" data-t="🔪">🔪</button><button type="button" data-t="🪓">🪓</button></div>
          <span class="blade">🗡️</span>
          <div class="kit-ui"><button type="button" class="btn alt clean">🧽 Clean up</button><button type="button" class="btn tr">🗺️ Trail</button></div>
        </div>`);
        const kit = root.querySelector(".kit"), mess = root.querySelector(".mess"), mc = mess.getContext("2d"), blade = root.querySelector(".blade"), meter = root.querySelector(".meter i");
        let W = 0, H = 0; const size = ()=>{ const r = kit.getBoundingClientRect(); W = r.width; H = r.height; const img = W && mess.width ? mc.getImageData(0,0,mess.width,mess.height) : null; mess.width = W; mess.height = H; if(img) mc.putImageData(img,0,0); };
        size(); const ro = new ResizeObserver(size); ro.observe(kit); cleanupFns.push(()=>ro.disconnect());
        let foods = [], halves = [], chunks = [], drips = [], pile = [], count = 0, t = 45, last = performance.now(), spawnAt = 0, swipe = [], down = false, swipeHits = 0, maxed = false;
        const tEl = root.querySelector("#njt"), cEl = root.querySelector("#njc");
        const BIG = ["🍉","🎃","🎂","🍍"];
        V("kit.go");
        later(function tk(){ t--; tEl.textContent = t; if(t <= 0){ end(); return; } later(tk, 1000); }, 1000);
        root.querySelectorAll(".tools button").forEach(b=>b.addEventListener("click", ()=>{ root.querySelectorAll(".tools button").forEach(x=>x.classList.remove("on")); b.classList.add("on"); blade.textContent = b.dataset.t; api.sfx("tap"); }));
        root.querySelector(".clean").addEventListener("click", ()=>{ mc.clearRect(0,0,W,H); drips = []; pile.forEach(c=>c.el.remove()); pile = []; meter.style.height = "0%"; maxed = false; kit.classList.remove("max"); api.sfx("whoosh"); V("kit.clean"); });
        root.querySelector(".tr").addEventListener("click", ()=>{ api.sfx("tap"); trail(); });
        function spawn(){ const e = FOODS[Math.random()*FOODS.length|0], el = document.createElement("span"); el.className = "food"; el.textContent = e; if(BIG.includes(e)) el.classList.add("big");
          const f = {e, el, x: W*.15 + Math.random()*W*.7, y: H + 30, vx: (Math.random()-.5)*2.4, vy: -Math.sqrt(2*.22*H*(.5 + Math.random()*.3)), r: Math.random()*360, vr: (Math.random()-.5)*6};
          kit.appendChild(el); foods.push(f); }
        function splat(x, y, c, big){
          const n = big ? 16 : 9, R = big ? 60 : 34;
          for(let i=0;i<n;i++){ const a = Math.random()*Math.PI*2, d = Math.random()*R; mc.fillStyle = c; mc.globalAlpha = .78; mc.beginPath(); mc.ellipse(x+Math.cos(a)*d, y+Math.sin(a)*d, 4+Math.random()*(big ? 18 : 12), 3+Math.random()*(big ? 13 : 9), a, 0, Math.PI*2); mc.fill(); }
          mc.globalAlpha = .92; mc.beginPath(); mc.arc(x, y, (big ? 26 : 14)+Math.random()*10, 0, Math.PI*2); mc.fill();
          // a few tiny dots fly further
          for(let i=0;i<(big ? 14 : 6);i++){ const a = Math.random()*Math.PI*2, d = R + Math.random()*R*1.4; mc.globalAlpha = .7; mc.beginPath(); mc.arc(x+Math.cos(a)*d, y+Math.sin(a)*d, 1.5+Math.random()*3.5, 0, Math.PI*2); mc.fill(); }
          mc.globalAlpha = 1;
          // drips run down from the splat for a while
          for(let i=0;i<(big ? 4 : 2);i++) drips.push({x: x + (Math.random()-.5)*(big ? 50 : 24), y: y + 6, len: 0, max: 30 + Math.random()*(big ? 120 : 70), w: 3 + Math.random()*4, c, v: .6 + Math.random()*1.2});
        }
        function chunk(f, x, y, big){
          const n = big ? 7 : 3;
          for(let i=0;i<n;i++){ const el = document.createElement("span"); el.className = "chunk"; el.style.background = JUICE[f.e] || "#FF5FA2"; el.style.width = el.style.height = (6 + Math.random()*(big ? 14 : 9)) + "px"; kit.appendChild(el);
            chunks.push({el, x, y, vx: (Math.random()-.5)*9, vy: -3 - Math.random()*6, r: Math.random()*360}); }
        }
        function slice(f, x, y){
          foods = foods.filter(g=>g!==f); f.el.remove(); count++; cEl.textContent = count; swipeHits++;
          const big = BIG.includes(f.e); api.sfx(big ? "splash" : (count % 3 ? "squish" : "splash")); splat(x, y, JUICE[f.e] || "#FF5FA2", big); chunk(f, x, y, big);
          if(big){ kit.classList.remove("shake"); void kit.offsetWidth; kit.classList.add("shake"); pop(x, y, "SPLAT!"); }
          ["l","r"].forEach(side=>{ const h = document.createElement("span"); h.className = "half " + side; h.innerHTML = `<span>${f.e}</span>`; kit.appendChild(h);
            halves.push({el:h, x: f.x + (side==="l" ? -14 : 2), y: f.y - 30, vx: (side==="l" ? -1 : 1)*(1.5+Math.random()*2), vy: -3 - Math.random()*3, r: 0, vr: (side==="l" ? -1 : 1)*8}); });
          const m = Math.min(100, Math.round(count/30*100)); meter.style.height = m + "%";
          if(m >= 100 && !maxed){ maxed = true; kit.classList.add("max"); api.sfx("cheer"); api.confetti(); pop(W/2, H*.35, "MAXIMUM MESS!"); V("kit.max"); }
          else if(count % 10 === 0) V("kit." + (1 + (count/10|0) % 4));
        }
        function pop(x, y, txt){ const el = document.createElement("span"); el.className = "pop"; el.textContent = txt; el.style.left = x+"px"; el.style.top = y+"px"; kit.appendChild(el); later(()=>el.remove(), 900); }
        const pos = e => { const r = kit.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        kit.addEventListener("pointerdown", e=>{ if(e.target.closest("button")) return; down = true; swipeHits = 0; kit.classList.add("live"); api.audio(); swipe = [pos(e)]; const p = swipe[0]; blade.style.left = p[0]+"px"; blade.style.top = p[1]+"px"; });
        kit.addEventListener("pointermove", e=>{ const p = pos(e); blade.style.left = p[0]+"px"; blade.style.top = p[1]+"px"; if(!down) return; swipe.push(p); if(swipe.length > 6) swipe.shift();
          const q = swipe[0], dist = Math.hypot(p[0]-q[0], p[1]-q[1]); if(dist < 14) return;
          blade.style.transform = `translate(-30%,-70%) rotate(${Math.atan2(p[1]-q[1], p[0]-q[0])*180/Math.PI - 20}deg)`;
          const prev = swipe[swipe.length-2] || q, n = Math.max(1, Math.ceil(Math.hypot(p[0]-prev[0], p[1]-prev[1]) / 18));
          for(let k=0;k<=n;k++){ const x = prev[0] + (p[0]-prev[0])*k/n, y = prev[1] + (p[1]-prev[1])*k/n; foods.slice().forEach(f=>{ if(Math.hypot(f.x-x, f.y-y) < 44) slice(f, x, y); }); }
          if(Math.random() < .3) api.sfx("whoosh"); });
        const up = ()=>{ if(down && swipeHits >= 3){ pop(W/2, H*.3, swipeHits >= 5 ? "MEGA SLICE!" : "TRIPLE SLICE!"); V("kit.triple"); } down = false; swipe = []; swipeHits = 0; };
        kit.addEventListener("pointerup", up); kit.addEventListener("pointercancel", up); kit.addEventListener("pointerleave", up);
        function frame(now){ const dt = Math.min(2, (now-last)/16.7); last = now;
          if(now > spawnAt){ spawn(); if(Math.random() < .35) spawn(); spawnAt = now + 650 + Math.random()*500; }
          foods.slice().forEach(f=>{ f.vy += .22*dt; f.x += f.vx*dt; f.y += f.vy*dt; f.r += f.vr*dt; f.el.style.transform = `translate(-50%,-50%) translate(${f.x}px,${f.y}px) rotate(${f.r}deg)`; if(f.y > H + 60){ f.el.remove(); foods = foods.filter(g=>g!==f); } });
          halves.slice().forEach(h=>{ h.vy += .3*dt; h.x += h.vx*dt; h.y += h.vy*dt; h.r += h.vr*dt; h.el.style.transform = `translate(${h.x}px,${h.y}px) rotate(${h.r}deg)`;
            if(h.y > H - 46){ // lands on the floor and stays as part of the pile
              h.el.style.transform = `translate(${h.x}px,${H - 46 - Math.random()*10}px) rotate(${Math.round(h.r/20)*20}deg)`; h.el.classList.add("rest"); pile.push({el:h.el}); halves = halves.filter(g=>g!==h);
              if(pile.length > 40){ const old = pile.shift(); old.el.remove(); } } });
          chunks.slice().forEach(c=>{ c.vy += .35*dt; c.x += c.vx*dt; c.y += c.vy*dt; c.r += 9*dt; c.el.style.transform = `translate(${c.x}px,${c.y}px) rotate(${c.r}deg)`;
            if(c.y > H - 30 - Math.random()*14){ c.el.classList.add("rest"); pile.push({el:c.el}); chunks = chunks.filter(g=>g!==c); if(pile.length > 40){ const old = pile.shift(); old.el.remove(); } } });
          drips.slice().forEach(d=>{ d.len += d.v*dt; mc.fillStyle = d.c; mc.globalAlpha = .8; mc.beginPath(); mc.ellipse(d.x, d.y + d.len, d.w*.5, d.w*.9, 0, 0, Math.PI*2); mc.fill(); mc.globalAlpha = 1; if(d.len >= d.max){ mc.beginPath(); mc.arc(d.x, d.y + d.len, d.w*.9, 0, Math.PI*2); mc.fill(); drips = drips.filter(g=>g!==d); } });
          raf = requestAnimationFrame(frame); }
        raf = requestAnimationFrame(frame);
        function end(){ cancelAnimationFrame(raf); raf = 0; foods.forEach(f=>f.el.remove()); foods = []; api.sfx("cheer"); api.confetti();
          const ui = root.querySelector(".kit-ui"); ui.innerHTML = `<button type="button" class="btn go tr2">🗺️ Back to the trail</button>`; root.querySelector(".kit-score").textContent = count + " sliced! What a mess."; V("kit.end");
          root.querySelector(".tr2").addEventListener("click", ()=>{ api.sfx("tap"); trail(); }); }
      }

      trail();
      return ()=>{ clearTimers(); };
    }
  });
})();
