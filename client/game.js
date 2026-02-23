// game.js
import { InputManager } from './input.js';
import { AudioManager }  from './audio.js';

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

const IMG_CACHE = {};
function cachedImage(src){
  if(!IMG_CACHE[src]){ const i=new Image(); i.src=src; IMG_CACHE[src]=i; }
  return IMG_CACHE[src];
}

const DEFS = {
  knight:{ src:'assets/Knight_anin.png', fw:48, fh:32, anims:{
    idle:  {row:0,frames:[0,1,2,3,4,5,6],fps:8},
    run:   {row:1,frames:[0,1,2,3,4,5,6],fps:12},
    crouch:{row:2,frames:[0],fps:4},
    attack:{row:4,frames:[0,1,2,3,4,5,6,7,8,9,10,11,12,13],fps:28},
    jump:  {row:5,frames:[0,1],fps:8},
    death: {row:3,frames:[0],fps:4},
  }},
  thief:{ src:'assets/Thief_anim.png', fw:48, fh:32, anims:{
    idle:  {row:0,frames:[0,1,2,3,4,5,6,7],fps:8},
    run:   {row:1,frames:[0,1,2,3,4,5,6],fps:12},
    crouch:{row:3,frames:[0],fps:4},
    attack:{row:2,frames:[0,1,2,3,4,5],fps:24},
    jump:  {row:4,frames:[0,1],fps:8},
    death: {row:3,frames:[3],fps:4},
  }},
};

class Sprite {
  constructor(key){
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

class Player {
  constructor(id,x,key){
    this.id=id; this.sprite=new Sprite(key);
    this.x=x; this.y=FLOOR_Y; this.vx=0; this.vy=0;
    this.grounded=true; this.facingRight=(id===1); this.sprite.flipX=(id===2);
    this.alive=true; this.dead=false; this.deadTimer=0;
    this.deadX=0; this.deadY=0; this.deadVx=0; this.deadVy=0; this.deadAngle=0;
    this.attacking=false; this.attackCd=0; this.crouching=false; this.score=0; this.anim='idle';
  }
  applySnap(s){
    // Always hard-sync game-state fields
    this.grounded=s.grounded; this.facingRight=s.facingRight;
    this.alive=s.alive; this.dead=s.dead;
    this.attacking=s.attacking; this.crouching=s.crouching;
    this.anim=s.anim; this.score=s.score;
    this.vx=s.vx; this.vy=s.vy;
    this.sprite.flipX=!s.facingRight;
    if(this.sprite.anim!==s.anim) this.sprite.play(s.anim);

    if(this.dead){
      // Hard-sync dead body physics
      this.deadX=s.deadX; this.deadY=s.deadY;
      this.deadAngle=s.deadAngle; this.deadTimer=s.deadTimer;
    } else if(this.alive){
      // Smooth lerp toward server position — eliminates jitter without adding lag
      const dx=s.x-this.x, dy=s.y-this.y;
      if(Math.abs(dx)>80||Math.abs(dy)>80){
        // Large desync: hard snap
        this.x=s.x; this.y=s.y;
      } else {
        this.x+=dx*0.35; this.y+=dy*0.35;
      }
    }
  }
  update(dt){ this.sprite.update(dt); }
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
  update(){ this.p=this.p.filter(p=>p.life>0); for(const p of this.p){p.x+=p.vx;p.y+=p.vy;p.vy+=.3;p.vx*=.96;p.life-=p.decay;} }
  draw(ctx){ for(const p of this.p){ctx.save();ctx.globalAlpha=p.life*p.life;ctx.fillStyle=p.col;ctx.beginPath();ctx.arc(p.x,p.y,p.r*p.life,0,Math.PI*2);ctx.fill();ctx.restore();} }
  clear(){this.p=[];}
}

class Shake {
  constructor(){this.v=0;}
  hit(n){this.v=Math.max(this.v,n);}
  tick(){this.v*=.87;}
  off(){return this.v<.2?{x:0,y:0}:{x:(Math.random()-.5)*this.v*2.2,y:(Math.random()-.5)*this.v*2.2};}
}

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

function drawHUD(ctx,p1,p2,w,h,round,maxR,state,msg,myPid){
  ctx.save();
  ctx.font='bold 13px "Courier New"'; ctx.textAlign='left';
  ctx.fillStyle='#e63946'; ctx.shadowColor='#e63946'; ctx.shadowBlur=7;
  ctx.fillText('KNIGHT'+(myPid===1?' ◀':''),20,22);
  ctx.textAlign='right'; ctx.fillStyle='#4ecdc4'; ctx.shadowColor='#4ecdc4';
  ctx.fillText((myPid===2?'▶ ':'')+' THIEF',w-20,22);
  ctx.shadowBlur=0;
  ctx.textAlign='center'; ctx.font='bold 12px "Courier New"'; ctx.fillStyle='rgba(255,255,255,0.48)';
  ctx.fillText(`ROUND  ${round} / ${maxR}`,w/2,16);
  const PW=14,PH=10,PG=5,rowW=maxR*(PW+PG)-PG, rx=w/2-rowW/2, ry=22;
  for(let i=0;i<maxR;i++){
    const px=rx+i*(PW+PG);
    ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(px,ry,PW,PH);
    if(i<p1.score){ctx.fillStyle='#e63946';ctx.fillRect(px,ry,PW,PH);}
    else if(i<p2.score){ctx.fillStyle='#4ecdc4';ctx.fillRect(px,ry,PW,PH);}
    ctx.strokeStyle='rgba(255,255,255,0.2)'; ctx.lineWidth=1; ctx.strokeRect(px,ry,PW,PH);
  }
  ctx.restore();
  if(msg&&msg.text && state!=='countdown' && state!=='playing'){
    const age=msg.age||0; let alpha=Math.min(1,age/110);
    if(state==='game_over'&&age>1200) alpha=Math.max(0,1-(age-1200)/800);
    ctx.save(); ctx.globalAlpha=alpha; ctx.textAlign='center';
    ctx.font='bold 60px "Courier New"';
    ctx.strokeStyle='rgba(0,0,0,0.9)'; ctx.lineWidth=10; ctx.strokeText(msg.text,w/2,h/2-14);
    ctx.fillStyle=msg.color||'#fff'; ctx.shadowColor=msg.color||'#fff'; ctx.shadowBlur=24;
    ctx.fillText(msg.text,w/2,h/2-14);
    if(msg.sub){
      ctx.font='bold 19px "Courier New"'; ctx.shadowBlur=0;
      ctx.fillStyle='rgba(230,230,230,0.92)'; ctx.fillText(msg.sub,w/2,h/2+24);
    }
    ctx.restore();
  }
}

export class Game {
  constructor(canvas, opts={}){
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.mode    = opts.mode || 'local';
    this.myPid   = opts.myPid || 1;

    this.input = new InputManager(this.mode);
    this.audio = new AudioManager();
    this.fx    = new Particles();
    this.shake = new Shake();
    this.slow  = new SlowMo();

    this.round   = 1;
    this.state   = (this.mode==='online') ? 'waiting' : 'countdown';
    this.msg     = null;
    this.cdVal   = 3; this.cdMs=0;
    this.roundMs = 0;
    this.hitDone = false;
    this.tutPhase= 0;

    this._spawn(0,0);

    this.running = false;
    this._raf    = null;
    this._tickFn = this._tick.bind(this);
    this._last   = 0;

    // Online: receive already-open socket from lobby
    this.ws     = opts.socket || null;
    this._lastSentInput = null;
  }

  _spawn(s1,s2){
    this.p1=new Player(1,W*0.28,'knight'); this.p2=new Player(2,W*0.72,'thief');
    this.p1.score=s1; this.p2.score=s2;
    this.p1.facingRight=true;  this.p1.sprite.flipX=false;
    this.p2.facingRight=false; this.p2.sprite.flipX=true;
  }

  start(){
    this.running=true;
    this.audio.init().then(()=>this.audio.startAmbience()).catch(()=>{});
    this._last=performance.now();
    this._raf=requestAnimationFrame(this._tickFn);
    if(this.mode==='online' && this.ws) this._attachWS();
  }

  stop(){
    this.running=false;
    if(this._raf){cancelAnimationFrame(this._raf);this._raf=null;}
    this.audio.stopAmbience();
    this.input.destroy();
    if(this.ws){try{this.ws.close();}catch(e){} this.ws=null;}
  }

  _attachWS(){
    // WS is already open and connected — just hook up message/close handlers
    this.ws.onmessage=(e)=>{
      try{this._onMsg(JSON.parse(e.data));}catch(_){}
    };
    this.ws.onclose=()=>{
      if(!this.running) return;
      if(this.state!=='game_over'){
        this.msg  ={text:'DISCONNECTED',sub:'connection lost',color:'#ff6b6b',age:0};
        this.state='game_over';
      }
    };
    this.ws.onerror=()=>{};
  }

  _onMsg(msg){
    switch(msg.type){
      case 'state':
        if(msg.p1) this.p1.applySnap(msg.p1);
        if(msg.p2) this.p2.applySnap(msg.p2);
        // Only sync state if we're not in a terminal/transitioning state
        if(msg.state && this.state!=='round_end' && this.state!=='game_over') this.state=msg.state;
        this.round=msg.round||this.round;
        this.cdVal=msg.cdVal!=null?msg.cdVal:this.cdVal;
        this.cdMs =msg.cdMs !=null?msg.cdMs :this.cdMs;
        if(msg.p1) this.p1.score=msg.p1.score;
        if(msg.p2) this.p2.score=msg.p2.score;
        break;

      case 'kill':{
        const atk=msg.atk===1?this.p1:this.p2, def=msg.atk===1?this.p2:this.p1;
        this.slow.hit(); this.shake.hit(14);
        this.fx.blood(def.x,def.y,atk.facingRight?1:-1);
        this.audio.playDeathImpact();
        this.msg={text:(msg.atk===1?'KNIGHT':'THIEF')+' WINS',sub:`Round ${this.round}`,color:msg.atk===1?'#e63946':'#4ecdc4',age:0};
        this.state='round_end';
        break;
      }

      case 'new_round':
        // Hard-reset both players and all visual state for the new round
        this.round = msg.round || this.round;
        this.fx.clear();
        this.shake = new Shake();
        this.slow  = new SlowMo();
        // Reset players to fresh state, keep scores
        const s1=this.p1.score, s2=this.p2.score;
        this.p1=new Player(1,W*0.28,'knight'); this.p1.score=s1;
        this.p2=new Player(2,W*0.72,'thief');  this.p2.score=s2;
        this.p1.facingRight=true;  this.p1.sprite.flipX=false;
        this.p2.facingRight=false; this.p2.sprite.flipX=true;
        this.msg   = null;
        this.cdVal = 3; this.cdMs = 0;
        this.state = 'countdown';
        break;

      case 'game_over':{
        const gs1=msg.scores[1], gs2=msg.scores[2];
        let text,color;
        if(gs1===gs2){text='DRAW!';color='#fff';}
        else if(gs1>gs2){text='KNIGHT WINS!';color='#e63946';}
        else{text='THIEF WINS!';color='#4ecdc4';}
        this.msg={text,sub:`${gs1} — ${gs2}`,color,age:0};
        this.state='game_over';
        // Auto-return to menu after 4 seconds
        setTimeout(()=>{ if(this.running) this._exit(); }, 4000);
        break;
      }

      case 'opponent_left':
        this.msg={text:'OPPONENT LEFT',sub:'returning to menu…',color:'#ff6b6b',age:0};
        this.state='game_over';
        setTimeout(()=>{ if(this.running) this._exit(); }, 3000);
        break;
    }
  }

  _sendInput(){
    if(!this.ws||this.ws.readyState!==1)return;
    const inp=this.input.p1;
    const s=JSON.stringify(inp);
    if(s===this._lastSentInput)return;
    this._lastSentInput=s;
    this.ws.send(JSON.stringify({type:'input',input:inp}));
  }

  _tick(now){
    if(!this.running)return;
    this._raf=requestAnimationFrame(this._tickFn);
    const raw=Math.min(now-this._last,50); this._last=now;
    const dt=raw*this.slow.tick(raw);
    this._update(dt,raw);
    this._render();
    this.input.flush();
  }

  _update(dt,raw){
    this.shake.tick(); this.fx.update();
    if(this.mode==='online'){
      if(this.state==='playing'||this.state==='countdown') this._sendInput();
      this.p1.update(dt); this.p2.update(dt);
      if(this.msg) this.msg.age+=raw;
      // Clear round-win message once it's been shown long enough (before new_round arrives)
      if(this.state==='round_end' && this.msg && this.msg.age > 2400) this.msg=null;
      return;
    }
    // LOCAL / TUTORIAL
    if(this.state==='countdown'){
      this.cdMs+=raw;
      while(this.cdMs>=1000){this.cdMs-=1000;this.cdVal--;if(this.cdVal<=0){this.state='playing';this.hitDone=false;this.cdVal=0;}}
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
      this._localUpdatePlayers(dt,true); this.roundMs+=raw; if(this.msg)this.msg.age+=raw;
      if(this.roundMs>=ROUND_DELAY)this._localNextRound();
    }
    if(this.state==='game_over'){
      if(this.msg)this.msg.age+=raw;
    }
  }

  _localUpdatePlayers(dt,lock){
    const blank={left:false,right:false,jump:false,crouch:false,attack:false};
    this._localPhysics(this.p1,dt,lock?blank:this.input.p1);
    if(this.mode==='tutorial')this._aiUpdate(this.p2,dt);
    else this._localPhysics(this.p2,dt,lock?blank:this.input.p2);
    this.p1.update(dt); this.p2.update(dt);
  }

  _localPhysics(p,dt,inp){
    if(p.dead){p.deadTimer+=dt;p.deadVy+=.48;p.deadVx*=.97;p.deadX+=p.deadVx;p.deadY+=p.deadVy;p.deadAngle+=p.deadVx*.065;if(p.deadY>=FLOOR_Y+4){p.deadY=FLOOR_Y+4;p.deadVy=0;p.deadVx*=.75;}return;}
    if(!p.alive)return;
    p.attackCd=Math.max(0,p.attackCd-dt); p.vx=0;
    if(inp.left){p.vx=-MOVE_SPEED;p.facingRight=false;} if(inp.right){p.vx=MOVE_SPEED;p.facingRight=true;}
    p.crouching=!!(inp.crouch&&p.grounded); if(p.crouching)p.vx=0;
    if(inp.jump&&p.grounded){p.vy=JUMP_VEL;p.grounded=false;}
    if(!p.grounded)p.vy+=GRAVITY; p.x+=p.vx; p.y+=p.vy;
    if(p.y>=FLOOR_Y){p.y=FLOOR_Y;p.vy=0;p.grounded=true;}else{p.grounded=false;}
    if(p.x<50)p.x=50; if(p.x>W-50)p.x=W-50;
    if(inp.attack&&p.attackCd<=0&&!p.attacking){p.attacking=true;p.attackCd=ATTACK_CD;p.sprite.play('attack',true);this.audio.playSwordSwing();this.audio.playAttackGrunt();}
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
      p._aiMs=0; const dx=this.p1.x-p.x, dist=Math.abs(dx);
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
    const dir=atk.facingRight?1:-1, tipX=atk.x+dir*48*SCALE*.42, tipY=atk.y-10+(atk.crouching?14:0);
    return tipX>=def.x-26&&tipX<=def.x+26&&tipY>=def.y-30&&tipY<=def.y+30;
  }

  _localKill(atk,def){
    const dir=atk.facingRight?1:-1;
    this.slow.hit(); this.shake.hit(14); this.fx.blood(def.x,def.y,dir);
    def.dead=true;def.alive=false;def.deadX=def.x;def.deadY=def.y;
    def.deadVx=dir*6+def.vx*.15;def.deadVy=-6;def.deadAngle=0;def.deadTimer=0;
    def.sprite.play('death',true); this.audio.playDeathImpact(); atk.score++;
    this.msg={text:(atk.id===1?'KNIGHT':'THIEF')+' WINS',sub:`Round ${this.round}`,color:atk.id===1?'#e63946':'#4ecdc4',age:0};
    this.state='round_end'; this.roundMs=0;
    if(this.mode==='tutorial')this.tutPhase=Math.min(this.tutPhase+1,2);
  }

  _localNextRound(){
    const s1=this.p1.score,s2=this.p2.score;
    if(s1>=MAJORITY||s2>=MAJORITY||this.round>=MAX_ROUNDS){
      let text,color;
      if(s1===s2){text='DRAW!';color='#fff';}else if(s1>s2){text='KNIGHT WINS!';color='#e63946';}else{text='THIEF WINS!';color='#4ecdc4';}
      this.msg={text,sub:`${s1} — ${s2}`,color,age:0};
      this.state='game_over';
      setTimeout(()=>{ if(this.running) this._exit(); }, 4000);
      return;
    }
    this.round++;
    // Full reset of all visual state
    this.fx.clear();
    this.shake = new Shake();
    this.slow  = new SlowMo();
    this.msg=null; this.roundMs=0; this.cdVal=3; this.cdMs=0; this.hitDone=false;
    this._spawn(s1,s2); this.state='countdown';
  }

  _exit(){ this.stop(); window.dispatchEvent(new CustomEvent('game:exit')); }

  _render(){
    const ctx=this.ctx,w=W,h=H;

    // Full black clear every frame — nothing persists
    ctx.fillStyle='#000';
    ctx.fillRect(0,0,w,h);

    // Floor line
    ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,FLOOR_Y); ctx.lineTo(w,FLOOR_Y); ctx.stroke();

    // Waiting screen — don't draw game objects
    if(this.state==='waiting'){
      ctx.save(); ctx.textAlign='center'; ctx.fillStyle='#4ecdc4';
      ctx.font='bold 24px "Courier New"';
      ctx.fillText('Connected — waiting for match to start…',w/2,h/2);
      ctx.restore();
      return;
    }

    // Draw game objects with screen shake
    const off=this.shake.off();
    ctx.save(); ctx.translate(off.x,off.y);
    this.fx.draw(ctx);
    this.p1.draw(ctx);
    this.p2.draw(ctx);
    ctx.restore();

    // Slow-mo vignette
    if(this.slow.on){
      const t=1-this.slow.m;
      const g=ctx.createRadialGradient(w/2,h/2,h*.28,w/2,h/2,h*.88);
      g.addColorStop(0,'transparent'); g.addColorStop(1,`rgba(0,0,0,${t*.58})`);
      ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
    }

    // Countdown
    if(this.state==='countdown'||(this.state==='playing'&&this.cdVal===0&&this.cdMs<700)){
      const label=this.cdVal>0?String(this.cdVal):'FIGHT!';
      const fadeAlpha=this.state==='playing'?Math.max(0,1-this.cdMs/500):1;
      ctx.save(); ctx.globalAlpha=fadeAlpha; ctx.textAlign='center';
      ctx.font='bold 90px "Courier New"';
      ctx.strokeStyle='rgba(0,0,0,0.9)'; ctx.lineWidth=11; ctx.strokeText(label,w/2,h/2+22);
      ctx.fillStyle='#fff'; ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=28; ctx.fillText(label,w/2,h/2+22);
      ctx.restore();
    }

    // HUD (scores, round counter, win message)
    drawHUD(ctx,this.p1,this.p2,w,h,this.round,MAX_ROUNDS,this.state,this.msg,this.myPid);

    // Tutorial hints
    if(this.mode==='tutorial'){
      const lines=['A/D Move  W Jump  S Crouch  J Attack','Get close and thrust — one hit kills!','Watch spacing. The first strike wins.'];
      ctx.save(); ctx.globalAlpha=.82;
      ctx.fillStyle='rgba(0,0,0,0.62)'; ctx.fillRect(w/2-290,h-54,580,36);
      ctx.fillStyle='#4ecdc4'; ctx.font='bold 13px "Courier New"'; ctx.textAlign='center';
      ctx.fillText(lines[Math.min(this.tutPhase,lines.length-1)],w/2,h-30);
      ctx.restore();
    }

    // Game-over: dark overlay + final message already drawn by HUD
    if(this.state==='game_over'){
      ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(0,0,w,h);
      // Re-draw the final message on top of the overlay
      if(this.msg&&this.msg.text){
        ctx.save(); ctx.textAlign='center';
        ctx.font='bold 60px "Courier New"';
        ctx.strokeStyle='rgba(0,0,0,0.9)'; ctx.lineWidth=10; ctx.strokeText(this.msg.text,w/2,h/2-14);
        ctx.fillStyle=this.msg.color||'#fff'; ctx.shadowColor=this.msg.color||'#fff'; ctx.shadowBlur=24;
        ctx.fillText(this.msg.text,w/2,h/2-14);
        if(this.msg.sub){
          ctx.font='bold 19px "Courier New"'; ctx.shadowBlur=0;
          ctx.fillStyle='rgba(230,230,230,0.92)'; ctx.fillText(this.msg.sub,w/2,h/2+24);
        }
        ctx.fillStyle='rgba(180,180,180,0.5)'; ctx.font='13px "Courier New"';
        ctx.fillText('returning to menu…',w/2,h/2+58);
        ctx.restore();
      }
    }
  }
}
