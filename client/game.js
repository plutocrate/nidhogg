// game.js — Nidhogg Grotto Duel  (v5 — online multiplayer, no background image)
import { InputManager } from './input.js';
import { AudioManager }  from './audio.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const W          = 960;
const H          = 540;
const FLOOR_Y    = 458;
const MOVE_SPEED = 4.8;
const JUMP_VEL   = -12.5;
const GRAVITY    = 0.72;
const ATTACK_CD  = 380;
const ROUND_DELAY= 2800;
const MAX_ROUNDS = 5;
const MAJORITY   = 3;
const SCALE      = 3;

// ─── SHARED IMAGE CACHE ───────────────────────────────────────────────────────
const IMG_CACHE = {};
function cachedImage(src) {
  if (!IMG_CACHE[src]) { const i=new Image(); i.src=src; IMG_CACHE[src]=i; }
  return IMG_CACHE[src];
}

// ─── SPRITE DEFS ──────────────────────────────────────────────────────────────
const DEFS = {
  knight: { src:'assets/Knight_anin.png', fw:48, fh:32,
    anims:{
      idle:  {row:0,frames:[0,1,2,3,4,5,6],fps:8},
      run:   {row:1,frames:[0,1,2,3,4,5,6],fps:12},
      crouch:{row:2,frames:[0],fps:4},
      attack:{row:4,frames:[0,1,2,3,4,5,6,7,8,9,10,11,12,13],fps:28},
      jump:  {row:5,frames:[0,1],fps:8},
      death: {row:3,frames:[0],fps:4},
    }
  },
  thief: { src:'assets/Thief_anim.png', fw:48, fh:32,
    anims:{
      idle:  {row:0,frames:[0,1,2,3,4,5,6,7],fps:8},
      run:   {row:1,frames:[0,1,2,3,4,5,6],fps:12},
      crouch:{row:3,frames:[0],fps:4},
      attack:{row:2,frames:[0,1,2,3,4,5],fps:24},
      jump:  {row:4,frames:[0,1],fps:8},
      death: {row:3,frames:[3],fps:4},
    }
  },
};

// ─── SPRITE ───────────────────────────────────────────────────────────────────
class Sprite {
  constructor(key) {
    this.def=DEFS[key]; this.img=cachedImage(this.def.src);
    this.anim='idle'; this.frame=0; this.timer=0; this.done=false; this.flipX=false;
  }
  play(name,reset=false){
    if(this.anim===name&&!reset)return;
    this.anim=name;this.frame=0;this.timer=0;this.done=false;
  }
  update(dt){
    const a=this.def.anims[this.anim]; if(!a)return;
    this.timer+=dt; const dur=1000/a.fps;
    while(this.timer>=dur){ this.timer-=dur; if(this.frame<a.frames.length-1)this.frame++; else this.done=true; }
  }
  draw(ctx,x,y,alpha=1){
    if(!this.img.complete||!this.img.naturalWidth)return;
    const a=this.def.anims[this.anim]; if(!a)return;
    const fw=this.def.fw,fh=this.def.fh;
    const sx=a.frames[Math.min(this.frame,a.frames.length-1)]*fw, sy=a.row*fh;
    const dw=fw*SCALE,dh=fh*SCALE;
    ctx.save(); ctx.globalAlpha=alpha; ctx.imageSmoothingEnabled=false;
    ctx.translate(x,y); if(this.flipX)ctx.scale(-1,1);
    ctx.drawImage(this.img,sx,sy,fw,fh,-dw/2,-dh/2,dw,dh);
    ctx.restore();
  }
}

// ─── CLIENT-SIDE PLAYER (render + local physics for responsiveness) ───────────
class Player {
  constructor(id,x,key){
    this.id=id; this.sprite=new Sprite(key);
    this.x=x; this.y=FLOOR_Y; this.vx=0; this.vy=0;
    this.grounded=true; this.facingRight=(id===1);
    this.sprite.flipX=(id===2);
    this.alive=true; this.dead=false; this.deadTimer=0;
    this.deadX=0; this.deadY=0; this.deadVx=0; this.deadVy=0; this.deadAngle=0;
    this.attacking=false; this.attackCd=0; this.crouching=false; this.score=0;
    this.anim='idle';
  }

  // Apply authoritative server snapshot
  applySnap(s){
    this.x=s.x; this.y=s.y; this.vx=s.vx; this.vy=s.vy;
    this.grounded=s.grounded; this.facingRight=s.facingRight;
    this.alive=s.alive; this.dead=s.dead;
    this.deadX=s.deadX; this.deadY=s.deadY; this.deadAngle=s.deadAngle; this.deadTimer=s.deadTimer;
    this.attacking=s.attacking; this.crouching=s.crouching; this.anim=s.anim; this.score=s.score;
    this.sprite.flipX=!s.facingRight;
    // Don't override current sprite frame mid-animation, just update anim name
    if(this.sprite.anim!==s.anim) this.sprite.play(s.anim);
  }

  update(dt){
    this.sprite.update(dt);
  }

  draw(ctx){
    if(this.dead){
      const alpha=Math.max(0,1-this.deadTimer/1500);
      ctx.save(); ctx.translate(this.deadX,this.deadY); ctx.rotate(this.deadAngle);
      this.sprite.flipX=!this.facingRight; this.sprite.draw(ctx,0,0,alpha);
      ctx.restore(); return;
    }
    if(!this.alive)return;
    this.sprite.draw(ctx,this.x,this.y);
  }
}

// ─── PARTICLES ────────────────────────────────────────────────────────────────
class Particles {
  constructor(){this.p=[];}
  blood(x,y,dir){
    for(let i=0;i<24;i++){
      const a=-Math.PI/2+(Math.random()-.5)*Math.PI+dir*.4, s=3+Math.random()*10;
      this.p.push({x,y,vx:Math.cos(a)*s+dir*3,vy:Math.sin(a)*s,life:1,decay:.013+Math.random()*.016,r:2+Math.random()*5,col:`hsl(${348+Math.random()*14},88%,${28+Math.random()*22}%)`});
    }
    for(let i=0;i<9;i++){
      const a=Math.random()*Math.PI*2;
      this.p.push({x,y,vx:Math.cos(a)*5,vy:Math.sin(a)*5-2,life:1,decay:.04+Math.random()*.03,r:2,col:'#ffe8c0'});
    }
  }
  update(){
    this.p=this.p.filter(p=>p.life>0);
    for(const p of this.p){p.x+=p.vx;p.y+=p.vy;p.vy+=.3;p.vx*=.96;p.life-=p.decay;}
  }
  draw(ctx){
    for(const p of this.p){
      ctx.save();ctx.globalAlpha=p.life*p.life;ctx.fillStyle=p.col;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r*p.life,0,Math.PI*2);ctx.fill();ctx.restore();
    }
  }
  clear(){this.p=[];}
}

// ─── SCREEN SHAKE ─────────────────────────────────────────────────────────────
class Shake {
  constructor(){this.v=0;}
  hit(n){this.v=Math.max(this.v,n);}
  tick(){this.v*=.87;}
  off(){return this.v<.2?{x:0,y:0}:{x:(Math.random()-.5)*this.v*2.2,y:(Math.random()-.5)*this.v*2.2};}
}

// ─── SLOW MO ──────────────────────────────────────────────────────────────────
class SlowMo {
  constructor(){this.t=0;this.on=false;this.dur=680;}
  hit(){this.t=0;this.on=true;}
  tick(raw){
    if(!this.on)return 1; this.t+=raw;
    if(this.t>this.dur){this.on=false;return 1;}
    const p=this.t/this.dur; return p<.25?.12:.12+(1-.12)*((p-.25)/.75);
  }
  get m(){if(!this.on)return 1;const p=this.t/this.dur;return p<.25?.12:.12+(1-.12)*((p-.25)/.75);}
}

// ─── PROCEDURAL CAVE BACKGROUND ───────────────────────────────────────────────
// Rendered once to an offscreen canvas so it's fast every frame
class CaveBG {
  constructor(){
    this.cvs=document.createElement('canvas');
    this.cvs.width=W; this.cvs.height=H;
    this._paint();
  }

  _paint(){
    const ctx=this.cvs.getContext('2d');

    // Deep cave sky gradient
    const sky=ctx.createLinearGradient(0,0,0,H);
    sky.addColorStop(0,'#050e0a');
    sky.addColorStop(0.35,'#071812');
    sky.addColorStop(0.7,'#0a2218');
    sky.addColorStop(1,'#0d2e1e');
    ctx.fillStyle=sky; ctx.fillRect(0,0,W,H);

    // Distant foggy glow — moonlight shaft from upper-right
    const shaft=ctx.createRadialGradient(W*.78,0,0,W*.78,0,H*.8);
    shaft.addColorStop(0,'rgba(140,210,195,0.18)');
    shaft.addColorStop(0.4,'rgba(80,160,140,0.06)');
    shaft.addColorStop(1,'transparent');
    ctx.fillStyle=shaft; ctx.fillRect(0,0,W,H);

    // Stalactite silhouettes — top edge
    ctx.fillStyle='#020a06';
    const rng=seeded(42);
    for(let i=0;i<22;i++){
      const x=(i/22)*W+rng()*30-15;
      const w=18+rng()*40;
      const h=30+rng()*110;
      ctx.beginPath();
      ctx.moveTo(x-w/2,0); ctx.lineTo(x+w/2,0);
      ctx.lineTo(x+w*(.1+rng()*.15),h); ctx.lineTo(x-w*(.1+rng()*.15),h);
      ctx.closePath(); ctx.fill();
    }

    // Stalagmite silhouettes — bottom edge (above floor)
    for(let i=0;i<16;i++){
      const x=(i/16)*W+rng()*40-20;
      const tw=14+rng()*28;
      const th=20+rng()*70;
      const base=H;
      ctx.beginPath();
      ctx.moveTo(x-tw/2,base); ctx.lineTo(x+tw/2,base);
      ctx.lineTo(x+tw*(.08+rng()*.12),base-th); ctx.lineTo(x-tw*(.08+rng()*.12),base-th);
      ctx.closePath(); ctx.fill();
    }

    // Cave wall boulders — left and right sides
    ctx.fillStyle='#061008';
    for(let side=0;side<2;side++){
      for(let i=0;i<6;i++){
        const bx=side===0 ? rng()*90 : W-rng()*90;
        const by=80+rng()*(H-160);
        const br=30+rng()*60;
        ctx.beginPath(); ctx.ellipse(bx,by,br,br*.6,rng()*.8,0,Math.PI*2); ctx.fill();
      }
    }

    // Subtle green bioluminescent moss patches
    const moss=ctx.createRadialGradient(W*.15,FLOOR_Y-12,0,W*.15,FLOOR_Y-12,120);
    moss.addColorStop(0,'rgba(40,120,60,0.18)');
    moss.addColorStop(1,'transparent');
    ctx.fillStyle=moss; ctx.fillRect(0,0,W,H);
    const moss2=ctx.createRadialGradient(W*.82,FLOOR_Y-8,0,W*.82,FLOOR_Y-8,90);
    moss2.addColorStop(0,'rgba(30,110,55,0.14)');
    moss2.addColorStop(1,'transparent');
    ctx.fillStyle=moss2; ctx.fillRect(0,0,W,H);

    // Atmosphere haze near floor
    const haze=ctx.createLinearGradient(0,FLOOR_Y-60,0,FLOOR_Y);
    haze.addColorStop(0,'transparent');
    haze.addColorStop(1,'rgba(10,30,18,0.35)');
    ctx.fillStyle=haze; ctx.fillRect(0,FLOOR_Y-60,W,60);
  }

  draw(ctx){ ctx.drawImage(this.cvs,0,0); }
}

function seeded(seed){
  let s=seed;
  return function(){ s=(s*16807+0)%2147483647; return (s-1)/2147483646; };
}

// ─── GROUND (tiled grass with overlay) ───────────────────────────────────────
class Ground {
  constructor(){this.tile=cachedImage('assets/Grass.png');}
  draw(ctx,w,h){
    const tw=40,th=40;
    if(!this.tile.complete||!this.tile.naturalWidth){
      ctx.fillStyle='#1a3a12'; ctx.fillRect(0,FLOOR_Y,w,h-FLOOR_Y); return;
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(0,FLOOR_Y,w,h-FLOOR_Y); ctx.clip();
    ctx.imageSmoothingEnabled=false;
    for(let x=0;x<w;x+=tw) for(let y=FLOOR_Y;y<h;y+=th)
      ctx.drawImage(this.tile,x,y,tw,th);
    ctx.globalCompositeOperation='multiply';
    ctx.fillStyle='rgba(40,70,30,0.6)'; ctx.fillRect(0,FLOOR_Y,w,h-FLOOR_Y);
    ctx.globalCompositeOperation='source-over';
    const grad=ctx.createLinearGradient(0,FLOOR_Y-6,0,FLOOR_Y+10);
    grad.addColorStop(0,'rgba(0,0,0,0.5)'); grad.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=grad; ctx.fillRect(0,FLOOR_Y-6,w,16);
    ctx.restore();
  }
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function drawHUD(ctx,p1,p2,w,h,round,maxR,state,msg,myPid){
  ctx.save();
  // labels
  ctx.font='bold 13px "Courier New"'; ctx.textAlign='left';
  ctx.fillStyle='#e63946'; ctx.shadowColor='#e63946'; ctx.shadowBlur=7;
  ctx.fillText('KNIGHT'+(myPid===1?' ◀':''), 20,22);
  ctx.textAlign='right'; ctx.fillStyle='#4ecdc4'; ctx.shadowColor='#4ecdc4';
  ctx.fillText((myPid===2?'▶ ':'')+' THIEF', w-20,22);
  ctx.shadowBlur=0;

  // round counter
  ctx.textAlign='center'; ctx.font='bold 12px "Courier New"';
  ctx.fillStyle='rgba(255,255,255,0.48)';
  ctx.fillText(`ROUND  ${round} / ${maxR}`,w/2,16);

  // pip row
  const PW=14,PH=10,PG=5,rowW=maxR*(PW+PG)-PG;
  const rx=w/2-rowW/2, ry=22;
  for(let i=0;i<maxR;i++){
    const px=rx+i*(PW+PG);
    ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(px,ry,PW,PH);
    if(i<p1.score){ctx.fillStyle='#e63946';ctx.fillRect(px,ry,PW,PH);}
    else if(i<p2.score){ctx.fillStyle='#4ecdc4';ctx.fillRect(px,ry,PW,PH);}
    ctx.strokeStyle='rgba(255,255,255,0.2)'; ctx.lineWidth=1; ctx.strokeRect(px,ry,PW,PH);
  }
  ctx.restore();

  // centre message
  if(msg&&msg.text){
    const age=msg.age||0;
    let alpha=Math.min(1,age/110);
    if(state==='game_over'&&age>1200) alpha=Math.max(0,1-(age-1200)/800);
    ctx.save(); ctx.globalAlpha=alpha; ctx.textAlign='center';
    ctx.font='bold 60px "Courier New"';
    ctx.strokeStyle='rgba(0,0,0,0.9)'; ctx.lineWidth=10;
    ctx.strokeText(msg.text,w/2,h/2-14);
    ctx.fillStyle=msg.color||'#fff'; ctx.shadowColor=msg.color||'#fff'; ctx.shadowBlur=24;
    ctx.fillText(msg.text,w/2,h/2-14);
    if(msg.sub){
      ctx.font='bold 19px "Courier New"'; ctx.shadowBlur=0;
      ctx.fillStyle='rgba(230,230,230,0.92)'; ctx.fillText(msg.sub,w/2,h/2+24);
    }
    ctx.restore();
  }
}

// ─── GAME ─────────────────────────────────────────────────────────────────────
export class Game {
  constructor(canvas, opts={}) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.mode    = opts.mode || 'online';  // 'online' | 'local' | 'tutorial'
    this.myPid   = opts.pid  || 1;         // which player am I (online only)

    this.input   = new InputManager();
    this.audio   = new AudioManager();
    this.fx      = new Particles();
    this.shake   = new Shake();
    this.slow    = new SlowMo();
    this.caveBG  = new CaveBG();
    this.ground  = new Ground();

    // state
    this.round   = 1;
    this.state   = 'waiting';
    this.msg     = null;
    this.cdVal   = 3; this.cdMs=0;
    this.roundMs = 0;
    this.hitDone = false;
    this.tutPhase= 0;

    this._spawn(0,0);

    this.running = false;
    this._raf    = null;
    this._tick   = this._tick.bind(this);
    this._last   = 0;

    // WebSocket (online mode)
    this.ws      = null;
    this._pendingKill = null;  // {atkId, defId} received from server before render
  }

  // ── local game init ───────────────────────────────────────────────────────
  _spawn(s1,s2){
    const key2 = this.mode==='tutorial' ? 'thief' : 'thief';
    this.p1 = new Player(1, W*0.28, 'knight');
    this.p2 = new Player(2, W*0.72, 'thief');
    this.p1.score=s1; this.p2.score=s2;
    this.p1.facingRight=true;  this.p1.sprite.flipX=false;
    this.p2.facingRight=false; this.p2.sprite.flipX=true;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  start(){
    this.running=true;
    this.audio.init().then(()=>this.audio.startAmbience()).catch(()=>{});
    this._last=performance.now();
    this._raf=requestAnimationFrame(this._tick);
    if(this.mode==='online') this._connectWS();
    else { this.state='countdown'; this.cdVal=3; this.cdMs=0; }
  }

  stop(){
    this.running=false;
    if(this._raf){cancelAnimationFrame(this._raf);this._raf=null;}
    this.audio.stopAmbience();
    this.input.destroy();
    if(this.ws){try{this.ws.close();}catch(e){}  this.ws=null;}
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  _connectWS(){
    const proto = location.protocol==='https:' ? 'wss' : 'ws';
    const url   = `${proto}://${location.host}`;
    this.ws     = new WebSocket(url);

    this.ws.onmessage = (e) => {
      try{ this._onMsg(JSON.parse(e.data)); }catch(_){}
    };
    this.ws.onclose = () => {
      if(this.running){
        this.msg   = {text:'DISCONNECTED', sub:'opponent left or connection lost', color:'#ff6b6b', age:0};
        this.state = 'game_over';
      }
    };
  }

  _onMsg(msg){
    switch(msg.type){
      case 'assign':
        this.myPid = msg.pid;
        this.state = 'waiting';
        break;

      case 'waiting':
        this.state = 'waiting';
        break;

      case 'start':
      case 'new_round':
        this.round = msg.round || 1;
        this.state = 'countdown';
        this.msg   = null;
        this.fx.clear();
        break;

      case 'kill': {
        const atk = msg.atk===1 ? this.p1 : this.p2;
        const def = msg.atk===1 ? this.p2 : this.p1;
        this._pendingKill = { atkId:msg.atk, defId:msg.def, scores:msg.scores };
        this.slow.hit(); this.shake.hit(14);
        this.fx.blood(def.x, def.y, atk.facingRight?1:-1);
        this.audio.playDeathImpact();
        const name  = msg.atk===1?'KNIGHT':'THIEF';
        const color = msg.atk===1?'#e63946':'#4ecdc4';
        this.msg    = {text:`${name} WINS`, sub:`Round ${this.round}`, color, age:0};
        this.state  = 'round_end';
        break;
      }

      case 'game_over': {
        const s1=msg.scores[1], s2=msg.scores[2];
        let text,color;
        if(s1===s2){text='DRAW!';color='#fff';}
        else if(s1>s2){text='KNIGHT WINS!';color='#e63946';}
        else{text='THIEF WINS!';color='#4ecdc4';}
        this.msg   = {text, sub:`${s1} — ${s2}   ·   press attack to continue`, color, age:0};
        this.state = 'game_over';
        break;
      }

      case 'state':
        // authoritative snapshot — apply to both players
        if(msg.p1) this.p1.applySnap(msg.p1);
        if(msg.p2) this.p2.applySnap(msg.p2);
        // sync server state/round/cd if we're out of sync
        if(msg.state && this.state!=='round_end' && this.state!=='game_over'){
          this.state = msg.state;
        }
        this.round = msg.round || this.round;
        this.cdVal = msg.cdVal != null ? msg.cdVal : this.cdVal;
        this.cdMs  = msg.cdMs  != null ? msg.cdMs  : this.cdMs;
        if(msg.p1) this.p1.score=msg.p1.score;
        if(msg.p2) this.p2.score=msg.p2.score;
        break;

      case 'opponent_left':
        this.msg   = {text:'OPPONENT LEFT', sub:'returning to menu…', color:'#ff6b6b', age:0};
        this.state = 'game_over';
        setTimeout(()=>this._exitToMenu(), 3000);
        break;
    }
  }

  _sendInput(){
    if(!this.ws||this.ws.readyState!==1) return;
    const inp = this.myPid===1 ? this.input.p1 : this.input.p2;
    this.ws.send(JSON.stringify({type:'input', input:inp}));
  }

  // ── main loop ─────────────────────────────────────────────────────────────
  _tick(now){
    if(!this.running)return;
    this._raf=requestAnimationFrame(this._tick);
    const raw=Math.min(now-this._last,50);
    this._last=now;
    const mul=this.slow.tick(raw);
    const dt=raw*mul;
    this._update(dt,raw);
    this._render();
    this.input.flush();
  }

  _update(dt,raw){
    this.shake.tick(); this.fx.update();

    // send input to server every frame (online)
    if(this.mode==='online') this._sendInput();

    if(this.mode==='online'){
      // Online: just update sprite timers (server drives positions)
      this.p1.update(dt);
      this.p2.update(dt);
      if(this.msg) this.msg.age+=raw;
      if(this.state==='game_over'){
        const i=this.input;
        if(i.p1Pressed.attack||i.p1Pressed.jump||i.p2Pressed.attack||i.p2Pressed.jump)
          this._exitToMenu();
      }
      return;
    }

    // ─ LOCAL / TUTORIAL ────────────────────────────────────────────────────
    if(this.state==='countdown'){
      this.cdMs+=raw;
      while(this.cdMs>=1000){
        this.cdMs-=1000; this.cdVal--;
        if(this.cdVal<=0){this.state='playing';this.hitDone=false;this.cdVal=0;}
      }
      this._localUpdatePlayers(dt,true); return;
    }

    if(this.state==='playing'){
      this._localUpdatePlayers(dt,false);
      if(!this.hitDone){
        if(this._localHit(this.p1,this.p2)){this._localKill(this.p1,this.p2);this.hitDone=true;}
        else if(this._localHit(this.p2,this.p1)){this._localKill(this.p2,this.p1);this.hitDone=true;}
      }
    }

    if(this.state==='round_end'){
      this._localUpdatePlayers(dt,true);
      this.roundMs+=raw; if(this.msg)this.msg.age+=raw;
      if(this.roundMs>=ROUND_DELAY) this._localNextRound();
    }

    if(this.state==='game_over'){
      if(this.msg)this.msg.age+=raw;
      const i=this.input;
      if(i.p1Pressed.attack||i.p1Pressed.jump||i.p2Pressed.attack||i.p2Pressed.jump)
        this._exitToMenu();
    }
  }

  // ─ LOCAL HELPERS ──────────────────────────────────────────────────────────
  _localUpdatePlayers(dt,lock){
    const blank={left:false,right:false,jump:false,crouch:false,attack:false};
    const in1=lock?blank:this.input.p1;
    const in2=lock?blank:this.input.p2;
    this._localPhysics(this.p1,dt,in1);
    if(this.mode==='tutorial') this._aiUpdate(this.p2,dt);
    else this._localPhysics(this.p2,dt,in2);
    this.p1.update(dt); this.p2.update(dt);
  }

  _localPhysics(p,dt,inp){
    if(p.dead){
      p.deadTimer+=dt; p.deadVy+=.48; p.deadVx*=.97;
      p.deadX+=p.deadVx; p.deadY+=p.deadVy; p.deadAngle+=p.deadVx*.065;
      if(p.deadY>=FLOOR_Y+4){p.deadY=FLOOR_Y+4;p.deadVy=0;p.deadVx*=.75;} return;
    }
    if(!p.alive)return;
    p.attackCd=Math.max(0,p.attackCd-dt);
    p.vx=0;
    if(inp.left){p.vx=-MOVE_SPEED;p.facingRight=false;}
    if(inp.right){p.vx=MOVE_SPEED;p.facingRight=true;}
    p.crouching=!!(inp.crouch&&p.grounded); if(p.crouching)p.vx=0;
    if(inp.jump&&p.grounded){p.vy=JUMP_VEL;p.grounded=false;}
    if(!p.grounded)p.vy+=GRAVITY;
    p.x+=p.vx; p.y+=p.vy;
    if(p.y>=FLOOR_Y){p.y=FLOOR_Y;p.vy=0;p.grounded=true;}else{p.grounded=false;}
    if(p.x<50)p.x=50; if(p.x>W-50)p.x=W-50;
    if(inp.attack&&p.attackCd<=0&&!p.attacking){
      p.attacking=true; p.attackCd=ATTACK_CD;
      p.sprite.play('attack',true); this.audio.playSwordSwing(); this.audio.playAttackGrunt();
    }
    if(p.attacking&&p.sprite.done)p.attacking=false;
    p.sprite.flipX=!p.facingRight;
    if(p.attacking)p.sprite.play('attack');
    else if(p.crouching)p.sprite.play('crouch');
    else if(!p.grounded)p.sprite.play('jump');
    else if(Math.abs(p.vx)>.1)p.sprite.play('run');
    else p.sprite.play('idle');
  }

  _aiUpdate(p,dt){
    if(!p._aiMs)p._aiMs=0; if(!p._aiIn)p._aiIn={left:false,right:false,jump:false,attack:false,crouch:false};
    p._aiMs+=dt;
    if(p._aiMs>=420){
      p._aiMs=0;
      const opp=this.p1; const dx=opp.x-p.x, dist=Math.abs(dx);
      p._aiIn={left:false,right:false,jump:false,attack:false,crouch:false};
      if(dist>140){dx>0?(p._aiIn.right=true):(p._aiIn.left=true);}
      else if(dist>60){if(Math.random()<.4)p._aiIn.attack=true;}
      else{if(Math.random()<.6)p._aiIn.attack=true;else dx>0?(p._aiIn.left=true):(p._aiIn.right=true);}
      if(p.grounded&&Math.random()<.06)p._aiIn.jump=true;
    }
    this._localPhysics(p,dt,p._aiIn);
  }

  _localHit(atk,def){
    if(!atk.attacking||!atk.alive||!def.alive)return false;
    const dir=atk.facingRight?1:-1;
    const tipX=atk.x+dir*48*SCALE*.42, tipY=atk.y-10+(atk.crouching?14:0);
    return tipX>=def.x-26&&tipX<=def.x+26&&tipY>=def.y-30&&tipY<=def.y+30;
  }

  _localKill(atk,def){
    const dir=atk.facingRight?1:-1;
    this.slow.hit(); this.shake.hit(14);
    this.fx.blood(def.x,def.y,dir);
    def.dead=true; def.alive=false; def.deadX=def.x; def.deadY=def.y;
    def.deadVx=dir*6+def.vx*.15; def.deadVy=-6; def.deadAngle=0; def.deadTimer=0;
    def.sprite.play('death',true);
    this.audio.playDeathImpact();
    atk.score++;
    const name=atk.id===1?'KNIGHT':'THIEF';
    const color=atk.id===1?'#e63946':'#4ecdc4';
    this.msg={text:`${name} WINS`,sub:`Round ${this.round}`,color,age:0};
    this.state='round_end'; this.roundMs=0;
    if(this.mode==='tutorial')this.tutPhase=Math.min(this.tutPhase+1,2);
  }

  _localNextRound(){
    const s1=this.p1.score,s2=this.p2.score;
    if(s1>=MAJORITY||s2>=MAJORITY||this.round>=MAX_ROUNDS){
      let text,color;
      if(s1===s2){text='DRAW!';color='#fff';}
      else if(s1>s2){text='KNIGHT WINS!';color='#e63946';}
      else{text='THIEF WINS!';color='#4ecdc4';}
      this.msg={text,sub:`${s1} — ${s2}   ·   press attack to continue`,color,age:0};
      this.state='game_over'; return;
    }
    this.round++; this.fx.clear(); this.msg=null;
    this.roundMs=0; this.cdVal=3; this.cdMs=0; this.hitDone=false;
    this._spawn(s1,s2); this.state='countdown';
  }

  _exitToMenu(){
    this.stop();
    window.dispatchEvent(new CustomEvent('game:exit'));
  }

  // ── render ────────────────────────────────────────────────────────────────
  _render(){
    const ctx=this.ctx,w=W,h=H;

    // cave BG (prerendered)
    ctx.clearRect(0,0,w,h);
    this.caveBG.draw(ctx);

    // tiled ground
    this.ground.draw(ctx,w,h);

    // screen shake
    const off=this.shake.off();
    ctx.save(); ctx.translate(off.x,off.y);
    this.fx.draw(ctx);
    this.p1.draw(ctx);
    this.p2.draw(ctx);
    ctx.restore();

    // slow-mo vignette
    if(this.slow.on){
      const t=1-this.slow.m;
      const g=ctx.createRadialGradient(w/2,h/2,h*.28,w/2,h/2,h*.88);
      g.addColorStop(0,'transparent'); g.addColorStop(1,`rgba(0,0,0,${t*.58})`);
      ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
    }

    // WAITING screen
    if(this.state==='waiting'){
      ctx.save(); ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(0,0,w,h);
      ctx.textAlign='center'; ctx.fillStyle='#4ecdc4';
      ctx.font='bold 32px "Courier New"'; ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=16;
      ctx.fillText('WAITING FOR OPPONENT…',w/2,h/2-16);
      const dots='.'.repeat(1+Math.floor(Date.now()/500)%3);
      ctx.font='bold 16px "Courier New"'; ctx.shadowBlur=0; ctx.fillStyle='rgba(255,255,255,0.5)';
      ctx.fillText(`You are ${this.myPid===1?'KNIGHT':'THIEF'}${dots}`,w/2,h/2+22);
      ctx.restore();
      return; // skip HUD while waiting
    }

    // countdown
    if(this.state==='countdown'||(this.state==='playing'&&this.cdVal===0&&this.cdMs<700)){
      const label=this.cdVal>0?String(this.cdVal):'FIGHT!';
      const fadeAlpha=this.state==='playing'?Math.max(0,1-this.cdMs/500):1;
      ctx.save(); ctx.globalAlpha=fadeAlpha; ctx.textAlign='center';
      ctx.font='bold 90px "Courier New"';
      ctx.strokeStyle='rgba(0,0,0,0.9)'; ctx.lineWidth=11;
      ctx.strokeText(label,w/2,h/2+22);
      ctx.fillStyle='#fff'; ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=28;
      ctx.fillText(label,w/2,h/2+22);
      ctx.restore();
    }

    // HUD
    drawHUD(ctx,this.p1,this.p2,w,h,this.round,MAX_ROUNDS,this.state,this.msg,this.myPid);

    // tutorial hints
    if(this.mode==='tutorial'){
      const lines=['A/D Move  W Jump  S Crouch  J Attack','Get close and thrust — one hit kills!','Watch spacing. The first strike wins.'];
      ctx.save(); ctx.globalAlpha=.82;
      ctx.fillStyle='rgba(0,0,0,0.62)'; ctx.fillRect(w/2-290,h-54,580,36);
      ctx.fillStyle='#4ecdc4'; ctx.font='bold 13px "Courier New"'; ctx.textAlign='center';
      ctx.fillText(lines[Math.min(this.tutPhase,lines.length-1)],w/2,h-30);
      ctx.restore();
    }

    // game-over dim
    if(this.state==='game_over'){
      ctx.fillStyle='rgba(0,0,0,0.38)'; ctx.fillRect(0,0,w,h);
    }
  }
}
