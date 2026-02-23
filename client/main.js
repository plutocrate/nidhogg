// main.js — Menu + boot
import { Game } from './game.js';

const canvas = document.getElementById('game-canvas');
const W = 960, H = 540;
canvas.width = W; canvas.height = H;

// ── canvas scaling ────────────────────────────────────────────────────────────
function resize(){
  const s=Math.min(window.innerWidth/W, window.innerHeight/H);
  canvas.style.width=`${W*s}px`; canvas.style.height=`${H*s}px`;
  canvas.style.position='absolute';
  canvas.style.left=`${(window.innerWidth-W*s)/2}px`;
  canvas.style.top=`${(window.innerHeight-H*s)/2}px`;
}
window.addEventListener('resize',resize); resize();

function canvasXY(e){
  const r=canvas.getBoundingClientRect();
  return {x:(e.clientX-r.left)*(W/r.width), y:(e.clientY-r.top)*(H/r.height)};
}

// ─── MENU ────────────────────────────────────────────────────────────────────
class Menu {
  constructor(){
    this.ctx   = canvas.getContext('2d');
    this.state = 'main';
    this.sel   = 0;
    this.glow  = 0; this.glowDir=1;
    this.t     = 0; this.last=0;
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

  _destroy(){
    this.alive=false; cancelAnimationFrame(this._raf);
    window.removeEventListener('keydown',   this._key);
    canvas.removeEventListener('click',     this._click);
    canvas.removeEventListener('mousemove', this._move);
  }

  _key(e){
    if(this.state==='controls'){ if(['Escape','Enter','Space'].includes(e.code))this.state='main'; return; }
    if(e.code==='ArrowUp'  ||e.code==='KeyW') this.sel=(this.sel-1+this.items.length)%this.items.length;
    if(e.code==='ArrowDown'||e.code==='KeyS') this.sel=(this.sel+1)%this.items.length;
    if(e.code==='Enter'||e.code==='Space'||e.code==='KeyJ') this.items[this.sel].action();
  }

  _click(e){
    if(this.state==='controls'){this.state='main';return;}
    const {x,y}=canvasXY(e);
    for(let i=0;i<this.rects.length;i++){
      const r=this.rects[i];
      if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h){this.sel=i;this.items[i].action();return;}
    }
  }

  _move(e){
    if(this.state!=='main'){this.hover=-1;return;}
    const {x,y}=canvasXY(e); this.hover=-1;
    for(let i=0;i<this.rects.length;i++){
      const r=this.rects[i];
      if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h){this.hover=i;break;}
    }
    canvas.style.cursor=this.hover>=0?'pointer':'default';
  }

  _launch(mode){
    this._destroy(); canvas.style.cursor='default';
    startGame(mode);
  }

  _frame(now){
    if(!this.alive)return;
    this._raf=requestAnimationFrame(this._frame.bind(this));
    const dt=Math.min(now-this.last,50); this.last=now; this.t+=dt;
    this.glow+=dt*.0028*this.glowDir;
    if(this.glow>1){this.glow=1;this.glowDir=-1;} if(this.glow<0){this.glow=0;this.glowDir=1;}
    this._draw();
  }

  _draw(){
    const ctx=this.ctx;
    ctx.clearRect(0,0,W,H);

    // procedural cave bg (simple version for menu)
    const sky=ctx.createLinearGradient(0,0,0,H);
    sky.addColorStop(0,'#050e0a'); sky.addColorStop(.5,'#071812'); sky.addColorStop(1,'#0d2e1e');
    ctx.fillStyle=sky; ctx.fillRect(0,0,W,H);
    // moonlight shaft
    const shaft=ctx.createRadialGradient(W*.75,0,0,W*.75,0,H*.9);
    shaft.addColorStop(0,'rgba(130,200,180,0.16)'); shaft.addColorStop(1,'transparent');
    ctx.fillStyle=shaft; ctx.fillRect(0,0,W,H);
    // dark overlay
    ctx.fillStyle='rgba(0,0,0,0.52)'; ctx.fillRect(0,0,W,H);

    if(this.state==='main')    this._drawMain();
    else                       this._drawControls();
  }

  _drawMain(){
    const ctx=this.ctx;

    // title
    ctx.save(); ctx.textAlign='center';
    ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=20+this.glow*32;
    ctx.font='bold 84px "Courier New"';
    ctx.fillStyle=`rgba(78,205,196,${.3+this.glow*.7})`; ctx.fillText('NIDHOGG',W/2,126);
    ctx.shadowBlur=0; ctx.fillStyle='#fff'; ctx.fillText('NIDHOGG',W/2,126);
    ctx.font='14px "Courier New"'; ctx.fillStyle='#4ecdc4'; ctx.fillText('— GROTTO DUEL —',W/2,160);
    ctx.restore();

    ctx.save(); ctx.strokeStyle='rgba(78,205,196,0.25)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(W/2-200,175); ctx.lineTo(W/2+200,175); ctx.stroke(); ctx.restore();

    // menu items
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
    ctx.fillStyle='rgba(0,0,0,0.78)'; ctx.fillRect(bx,by,bw,bh);
    ctx.strokeStyle='#4ecdc4'; ctx.lineWidth=1; ctx.strokeRect(bx,by,bw,bh);
    ctx.textAlign='center'; ctx.fillStyle='#4ecdc4';
    ctx.font='bold 24px "Courier New"'; ctx.fillText('CONTROLS',W/2,by+44);
    ctx.strokeStyle='rgba(78,205,196,0.25)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(bx+40,by+58); ctx.lineTo(bx+bw-40,by+58); ctx.stroke();

    const c1=bx+55, c2=bx+340;
    const rows=[['A / D','Move'],['W','Jump'],['S','Crouch'],['J','Attack'],['ESC','Back to menu']];
    const rows2=[['← →','Move'],['↑','Jump'],['↓','Crouch'],['Num0 / /','Attack'],['ESC','Back to menu']];
    ctx.textAlign='left'; ctx.fillStyle='#e63946'; ctx.font='bold 15px "Courier New"';
    ctx.fillText('PLAYER 1 — KNIGHT',c1,by+82);
    ctx.fillStyle='#4ecdc4'; ctx.fillText('PLAYER 2 — THIEF',c2,by+82);
    rows.forEach(([k,d],i)=>{
      ctx.fillStyle='#777'; ctx.font='13px "Courier New"'; ctx.fillText(`[ ${k} ]`,c1,by+108+i*28);
      ctx.fillStyle='#ddd'; ctx.fillText(d,c1+110,by+108+i*28);
    });
    rows2.forEach(([k,d],i)=>{
      ctx.fillStyle='#777'; ctx.font='13px "Courier New"'; ctx.fillText(`[ ${k} ]`,c2,by+108+i*28);
      ctx.fillStyle='#ddd'; ctx.fillText(d,c2+110,by+108+i*28);
    });
    ctx.textAlign='center'; ctx.fillStyle='rgba(78,205,196,0.7)';
    ctx.font='bold 13px "Courier New"'; ctx.fillText('ONE HIT KILLS — TIMING IS EVERYTHING',W/2,by+270);
    ctx.fillStyle='rgba(100,140,130,0.5)'; ctx.font='11px "Courier New"';
    ctx.fillText('ONLINE: open this page in two browsers / tabs / share the URL',W/2,by+300);
    ctx.fillText('CLICK or PRESS ENTER to return',W/2,by+325);
    ctx.restore();
  }
}

// ── start game ────────────────────────────────────────────────────────────────
function startGame(mode){
  const loading=document.getElementById('loading');
  if(loading) loading.classList.add('hidden');

  let game=null;
  const cleanup=()=>{
    window.removeEventListener('keydown',onKey);
    window.removeEventListener('game:exit',onExit);
    if(game){game.stop();game=null;}
  };
  const showMenu=()=>{cleanup();canvas.style.cursor='default';new Menu();};
  const onExit  =()=>showMenu();
  const onKey   =(e)=>{if(e.code==='Escape')showMenu();};

  // For online: server assigns pid via WebSocket 'assign' message
  // For local/tutorial: pid=1 means P1 controls, but both players on same keyboard
  game = new Game(canvas, { mode, pid: 1 });
  window.addEventListener('keydown',   onKey);
  window.addEventListener('game:exit', onExit);
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
