/* NDS Performance bridge: game-agnostic MIDI, stylus, save-state and RAM control for any .nds ROM.
   Built on little-scale's DS-10 performance wrapper (EmulatorJS + DeSmuME inside jweb~). */
(() => {
'use strict';
const BUTTONS={b:0,y:1,select:2,start:3,up:4,down:5,left:6,right:7,a:8,x:9,l:10,r:11,l2:12,r2:13,l3:14,r3:15};
// Default note layout. Live names: MIDI 60 = C3.
const LAYOUT={
  states:{first:24,count:4},                                                                // C0–D#0 recall state 1–4
  buttons:{first:36,order:['a','b','x','y','l','r','start','select','up','down','left','right']}, // C1–B1
  grid:{first:48,cols:8,rows:6}                                                             // C2–B5 touch grid, C2 = bottom left
};
const SLOTS=8, RAM=0x02000000, RAM_SIZE=0x400000;
const NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const noteName=n=>NAMES[n%12]+(Math.floor(n/12)-2);

/* Small IndexedDB key/value store. Every call may fail inside jweb~; callers treat it as optional. */
const idb=(()=>{
  let opened=null;
  const open=()=>opened||(opened=new Promise((resolve,reject)=>{
    const r=indexedDB.open('nds-performance',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('kv');
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  }));
  const run=(mode,fn)=>open().then(db=>new Promise((resolve,reject)=>{
    const t=db.transaction('kv',mode),req=fn(t.objectStore('kv'));
    t.oncomplete=()=>resolve(req.result);t.onerror=()=>reject(t.error);
  }));
  return {get:k=>run('readonly',s=>s.get(k)),put:(k,v)=>run('readwrite',s=>s.put(v,k)),del:k=>run('readwrite',s=>s.delete(k))};
})();
const local={
  get(k){try{return JSON.parse(localStorage.getItem(k));}catch(_){return null;}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(_){}}
};

let layout='horizontal', game={title:'',code:'',header:null};
let learned={}, learning=false, learnNote=null, glide=false;
const held=new Map(), touchNotes=[], slots=new Map();
const stylus={x:128,y:96,down:false};
// Values from Live parameters can arrive before the ROM runs; apply them on start.
const wanted={speed:1,paused:false,dial:[128,96],hold:false,glitch:0,chaos:0,pad:true};
let retapTimer=null, ram=null, monitorRunning=false;

let hudTimer=null;
function hud(text,sticky=false){
  const el=document.getElementById('hud');if(!el)return;
  el.textContent=text;el.hidden=!text;clearTimeout(hudTimer);
  if(text&&!sticky)hudTimer=setTimeout(()=>{el.hidden=true;},1800);
}
function report(...args){
  const status=document.getElementById('status');
  if(status){status.textContent=args.join(' ');status.hidden=args[0]!=='error';}
  if(window.max)window.max.outlet(...args);
  console.log('[NDS bridge]',...args);
}
function emulator(){
  const e=window.EJS_emulator;
  if(!e||!e.started||!e.gameManager)throw new Error('Start a ROM first');
  return e;
}
const running=()=>!!(window.EJS_emulator&&window.EJS_emulator.started&&window.EJS_emulator.gameManager);
// Keep emulating while the page is hidden (in Live: the device is off screen). Animation frames stop
// when hidden, so switch the core's main loop to a 60 Hz timer (setMainLoopTiming is patched in by build.py).
function followVisibility(){
  const e=window.EJS_emulator,m=e&&e.Module;if(!m||!m.setMainLoopTiming)return;
  if(document.hidden)m.setMainLoopTiming(0,1000/60);else m.setMainLoopTiming(1,1);
  if(!e.paused){m.pauseMainLoop();m.resumeMainLoop();} // restart the loop with the new timing
}
document.addEventListener('visibilitychange',()=>{try{followVisibility();}catch(error){report('error',error.message);}});
const int=(v,lo,hi,what)=>{v=Number(v);if(!Number.isInteger(v)||v<lo||v>hi)throw Error(what+' must be '+lo+'–'+hi);return v;};
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,Math.round(Number(v)||0)));

/* Lower-screen coordinates (0–255, 0–191) to canvas mouse events, and back. */
function geometry(){
  const e=emulator(),canvas=e.canvas||e.Module.canvas,r=canvas.getBoundingClientRect();
  const h=layout==='horizontal',nw=h?512:256,nh=h?192:384;
  const width=Math.min(r.width,r.height*nw/nh),height=width*nh/nw;
  return {canvas,left:r.left+(r.width-width)/2,top:r.top+(r.height-height)/2,width,height,nw,nh,ox:h?256:0,oy:h?0:192};
}
function pointer(type,x,y,down){
  const g=geometry();
  g.canvas.dispatchEvent(new MouseEvent(type,{clientX:g.left+(x+g.ox+.5)/g.nw*g.width,
    clientY:g.top+(y+g.oy+.5)/g.nh*g.height,button:0,buttons:down?1:0,bubbles:true}));
}
function toNative(clientX,clientY){
  const g=geometry();
  const x=Math.floor((clientX-g.left)/g.width*g.nw)-g.ox,y=Math.floor((clientY-g.top)/g.height*g.nh)-g.oy;
  return x>=0&&x<256&&y>=0&&y<192?[x,y]:null;
}
function press(x,y){stylus.x=x;stylus.y=y;pointer('mousemove',x,y,true);pointer('mousedown',x,y,true);stylus.down=true;}
function drag(x,y){stylus.x=x;stylus.y=y;pointer('mousemove',x,y,true);}
function lift(){pointer('mousemove',stylus.x,stylus.y,false);pointer('mouseup',stylus.x,stylus.y,false);stylus.down=false;}
function cancelRetap(){clearTimeout(retapTimer);retapTimer=null;}
// The core samples the stylus once per frame: a new tap needs at least one frame without contact.
function afterFrames(n,fn){
  const f=()=>{try{return emulator().gameManager.functions.getFrameNum();}catch(_){return Infinity;}};
  const start=f(),t0=performance.now();
  const poll=()=>{if(f()-start>=n||performance.now()-t0>150){retapTimer=null;fn();}else retapTimer=setTimeout(poll,4);};
  cancelRetap();retapTimer=setTimeout(poll,4);
}
function tap(x,y){
  cancelRetap();
  if(!stylus.down)press(x,y);
  else if(glide)drag(x,y);
  else{lift();afterFrames(2,()=>press(x,y));}
}
function setButton(name,down){emulator().gameManager.simulateInput(0,BUTTONS[name],down?1:0);}
// MIDI, controller and Chaos can hold the same button: count holders, release on the last.
function holdButton(name){const n=(held.get(name)||0)+1;held.set(name,n);if(n===1)setButton(name,1);}
function releaseButton(name){const n=(held.get(name)||0)-1;if(n<=0){if(held.delete(name))setButton(name,0);}else held.set(name,n);}

/* Note → action: learned mappings first, then the default layout. */
function mapping(note){
  if(learned[note])return learned[note];
  const s=LAYOUT.states,b=LAYOUT.buttons,g=LAYOUT.grid;
  if(note>=s.first&&note<s.first+s.count)return {state:note-s.first+1};
  if(note>=b.first&&note<b.first+b.order.length)return {button:b.order[note-b.first]};
  const i=note-g.first;
  if(i>=0&&i<g.cols*g.rows){
    const col=i%g.cols,row=Math.floor(i/g.cols);
    return {touch:[Math.floor((col+.5)*256/g.cols),Math.floor(192-(row+.5)*192/g.rows)]};
  }
  return null;
}
function noteOn(note){
  if(learning){learnNote=note;hud('LEARN '+noteName(note)+' → tap the touch screen',true);report('learn','note',note);return;}
  const m=mapping(note);if(!m)return;
  if(m.state){api.load(m.state);return;}
  if(m.button){holdButton(m.button);return;}
  if(m.touch){const i=touchNotes.indexOf(note);if(i>=0)touchNotes.splice(i,1);touchNotes.push(note);tap(...m.touch);}
}
function noteOff(note){
  if(learning)return;
  const m=mapping(note);if(!m)return;
  if(m.button){releaseButton(m.button);return;}
  if(m.touch){
    const i=touchNotes.indexOf(note);if(i<0)return;
    const active=i===touchNotes.length-1;touchNotes.splice(i,1);
    if(!active)return;
    // Glide behaves like a mono synth: fall back to the previous held note without lifting.
    if(glide&&touchNotes.length){cancelRetap();const p=mapping(touchNotes[touchNotes.length-1]);if(stylus.down)drag(...p.touch);else press(...p.touch);}
    else{cancelRetap();if(stylus.down)lift();}
  }
}
function releaseAll(){
  cancelRetap();touchNotes.length=0;
  for(const name of held.keys())setButton(name,0);
  held.clear();chaos.held.clear();pad.buttons={};
  if(stylus.down)lift();
}

/* Learn: arm, play a note, then click the lower screen. Clicks are kept from the game while armed. */
const mapKey=()=>'nds-performance:map:'+(game.code||'unknown');
function saveMap(){local.set(mapKey(),learned);}
for(const type of ['mousedown','mouseup','click','pointerdown','pointerup','touchstart','touchend'])
  window.addEventListener(type,ev=>{
    if(!learning||!ev.isTrusted||!(ev.target instanceof HTMLCanvasElement))return;
    ev.stopImmediatePropagation();ev.preventDefault();
    // A cancelled pointerdown suppresses the mousedown that would follow, so accept either.
    if(type!=='pointerdown'&&type!=='mousedown')return;
    if(learnNote===null){hud('LEARN: play a MIDI note first',true);return;}
    const p=toNative(ev.clientX,ev.clientY);
    if(!p){hud('LEARN: tap inside the touch screen',true);return;}
    learned[learnNote]={touch:p};saveMap();
    report('learned',learnNote,p[0],p[1]);
    hud('LEARN '+noteName(learnNote)+' → '+p.join(', ')+' · next note',true);
    learnNote=null;
  },true);

/* DS main RAM inside the wasm heap. DeSmuME keeps a copy of the cartridge header at 0x027FFE00
   and the ARM9 binary at its load address; the ARM9 check rules out the ROM buffer. Save states
   hold RAM snapshots too, so take the lowest match: the emulator's static RAM sits below the heap. */
function findRam(){
  const e=emulator();
  if(ram&&ram.module===e.Module)return ram;
  const h=e.Module.HEAPU8,hd=game.header;if(!hd)throw Error('ROM header unavailable');
  const arm9Ram=new DataView(hd.buffer,hd.byteOffset,hd.byteLength).getUint32(0x28,true),arm9=game.arm9;
  const candidates=[];
  for(let p=0x3ffe00;p+0x40<=h.length;p+=4){
    if(h[p]!==hd[0]||h[p+12]!==hd[12])continue;
    let ok=true;for(let i=0;i<0x40;i++)if(h[p+i]!==hd[i]){ok=false;break;}
    if(ok)candidates.push(p-0x3ffe00);
  }
  let found=candidates;
  if(arm9&&arm9Ram>=RAM&&arm9Ram+0x800<RAM+RAM_SIZE)
    found=found.filter(base=>{const at=base+arm9Ram-RAM+0x800;return arm9.every((v,i)=>h[at+i]===v);});
  if(!found.length)throw Error('DS RAM not found yet; let the game boot');
  ram={module:e.Module,base:found[0]};
  report('ram',ram.base);
  return ram;
}
function ramAddress(a,size=1){
  a=typeof a==='string'?parseInt(a,a.startsWith('0x')?16:10):Number(a);
  if(!Number.isInteger(a))throw Error('Address must be a number or 0x… hex');
  if(a<RAM_SIZE)a+=RAM; // allow offsets
  else if(a>=RAM&&a<0x03000000)a=RAM+((a-RAM)&(RAM_SIZE-1)); // fold mirrors such as 0x027FFE00
  if(a<RAM||a+size>RAM+RAM_SIZE)throw Error('Address must be in DS main RAM 0x02000000–0x023FFFFF');
  return a;
}
// Glitch: overwrite random main-RAM bytes every frame. Recall a saved state to recover.
const glitchRange={from:RAM,to:RAM+RAM_SIZE};
function glitchTick(){
  const r=findRam(),h=window.EJS_emulator.Module.HEAPU8,span=glitchRange.to-glitchRange.from;
  for(let i=0;i<wanted.glitch;i++)h[r.base+glitchRange.from-RAM+Math.floor(Math.random()*span)]=Math.random()*256|0;
}

/* Chaos: the game plays itself. Random presses (and the odd stylus tap) at a rate set by the dial. */
const CHAOS_BUTTONS=['a','b','x','y','l','r','up','down','left','right'];
const chaos={held:new Map(),touchUntil:0};
const stylusFree=()=>!touchNotes.length&&!wanted.hold&&!pad.touch;
function chaosTick(now){
  for(const [name,until] of chaos.held)if(now>=until){chaos.held.delete(name);releaseButton(name);}
  if(chaos.touchUntil&&now>=chaos.touchUntil){chaos.touchUntil=0;if(stylus.down&&stylusFree())lift();}
  const p=wanted.chaos/100;if(!p)return;
  if(Math.random()<p*.3){
    const name=CHAOS_BUTTONS[Math.random()*CHAOS_BUTTONS.length|0];
    if(!chaos.held.has(name)){holdButton(name);chaos.held.set(name,now+40+Math.random()*360);}
  }
  if(Math.random()<p*.05&&!stylus.down&&stylusFree()){press(Math.random()*256|0,Math.random()*192|0);chaos.touchUntil=now+50+Math.random()*250;}
}
function chaosStop(){
  for(const name of chaos.held.keys())releaseButton(name);
  chaos.held.clear();
  if(chaos.touchUntil){chaos.touchUntil=0;if(stylus.down&&stylusFree())lift();}
}

/* PS5 (or any standard) controller via the Gamepad API. EmulatorJS's own pad mapping is off (started()).
   Buttons follow the Nintendo layout by position: Circle A, Cross B, Triangle X, Square Y. */
const PAD_BUTTONS={1:'a',0:'b',3:'x',2:'y',4:'l',5:'r',9:'start',8:'select',12:'up',13:'down',14:'left',15:'right'};
const pad={id:null,buttons:{},edges:{},touch:false,slow:0,cursor:[128,96],cursorTimer:null};
function showCursor(){
  const el=document.getElementById('cursor');if(!el)return;
  try{const g=geometry();
    el.style.left=(g.left+(pad.cursor[0]+g.ox+.5)/g.nw*g.width)+'px';el.style.top=(g.top+(pad.cursor[1]+g.oy+.5)/g.nh*g.height)+'px';
  }catch(_){return;}
  el.hidden=false;clearTimeout(pad.cursorTimer);
  pad.cursorTimer=setTimeout(()=>{if(!pad.touch)el.hidden=true;},1500);
}
function releasePad(){
  for(const [name,down] of Object.entries(pad.buttons))if(down)releaseButton(name);
  pad.buttons={};pad.edges={};
  if(pad.touch&&stylus.down)lift();pad.touch=false;
  if(pad.slow){pad.slow=0;applyWantedSpeed();}
}
function pollPad(){
  const pads=wanted.pad&&running()&&navigator.getGamepads?[...navigator.getGamepads()].filter(Boolean):[];
  const p=pads.find(x=>x.mapping==='standard')||pads[0];
  if(!p){if(pad.id){releasePad();report('pad','none');pad.id=null;}return;}
  if(pad.id!==p.id){pad.id=p.id;report('pad',p.id);hud('controller: '+p.id.replace(/\s*\(.*$/,''));}
  const on=i=>!!(p.buttons[i]&&p.buttons[i].pressed),ax=i=>p.axes[i]||0,value=i=>(p.buttons[i]&&p.buttons[i].value)||0;
  const stick={left:ax(0)<-.5,right:ax(0)>.5,up:ax(1)<-.5,down:ax(1)>.5}; // left stick doubles as the d-pad
  for(const [i,name] of Object.entries(PAD_BUTTONS)){
    const down=on(+i)||!!stick[name];
    if(down!==!!pad.buttons[name]){pad.buttons[name]=down;down?holdButton(name):releaseButton(name);}
  }
  // Right stick moves a stylus cursor, R2 touches, R3 recentres it.
  const dz=v=>Math.abs(v)<.15?0:v,dx=dz(ax(2)),dy=dz(ax(3));
  if(on(11))pad.cursor=[128,96];
  if(dx||dy||on(11)){pad.cursor=[Math.max(0,Math.min(255,pad.cursor[0]+dx*5)),Math.max(0,Math.min(191,pad.cursor[1]+dy*5))];showCursor();}
  const [cx,cy]=pad.cursor.map(Math.round),touch=value(7)>.3;
  if(touch&&!pad.touch){cancelRetap();if(stylus.down)drag(cx,cy);else press(cx,cy);showCursor();}
  else if(touch&&(dx||dy))drag(cx,cy);
  else if(!touch&&pad.touch&&stylus.down)lift();
  pad.touch=touch;
  // L2 pressure slows the game down, on top of the Speed dial.
  const slow=Math.round(value(6)*20)/20;
  if(slow!==pad.slow){pad.slow=slow;applyWantedSpeed();}
  // L3 saves state 1, touchpad click recalls it.
  for(const [i,fn] of [[10,()=>api.save(1)],[17,()=>api.load(1)]]){
    const d=on(i);
    if(d&&!pad.edges[i]){try{fn();}catch(error){report('error',error.message);}}
    pad.edges[i]=d;
  }
}

/* Stutter: loop a snapshot at a tempo-synced length (Live sends the bar length in ms). */
const STUTTER=[0,1,1/2,1/4,1/8,1/16,1/32,1/6,1/12,1/24]; // menu index → fraction of a bar; last three are triplets
const stutter={index:0,snapshot:null,timer:null,barMs:2000};
function restartStutter(){
  clearInterval(stutter.timer);stutter.timer=null;
  if(!stutter.index||!running()){stutter.snapshot=null;return;}
  const g=emulator().gameManager;
  if(!stutter.snapshot)stutter.snapshot=g.getState();
  stutter.timer=setInterval(()=>{try{g.loadState(stutter.snapshot);}catch(_){}},Math.max(20,stutter.barMs*STUTTER[stutter.index]));
}

// If frames stop advancing while not paused, restart the core's main loop.
const watch={frame:-1,since:0};
function watchdog(now){
  const e=window.EJS_emulator;
  if(!running()||e.paused){watch.since=0;return;}
  const f=e.gameManager.functions.getFrameNum();
  if(f!==watch.frame){watch.frame=f;watch.since=0;return;}
  if(!watch.since){watch.since=now;return;}
  if(now-watch.since>1500){watch.since=0;report('stall',f,document.visibilityState);hud('emulator stalled: restarting');followVisibility();}
}

// A timer, not animation frames: it has to keep running while the device is off screen.
function monitor(){
  if(monitorRunning)return;monitorRunning=true;
  let lastError=null;
  setInterval(()=>{
    const now=performance.now();
    try{
      if(running()&&!window.EJS_emulator.paused){if(wanted.glitch>0)glitchTick();chaosTick(now);}
      pollPad();
      watchdog(now);
      lastError=null;
    }catch(error){if(lastError!==error.message)report('error',error.message);lastError=error.message;}
  },1000/60);
}

function applySpeed(r){
  const g=emulator().gameManager;
  if(Math.abs(r-1)<0.02){g.toggleFastForward(0);g.toggleSlowMotion(0);}
  else if(r>1){g.toggleSlowMotion(0);g.setFastForwardRatio(r);g.toggleFastForward(1);}
  else{g.toggleFastForward(0);g.toggleSlowMotion(0);g.setSlowMotionRatio(1/r);setTimeout(()=>{try{g.toggleSlowMotion(1);}catch(_){}},10);}
}
let appliedSpeed=1;
function applyWantedSpeed(){
  const r=Math.max(0.1,wanted.speed*(1-0.75*pad.slow));
  if(!running()||Math.abs(r-appliedSpeed)<0.005)return;
  appliedSpeed=r;applySpeed(r);
}
const stateKey=slot=>'state:'+(game.code||'unknown')+':'+slot;

const api={
  setGame(bytes,name){
    const ascii=(a,b)=>String.fromCharCode(...bytes.slice(a,b)).replace(/[^\x20-\x7e]/g,'').trim();
    const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const arm9Rom=dv.getUint32(0x20,true),arm9Size=dv.getUint32(0x2c,true);
    // Skip the secure area at the start of ARM9; compare a later chunk that survives booting.
    const from=arm9Rom+0x800,len=Math.min(64,Math.max(0,arm9Size-0x800));
    game={title:ascii(0,12)||name,code:ascii(12,16),header:bytes.slice(0,0x200),
      arm9:len&&from+len<=bytes.length?Array.from(bytes.slice(from,from+len)):null,name};
    ram=null;
    learned=local.get(mapKey())||{};
    return game;
  },
  started(){
    const e=emulator();
    e.enableMouseLock=false;
    if(document.pointerLockElement&&document.exitPointerLock)document.exitPointerLock();
    for(const [key,value] of Object.entries({desmume_pointer_mouse:'enabled',desmume_pointer_type:'touch',desmume_input_rotation:'0',
      desmume_screens_layout:layout==='horizontal'?'left/right':'top/bottom',desmume_screens_gap:'0'}))
      e.gameManager.functions.setVariable(key,value);
    const gate=document.getElementById('rom-gate');if(gate)gate.hidden=true;
    if(document.hidden)followVisibility();
    ram=null;monitor();
    setTimeout(()=>{try{if(running())findRam();}catch(_){}},3000); // map RAM before any save state exists
    try{e.gamepad&&e.gamepad.terminate();}catch(_){} // the bridge maps the controller itself
    try{appliedSpeed=1;applyWantedSpeed();if(wanted.paused)e.pause();if(wanted.hold)press(...wanted.dial);restartStutter();}
    catch(error){report('error',error.message);}
    (async()=>{for(let s=1;s<=SLOTS;s++){try{const v=await idb.get(stateKey(s));if(v)slots.set(s,v);}catch(_){return;}}
      if(slots.size)report('slots',[...slots.keys()].join(' '));})();
    report('ready',game.title,game.code);
    hud(game.title+' · '+game.code);
  },
  loadrom(){const p=document.getElementById('rom-picker');if(p)p.click();},
  start(){const b=document.querySelector('.ejs_start_button');if(b)b.click();},
  async forget(){
    try{await idb.del('rom');for(let s=1;s<=SLOTS;s++)await idb.del(stateKey(s));}catch(_){}
    report('forget');hud('cached ROM and states cleared');
  },
  pause(){wanted.paused=true;if(running())emulator().pause();},
  resume(){wanted.paused=false;if(running())emulator().play();},
  freeze(on){Number(on)?api.pause():api.resume();},
  state(){const e=window.EJS_emulator;report('state',e?.started?1:0,e?.paused?1:0,game.title,game.code);},
  inspect(){
    const info={held:Object.fromEntries(held),stylus,speed:appliedSpeed,stutter:stutter.index,chaos:wanted.chaos,
      pad:pad.id,padSlow:pad.slow,cursor:pad.cursor,visibility:document.visibilityState,
      frame:running()?emulator().gameManager.functions.getFrameNum():null};
    report('inspect',JSON.stringify(info));return info;
  },
  button(name,down){
    name=String(name).toLowerCase();
    if(!(name in BUTTONS))throw Error('Unknown DS button: '+name);
    setButton(name,Number(down));
  },
  pulse(name,frames=6){
    frames=int(frames,1,120,'Pulse frames');name=String(name).toLowerCase();
    api.button(name,1);setTimeout(()=>api.button(name,0),frames*1000/60);
  },
  touch(x,y,down=1){
    x=int(x,0,255,'Touch x');y=int(y,0,191,'Touch y');
    cancelRetap();
    if(Number(down)){if(stylus.down)drag(x,y);else press(x,y);}else{stylus.x=x;stylus.y=y;lift();}
  },
  // Live dials: position the stylus; it only touches while Stylus hold is on.
  stylus(x,y){
    x=clamp(x,0,255);y=clamp(y,0,191);wanted.dial=[x,y];
    if(!running())return;
    if(wanted.hold){if(stylus.down)drag(x,y);else press(x,y);}
  },
  stylushold(on){
    wanted.hold=!!Number(on);
    if(!running())return;
    cancelRetap();
    if(wanted.hold){if(stylus.down)drag(...wanted.dial);else press(...wanted.dial);}else if(stylus.down)lift();
  },
  note(pitch,velocity=100){
    pitch=int(pitch,0,127,'Pitch');velocity=int(velocity,0,127,'Velocity');
    if(!running())return;
    velocity?noteOn(pitch):noteOff(pitch);
  },
  noteon(pitch,velocity=100){api.note(pitch,velocity);},
  noteoff(pitch){api.note(pitch,0);},
  allnotesoff(){if(running())releaseAll();report('allnotesoff');},
  glide(on){glide=!!Number(on);report('glide',glide?1:0);},
  learn(on){
    learning=!!Number(on);learnNote=null;
    if(learning&&running())releaseAll();
    hud(learning?'LEARN: play a MIDI note, then tap the touch screen':'',learning);
    report('learn',learning?1:0);
  },
  maptouch(note,x,y){note=int(note,0,127,'Note');learned[note]={touch:[int(x,0,255,'Touch x'),int(y,0,191,'Touch y')]};saveMap();report('mapped',note,'touch',x,y);},
  mapbutton(note,name){note=int(note,0,127,'Note');name=String(name).toLowerCase();if(!(name in BUTTONS))throw Error('Unknown DS button: '+name);learned[note]={button:name};saveMap();report('mapped',note,'button',name);},
  mapstate(note,slot){note=int(note,0,127,'Note');learned[note]={state:int(slot,1,SLOTS,'Slot')};saveMap();report('mapped',note,'state',slot);},
  unmap(note){note=int(note,0,127,'Note');delete learned[note];saveMap();report('unmapped',note);},
  mapreset(){learned={};saveMap();report('mapreset');hud('learned notes cleared');},
  mapdump(){report('map',JSON.stringify(learned));},
  save(slot){
    slot=int(slot,1,SLOTS,'Slot');
    const data=emulator().gameManager.getState();
    slots.set(slot,data);
    idb.put(stateKey(slot),data).catch(()=>{});
    report('save',slot);hud('saved state '+slot);
  },
  load(slot){
    slot=int(slot,1,SLOTS,'Slot');
    const data=slots.get(slot);
    if(!data)throw Error('State slot '+slot+' is empty');
    emulator().gameManager.loadState(data);
    report('load',slot);
  },
  speed(ratio){
    ratio=Number(ratio);
    if(!Number.isFinite(ratio)||ratio<0.1||ratio>8)throw Error('Speed must be 0.1–8');
    wanted.speed=ratio;applyWantedSpeed();
  },
  frameskip(value=0){
    value=int(value,0,5,'Frameskip');
    emulator().gameManager.functions.setVariable('desmume_frameskip',String(value));
    report('frameskip',value);
  },
  layout(value='horizontal'){
    value=String(value).toLowerCase();
    if(!['horizontal','vertical'].includes(value))throw Error('Layout must be horizontal or vertical');
    emulator().gameManager.functions.setVariable('desmume_screens_layout',value==='horizontal'?'left/right':'top/bottom');
    layout=value;document.documentElement.style.setProperty('--ar',String(value==='horizontal'?512/192:256/384));
    report('layout',value);
  },
  glitch(bytes){wanted.glitch=clamp(bytes,0,4096);},
  chaos(percent){wanted.chaos=clamp(percent,0,100);if(!wanted.chaos&&running())chaosStop();},
  pad(on){wanted.pad=!!Number(on);if(!wanted.pad&&pad.id){releasePad();pad.id=null;}report('pad',wanted.pad?'on':'off');},
  stutter(index){
    index=int(index,0,STUTTER.length-1,'Stutter');
    if(!stutter.index||!index)stutter.snapshot=null; // switching on captures a fresh moment
    stutter.index=index;restartStutter();
  },
  bar(ms){ms=Number(ms);if(ms>0){stutter.barMs=ms;if(stutter.timer)restartStutter();}},
  glitchrange(from,to){
    from=ramAddress(from);to=ramAddress(to,0);
    if(to<=from)throw Error('Glitch range end must be after start');
    glitchRange.from=from;glitchRange.to=to;report('glitchrange',from,to);
  },
  ram(){report('ram',findRam().base);},
  peek(addr,length=16){
    const a=ramAddress(addr,int(length,1,256,'Length')),r=findRam(),h=emulator().Module.HEAPU8;
    report('peek','0x'+a.toString(16),...Array.from(h.slice(r.base+a-RAM,r.base+a-RAM+Number(length))));
  },
  poke(addr,...values){
    const a=ramAddress(addr,values.length||1),r=findRam(),h=emulator().Module.HEAPU8;
    values.forEach((v,i)=>{h[r.base+a-RAM+i]=int(v,0,255,'Byte');});
    report('poke','0x'+a.toString(16),values.length);
  },
  stats(){
    const e=emulator(),start=performance.now(),frame=e.gameManager.functions.getFrameNum();
    let paints=0,raf=requestAnimationFrame(function count(){paints++;raf=requestAnimationFrame(count);});
    setTimeout(()=>{
      cancelAnimationFrame(raf);
      const seconds=(performance.now()-start)/1000,context=e.Module.AL?.currentCtx?.audioCtx;
      report('performance',JSON.stringify({seconds:+seconds.toFixed(2),
        emulatorFps:+((e.gameManager.functions.getFrameNum()-frame)/seconds).toFixed(1),
        browserFps:+(paints/seconds).toFixed(1),paused:!!e.paused,visibility:document.visibilityState,
        audioState:context?.state||'unavailable',sampleRate:context?.sampleRate||null}));
    },3000);
  }
};
window.NDS=api;
window.NDSStore=idb;
if(window.max){
  for(const name of Object.keys(api).filter(n=>!['setGame','started'].includes(n)))
    window.max.bindInlet(name,(...args)=>{try{const r=api[name](...args);if(r&&r.catch)r.catch(e=>report('error',e.message));}catch(e){report('error',e.message);}});
  report('bridge','connected');
}
})();
