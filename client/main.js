import { Game } from './game.js';
import { AudioManager } from './audio.js';

// ─── SHARED AUDIO SINGLETON ───────────────────────────────────────────────────
// One AudioManager for the entire page lifetime.
// initAudio() is triggered on the very first user gesture (key or click),
// unlocking the AudioContext and immediately starting BGM + background SFX decode.
// The Game receives this same instance so it never re-initialises the context.
const sharedAudio = new AudioManager();
let _audioUnlocked = false;

function unlockAudio() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  sharedAudio.initAudio().catch(() => {});
}
window.addEventListener('keydown', unlockAudio, { once: true });
window.addEventListener('click',   unlockAudio, { once: true });

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
    unlockAudio();
    if(this.state==='controls'){ if(['Escape','Enter','Space'].includes(e.code)) this.state='main'; return; }
    if(e.code==='ArrowUp'  ||e.code==='KeyW') this.sel=(this.sel-1+this.items.length)%this.items.length;
    if(e.code==='ArrowDown'||e.code==='KeyS') this.sel=(this.sel+1)%this.items.length;
    if(e.code==='Enter'||e.code==='Space'||e.code==='KeyJ') this.items[this.sel].action();
  }

  _click(e){
    unlockAudio();
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
    // rich dark background
    ctx.fillStyle='#080b0a'; ctx.fillRect(0,0,W,H);
    if(this.state==='main') this._drawMain();
    else                    this._drawControls();
  }

  _drawMain(){
    const ctx=this.ctx;
    const cx=W/2, t=this.t;

    // — scanline / noise background —
    ctx.fillStyle='#080b0a'; ctx.fillRect(0,0,W,H);
    // subtle diagonal grid
    ctx.save();
    ctx.strokeStyle='rgba(78,205,196,0.03)'; ctx.lineWidth=1;
    for(let x=-H;x<W+H;x+=38){
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x+H,H); ctx.stroke();
    }
    ctx.restore();
    // horizontal scan band
    const scanY=(t*0.04)%H;
    const grad=ctx.createLinearGradient(0,scanY-18,0,scanY+18);
    grad.addColorStop(0,'rgba(78,205,196,0)');
    grad.addColorStop(0.5,'rgba(78,205,196,0.04)');
    grad.addColorStop(1,'rgba(78,205,196,0)');
    ctx.fillStyle=grad; ctx.fillRect(0,scanY-18,W,36);

    // — corner ornaments —
    ctx.save(); ctx.strokeStyle='rgba(78,205,196,0.3)'; ctx.lineWidth=1.5;
    const co=22, cl=40;
    [[co,co],[W-co,co],[co,H-co],[W-co,H-co]].forEach(([ox,oy])=>{
      const sx=ox===co?1:-1, sy=oy===co?1:-1;
      ctx.beginPath(); ctx.moveTo(ox,oy+sy*cl); ctx.lineTo(ox,oy); ctx.lineTo(ox+sx*cl,oy); ctx.stroke();
    });
    ctx.restore();

    // — NIDHOGG title —
    ctx.save(); ctx.textAlign='center';
    // shadow glow layers
    for(let g=3;g>=0;g--){
      ctx.font='bold 96px "Courier New"';
      ctx.fillStyle=`rgba(78,205,196,${(0.06+this.glow*0.08)/(g+1)})`;
      ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=60-g*12;
      ctx.fillText('NIDHOGG',cx+g*0.5,118+g*0.5);
    }
    // crisp white top
    ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=18+this.glow*22;
    ctx.font='bold 96px "Courier New"';
    ctx.fillStyle='#ffffff'; ctx.fillText('NIDHOGG',cx,118);
    ctx.restore();

    // subtitle with decorative dashes
    ctx.save(); ctx.textAlign='center';
    ctx.font='13px "Courier New"';
    ctx.letterSpacing='6px';
    ctx.fillStyle=`rgba(78,205,196,${0.55+this.glow*0.3})`;
    ctx.fillText('◈  GROTTO DUEL  ◈',cx,150);
    ctx.restore();

    // divider line with glow
    ctx.save();
    const lg=ctx.createLinearGradient(cx-260,0,cx+260,0);
    lg.addColorStop(0,'rgba(78,205,196,0)');
    lg.addColorStop(0.5,`rgba(78,205,196,${0.35+this.glow*0.25})`);
    lg.addColorStop(1,'rgba(78,205,196,0)');
    ctx.strokeStyle=lg; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(cx-260,168); ctx.lineTo(cx+260,168); ctx.stroke();
    ctx.restore();

    // — Menu items —
    const startY=212, gap=66, bw=340, bh=50;
    this.rects=[];
    this.items.forEach((item,i)=>{
      const cy=startY+i*gap, bx=cx-bw/2, by=cy-32;
      this.rects.push({x:bx,y:by,w:bw,h:bh});
      const hot=i===this.sel||i===this.hover;
      ctx.save(); ctx.textAlign='center';

      if(hot){
        // glowing selected state
        const pulse=0.7+Math.sin(t*0.007)*0.3;
        // bg fill with gradient
        const bg=ctx.createLinearGradient(bx,by,bx+bw,by);
        bg.addColorStop(0,'rgba(78,205,196,0.00)');
        bg.addColorStop(0.5,`rgba(78,205,196,${0.14*pulse})`);
        bg.addColorStop(1,'rgba(78,205,196,0.00)');
        ctx.fillStyle=bg; ctx.fillRect(bx,by,bw,bh);
        // left/right accent bars
        ctx.fillStyle=`rgba(78,205,196,${0.8*pulse})`;
        ctx.fillRect(bx,by,3,bh);
        ctx.fillRect(bx+bw-3,by,3,bh);
        // top/bottom hairlines
        ctx.strokeStyle=`rgba(78,205,196,${0.4*pulse})`; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(bx+3,by); ctx.lineTo(bx+bw-3,by); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx+3,by+bh); ctx.lineTo(bx+bw-3,by+bh); ctx.stroke();
        // animated arrow indicators
        const arrowPulse=Math.sin(t*0.009)*6;
        ctx.font='bold 14px "Courier New"';
        ctx.fillStyle=`rgba(78,205,196,${0.85*pulse})`;
        ctx.fillText('▶',bx+18+arrowPulse,cy+2);
        ctx.fillText('◀',bx+bw-18-arrowPulse,cy+2);
        // label
        ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=14*pulse;
        ctx.font='bold 20px "Courier New"'; ctx.fillStyle='#ffffff';
        ctx.fillText(item.label,cx,cy+1);
        ctx.shadowBlur=0;
        if(item.sub){
          ctx.font='11px "Courier New"'; ctx.fillStyle='rgba(78,205,196,0.75)';
          ctx.fillText(item.sub,cx,cy+19);
        }
      } else {
        // dim unselected — slight indent feel
        ctx.font='bold 20px "Courier New"';
        ctx.fillStyle=`rgba(160,195,188,${0.28+Math.sin(t*0.003+i)*0.04})`;
        ctx.fillText(item.label,cx,cy+1);
        if(item.sub){
          ctx.font='11px "Courier New"'; ctx.fillStyle='rgba(120,160,150,0.32)';
          ctx.fillText(item.sub,cx,cy+19);
        }
      }
      ctx.restore();
    });

    // footer hint
    ctx.save(); ctx.textAlign='center';
    ctx.font='10px "Courier New"';
    ctx.fillStyle=`rgba(78,205,196,${0.25+this.glow*0.1})`;
    ctx.fillText('↑ ↓  or  MOUSE  to navigate    ·    ENTER  or  CLICK  to select',cx,H-16);
    ctx.restore();
  }

  _drawControls(){
    const ctx=this.ctx; const cx=W/2;
    // dim bg
    ctx.fillStyle='rgba(0,0,0,0.7)'; ctx.fillRect(0,0,W,H);

    // panel
    const bx=cx-340,by=H/2-220,bw=680,bh=440;
    // panel bg
    const panelGrad=ctx.createLinearGradient(bx,by,bx,by+bh);
    panelGrad.addColorStop(0,'rgba(8,18,15,0.98)');
    panelGrad.addColorStop(1,'rgba(4,10,8,0.98)');
    ctx.fillStyle=panelGrad; ctx.fillRect(bx,by,bw,bh);
    // panel border
    ctx.strokeStyle='rgba(78,205,196,0.55)'; ctx.lineWidth=1.5;
    ctx.strokeRect(bx,by,bw,bh);
    // inner highlight
    ctx.strokeStyle='rgba(78,205,196,0.08)'; ctx.lineWidth=1;
    ctx.strokeRect(bx+4,by+4,bw-8,bh-8);
    // corner ticks
    ctx.strokeStyle='rgba(78,205,196,0.5)'; ctx.lineWidth=2;
    const ctl=14;
    [[bx,by],[bx+bw,by],[bx,by+bh],[bx+bw,by+bh]].forEach(([ox,oy])=>{
      const sx=ox===bx?1:-1, sy=oy===by?1:-1;
      ctx.beginPath(); ctx.moveTo(ox+sx*ctl,oy); ctx.lineTo(ox,oy); ctx.lineTo(ox,oy+sy*ctl); ctx.stroke();
    });

    // title
    ctx.save(); ctx.textAlign='center';
    ctx.font='bold 22px "Courier New"';
    ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=14;
    ctx.fillStyle='#4ecdc4'; ctx.fillText('CONTROLS',cx,by+46);
    ctx.shadowBlur=0;
    // divider
    ctx.strokeStyle='rgba(78,205,196,0.3)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(bx+50,by+60); ctx.lineTo(bx+bw-50,by+60); ctx.stroke();
    ctx.restore();

    // two columns
    const c1=bx+60, c2=bx+370;
    const rowH=30, rowStart=by+100;

    // P1 header
    ctx.save(); ctx.textAlign='left';
    ctx.font='bold 13px "Courier New"';
    ctx.fillStyle='#e63946'; ctx.shadowColor='#e63946'; ctx.shadowBlur=8;
    ctx.fillText('P1  KNIGHT',c1,by+86);
    ctx.shadowBlur=0;
    ctx.fillStyle='rgba(180,80,80,0.5)'; ctx.font='11px "Courier New"';
    ctx.fillText('WASD + J / K / LShift',c1,by+86+14);
    ctx.restore();

    // P2 header
    ctx.save(); ctx.textAlign='left';
    ctx.font='bold 13px "Courier New"';
    ctx.fillStyle='#4ecdc4'; ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=8;
    ctx.fillText('P2  THIEF',c2,by+86);
    ctx.shadowBlur=0;
    ctx.fillStyle='rgba(60,160,150,0.5)'; ctx.font='11px "Courier New"';
    ctx.fillText('Arrows + L / ; / RShift',c2,by+86+14);
    ctx.restore();

    const rows=[
      ['A / D','Move left / right'],
      ['W','Jump'],
      ['S','Crouch'],
      ['J','Attack'],
      ['K','Parry'],
      ['LShift','Sprint'],
    ];
    const rows2=[
      ['← / →','Move left / right'],
      ['↑','Jump'],
      ['↓','Crouch'],
      ['L','Attack'],
      [';','Parry'],
      ['RShift','Sprint'],
    ];

    rows.forEach(([k,d],i)=>{
      const ry=rowStart+i*rowH;
      ctx.save(); ctx.textAlign='left';
      // key badge
      ctx.fillStyle='rgba(78,205,196,0.1)';
      ctx.fillRect(c1,ry-14,52,19);
      ctx.strokeStyle='rgba(78,205,196,0.3)'; ctx.lineWidth=1;
      ctx.strokeRect(c1,ry-14,52,19);
      ctx.font='bold 11px "Courier New"'; ctx.fillStyle='rgba(78,205,196,0.9)';
      ctx.fillText(k,c1+6,ry);
      // desc
      ctx.font='12px "Courier New"'; ctx.fillStyle='rgba(210,230,225,0.75)';
      ctx.fillText(d,c1+60,ry);
      ctx.restore();
    });

    rows2.forEach(([k,d],i)=>{
      const ry=rowStart+i*rowH;
      ctx.save(); ctx.textAlign='left';
      ctx.fillStyle='rgba(78,205,196,0.1)';
      ctx.fillRect(c2,ry-14,60,19);
      ctx.strokeStyle='rgba(78,205,196,0.3)'; ctx.lineWidth=1;
      ctx.strokeRect(c2,ry-14,60,19);
      ctx.font='bold 11px "Courier New"'; ctx.fillStyle='rgba(78,205,196,0.9)';
      ctx.fillText(k,c2+6,ry);
      ctx.font='12px "Courier New"'; ctx.fillStyle='rgba(210,230,225,0.75)';
      ctx.fillText(d,c2+70,ry);
      ctx.restore();
    });

    // divider line between columns
    ctx.strokeStyle='rgba(78,205,196,0.12)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(cx,by+70); ctx.lineTo(cx,by+bh-60); ctx.stroke();

    // notes at bottom
    ctx.save(); ctx.textAlign='center';
    ctx.strokeStyle='rgba(78,205,196,0.2)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(bx+50,by+bh-72); ctx.lineTo(bx+bw-50,by+bh-72); ctx.stroke();
    ctx.font='bold 12px "Courier New"'; ctx.fillStyle='rgba(78,205,196,0.75)';
    ctx.fillText('ONLINE — both players use WASD + J on their own machine',cx,by+bh-50);
    ctx.fillText('ONE HIT KILLS  ·  [ \ ] toggle hitboxes in-game',cx,by+bh-30);
    ctx.font='10px "Courier New"'; ctx.fillStyle='rgba(100,140,130,0.45)';
    ctx.fillText('CLICK or ENTER to close',cx,by+bh-10);
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
    unlockAudio();
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
    unlockAudio();
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
    ctx.fillStyle='#080b0a'; ctx.fillRect(0,0,W,H);
    // grid
    ctx.strokeStyle='rgba(78,205,196,0.03)'; ctx.lineWidth=1;
    for(let x=-H;x<W+H;x+=38){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x+H,H);ctx.stroke();}

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
      // panel
      const wpx=W/2-180,wpy=H/2-140,wpw=360,wph=280;
      const wpg=ctx.createLinearGradient(wpx,wpy,wpx,wpy+wph);
      wpg.addColorStop(0,'rgba(8,20,16,0.98)'); wpg.addColorStop(1,'rgba(4,10,8,0.98)');
      ctx.fillStyle=wpg; ctx.fillRect(wpx,wpy,wpw,wph);
      ctx.strokeStyle='rgba(78,205,196,0.55)'; ctx.lineWidth=1.5; ctx.strokeRect(wpx,wpy,wpw,wph);
      // corner marks
      ctx.strokeStyle='rgba(78,205,196,0.5)'; ctx.lineWidth=2;
      [[wpx,wpy],[wpx+wpw,wpy],[wpx,wpy+wph],[wpx+wpw,wpy+wph]].forEach(([ox,oy])=>{
        const sx=ox===wpx?1:-1,sy=oy===wpy?1:-1;
        ctx.beginPath();ctx.moveTo(ox+sx*12,oy);ctx.lineTo(ox,oy);ctx.lineTo(ox,oy+sy*12);ctx.stroke();
      });
      ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=18;
      ctx.font='bold 22px "Courier New"'; ctx.fillStyle='#4ecdc4';
      ctx.fillText('ROOM CREATED',W/2,H/2-98);
      ctx.shadowBlur=0;
      ctx.font='11px "Courier New"'; ctx.fillStyle='rgba(180,220,210,0.55)';
      ctx.fillText('share this code with your opponent',W/2,H/2-72);
      // code display
      ctx.fillStyle='rgba(78,205,196,0.08)'; ctx.fillRect(W/2-110,H/2-58,220,70);
      ctx.strokeStyle='rgba(78,205,196,0.4)'; ctx.lineWidth=1; ctx.strokeRect(W/2-110,H/2-58,220,70);
      ctx.font='bold 58px "Courier New"'; ctx.fillStyle='#fff';
      ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=30; ctx.fillText(roomCode,W/2,H/2+2);
      ctx.shadowBlur=0;
      ctx.font='11px "Courier New"'; ctx.fillStyle='rgba(255,255,255,0.35)';
      ctx.fillText('Waiting for opponent'+dots(),W/2,H/2+36);
      ctx.fillStyle='rgba(100,140,130,0.4)'; ctx.font='10px "Courier New"';
      ctx.fillText('ESC to cancel',W/2,H/2+60);
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
    ctx.font='bold 42px "Courier New"';
    ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=22;
    ctx.fillStyle='rgba(78,205,196,0.25)'; ctx.fillText('ONLINE DUEL',W/2,78);
    ctx.shadowBlur=14; ctx.fillStyle='#fff'; ctx.fillText('ONLINE DUEL',W/2,78);
    ctx.shadowBlur=0;
    ctx.font='11px "Courier New"'; ctx.fillStyle='rgba(78,205,196,0.5)';
    ctx.fillText('◈  GROTTO DUEL  ◈',W/2,100);
    ctx.restore();
    ctx.save(); const lg2=ctx.createLinearGradient(W/2-220,0,W/2+220,0);
    lg2.addColorStop(0,'rgba(78,205,196,0)'); lg2.addColorStop(0.5,'rgba(78,205,196,0.3)'); lg2.addColorStop(1,'rgba(78,205,196,0)');
    ctx.strokeStyle=lg2; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(W/2-220,112); ctx.lineTo(W/2+220,112); ctx.stroke(); ctx.restore();

    const bw=320,bh=52,bx=W/2-bw/2;

    // CREATE button
    const createY=168;
    rects[0]={x:bx,y:createY-36,w:bw,h:bh};
    ctx.save(); ctx.textAlign='center';
    const cg=ctx.createLinearGradient(bx,0,bx+bw,0);
    cg.addColorStop(0,'rgba(78,205,196,0.0)'); cg.addColorStop(0.5,'rgba(78,205,196,0.14)'); cg.addColorStop(1,'rgba(78,205,196,0.0)');
    ctx.fillStyle=cg; ctx.fillRect(bx,createY-36,bw,bh);
    ctx.strokeStyle='rgba(78,205,196,0.6)'; ctx.lineWidth=1.5; ctx.strokeRect(bx,createY-36,bw,bh);
    // left/right accent bars
    ctx.fillStyle='rgba(78,205,196,0.7)'; ctx.fillRect(bx,createY-36,3,bh); ctx.fillRect(bx+bw-3,createY-36,3,bh);
    ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=10;
    ctx.font='bold 20px "Courier New"'; ctx.fillStyle='#ffffff';
    ctx.fillText('CREATE ROOM',W/2,createY+1);
    ctx.shadowBlur=0;
    ctx.font='11px "Courier New"'; ctx.fillStyle='rgba(78,205,196,0.6)';
    ctx.fillText('generate a code to share with your opponent',W/2,createY+17);
    ctx.restore();

    // or divider
    ctx.save(); ctx.textAlign='center';
    const dg=ctx.createLinearGradient(W/2-120,0,W/2+120,0);
    dg.addColorStop(0,'rgba(78,205,196,0)'); dg.addColorStop(0.5,'rgba(78,205,196,0.25)'); dg.addColorStop(1,'rgba(78,205,196,0)');
    ctx.strokeStyle=dg; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(W/2-120,248); ctx.lineTo(W/2+120,248); ctx.stroke();
    ctx.font='11px "Courier New"'; ctx.fillStyle='rgba(78,205,196,0.4)';
    ctx.fillText('or',W/2,244);
    ctx.restore();

    ctx.save(); ctx.textAlign='center'; ctx.font='bold 13px "Courier New"';
    ctx.fillStyle='rgba(78,205,196,0.7)'; ctx.fillText('JOIN WITH CODE',W/2,274); ctx.restore();

    // 4 letter boxes
    const boxW=56,boxH=62,boxGap=12;
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
    const jY=382; rects[1]={x:bx,y:jY,w:bw,h:46};
    const canJoin=joinCode.length===4;
    ctx.save(); ctx.textAlign='center';
    if(canJoin){
      const jg=ctx.createLinearGradient(bx,0,bx+bw,0);
      jg.addColorStop(0,'rgba(78,205,196,0.0)'); jg.addColorStop(0.5,'rgba(78,205,196,0.14)'); jg.addColorStop(1,'rgba(78,205,196,0.0)');
      ctx.fillStyle=jg; ctx.fillRect(bx,jY,bw,46);
      ctx.fillStyle='rgba(78,205,196,0.7)'; ctx.fillRect(bx,jY,3,46); ctx.fillRect(bx+bw-3,jY,3,46);
      ctx.strokeStyle='rgba(78,205,196,0.55)';
    } else {
      ctx.fillStyle='rgba(255,255,255,0.02)'; ctx.fillRect(bx,jY,bw,46);
      ctx.strokeStyle='rgba(255,255,255,0.07)';
    }
    ctx.lineWidth=1.5; ctx.strokeRect(bx,jY,bw,46);
    ctx.font='bold 18px "Courier New"';
    if(canJoin){ ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=8; ctx.fillStyle='#ffffff'; }
    else        { ctx.fillStyle='rgba(100,130,120,0.3)'; }
    ctx.fillText('JOIN ROOM',W/2,jY+29); ctx.restore();

    if(errorMsg){
      ctx.save(); ctx.textAlign='center'; ctx.font='bold 13px "Courier New"';
      ctx.fillStyle='#ff6b6b'; ctx.shadowColor='#ff6b6b'; ctx.shadowBlur=8;
      ctx.fillText(errorMsg,W/2,440); ctx.restore();
    }

    ctx.save(); ctx.textAlign='center'; ctx.fillStyle='rgba(78,205,196,0.22)';
    ctx.font='10px "Courier New"';
    ctx.fillText('ESC  go back    ·    type or paste your 4-letter code, then ENTER',W/2,H-16); ctx.restore();
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

  game = new Game(canvas, { mode:'online', myPid: pid, roomCode, socket, audio: sharedAudio });
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

  game = new Game(canvas, { mode, audio: sharedAudio });
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
