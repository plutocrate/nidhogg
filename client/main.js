// main.js
import { Game } from './game.js';

const canvas = document.getElementById('game-canvas');
const W = 960, H = 540;
canvas.width = W; canvas.height = H;

function resize(){
  const s = Math.min(window.innerWidth/W, window.innerHeight/H);
  canvas.style.width  = `${W*s}px`;
  canvas.style.height = `${H*s}px`;
  canvas.style.position = 'absolute';
  canvas.style.left = `${(window.innerWidth  - W*s)/2}px`;
  canvas.style.top  = `${(window.innerHeight - H*s)/2}px`;
}
window.addEventListener('resize', resize); resize();

function canvasXY(e){
  const r = canvas.getBoundingClientRect();
  return { x:(e.clientX-r.left)*(W/r.width), y:(e.clientY-r.top)*(H/r.height) };
}

// ─── MENU ─────────────────────────────────────────────────────────────────────
class Menu {
  constructor(){
    this.ctx   = canvas.getContext('2d');
    this.state = 'main';
    this.sel   = 0;
    this.glow  = 0; this.glowDir = 1;
    this.t     = 0; this.last = 0;
    this.alive = true;
    this.hover = -1;
    this.rects = [];

    this.items = [
      { label:'ONLINE DUEL',  sub:'play vs a friend online',  action:()=>this._launch('online')   },
      { label:'LOCAL DUEL',   sub:'2 players, 1 keyboard',    action:()=>this._launch('local')    },
      { label:'TUTORIAL',     sub:'practice vs AI',           action:()=>this._launch('tutorial') },
      { label:'CONTROLS',     sub:'',                         action:()=>this.state='controls'    },
    ];

    this._key   = this._key.bind(this);
    this._click = this._click.bind(this);
    this._move  = this._move.bind(this);
    window.addEventListener('keydown',   this._key);
    canvas.addEventListener('click',     this._click);
    canvas.addEventListener('mousemove', this._move);
    this._raf = requestAnimationFrame(this._frame.bind(this));
  }

  destroy(){
    this.alive = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('keydown',   this._key);
    canvas.removeEventListener('click',     this._click);
    canvas.removeEventListener('mousemove', this._move);
    canvas.style.cursor = 'default';
  }

  _key(e){
    if(this.state==='controls'){ if(['Escape','Enter','Space'].includes(e.code)) this.state='main'; return; }
    if(e.code==='ArrowUp'  ||e.code==='KeyW') this.sel=(this.sel-1+this.items.length)%this.items.length;
    if(e.code==='ArrowDown'||e.code==='KeyS') this.sel=(this.sel+1)%this.items.length;
    if(e.code==='Enter'||e.code==='Space'||e.code==='KeyJ') this.items[this.sel].action();
  }

  _click(e){
    if(this.state==='controls'){ this.state='main'; return; }
    const {x,y} = canvasXY(e);
    for(let i=0;i<this.rects.length;i++){
      const r=this.rects[i];
      if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h){ this.sel=i; this.items[i].action(); return; }
    }
  }

  _move(e){
    if(this.state!=='main'){ this.hover=-1; return; }
    const {x,y}=canvasXY(e); this.hover=-1;
    for(let i=0;i<this.rects.length;i++){
      const r=this.rects[i];
      if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h){ this.hover=i; break; }
    }
    canvas.style.cursor = this.hover>=0 ? 'pointer' : 'default';
  }

  _launch(mode){
    this.destroy();
    if(mode==='online') showOnlineLobby();
    else startLocal(mode);
  }

  _frame(now){
    if(!this.alive) return;
    this._raf = requestAnimationFrame(this._frame.bind(this));
    const dt = Math.min(now-this.last, 50); this.last=now; this.t+=dt;
    this.glow += dt*.0028*this.glowDir;
    if(this.glow>1){this.glow=1;this.glowDir=-1;} if(this.glow<0){this.glow=0;this.glowDir=1;}
    this._draw();
  }

  _draw(){
    const ctx=this.ctx;
    ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);
    if(this.state==='main') this._drawMain();
    else                    this._drawControls();
  }

  _drawMain(){
    const ctx=this.ctx;
    ctx.save(); ctx.textAlign='center';
    ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=20+this.glow*32;
    ctx.font='bold 84px "Courier New"';
    ctx.fillStyle=`rgba(78,205,196,${.3+this.glow*.7})`; ctx.fillText('NIDHOGG',W/2,126);
    ctx.shadowBlur=0; ctx.fillStyle='#fff'; ctx.fillText('NIDHOGG',W/2,126);
    ctx.font='14px "Courier New"'; ctx.fillStyle='#4ecdc4'; ctx.fillText('— GROTTO DUEL —',W/2,160);
    ctx.restore();
    ctx.save(); ctx.strokeStyle='rgba(78,205,196,0.25)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(W/2-200,175); ctx.lineTo(W/2+200,175); ctx.stroke(); ctx.restore();
    const startY=220, gap=58, bw=300, bh=44;
    this.rects=[];
    this.items.forEach((item,i)=>{
      const cy=startY+i*gap, bx=W/2-bw/2, by=cy-30;
      this.rects.push({x:bx,y:by,w:bw,h:bh});
      const hot=i===this.sel||i===this.hover;
      ctx.save(); ctx.textAlign='center';
      if(hot){
        ctx.fillStyle='rgba(78,205,196,0.12)'; ctx.fillRect(bx,by,bw,bh);
        ctx.strokeStyle=i===this.hover?'rgba(78,205,196,0.65)':'#4ecdc4';
        ctx.lineWidth=1; ctx.strokeRect(bx,by,bw,bh);
        const pulse=Math.sin(this.t*.006)*4;
        ctx.fillStyle='#4ecdc4'; ctx.font='bold 17px "Courier New"';
        ctx.fillText('▶',W/2-130+pulse,cy+2); ctx.fillText('◀',W/2+130-pulse,cy+2);
        ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=8; ctx.fillStyle='#fff';
      } else {
        ctx.fillStyle='rgba(190,210,208,0.45)';
      }
      ctx.font='bold 22px "Courier New"'; ctx.fillText(item.label,W/2,cy+2);
      if(item.sub){
        ctx.shadowBlur=0; ctx.font='11px "Courier New"';
        ctx.fillStyle=hot?'rgba(78,205,196,0.7)':'rgba(140,170,160,0.5)';
        ctx.fillText(item.sub,W/2,cy+18);
      }
      ctx.restore();
    });
    ctx.save(); ctx.textAlign='center'; ctx.fillStyle='rgba(100,140,130,0.5)';
    ctx.font='11px "Courier New"';
    ctx.fillText('↑↓ or MOUSE to select   ·   ENTER / CLICK to confirm',W/2,H-18);
    ctx.restore();
  }

  _drawControls(){
    const ctx=this.ctx;
    const bx=W/2-330,by=H/2-210,bw=660,bh=420;
    ctx.save();
    ctx.fillStyle='rgba(0,0,0,0.95)'; ctx.fillRect(bx,by,bw,bh);
    ctx.strokeStyle='#4ecdc4'; ctx.lineWidth=1; ctx.strokeRect(bx,by,bw,bh);
    ctx.textAlign='center'; ctx.fillStyle='#4ecdc4';
    ctx.font='bold 24px "Courier New"'; ctx.fillText('CONTROLS',W/2,by+44);
    ctx.strokeStyle='rgba(78,205,196,0.25)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(bx+40,by+58); ctx.lineTo(bx+bw-40,by+58); ctx.stroke();
    const c1=bx+55, c2=bx+340;
    const rows =[['A/D','Move'],['W','Jump'],['S','Crouch'],['J','Attack']];
    const rows2=[['← →','Move'],['↑','Jump'],['↓','Crouch'],['Num0','Attack']];
    ctx.textAlign='left'; ctx.fillStyle='#e63946'; ctx.font='bold 15px "Courier New"';
    ctx.fillText('P1 — KNIGHT  (WASD+J)',c1,by+82);
    ctx.fillStyle='#4ecdc4'; ctx.fillText('P2 LOCAL  (Arrows+Num0)',c2,by+82);
    rows.forEach(([k,d],i)=>{
      ctx.fillStyle='#777'; ctx.font='13px "Courier New"'; ctx.fillText(`[ ${k} ]`,c1,by+108+i*28);
      ctx.fillStyle='#ddd'; ctx.fillText(d,c1+90,by+108+i*28);
    });
    rows2.forEach(([k,d],i)=>{
      ctx.fillStyle='#777'; ctx.font='13px "Courier New"'; ctx.fillText(`[ ${k} ]`,c2,by+108+i*28);
      ctx.fillStyle='#ddd'; ctx.fillText(d,c2+90,by+108+i*28);
    });
    ctx.textAlign='center'; ctx.fillStyle='rgba(78,205,196,0.7)';
    ctx.font='bold 13px "Courier New"';
    ctx.fillText('ONLINE: both players use WASD+J on their own machine',W/2,by+250);
    ctx.fillText('ONE HIT KILLS — TIMING IS EVERYTHING',W/2,by+278);
    ctx.fillStyle='rgba(100,140,130,0.5)'; ctx.font='11px "Courier New"';
    ctx.fillText('CLICK or ENTER to return',W/2,by+318);
    ctx.restore();
  }
}

// ─── ONLINE LOBBY ─────────────────────────────────────────────────────────────
// Handles WS connection itself — Game receives the already-open socket
function showOnlineLobby(prefillError){
  const ctx = canvas.getContext('2d');
  let alive  = true;
  let phase  = 'choose';   // 'choose' | 'connecting' | 'waiting_opponent' | 'joining'
  let joinCode = '';
  let errorMsg = prefillError || '';
  let roomCode = '';
  let ws = null;
  const rects = [];

  function wsUrl(){
    const proto = location.protocol==='https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
  }

  function cleanup(){
    alive = false;
    canvas.removeEventListener('click',     onClick);
    canvas.removeEventListener('mousemove', onMove);
    window.removeEventListener('keydown',   onKey);
    document.removeEventListener('paste',   onPaste);
    canvas.style.cursor = 'default';
  }

  function closeWS(){
    if(ws){ try{ ws.close(); }catch(e){} ws=null; }
  }

  function backToMenu(){ cleanup(); closeWS(); new Menu(); }

  function onKey(e){
    if(!alive) return;
    if(e.code==='Escape'){
      if(phase==='waiting_opponent'||phase==='connecting'||phase==='joining'){
        closeWS(); phase='choose'; errorMsg=''; return;
      }
      backToMenu(); return;
    }
    if(phase!=='choose') return;
    if(e.code==='Backspace'){ joinCode=joinCode.slice(0,-1); errorMsg=''; return; }
    if(e.code==='Enter' && joinCode.length===4){ doJoin(); return; }
    const ch=e.key.toUpperCase();
    if(/^[A-Z0-9]$/.test(ch) && joinCode.length<4){ joinCode+=ch; errorMsg=''; }
  }

  function onClick(e){
    if(!alive || phase!=='choose') return;
    const {x,y}=canvasXY(e);
    if(rects[0]&&hit(x,y,rects[0])){ doCreate(); return; }
    if(rects[1]&&hit(x,y,rects[1])&&joinCode.length===4){ doJoin(); return; }
  }

  function onMove(e){
    if(!alive || phase!=='choose') return;
    const {x,y}=canvasXY(e);
    let h=-1;
    for(let i=0;i<rects.length;i++) if(rects[i]&&hit(x,y,rects[i])){h=i;break;}
    canvas.style.cursor = h>=0 ? 'pointer' : 'default';
  }

  function onPaste(e){
    if(!alive || phase!=='choose') return;
    const t=(e.clipboardData||window.clipboardData).getData('text');
    const code=t.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
    if(code){ joinCode=code; errorMsg=''; }
    e.preventDefault();
  }

  function hit(x,y,r){ return x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h; }

  // ── CREATE ROOM ──────────────────────────────────────────────────────────────
  function doCreate(){
    phase='connecting'; errorMsg='';
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      console.log('[Lobby] WS open, sending create_room');
      ws.send(JSON.stringify({ type:'create_room' }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      console.log('[Lobby] received:', msg);
      if(msg.type==='assign'){
        roomCode = msg.code;
        phase = 'waiting_opponent';
      } else if(msg.type==='start'){
        // Opponent joined — hand off to game
        launchGame(ws, msg.pid || 1, roomCode, 1);
      } else if(msg.type==='error'){
        phase='choose'; errorMsg=msg.msg; closeWS();
      }
    };
    ws.onerror = (e) => {
      console.error('[Lobby] WS error', e);
    };
    ws.onclose = (e) => {
      console.log('[Lobby] WS closed, code:', e.code, 'phase:', phase);
      if(!alive) return;
      if(phase==='connecting'){
        phase='choose';
        errorMsg='Could not connect to server (code '+e.code+')';
      } else if(phase==='waiting_opponent'){
        phase='choose';
        errorMsg='Connection lost while waiting.';
      }
      ws=null;
    };
  }

  // ── JOIN ROOM ────────────────────────────────────────────────────────────────
  function doJoin(){
    if(joinCode.length!==4){ errorMsg='Enter 4-letter code'; return; }
    phase='joining'; errorMsg='';
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      console.log('[Lobby] WS open, sending join_room', joinCode);
      ws.send(JSON.stringify({ type:'join_room', code: joinCode }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      console.log('[Lobby] received:', msg);
      if(msg.type==='assign'){
        roomCode = msg.code;
        // pid 2 assigned — wait for 'start'
      } else if(msg.type==='start'){
        launchGame(ws, 2, roomCode, 2);
      } else if(msg.type==='error'){
        phase='choose'; errorMsg=msg.msg; closeWS();
      }
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if(!alive) return;
      if(phase==='joining'){
        phase='choose';
        errorMsg='Could not connect or room not found.';
      }
      ws=null;
    };
  }

  // ── HAND OFF TO GAME ─────────────────────────────────────────────────────────
  function launchGame(socket, pid, code, myPid){
    cleanup(); // stop lobby draw loop, remove listeners (but keep ws open!)
    startGame(socket, pid, code, myPid);
  }

  canvas.addEventListener('click',     onClick);
  canvas.addEventListener('mousemove', onMove);
  window.addEventListener('keydown',   onKey);
  document.addEventListener('paste',   onPaste);

  // ── DRAW LOOP ────────────────────────────────────────────────────────────────
  function draw(){
    if(!alive) return;
    requestAnimationFrame(draw);
    ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);

    if(phase==='connecting'){
      ctx.save(); ctx.textAlign='center'; ctx.fillStyle='#4ecdc4';
      ctx.font='bold 22px "Courier New"';
      ctx.fillText('Connecting'+dots(),W/2,H/2);
      ctx.fillStyle='rgba(130,170,160,0.5)'; ctx.font='12px "Courier New"';
      ctx.fillText('ESC to cancel',W/2,H/2+36);
      ctx.restore(); return;
    }

    if(phase==='waiting_opponent'){
      ctx.save(); ctx.textAlign='center';
      ctx.fillStyle='#4ecdc4'; ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=14;
      ctx.font='bold 26px "Courier New"';
      ctx.fillText('ROOM CREATED',W/2,H/2-90);
      ctx.shadowBlur=0;
      ctx.font='14px "Courier New"'; ctx.fillStyle='rgba(180,220,210,0.7)';
      ctx.fillText('Share this code with your opponent:',W/2,H/2-52);
      // code box
      ctx.fillStyle='rgba(78,205,196,0.1)';
      ctx.fillRect(W/2-130,H/2-38,260,78);
      ctx.strokeStyle='#4ecdc4'; ctx.lineWidth=2;
      ctx.strokeRect(W/2-130,H/2-38,260,78);
      ctx.font='bold 64px "Courier New"'; ctx.fillStyle='#fff';
      ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=28;
      ctx.fillText(roomCode,W/2,H/2+30);
      ctx.shadowBlur=0;
      ctx.font='13px "Courier New"'; ctx.fillStyle='rgba(255,255,255,0.4)';
      ctx.fillText('Waiting for opponent'+dots(),W/2,H/2+62);
      ctx.fillText('ESC to cancel',W/2,H/2+86);
      ctx.restore(); return;
    }

    if(phase==='joining'){
      ctx.save(); ctx.textAlign='center'; ctx.fillStyle='#4ecdc4';
      ctx.font='bold 22px "Courier New"';
      ctx.fillText('Joining room '+joinCode+dots(),W/2,H/2);
      ctx.fillStyle='rgba(130,170,160,0.5)'; ctx.font='12px "Courier New"';
      ctx.fillText('ESC to cancel',W/2,H/2+36);
      ctx.restore(); return;
    }

    // phase === 'choose'
    ctx.save(); ctx.textAlign='center';
    ctx.font='bold 36px "Courier New"'; ctx.fillStyle='#4ecdc4';
    ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=12;
    ctx.fillText('ONLINE DUEL',W/2,80); ctx.restore();
    ctx.save(); ctx.strokeStyle='rgba(78,205,196,0.25)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(W/2-200,98); ctx.lineTo(W/2+200,98); ctx.stroke(); ctx.restore();

    const bw=300,bh=52,bx=W/2-bw/2;

    // CREATE button
    const createY=165;
    rects[0]={x:bx,y:createY-36,w:bw,h:bh};
    ctx.save(); ctx.textAlign='center';
    ctx.fillStyle='rgba(78,205,196,0.1)'; ctx.fillRect(bx,createY-36,bw,bh);
    ctx.strokeStyle='rgba(78,205,196,0.5)'; ctx.lineWidth=1; ctx.strokeRect(bx,createY-36,bw,bh);
    ctx.font='bold 22px "Courier New"'; ctx.fillStyle='#4ecdc4';
    ctx.fillText('CREATE ROOM',W/2,createY+2);
    ctx.font='11px "Courier New"'; ctx.fillStyle='rgba(78,205,196,0.6)';
    ctx.fillText('get a code to share with your opponent',W/2,createY+18);
    ctx.restore();

    ctx.save(); ctx.textAlign='center'; ctx.fillStyle='rgba(130,170,160,0.5)';
    ctx.font='13px "Courier New"'; ctx.fillText('— or —',W/2,245); ctx.restore();

    ctx.save(); ctx.textAlign='center'; ctx.font='bold 15px "Courier New"';
    ctx.fillStyle='rgba(180,220,210,0.75)'; ctx.fillText('JOIN WITH CODE',W/2,278); ctx.restore();

    // 4 letter boxes
    const boxW=54,boxH=60,boxGap=12;
    const totalW=4*boxW+3*boxGap, startX=W/2-totalW/2, boxY=292;
    for(let i=0;i<4;i++){
      const bxi=startX+i*(boxW+boxGap);
      const filled=i<joinCode.length, active=i===joinCode.length&&joinCode.length<4;
      ctx.save();
      ctx.fillStyle=filled?'rgba(78,205,196,0.18)':'rgba(255,255,255,0.04)';
      ctx.fillRect(bxi,boxY,boxW,boxH);
      ctx.strokeStyle=active?'#4ecdc4':(filled?'rgba(78,205,196,0.6)':'rgba(255,255,255,0.15)');
      ctx.lineWidth=active?2:1; ctx.strokeRect(bxi,boxY,boxW,boxH);
      if(filled){
        ctx.font='bold 34px "Courier New"'; ctx.fillStyle='#fff'; ctx.textAlign='center';
        ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=6;
        ctx.fillText(joinCode[i],bxi+boxW/2,boxY+42);
      } else if(active && Math.floor(Date.now()/500)%2===0){
        ctx.fillStyle='rgba(78,205,196,0.8)'; ctx.fillRect(bxi+boxW/2-1,boxY+12,2,36);
      }
      ctx.restore();
    }

    // JOIN button
    const jY=378; rects[1]={x:bx,y:jY,w:bw,h:44};
    const canJoin=joinCode.length===4;
    ctx.save(); ctx.textAlign='center';
    ctx.fillStyle=canJoin?'rgba(78,205,196,0.1)':'rgba(255,255,255,0.02)';
    ctx.fillRect(bx,jY,bw,44);
    ctx.strokeStyle=canJoin?'rgba(78,205,196,0.5)':'rgba(255,255,255,0.08)';
    ctx.lineWidth=1; ctx.strokeRect(bx,jY,bw,44);
    ctx.font='bold 20px "Courier New"';
    ctx.fillStyle=canJoin?'#4ecdc4':'rgba(100,130,120,0.35)';
    ctx.fillText('JOIN ROOM',W/2,jY+28); ctx.restore();

    if(errorMsg){
      ctx.save(); ctx.textAlign='center'; ctx.font='bold 13px "Courier New"';
      ctx.fillStyle='#ff6b6b'; ctx.shadowColor='#ff6b6b'; ctx.shadowBlur=8;
      ctx.fillText(errorMsg,W/2,440); ctx.restore();
    }

    ctx.save(); ctx.textAlign='center'; ctx.fillStyle='rgba(100,140,130,0.45)';
    ctx.font='11px "Courier New"';
    ctx.fillText('ESC to go back  ·  type or paste code then ENTER',W/2,H-18); ctx.restore();
  }

  requestAnimationFrame(draw);
}

function dots(){ return '.'.repeat(1+Math.floor(Date.now()/500)%3); }

// ─── START GAME (receives already-open WS socket) ─────────────────────────────
function startGame(socket, pid, roomCode, myPid){
  let game = null;
  let done = false;

  function finish(){
    if(done) return; done=true;
    window.removeEventListener('game:exit', onExit);
    if(game){ game.stop(); game=null; }
    canvas.style.cursor='default';
    showOnlineLobby();
  }

  function onExit(){ finish(); }
  window.addEventListener('game:exit', onExit);

  game = new Game(canvas, { mode:'online', myPid: pid, roomCode, socket });
  game.start();
}

// ─── LOCAL / TUTORIAL START ───────────────────────────────────────────────────
function startLocal(mode){
  let game = null;
  let done = false;

  function finish(){
    if(done) return; done=true;
    window.removeEventListener('game:exit', onExit);
    window.removeEventListener('keydown',   onKey);
    if(game){ game.stop(); game=null; }
    canvas.style.cursor='default';
    new Menu();
  }

  function onExit(){ finish(); }
  function onKey(e){ if(e.code==='Escape') finish(); }

  window.addEventListener('game:exit', onExit);
  window.addEventListener('keydown',   onKey);

  game = new Game(canvas, { mode });
  game.start();
}

// ── boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded',()=>{
  const bar=document.getElementById('load-bar');
  const scr=document.getElementById('loading');
  let p=0;
  const iv=setInterval(()=>{
    p+=Math.random()*20; if(p>100)p=100;
    if(bar) bar.style.width=p+'%';
    if(p>=100){ clearInterval(iv); setTimeout(()=>{ if(scr)scr.classList.add('hidden'); new Menu(); },250); }
  },70);
});
