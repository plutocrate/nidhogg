// game.js — Nidhogg Grotto Duel
// ─────────────────────────────────────────────────────────────────────────────
// NETWORKING ARCHITECTURE
// ─────────────────────────────────────────────────────────────────────────────
//
// CLIENT-SIDE PREDICTION (online mode, local player only)
//   Input is applied immediately to the local player — no waiting for the
//   server. Each input frame is stamped with a sequence number and pushed
//   onto a pending-input ring buffer.
//
// SERVER RECONCILIATION
//   The server echoes back the last processed sequence number with every
//   state snapshot. On receipt, we discard all inputs ≤ that seq from the
//   buffer, then replay any remaining (unacknowledged) inputs on top of the
//   authoritative server position.  If the corrected position differs from
//   where we predicted by more than RECONCILE_SNAP_THRESHOLD we teleport
//   instantly; otherwise we smoothly lerp toward the correction over
//   RECONCILE_LERP_MS milliseconds.
//
// REMOTE PLAYER INTERPOLATION
//   Instead of snapping the remote player to each incoming packet we push
//   each snapshot into a small ring buffer (INTERP_BUFFER_SIZE entries) and
//   render from a fixed INTERP_DELAY ms in the past.  We linearly interpolate
//   between the two surrounding keyframes, producing smooth motion even when
//   packets arrive slightly late or out of order.
//
// AUDIO
//   Audio is NEVER sent over the network.  Local player SFX fire from the
//   prediction path.  Remote player SFX fire from state-change detection in
//   applyRemoteSnap().
//
// NETWORK TICK
//   Inputs are sent at INPUT_HZ (60 Hz) but only when the input has changed
//   OR a heartbeat is due every HEARTBEAT_MS.  State snapshots from the
//   server arrive at ~50 Hz (BROADCAST_MS=20 on the server side).
//
// ─────────────────────────────────────────────────────────────────────────────

import { InputManager } from './input.js';
import { AudioManager }  from './audio.js';

// ── Constants (MUST match server/server.js exactly) ───────────────────────────
const WORLD_W    = 3200;
const FLOOR_Y    = 460;
const MOVE_SPEED = 5.5;
const JUMP_VEL   = -19;
const GRAVITY    = 0.72;
const ATTACK_CD  = 380;
const ROUND_DELAY= 2800;
const MAX_ROUNDS = 5;
const MAJORITY   = 3;
const SCALE      = 3;

const VW = 960;
const VH = 540;

const HB          = { knight:{ hw:20, hh:50 }, thief:{ hw:16, hh:46 } };
const SWORD_REACH = { knight:62, thief:50 };
const ATTACK_DUR  = { knight:500, thief:260 };

// ── Prediction / reconciliation tuning ───────────────────────────────────────
const RECONCILE_SNAP_THRESHOLD = 180;   // px — teleport if error is larger than this
const RECONCILE_LERP_MS        = 120;   // ms — smooth correction window
const INPUT_BUFFER_SIZE        = 128;   // ring buffer: max unacknowledged inputs kept
const HEARTBEAT_MS             = 100;   // send input even if unchanged every N ms

// ── Remote player interpolation ───────────────────────────────────────────────
const INTERP_BUFFER_SIZE = 32;    // snapshot ring buffer length
const INTERP_DELAY       = 100;   // ms — how far behind "now" we render the remote player
                                  // (must be > typical inter-packet gap ≈ 20ms, with headroom)

// ── Camera ────────────────────────────────────────────────────────────────────
const CAM_LERP     = 0.085;
const CAM_ZOOM_MAX = 1.0;
const CAM_ZOOM_MIN = 0.38;
const CAM_DIST_MIN = 250;
const CAM_DIST_MAX = 1600;

// ── Asset preload ─────────────────────────────────────────────────────────────
const IMG_CACHE = {};
function preloadImg(src) {
  if (!IMG_CACHE[src]) { const i = new Image(); i.src = src; IMG_CACHE[src] = i; }
  return IMG_CACHE[src];
}
['assets/Knight_anin.png','assets/Thief_anim.png'].forEach(preloadImg);

// ── Sprite sheet definitions ──────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Sprite
// ─────────────────────────────────────────────────────────────────────────────
class Sprite {
  constructor(key) {
    this.def=DEFS[key]; this.img=preloadImg(this.def.src);
    this.anim='idle'; this.frame=0; this.timer=0; this.done=false; this.flipX=false;
  }
  play(name, reset=false) {
    if (this.anim===name && !reset) return;
    this.anim=name; this.frame=0; this.timer=0; this.done=false;
  }
  update(dt) {
    const a=this.def.anims[this.anim]; if(!a) return;
    this.timer+=dt;
    const dur=1000/a.fps;
    while(this.timer>=dur){
      this.timer-=dur;
      if(this.frame<a.frames.length-1) this.frame++; else this.done=true;
    }
  }
  draw(ctx, x, y, alpha=1) {
    if(!this.img.complete||!this.img.naturalWidth) return;
    const a=this.def.anims[this.anim]; if(!a) return;
    const fw=this.def.fw, fh=this.def.fh;
    const sx=a.frames[Math.min(this.frame,a.frames.length-1)]*fw, sy=a.row*fh;
    const dw=fw*SCALE, dh=fh*SCALE;
    ctx.save();
    ctx.globalAlpha=alpha; ctx.imageSmoothingEnabled=false;
    ctx.shadowBlur=0; ctx.shadowColor='transparent';
    ctx.translate(x,y);
    if(this.flipX) ctx.scale(-1,1);
    ctx.drawImage(this.img,sx,sy,fw,fh,-dw/2,-dh/2,dw,dh);
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LocalPlayer — owns prediction + reconciliation
// ─────────────────────────────────────────────────────────────────────────────
class LocalPlayer {
  constructor(id, x, key) {
    this.id=id; this.key=key;
    this.sprite=new Sprite(key);

    // Predicted (display) state
    this.x=x; this.y=FLOOR_Y;
    this.vx=0; this.vy=0;
    this.grounded=true; this.facingRight=(id===1);
    this.sprite.flipX=(id===2);
    this.alive=true; this.dead=false; this.deadTimer=0;
    this.deadX=0; this.deadY=0; this.deadVx=0; this.deadVy=0; this.deadAngle=0;
    this.attacking=false; this.attackTimer=0; this.attackCd=0;
    this.crouching=false; this.score=0; this.anim='idle';

    // ── Prediction bookkeeping ────────────────────────────────────────────────
    // Ring buffer of inputs we have applied locally but the server hasn't yet
    // acknowledged.  Each entry: { seq, input, dt }
    this._pendingInputs = [];
    this._seq = 0;               // monotonically-increasing input sequence number

    // ── Reconciliation lerp ───────────────────────────────────────────────────
    // When the server sends a correction we lerp from current to corrected.
    this._lerpSrc = null;        // { x, y } start of lerp
    this._lerpTgt = null;        // { x, y } server-authoritative position
    this._lerpT   = 0;           // current lerp progress (0-1)
    this._lerpActive = false;
  }

  // ── Run one physics step using given input, store in pending buffer ──────────
  // Returns the sequence number for this input.
  predictStep(input, dt) {
    this._seq++;
    const entry = { seq: this._seq, input: { ...input }, dt };

    // Apply physics locally (prediction)
    this._applyPhysics(input, dt);

    this._pendingInputs.push(entry);
    // Trim buffer to max size (drop very old unacknowledged inputs)
    if (this._pendingInputs.length > INPUT_BUFFER_SIZE) {
      this._pendingInputs.shift();
    }
    return this._seq;
  }

  // ── Server reconciliation ─────────────────────────────────────────────────
  // Called when a server state snapshot arrives.
  // lastAckedSeq: the server's echo of the last input sequence it processed.
  // snap: authoritative player state from server.
  reconcile(snap, lastAckedSeq) {
    if (!this.alive || this.dead) {
      // Dead state: hard sync
      this._applyDeadSnap(snap);
      return;
    }

    // 1. Discard all inputs the server has already processed
    this._pendingInputs = this._pendingInputs.filter(e => e.seq > lastAckedSeq);

    // 2. Start from the server's authoritative position
    let rx = snap.x, ry = snap.y, rvx = snap.vx, rvy = snap.vy;
    let rGrounded = snap.grounded;

    // 3. Re-simulate all still-pending (unacknowledged) inputs on top
    for (const entry of this._pendingInputs) {
      ({ rx, ry, rvx, rvy, rGrounded } =
        this._replayStep(rx, ry, rvx, rvy, rGrounded, entry.input, entry.dt));
    }

    // 4. Compare reconciled position to our current predicted position
    const errX = Math.abs(rx - this.x);
    const errY = Math.abs(ry - this.y);

    if (errX > RECONCILE_SNAP_THRESHOLD || errY > RECONCILE_SNAP_THRESHOLD) {
      // Large error — teleport immediately
      this.x = rx; this.y = ry;
      this.vx = rvx; this.vy = rvy;
      this.grounded = rGrounded;
      this._lerpActive = false;
    } else if (errX > 1 || errY > 1) {
      // Small error — smooth correction lerp
      this._lerpSrc = { x: this.x, y: this.y };
      this._lerpTgt = { x: rx, y: ry };
      this._lerpT   = 0;
      this._lerpActive = true;
      // Still update velocity so future prediction is accurate
      this.vx = rvx; this.vy = rvy;
      this.grounded = rGrounded;
    }

    // Sync non-positional authoritative state
    this.attacking = snap.attacking;
    this.attackCd  = snap.attackCd !== undefined ? snap.attackCd : this.attackCd;
    this.crouching = snap.crouching;
    this.score     = snap.score;
    this.facingRight = snap.facingRight;
    this.sprite.flipX = !snap.facingRight;
  }

  // ── Advance the reconciliation lerp ─────────────────────────────────────────
  tickReconcileLerp(dt) {
    if (!this._lerpActive) return;
    this._lerpT += dt / RECONCILE_LERP_MS;
    if (this._lerpT >= 1) {
      this._lerpT = 1;
      this._lerpActive = false;
    }
    const a = this._lerpT;
    this.x = this._lerpSrc.x + (this._lerpTgt.x - this._lerpSrc.x) * a;
    this.y = this._lerpSrc.y + (this._lerpTgt.y - this._lerpSrc.y) * a;
  }

  // ── Physics step (shared by prediction & replay) ───────────────────────────
  _applyPhysics(inp, dt) {
    if (this.dead || !this.alive) return;
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.vx = 0;
    if (inp.left)  { this.vx = -MOVE_SPEED; this.facingRight = false; }
    if (inp.right) { this.vx =  MOVE_SPEED; this.facingRight = true;  }
    this.crouching = !!(inp.crouch && this.grounded);
    if (this.crouching) this.vx = 0;
    if (inp.jump && this.grounded) { this.vy = JUMP_VEL; this.grounded = false; }
    if (!this.grounded) this.vy += GRAVITY;
    this.x += this.vx; this.y += this.vy;
    if (this.y >= FLOOR_Y) { this.y = FLOOR_Y; this.vy = 0; this.grounded = true; }
    else { this.grounded = false; }
    if (this.x < 60) this.x = 60;
    if (this.x > WORLD_W - 60) this.x = WORLD_W - 60;
    if (inp.attack && this.attackCd <= 0 && !this.attacking) {
      this.attacking = true; this.attackTimer = 0; this.attackCd = ATTACK_CD;
    }
    if (this.attacking) {
      this.attackTimer += dt;
      if (this.attackTimer >= ATTACK_DUR[this.key]) { this.attacking = false; this.attackTimer = 0; }
    }
  }

  // ── Pure replay for reconciliation (no side-effects on this) ───────────────
  _replayStep(x, y, vx, vy, grounded, inp, dt) {
    let ax=0, ay=0;
    if (inp.left)  ax = -MOVE_SPEED;
    if (inp.right) ax =  MOVE_SPEED;
    let avx = ax, avy = vy;
    if (inp.crouch && grounded) avx = 0;
    if (inp.jump && grounded) { avy = JUMP_VEL; grounded = false; }
    if (!grounded) avy += GRAVITY;
    x += avx; y += avy;
    if (y >= FLOOR_Y) { y = FLOOR_Y; avy = 0; grounded = true; }
    else { grounded = false; }
    if (x < 60) x = 60; if (x > WORLD_W-60) x = WORLD_W-60;
    return { rx:x, ry:y, rvx:avx, rvy:avy, rGrounded:grounded };
  }

  _applyDeadSnap(s) {
    this.alive=false; this.dead=true;
    this.deadX=s.deadX; this.deadY=s.deadY;
    this.deadAngle=s.deadAngle; this.deadTimer=s.deadTimer;
    this.score=s.score;
  }

  // ── Per-frame update (sprite + lerp) ────────────────────────────────────────
  update(dt) {
    this.sprite.update(dt);
    this.tickReconcileLerp(dt);
    if (this.dead) {
      this.deadTimer+=dt;
      this.deadVy+=0.52; this.deadVx*=0.96;
      this.deadX+=this.deadVx; this.deadY+=this.deadVy;
      this.deadAngle+=this.deadVx*0.06;
      if (this.deadY>=FLOOR_Y) { this.deadY=FLOOR_Y; this.deadVy=0; this.deadVx*=0.7; }
    }
    // Sync sprite state from physics
    this.sprite.flipX = !this.facingRight;
    if (this.dead)              this.sprite.play('death');
    else if (this.attacking)    this.sprite.play('attack');
    else if (this.crouching)    this.sprite.play('crouch');
    else if (!this.grounded)    this.sprite.play('jump');
    else if (Math.abs(this.vx)>.1) this.sprite.play('run');
    else                        this.sprite.play('idle');
  }

  draw(ctx) {
    if (this.dead) {
      const alpha=Math.max(0,1-this.deadTimer/1400);
      if(alpha<=0) return;
      ctx.save();
      ctx.shadowBlur=0; ctx.shadowColor='transparent';
      ctx.translate(this.deadX,this.deadY);
      ctx.rotate(this.deadAngle);
      this.sprite.flipX=!this.facingRight;
      this.sprite.draw(ctx,0,0,alpha);
      ctx.restore();
      return;
    }
    if (!this.alive) return;
    this.sprite.draw(ctx, this.x, this.y);

    // Debug: show reconciliation lerp in progress (red tint if active)
    // Uncomment for debugging:
    // if (this._lerpActive) { ctx.save(); ctx.fillStyle='rgba(255,0,0,0.15)';
    //   ctx.fillRect(this.x-20,this.y-50,40,50); ctx.restore(); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RemotePlayer — owns snapshot interpolation
// ─────────────────────────────────────────────────────────────────────────────
class RemotePlayer {
  constructor(id, x, key) {
    this.id=id; this.key=key;
    this.sprite=new Sprite(key);

    // Display position (interpolated)
    this.x=x; this.y=FLOOR_Y;
    this.vx=0; this.vy=0;
    this.grounded=true; this.facingRight=(id===1);
    this.sprite.flipX=(id===2);
    this.alive=true; this.dead=false; this.deadTimer=0;
    this.deadX=0; this.deadY=0; this.deadVx=0; this.deadVy=0; this.deadAngle=0;
    this.attacking=false; this.crouching=false; this.score=0; this.anim='idle';

    // ── Interpolation snapshot ring buffer ────────────────────────────────────
    // Each entry: { t: serverTimestamp(ms), state: {...} }
    this._snapBuf = [];

    // Track previous anim/action state for triggering SFX
    this._prevAttacking = false;
    this._prevAnim      = 'idle';
  }

  // ── Called when a new server snapshot arrives ─────────────────────────────
  // serverTime: the time the snapshot represents (performance.now()-like, ms)
  pushSnapshot(serverTime, snap) {
    this._snapBuf.push({ t: serverTime, s: snap });
    // Keep buffer bounded
    if (this._snapBuf.length > INTERP_BUFFER_SIZE) this._snapBuf.shift();
    // Keep it sorted by time (usually already sorted)
    if (this._snapBuf.length > 1 &&
        this._snapBuf[this._snapBuf.length-1].t < this._snapBuf[this._snapBuf.length-2].t) {
      this._snapBuf.sort((a,b)=>a.t-b.t);
    }
  }

  // ── Advance interpolation — call every render frame ──────────────────────
  // renderTime: current client time minus INTERP_DELAY
  interpolate(renderTime, audio) {
    const buf = this._snapBuf;
    if (buf.length === 0) return;

    // Dead state: hard-sync from latest snapshot (no interp needed)
    const latest = buf[buf.length-1].s;
    if (latest.dead || !latest.alive) {
      this._applyDeadState(latest, audio);
      this.sprite.update(0);
      return;
    }

    // Find the two snapshots that bracket renderTime
    let before = null, after = null;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= renderTime && buf[i+1].t >= renderTime) {
        before = buf[i]; after = buf[i+1]; break;
      }
    }

    if (before && after) {
      // ── Normal case: interpolate between two bracketing snapshots ──────────
      const span = after.t - before.t;
      const t    = span > 0 ? (renderTime - before.t) / span : 0;
      const a    = Math.max(0, Math.min(1, t));

      this.x           = lerp(before.s.x,           after.s.x,           a);
      this.y           = lerp(before.s.y,            after.s.y,           a);
      this.vx          = lerp(before.s.vx,           after.s.vx,          a);
      this.vy          = lerp(before.s.vy,            after.s.vy,         a);
      this.facingRight = after.s.facingRight;  // use latest direction
      this.grounded    = after.s.grounded;
      this.alive       = true; this.dead = false;
      this._syncAnimState(after.s, audio);

    } else if (buf[0].t > renderTime) {
      // ── render time is before our oldest snapshot: use oldest ──────────────
      this._applySnapState(buf[0].s, audio);

    } else {
      // ── render time is after our newest snapshot: extrapolate briefly ──────
      const newest = buf[buf.length-1];
      const age    = Math.min(renderTime - newest.t, 80); // cap at 80ms
      const steps  = age / 16.67;
      this.x           = newest.s.x + newest.s.vx * steps;
      this.y = Math.min(newest.s.y + newest.s.vy * steps + 0.5 * GRAVITY * steps * steps, FLOOR_Y);
      this.vx          = newest.s.vx;
      this.vy          = newest.s.vy;
      this.facingRight = newest.s.facingRight;
      this.grounded    = this.y >= FLOOR_Y;
      this.alive       = true; this.dead = false;
      this._syncAnimState(newest.s, audio);
    }

    this.sprite.flipX = !this.facingRight;
    this.sprite.update(16.67); // advance anim at nominal 60fps
  }

  _applyDeadState(s, audio) {
    if (this.alive) {
      // Transition to dead — trigger SFX
      if (audio) audio.playDeathImpact();
    }
    this.alive=false; this.dead=true;
    this.deadX=s.deadX; this.deadY=s.deadY;
    this.deadAngle=s.deadAngle; this.deadTimer=s.deadTimer;
    this.score=s.score;
  }

  _applySnapState(snap, audio) {
    this.x=snap.x; this.y=snap.y;
    this.vx=snap.vx; this.vy=snap.vy;
    this.facingRight=snap.facingRight;
    this.grounded=snap.grounded;
    this.alive=snap.alive; this.dead=snap.dead;
    this._syncAnimState(snap, audio);
  }

  // Detect state transitions and trigger appropriate SFX on the remote player
  _syncAnimState(snap, audio) {
    const wasAttacking = this._prevAttacking;
    this.attacking  = snap.attacking;
    this.crouching  = snap.crouching;
    this.score      = snap.score;
    this.anim       = snap.anim;

    // ── AUDIO: fire SFX locally based on remote state transitions ────────────
    // (No audio data is sent over the network — we infer from state changes)
    if (audio) {
      if (!wasAttacking && snap.attacking) {
        // Remote player just started attacking
        audio.playSwordSwing();
        audio.playAttackGrunt();
      }
    }

    this._prevAttacking = snap.attacking;
    this._prevAnim      = snap.anim;

    // Sync sprite
    this.sprite.flipX = !snap.facingRight;
    if (this.sprite.anim !== snap.anim) this.sprite.play(snap.anim);
  }

  update(dt) {
    this.sprite.update(dt);
    if (this.dead) {
      this.deadTimer+=dt;
      this.deadVy+=0.52; this.deadVx*=0.96;
      this.deadX+=this.deadVx; this.deadY+=this.deadVy;
      this.deadAngle+=this.deadVx*0.06;
      if (this.deadY>=FLOOR_Y) { this.deadY=FLOOR_Y; this.deadVy=0; this.deadVx*=0.7; }
    }
  }

  draw(ctx) {
    if (this.dead) {
      const alpha=Math.max(0,1-this.deadTimer/1400);
      if(alpha<=0) return;
      ctx.save();
      ctx.shadowBlur=0; ctx.shadowColor='transparent';
      ctx.translate(this.deadX,this.deadY);
      ctx.rotate(this.deadAngle);
      this.sprite.flipX=!this.facingRight;
      this.sprite.draw(ctx,0,0,alpha);
      ctx.restore();
      return;
    }
    if (!this.alive) return;
    this.sprite.draw(ctx, this.x, this.y);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LocalPhysicsPlayer — used for local/tutorial modes (unchanged logic)
// ─────────────────────────────────────────────────────────────────────────────
class Player {
  constructor(id, x, key) {
    this.id=id; this.key=key; this.sprite=new Sprite(key);
    this.x=x; this.y=FLOOR_Y;
    this.vx=0; this.vy=0;
    this.grounded=true; this.facingRight=(id===1);
    this.sprite.flipX=(id===2);
    this.alive=true; this.dead=false; this.deadTimer=0;
    this.deadX=0; this.deadY=0; this.deadVx=0; this.deadVy=0; this.deadAngle=0;
    this.attacking=false; this.attackTimer=0; this.attackCd=0;
    this.crouching=false; this.score=0; this.anim='idle';
  }
  update(dt) {
    this.sprite.update(dt);
    if(this.dead) {
      this.deadTimer+=dt;
      this.deadVy+=0.52; this.deadVx*=0.96;
      this.deadX+=this.deadVx; this.deadY+=this.deadVy;
      this.deadAngle+=this.deadVx*0.06;
      if(this.deadY>=FLOOR_Y){this.deadY=FLOOR_Y;this.deadVy=0;this.deadVx*=0.7;}
    }
  }
  draw(ctx) {
    if(this.dead){
      const alpha=Math.max(0,1-this.deadTimer/1400);
      if(alpha<=0)return;
      ctx.save(); ctx.shadowBlur=0; ctx.shadowColor='transparent';
      ctx.translate(this.deadX,this.deadY); ctx.rotate(this.deadAngle);
      this.sprite.flipX=!this.facingRight;
      this.sprite.draw(ctx,0,0,alpha); ctx.restore(); return;
    }
    if(!this.alive) return;
    this.sprite.draw(ctx,this.x,this.y);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Particles, Shake, SlowMo, Camera (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
class Particles {
  constructor(){this.p=[];}
  blood(x,y,dir){
    for(let i=0;i<22;i++){
      const a=-Math.PI/2+(Math.random()-.5)*Math.PI+dir*.35, s=4+Math.random()*10;
      this.p.push({x,y,vx:Math.cos(a)*s+dir*3,vy:Math.sin(a)*s-2,
        life:1,decay:.012+Math.random()*.018,r:2+Math.random()*5,
        col:`hsl(${345+Math.random()*18},90%,${26+Math.random()*22}%)`});
    }
  }
  update(){
    this.p=this.p.filter(p=>p.life>0);
    for(const p of this.p){p.x+=p.vx;p.y+=p.vy;p.vy+=.3;p.vx*=.96;p.life-=p.decay;}
  }
  draw(ctx){
    for(const p of this.p){
      ctx.save(); ctx.shadowBlur=0; ctx.shadowColor='transparent';
      ctx.globalAlpha=p.life*p.life; ctx.fillStyle=p.col;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r*p.life,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
  }
  clear(){this.p=[];}
}

class Shake {
  constructor(){this.v=0;}
  hit(n){this.v=Math.max(this.v,n);}
  tick(){this.v*=.84;}
  off(){return this.v<.15?{x:0,y:0}:{x:(Math.random()-.5)*this.v*2,y:(Math.random()-.5)*this.v*1.2};}
}

class SlowMo {
  constructor(){this.t=0;this.on=false;this.dur=600;}
  hit(){this.t=0;this.on=true;}
  tick(raw){
    if(!this.on)return 1; this.t+=raw;
    if(this.t>this.dur){this.on=false;return 1;}
    const p=this.t/this.dur; return p<.25?.14:.14+(1-.14)*((p-.25)/.75);
  }
  get m(){if(!this.on)return 1;const p=this.t/this.dur;return p<.25?.14:.14+(1-.14)*((p-.25)/.75);}
}

class Camera {
  constructor() {
    this.x=WORLD_W/2; this.y=FLOOR_Y-160;
    this.zoom=CAM_ZOOM_MAX; this._tz=CAM_ZOOM_MAX;
    this._tx=this.x; this._ty=this.y;
  }
  update(p1, p2, dt) {
    const mx=(p1.x+p2.x)/2;
    const dist=Math.abs(p2.x-p1.x);
    const t=Math.max(0,Math.min(1,(dist-CAM_DIST_MIN)/(CAM_DIST_MAX-CAM_DIST_MIN)));
    this._tz=CAM_ZOOM_MAX-t*(CAM_ZOOM_MAX-CAM_ZOOM_MIN);
    const s=1-Math.pow(1-CAM_LERP,dt/16.67);
    this.zoom+=(this._tz-this.zoom)*s;
    const halfW=(VW/2)/this.zoom;
    const floorScreenTarget=VH*0.88;
    const idealCamY=FLOOR_Y-(floorScreenTarget-VH/2)/this.zoom;
    let tx=Math.max(halfW,Math.min(WORLD_W-halfW,mx));
    let ty=idealCamY;
    const minY=Math.min(p1.y,p2.y);
    const jumpLead=Math.max(0,FLOOR_Y-minY-60);
    ty-=jumpLead*0.25;
    this._tx=tx; this._ty=ty;
    this.x+=(this._tx-this.x)*s;
    this.y+=(this._ty-this.y)*s;
  }
  apply(ctx) {
    ctx.translate(VW/2,VH/2); ctx.scale(this.zoom,this.zoom);
    ctx.translate(-this.x,-this.y);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD
// ─────────────────────────────────────────────────────────────────────────────
function drawHUD(ctx, p1, p2, round, maxR, state, msg, myPid, debug) {
  const w=VW, h=VH;
  ctx.save(); ctx.shadowBlur=0; ctx.shadowColor='transparent';
  ctx.font='bold 13px "Courier New"'; ctx.textAlign='left';
  ctx.fillStyle='#e63946'; ctx.shadowColor='#e63946'; ctx.shadowBlur=7;
  ctx.fillText('KNIGHT'+(myPid===1?' ◀':''),20,24);
  ctx.shadowBlur=0; ctx.shadowColor='transparent';
  ctx.textAlign='right'; ctx.fillStyle='#4ecdc4'; ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=7;
  ctx.fillText((myPid===2?'▶ ':'')+'THIEF',w-20,24);
  ctx.shadowBlur=0; ctx.shadowColor='transparent';
  ctx.textAlign='center'; ctx.font='bold 12px "Courier New"';
  ctx.fillStyle='rgba(255,255,255,0.5)';
  ctx.fillText(`ROUND ${round} / ${maxR}`,w/2,16);
  const PW=14,PH=10,PG=5,rowW=maxR*(PW+PG)-PG,rx=w/2-rowW/2,ry=22;
  for(let i=0;i<maxR;i++){
    const px=rx+i*(PW+PG);
    ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(px,ry,PW,PH);
    if(i<p1.score){ctx.fillStyle='#e63946';ctx.fillRect(px,ry,PW,PH);}
    else if(i<p2.score){ctx.fillStyle='#4ecdc4';ctx.fillRect(px,ry,PW,PH);}
    ctx.strokeStyle='rgba(255,255,255,0.2)'; ctx.lineWidth=1; ctx.strokeRect(px,ry,PW,PH);
  }
  if(msg&&msg.text&&(state==='round_end'||state==='game_over')){
    const age=msg.age||0, alpha=Math.min(1,age/120);
    ctx.globalAlpha=alpha; ctx.textAlign='center';
    ctx.font='bold 62px "Courier New"'; ctx.shadowBlur=0;
    ctx.strokeStyle='rgba(0,0,0,0.92)'; ctx.lineWidth=12;
    ctx.strokeText(msg.text,w/2,h/2-14);
    ctx.shadowColor=msg.color||'#fff'; ctx.shadowBlur=28;
    ctx.fillStyle=msg.color||'#fff';
    ctx.fillText(msg.text,w/2,h/2-14);
    ctx.shadowBlur=0; ctx.shadowColor='transparent';
    if(msg.sub){
      ctx.font='bold 20px "Courier New"'; ctx.fillStyle='rgba(230,230,230,0.9)';
      ctx.fillText(msg.sub,w/2,h/2+26);
    }
  }

  // ── Debug overlay ─────────────────────────────────────────────────────────
  if (debug && debug.enabled) {
    ctx.globalAlpha=1; ctx.shadowBlur=0;
    ctx.font='10px monospace'; ctx.textAlign='left'; ctx.fillStyle='rgba(0,255,100,0.8)';
    ctx.fillText(`ping: ${debug.ping}ms`,8,h-52);
    ctx.fillText(`interp delay: ${INTERP_DELAY}ms`,8,h-40);
    ctx.fillText(`pending inputs: ${debug.pendingInputs}`,8,h-28);
    ctx.fillText(`pred err: (${debug.predErrX.toFixed(1)}, ${debug.predErrY.toFixed(1)}) px`,8,h-16);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b-a)*t; }

// ─────────────────────────────────────────────────────────────────────────────
// Game
// ─────────────────────────────────────────────────────────────────────────────
export class Game {
  constructor(canvas, opts={}) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.mode   = opts.mode || 'local';
    this.myPid  = opts.myPid || 1;

    this.input = new InputManager(this.mode);
    this.audio = opts.audio || new AudioManager();
    this.fx    = new Particles();
    this.shake = new Shake();
    this.slow  = new SlowMo();
    this.cam   = new Camera();

    this.round   = 1;
    this.state   = (this.mode==='online') ? 'waiting' : 'countdown';
    this.msg     = null;
    this.cdVal   = 3; this.cdMs=0;
    this.roundMs = 0;
    this.hitDone = false;
    this.tutPhase= 0;

    // ── Online-mode players ────────────────────────────────────────────────
    // myPlayer:     LocalPlayer (prediction + reconciliation)
    // remotePlayer: RemotePlayer (interpolation)
    this.myPlayer     = null;
    this.remotePlayer = null;

    // ── Network send state ─────────────────────────────────────────────────
    this._lastInputSentMs = 0;
    this._lastSentInputStr = '';
    this._currentSeq      = 0;

    // ── Debug metrics ──────────────────────────────────────────────────────
    this._debug = {
      enabled: false,   // toggle with backtick key
      ping: 0,
      pendingInputs: 0,
      predErrX: 0,
      predErrY: 0,
      _pingStart: 0,
    };

    // Expose p1/p2 as aliases so HUD code is the same across modes
    this._spawn(0,0);

    this.running  = false;
    this._raf     = null;
    this._tickFn  = this._tick.bind(this);
    this._last    = 0;
    this.ws       = opts.socket || null;

    // Monotonic time used for snapshot timestamps
    this._serverTimeDelta = 0;  // offset: serverTime = clientNow - _serverTimeDelta
    this._clientNow = () => performance.now();
  }

  // ── Spawn / respawn ────────────────────────────────────────────────────────
  _spawn(s1,s2) {
    if (this.mode === 'online') {
      if (this.myPid === 1) {
        this.myPlayer     = new LocalPlayer(1, WORLD_W*0.25, 'knight');
        this.remotePlayer = new RemotePlayer(2, WORLD_W*0.75, 'thief');
        this.remotePlayer.facingRight=false; this.remotePlayer.sprite.flipX=true;
      } else {
        this.myPlayer     = new LocalPlayer(2, WORLD_W*0.75, 'thief');
        this.remotePlayer = new RemotePlayer(1, WORLD_W*0.25, 'knight');
        this.myPlayer.facingRight=false; this.myPlayer.sprite.flipX=true;
      }
      this.myPlayer.score     = this.myPid===1 ? s1 : s2;
      this.remotePlayer.score = this.myPid===1 ? s2 : s1;
      // p1/p2 refs for HUD & camera
      this.p1 = this.myPid===1 ? this.myPlayer : this.remotePlayer;
      this.p2 = this.myPid===2 ? this.myPlayer : this.remotePlayer;
    } else {
      // Local / tutorial — use plain Player objects
      this.p1 = new Player(1, WORLD_W*0.25, 'knight');
      this.p2 = new Player(2, WORLD_W*0.75, 'thief');
      this.p1.score=s1; this.p2.score=s2;
      this.p1.facingRight=true;  this.p1.sprite.flipX=false;
      this.p2.facingRight=false; this.p2.sprite.flipX=true;
    }
    this.cam = new Camera();
  }

  start() {
    this.running = true;
    if (!this.audio.initialized) {
      this.audio.init().then(() => this.audio.startAmbience()).catch(() => {});
    } else {
      this.audio.startAmbience();
    }
    this._last = performance.now();
    this._raf  = requestAnimationFrame(this._tickFn);
    if (this.mode==='online' && this.ws) this._attachWS();

    // Debug toggle
    window.addEventListener('keydown', this._debugKey = (e) => {
      if (e.code === 'Backquote') this._debug.enabled = !this._debug.enabled;
    });
  }

  stop() {
    this.running = false;
    if (this._raf){ cancelAnimationFrame(this._raf); this._raf=null; }
    this.audio.stopAmbience();
    this.input.destroy();
    if (this.ws){ try{this.ws.close();}catch(e){} this.ws=null; }
    if (this._debugKey) window.removeEventListener('keydown', this._debugKey);
  }

  // ── WebSocket attachment ────────────────────────────────────────────────────
  _attachWS() {
    this.ws.onmessage = (e) => {
      try { this._onMsg(JSON.parse(e.data)); } catch(_) {}
    };
    this.ws.onclose = () => {
      if (!this.running) return;
      if (this.state !== 'game_over') {
        this.msg={text:'DISCONNECTED',sub:'connection lost',color:'#ff6b6b',age:0};
        this.state='game_over';
        setTimeout(()=>{ if(this.running) this._exit(); },3000);
      }
    };
    this.ws.onerror = ()=>{};
  }

  // ── Handle server messages ─────────────────────────────────────────────────
  _onMsg(msg) {
    switch (msg.type) {

      case 'state': {
        // ── RECONCILE local player ────────────────────────────────────────────
        const mySnap   = msg.p1.id === this.myPid ? msg.p1 : msg.p2;
        const remSnap  = msg.p1.id === this.myPid ? msg.p2 : msg.p1;

        if (this.myPlayer && mySnap) {
          // Measure prediction error before reconciliation (for debug display)
          this._debug.predErrX = Math.abs(this.myPlayer.x - mySnap.x);
          this._debug.predErrY = Math.abs(this.myPlayer.y - mySnap.y);
          this._debug.pendingInputs = this.myPlayer._pendingInputs.length;

          this.myPlayer.reconcile(mySnap, msg.lastAckedSeq || 0);
        }

        // ── PUSH snapshot to remote player interpolation buffer ───────────────
        if (this.remotePlayer && remSnap) {
          // Use server's reported timestamp if available, else use client's now
          // minus a rough latency estimate.  We tag the snapshot with the time
          // it represents: either msg.serverTime or client now - half ping.
          const snapTime = msg.serverTime != null
            ? msg.serverTime
            : (this._clientNow() - this._debug.ping/2);
          this.remotePlayer.pushSnapshot(snapTime, remSnap);
        }

        // Sync game state flags
        if (msg.state && this.state !== 'round_end' && this.state !== 'game_over')
          this.state = msg.state;
        if ((msg.state==='countdown'||msg.state==='playing') && this.msg && this.state!=='game_over')
          this.msg = null;
        this.round = msg.round || this.round;
        this.cdVal = msg.cdVal != null ? msg.cdVal : this.cdVal;
        this.cdMs  = msg.cdMs  != null ? msg.cdMs  : this.cdMs;
        break;
      }

      case 'kill': {
        const atkIsMe = msg.atk === this.myPid;
        const atk = atkIsMe ? this.myPlayer : this.remotePlayer;
        const def = atkIsMe ? this.remotePlayer : this.myPlayer;
        this.slow.hit(); this.shake.hit(12);
        const dx = def ? def.x : VW/2;
        const dy = def ? def.y : VH/2;
        this.fx.blood(dx, dy, atk ? (atk.facingRight?1:-1) : 1);
        this.audio.playDeathImpact();
        this.msg={text:(msg.atk===1?'KNIGHT':'THIEF')+' WINS',
                  sub:`Round ${this.round}`,
                  color:msg.atk===1?'#e63946':'#4ecdc4',age:0};
        this.state='round_end';
        // Update scores
        if (msg.scores) {
          if (this.p1) this.p1.score = msg.scores[this.p1.id] || 0;
          if (this.p2) this.p2.score = msg.scores[this.p2.id] || 0;
        }
        break;
      }

      case 'new_round': {
        this.round = msg.round || this.round;
        this.fx.clear(); this.shake=new Shake(); this.slow=new SlowMo();
        const s1 = this.p1 ? this.p1.score : 0;
        const s2 = this.p2 ? this.p2.score : 0;
        this._spawn(s1,s2);
        this.msg=null; this.cdVal=3; this.cdMs=0; this.state='countdown';
        break;
      }

      case 'game_over': {
        const gs1=msg.scores[1], gs2=msg.scores[2];
        const text = gs1===gs2?'DRAW!':gs1>gs2?'KNIGHT WINS!':'THIEF WINS!';
        const color= gs1===gs2?'#fff' :gs1>gs2?'#e63946':'#4ecdc4';
        this.msg={text, sub:`${gs1} — ${gs2}`, color, age:0};
        this.state='game_over';
        setTimeout(()=>{ if(this.running) this._exit(); },4000);
        break;
      }

      case 'opponent_left':
        this.msg={text:'OPPONENT LEFT',sub:'returning to menu…',color:'#ff6b6b',age:0};
        this.state='game_over';
        setTimeout(()=>{ if(this.running) this._exit(); },3000);
        break;

      case 'pong':
        // Round-trip ping measurement
        this._debug.ping = Math.round(this._clientNow() - this._debug._pingStart);
        break;
    }
  }

  // ── Send input to server ────────────────────────────────────────────────────
  // Sends current input + sequence number.  Fires on change or on heartbeat.
  _sendInput(seq) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const inp = this.input.p1;
    const now = this._clientNow();
    const str = JSON.stringify(inp);
    const heartbeatDue = (now - this._lastInputSentMs) >= HEARTBEAT_MS;
    if (str === this._lastSentInputStr && !heartbeatDue) return;
    this._lastSentInputStr = str;
    this._lastInputSentMs  = now;
    // Pack: input + sequence number so server can echo lastAckedSeq
    this.ws.send(JSON.stringify({ type:'input', input:inp, seq }));
  }

  // ── Send a ping to measure RTT ─────────────────────────────────────────────
  _sendPing() {
    if (!this.ws || this.ws.readyState !== 1) return;
    this._debug._pingStart = this._clientNow();
    this.ws.send(JSON.stringify({ type:'ping' }));
  }

  // ── Main game loop ─────────────────────────────────────────────────────────
  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tickFn);
    const raw = Math.min(now - this._last, 50); this._last=now;
    const dt  = raw * this.slow.tick(raw);
    this._update(dt, raw, now);
    this._render();
    this.input.flush();
  }

  _update(dt, raw, now) {
    this.shake.tick(); this.fx.update();

    if (this.mode === 'online') {
      this._updateOnline(dt, raw, now);
      return;
    }
    this._updateLocal(dt, raw);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ONLINE UPDATE — prediction + interpolation
  // ─────────────────────────────────────────────────────────────────────────
  _updateOnline(dt, raw, now) {
    if (this.state === 'waiting') return;

    // ── CLIENT-SIDE PREDICTION for local player ─────────────────────────────
    // Apply input immediately — do NOT wait for server response.
    if (this.myPlayer && this.myPlayer.alive && !this.myPlayer.dead) {
      const inp = this.input.p1;

      // Trigger SFX locally (attack start)
      if (inp.attack && this.myPlayer.attackCd <= 0 && !this.myPlayer.attacking) {
        this.audio.playSwordSwing();
        this.audio.playAttackGrunt();
      }

      // Run prediction step and get sequence number
      const seq = this.myPlayer.predictStep(inp, dt);

      // Send to server (may be rate-limited by change-detection + heartbeat)
      if (this.state === 'playing' || this.state === 'countdown') {
        this._sendInput(seq);
      }
    }

    // ── REMOTE PLAYER INTERPOLATION ─────────────────────────────────────────
    // We render the remote player at a point INTERP_DELAY ms in the past
    // so we always have surrounding keyframes for smooth interpolation.
    if (this.remotePlayer) {
      const renderTime = this._clientNow() - INTERP_DELAY;
      this.remotePlayer.interpolate(renderTime, this.audio);
      this.remotePlayer.update(dt);
    }

    // Update local player sprite/lerp
    if (this.myPlayer) this.myPlayer.update(dt);

    if (this.msg) this.msg.age += raw;
    if (this.state === 'round_end' && this.msg && this.msg.age > 2400) this.msg = null;
    if (this.state !== 'waiting') this.cam.update(this.p1, this.p2, raw);

    // Periodic ping (every 2s)
    if (!this._lastPing || now - this._lastPing > 2000) {
      this._lastPing = now;
      this._sendPing();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOCAL / TUTORIAL UPDATE (no changes to existing logic)
  // ─────────────────────────────────────────────────────────────────────────
  _updateLocal(dt, raw) {
    if (this.state==='countdown'){
      this.cdMs+=raw;
      while(this.cdMs>=1000){
        this.cdMs-=1000; this.cdVal--;
        if(this.cdVal<=0){this.state='playing';this.hitDone=false;this.cdVal=0;}
      }
      this._localUpdatePlayers(dt,true);
      this.cam.update(this.p1,this.p2,raw);
      return;
    }
    if(this.state==='playing'){
      this._localUpdatePlayers(dt,false);
      if(!this.hitDone){
        if(this._localHit(this.p1,this.p2)){this._localKill(this.p1,this.p2);this.hitDone=true;}
        else if(this._localHit(this.p2,this.p1)){this._localKill(this.p2,this.p1);this.hitDone=true;}
      }
      this.cam.update(this.p1,this.p2,raw);
    }
    if(this.state==='round_end'){
      this._localUpdatePlayers(dt,true);
      this.roundMs+=raw; if(this.msg)this.msg.age+=raw;
      this.cam.update(this.p1,this.p2,raw);
      if(this.roundMs>=ROUND_DELAY) this._localNextRound();
    }
    if(this.state==='game_over'){
      if(this.msg)this.msg.age+=raw;
      this.cam.update(this.p1,this.p2,raw);
    }
  }

  _localUpdatePlayers(dt, lock) {
    const b={left:false,right:false,jump:false,crouch:false,attack:false};
    this._localPhysics(this.p1, dt, lock?b:this.input.p1);
    if(this.mode==='tutorial') this._aiUpdate(this.p2,dt);
    else this._localPhysics(this.p2, dt, lock?b:this.input.p2);
    this.p1.update(dt); this.p2.update(dt);
  }

  _localPhysics(p, dt, inp) {
    if(p.dead){ p.update(dt); return; }
    if(!p.alive) return;
    p.attackCd=Math.max(0,p.attackCd-dt);
    p.vx=0;
    if(inp.left){p.vx=-MOVE_SPEED;p.facingRight=false;}
    if(inp.right){p.vx=MOVE_SPEED;p.facingRight=true;}
    p.crouching=!!(inp.crouch&&p.grounded);
    if(p.crouching)p.vx=0;
    if(inp.jump&&p.grounded){p.vy=JUMP_VEL;p.grounded=false;}
    if(!p.grounded)p.vy+=GRAVITY;
    p.x+=p.vx;p.y+=p.vy;
    if(p.y>=FLOOR_Y){p.y=FLOOR_Y;p.vy=0;p.grounded=true;}else{p.grounded=false;}
    if(p.x<60)p.x=60; if(p.x>WORLD_W-60)p.x=WORLD_W-60;
    if(inp.attack&&p.attackCd<=0&&!p.attacking){
      p.attacking=true;p.attackTimer=0;p.attackCd=ATTACK_CD;
      p.sprite.play('attack',true);
      this.audio.playSwordSwing();this.audio.playAttackGrunt();
    }
    if(p.attacking){
      p.attackTimer+=dt;
      if(p.attackTimer>=ATTACK_DUR[p.key]){p.attacking=false;p.attackTimer=0;}
    }
    p.sprite.flipX=!p.facingRight;
    if(p.attacking)p.sprite.play('attack');
    else if(p.crouching)p.sprite.play('crouch');
    else if(!p.grounded)p.sprite.play('jump');
    else if(Math.abs(p.vx)>.1)p.sprite.play('run');
    else p.sprite.play('idle');
  }

  _aiUpdate(p, dt) {
    if(!p._aiMs)p._aiMs=0;
    if(!p._aiIn)p._aiIn={left:false,right:false,jump:false,attack:false,crouch:false};
    p._aiMs+=dt;
    if(p._aiMs>=380){
      p._aiMs=0;
      const dx=this.p1.x-p.x,dist=Math.abs(dx);
      p._aiIn={left:false,right:false,jump:false,attack:false,crouch:false};
      if(dist>160){dx>0?(p._aiIn.right=true):(p._aiIn.left=true);}
      else if(dist>70){if(Math.random()<.4)p._aiIn.attack=true;}
      else{if(Math.random()<.6)p._aiIn.attack=true;else dx>0?(p._aiIn.left=true):(p._aiIn.right=true);}
      if(p.grounded&&Math.random()<.08)p._aiIn.jump=true;
    }
    this._localPhysics(p,dt,p._aiIn);
  }

  _localHit(atk, def) {
    if(!atk.attacking||!atk.alive||!def.alive) return false;
    const dir=atk.facingRight?1:-1;
    const hbA=HB[atk.key];
    const tipX=atk.x+dir*(hbA.hw+SWORD_REACH[atk.key]);
    const tipY=atk.y-hbA.hh*0.6+(atk.crouching?hbA.hh*0.35:0);
    const hbD=HB[def.key];
    const yOff=def.crouching?hbD.hh*0.3:0;
    return tipX>=def.x-hbD.hw&&tipX<=def.x+hbD.hw&&
           tipY>=def.y-hbD.hh+yOff&&tipY<=def.y;
  }

  _localKill(atk, def) {
    const dir=atk.facingRight?1:-1;
    this.slow.hit(); this.shake.hit(12);
    this.fx.blood(def.x,def.y,dir);
    def.dead=true;def.alive=false;
    def.deadX=def.x;def.deadY=def.y;
    def.deadVx=dir*5+def.vx*.2;def.deadVy=-7;
    def.deadAngle=0;def.deadTimer=0;
    def.sprite.play('death',true);
    this.audio.playDeathImpact();
    atk.score++;
    this.msg={text:(atk.id===1?'KNIGHT':'THIEF')+' WINS',
              sub:`Round ${this.round}`,
              color:atk.id===1?'#e63946':'#4ecdc4',age:0};
    this.state='round_end';this.roundMs=0;
    if(this.mode==='tutorial')this.tutPhase=Math.min(this.tutPhase+1,2);
  }

  _localNextRound() {
    const s1=this.p1.score,s2=this.p2.score;
    if(s1>=MAJORITY||s2>=MAJORITY||this.round>=MAX_ROUNDS){
      const text=s1===s2?'DRAW!':s1>s2?'KNIGHT WINS!':'THIEF WINS!';
      const color=s1===s2?'#fff':s1>s2?'#e63946':'#4ecdc4';
      this.msg={text,sub:`${s1} — ${s2}`,color,age:0};
      this.state='game_over';
      setTimeout(()=>{if(this.running)this._exit();},4000);
      return;
    }
    this.round++;
    this.fx.clear();this.shake=new Shake();this.slow=new SlowMo();
    this.msg=null;this.roundMs=0;this.cdVal=3;this.cdMs=0;this.hitDone=false;
    this._spawn(s1,s2);this.state='countdown';
  }

  _exit() { this.stop(); window.dispatchEvent(new CustomEvent('game:exit')); }

  // ── Render ─────────────────────────────────────────────────────────────────
  _render() {
    const ctx=this.ctx,vw=VW,vh=VH;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';
    ctx.shadowBlur=0; ctx.shadowColor='transparent';
    ctx.clearRect(0,0,vw,vh);
    ctx.fillStyle='#000'; ctx.fillRect(0,0,vw,vh);

    if(this.state==='waiting'){
      ctx.textAlign='center'; ctx.fillStyle='#4ecdc4';
      ctx.font='bold 22px "Courier New"';
      ctx.fillText('Connected — waiting for opponent…',vw/2,vh/2);
      return;
    }

    ctx.save();
    const shk=this.shake.off();
    ctx.translate(shk.x,shk.y);
    this.cam.apply(ctx);
    ctx.fillStyle='rgba(255,255,255,0.09)';
    ctx.fillRect(0,FLOOR_Y,WORLD_W,3);
    ctx.fillStyle='rgba(0,0,0,0.35)';
    ctx.fillRect(0,FLOOR_Y+3,WORLD_W,8);
    ctx.fillStyle='rgba(78,205,196,0.12)';
    ctx.fillRect(0,0,6,FLOOR_Y+3);
    ctx.fillRect(WORLD_W-6,0,6,FLOOR_Y+3);
    this.fx.draw(ctx);
    this.p1.draw(ctx);
    this.p2.draw(ctx);
    ctx.restore();

    if(this.slow.on){
      ctx.save(); ctx.shadowBlur=0;
      const t=1-this.slow.m;
      const g=ctx.createRadialGradient(vw/2,vh/2,vh*.3,vw/2,vh/2,vh*.9);
      g.addColorStop(0,'transparent'); g.addColorStop(1,`rgba(0,0,0,${t*.5})`);
      ctx.fillStyle=g; ctx.fillRect(0,0,vw,vh);
      ctx.restore();
    }

    if(this.state==='countdown'||(this.state==='playing'&&this.cdVal===0&&this.cdMs<700)){
      const label=this.cdVal>0?String(this.cdVal):'FIGHT!';
      const fade=this.state==='playing'?Math.max(0,1-this.cdMs/500):1;
      ctx.save(); ctx.shadowBlur=0; ctx.globalAlpha=fade; ctx.textAlign='center';
      ctx.font='bold 90px "Courier New"';
      ctx.strokeStyle='rgba(0,0,0,0.92)'; ctx.lineWidth=12;
      ctx.strokeText(label,vw/2,vh/2+22);
      ctx.shadowColor='#4ecdc4'; ctx.shadowBlur=30;
      ctx.fillStyle='#fff'; ctx.fillText(label,vw/2,vh/2+22);
      ctx.restore();
    }

    drawHUD(ctx, this.p1, this.p2, this.round, MAX_ROUNDS,
            this.state, this.msg, this.myPid, this._debug);

    if(this.mode==='tutorial'){
      const lines=['A/D Move  W Jump  S Crouch  J Attack',
                   'Get close and thrust — one hit kills!',
                   'Watch your spacing. First strike wins.'];
      ctx.save(); ctx.shadowBlur=0; ctx.globalAlpha=.85;
      ctx.fillStyle='rgba(0,0,0,0.65)'; ctx.fillRect(vw/2-290,vh-54,580,36);
      ctx.fillStyle='#4ecdc4'; ctx.font='bold 13px "Courier New"'; ctx.textAlign='center';
      ctx.fillText(lines[Math.min(this.tutPhase,lines.length-1)],vw/2,vh-30);
      ctx.restore();
    }

    if(this.state==='game_over'){
      ctx.save(); ctx.shadowBlur=0;
      ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.fillRect(0,0,vw,vh);
      if(this.msg&&this.msg.text){
        ctx.textAlign='center';
        ctx.font='bold 62px "Courier New"';
        ctx.strokeStyle='rgba(0,0,0,0.95)'; ctx.lineWidth=13;
        ctx.strokeText(this.msg.text,vw/2,vh/2-14);
        ctx.shadowColor=this.msg.color||'#fff'; ctx.shadowBlur=28;
        ctx.fillStyle=this.msg.color||'#fff';
        ctx.fillText(this.msg.text,vw/2,vh/2-14);
        ctx.shadowBlur=0;
        if(this.msg.sub){
          ctx.font='bold 20px "Courier New"'; ctx.fillStyle='rgba(230,230,230,0.9)';
          ctx.fillText(this.msg.sub,vw/2,vh/2+26);
        }
        ctx.fillStyle='rgba(150,150,150,0.55)';
        ctx.font='13px "Courier New"';
        ctx.fillText('returning to menu…',vw/2,vh/2+60);
      }
      ctx.restore();
    }
  }
}
