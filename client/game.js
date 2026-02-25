// game.js
import { InputManager } from './input.js';
import { AudioManager }  from './audio.js';

// ── Constants (must mirror server exactly) ────────────────────────────────────
const WORLD_W        = 3200;
const FLOOR_Y        = 460;
const MOVE_SPEED     = 5.5;
const SPRINT_SPEED   = 9.5;
const JUMP_VEL       = -19;
const GRAVITY        = 0.72;
const ATTACK_CD      = 480;
const PARRY_DUR      = 650;
const PARRY_CD       = 800;
const ATTACK_GROW_MS = 350;
const ROUND_DELAY    = 2800;
const MAX_ROUNDS     = 5;
const MAJORITY       = 3;
const SCALE          = 3;

const VW = 960;
const VH = 540;

const HB       = { heavy: { hw: 36, hh: 115 }, light: { hw: 32, hh: 110 } };
const PARRY_HB = { heavy: { fw: 85, fh: 63  }, light: { fw: 78, fh: 60  } };
const SWORD_REACH = { heavy: 85, light: 78 };
const ATTACK_DUR  = { heavy: 900, light: 750 };

const CAM_LERP     = 0.12;
const CAM_ZOOM_MAX = 1.0;
const CAM_ZOOM_MIN = 0.38;
const CAM_DIST_MIN = 250;
const CAM_DIST_MAX = 1600;

// Opponent interpolation: render remote player this many ms behind.
// At 30Hz broadcast (33ms interval), 40ms gives a safe 7ms buffer
// while halving the previous 80ms visual lag.
const INTERP_DELAY = 40;

// For my own player (host side): do NOT interpolate — apply server corrections
// directly without the snap buffer delay. This is what makes host feel snappy.

// ── Asset preload ─────────────────────────────────────────────────────────────
const IMG_CACHE = {};
function preloadImg(src) {
  if (!IMG_CACHE[src]) { const i = new Image(); i.src = src; IMG_CACHE[src] = i; }
  return IMG_CACHE[src];
}
['assets/HeavyBandit.png', 'assets/LightBandit.png'].forEach(preloadImg);

// ── Sprite sheet definitions ──────────────────────────────────────────────────
// loop:true  → animation wraps at last frame (idle, walk, sprint, parry)
// loop:false → animation plays once and sticks on last frame (attack, death)
const DEFS = {
  heavy: {
    src: 'assets/HeavyBandit.png', fw: 48, fh: 48,
    anims: {
      idle:   { row:0, frames:[0],               fps:4,  loop:true  },
      walk:   { row:0, frames:[0,1,2,3,4,5,6,7], fps:27, loop:true  },
      run:    { row:1, frames:[0,1,2,3,4,5,6,7], fps:13, loop:true  },
      sprint: { row:1, frames:[0,1,2,3,4,5,6,7], fps:18, loop:true  },
      jump:   { row:2, frames:[0],               fps:4,  loop:true  },
      crouch: { row:0, frames:[4],               fps:4,  loop:true  },
      attack: { row:2, frames:[0,1,2,3,4,5,6,7], fps:20, loop:false },
      parry:  { row:0, frames:[0,1,2,3,4,5,6,7], fps:14, loop:true  },
      death:  { row:4, frames:[1,2,3,4],         fps:8,  loop:false },
    },
  },
  light: {
    src: 'assets/LightBandit.png', fw: 48, fh: 48,
    anims: {
      idle:   { row:0, frames:[0],               fps:4,  loop:true  },
      walk:   { row:0, frames:[0,1,2,3,4,5,6,7], fps:27, loop:true  },
      run:    { row:1, frames:[0,1,2,3,4,5,6,7], fps:13, loop:true  },
      sprint: { row:1, frames:[0,1,2,3,4,5,6,7], fps:18, loop:true  },
      jump:   { row:2, frames:[0],               fps:4,  loop:true  },
      crouch: { row:0, frames:[4],               fps:4,  loop:true  },
      attack: { row:2, frames:[0,1,2,3,4,5,6,7], fps:22, loop:false },
      parry:  { row:0, frames:[0,1,2,3,4,5,6,7], fps:14, loop:true  },
      death:  { row:4, frames:[1,2,3,4],         fps:8,  loop:false },
    },
  },
};

// ── Sprite ────────────────────────────────────────────────────────────────────
class Sprite {
  constructor(key) {
    this.def = DEFS[key]; this.img = preloadImg(this.def.src);
    this.anim = 'idle'; this.frame = 0; this.timer = 0;
    this.done = false; this.flipX = false;
  }

  play(name, reset = false) {
    if (this.anim === name && !reset) return;
    this.anim  = name;
    this.frame = 0;
    this.timer = 0;
    this.done  = false;
  }

  update(dt) {
    const a = this.def.anims[this.anim];
    if (!a) return;
    if (this.done && !a.loop) return; // one-shot: hold last frame

    this.timer += dt;
    const dur = 1000 / a.fps;
    while (this.timer >= dur) {
      this.timer -= dur;
      if (this.frame < a.frames.length - 1) {
        this.frame++;
      } else if (a.loop) {
        this.frame = 0; // loop back to start — fixes sprite freeze on walk/sprint
      } else {
        this.done = true; // one-shot finished
        break;
      }
    }
  }

  draw(ctx, x, y, alpha = 1) {
    if (!this.img.complete || !this.img.naturalWidth) return;
    const a = this.def.anims[this.anim]; if (!a) return;
    const fw = this.def.fw, fh = this.def.fh;
    const sx = a.frames[Math.min(this.frame, a.frames.length - 1)] * fw;
    const sy = a.row * fh;
    const dw = fw * SCALE, dh = fh * SCALE;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
    ctx.translate(x, y);
    if (this.flipX) ctx.scale(-1, 1);
    ctx.drawImage(this.img, sx, sy, fw, fh, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }
}

// ── Player ────────────────────────────────────────────────────────────────────
class Player {
  constructor(id, x, key) {
    this.id = id; this.key = key; this.sprite = new Sprite(key);
    this.x = x; this.y = FLOOR_Y;
    this.vx = 0; this.vy = 0;
    this.grounded = true; this.facingRight = (id === 1);
    this.sprite.flipX = (id === 1);
    this.alive = true; this.dead = false; this.deadTimer = 0;
    this.deadX = 0; this.deadY = 0; this.deadVx = 0; this.deadVy = 0; this.deadAngle = 0;
    this.attacking = false; this.attackTimer = 0; this.attackCd = 0;
    this.crouching = false; this.parrying = false; this.parryTimer = 0; this.parryCd = 0;
    this.sprinting = false;
    this.score = 0; this.anim = 'idle';
    // Track previous anim so we only restart walk/sprint when direction changes,
    // not every frame (avoids the jitter of constant frame-0 resets)
    this._prevAnim = 'idle';
  }

  update(dt) {
    this.sprite.update(dt);
    if (this.dead) {
      this.deadTimer += dt;
      this.deadVy += 0.52; this.deadVx *= 0.96;
      this.deadX += this.deadVx; this.deadY += this.deadVy;
      this.deadAngle += this.deadVx * 0.06;
      if (this.deadY >= FLOOR_Y) { this.deadY = FLOOR_Y; this.deadVy = 0; this.deadVx *= 0.7; }
    }
  }

  draw(ctx) {
    if (this.dead) {
      const alpha = Math.max(0, 1 - this.deadTimer / 1400);
      if (alpha <= 0) return;
      ctx.save();
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      ctx.translate(this.deadX, this.deadY);
      ctx.rotate(this.deadAngle);
      this.sprite.flipX = this.facingRight;
      this.sprite.draw(ctx, 0, 0, alpha);
      ctx.restore();
      return;
    }
    if (!this.alive) return;
    this.sprite.draw(ctx, this.x, this.y);
  }

  drawHitboxes(ctx) {
    if (!this.alive || this.dead) return;
    const hb  = HB[this.key];
    const phb = PARRY_HB[this.key];
    const dir = this.facingRight ? 1 : -1;
    ctx.save(); ctx.lineWidth = 1.5;

    ctx.strokeStyle = 'rgba(0,255,80,0.85)';
    ctx.strokeRect(this.x - hb.hw, this.y - hb.hh, hb.hw * 2, hb.hh);

    const sr       = SWORD_REACH[this.key];
    const growFrac = this.attacking ? Math.min(this.attackTimer / ATTACK_GROW_MS, 1) : 1;
    const curReach = this.attacking ? sr * growFrac : sr;
    const tipX = this.x + dir * (hb.hw + curReach);
    const tipY = this.y - hb.hh * 0.6 + (this.crouching ? hb.hh * 0.35 : 0);
    ctx.fillStyle = 'rgba(255,50,50,0.9)';
    ctx.beginPath(); ctx.arc(tipX, tipY, 3, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = 'rgba(255,80,80,0.70)';
    ctx.beginPath(); ctx.moveTo(this.x + dir * hb.hw, tipY); ctx.lineTo(tipX, tipY); ctx.stroke();

    if (this.attacking) {
      const atkW = sr * growFrac;
      const atkH = hb.hh * 0.55;
      const atkX = this.facingRight ? this.x + hb.hw : this.x - hb.hw - atkW;
      const atkY = this.y - hb.hh * 0.6 - atkH * 0.5 + (this.crouching ? hb.hh * 0.35 : 0);
      ctx.strokeStyle = 'rgba(255,160,0,0.90)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(atkX, atkY, atkW, atkH);
      ctx.fillStyle = 'rgba(255,160,0,0.10)'; ctx.fillRect(atkX, atkY, atkW, atkH);
    }

    if (this.parrying) {
      const pLeft  = this.facingRight ? this.x + hb.hw          : this.x - hb.hw - phb.fw;
      const pRight = this.facingRight ? this.x + hb.hw + phb.fw : this.x - hb.hw;
      const pTop   = this.y - hb.hh * 0.85;
      const pBot   = this.y - hb.hh * 0.15;
      ctx.strokeStyle = 'rgba(0,220,255,0.90)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(pLeft, pTop, pRight - pLeft, pBot - pTop);
      ctx.fillStyle = 'rgba(0,220,255,0.07)'; ctx.fillRect(pLeft, pTop, pRight - pLeft, pBot - pTop);
    }
    ctx.restore();
  }
}

// ── Particles ─────────────────────────────────────────────────────────────────
class Particles {
  constructor() { this.p = []; }
  blood(x, y, dir) {
    for (let i = 0; i < 22; i++) {
      const a = -Math.PI / 2 + (Math.random() - .5) * Math.PI + dir * .35;
      const s = 4 + Math.random() * 10;
      this.p.push({
        x, y, vx: Math.cos(a) * s + dir * 3, vy: Math.sin(a) * s - 2,
        life: 1, decay: .012 + Math.random() * .018, r: 2 + Math.random() * 5,
        col: `hsl(${345 + Math.random() * 18},90%,${26 + Math.random() * 22}%)`,
      });
    }
  }
  update() {
    this.p = this.p.filter(p => p.life > 0);
    for (const p of this.p) { p.x += p.vx; p.y += p.vy; p.vy += .3; p.vx *= .96; p.life -= p.decay; }
  }
  draw(ctx) {
    for (const p of this.p) {
      ctx.save(); ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      ctx.globalAlpha = p.life * p.life; ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
  clear() { this.p = []; }
}

class Shake {
  constructor() { this.v = 0; }
  hit(n) { this.v = Math.max(this.v, n); }
  tick() { this.v *= .84; }
  off() { return this.v < .15 ? { x:0, y:0 } : { x:(Math.random()-.5)*this.v*2, y:(Math.random()-.5)*this.v*1.2 }; }
}

class SlowMo {
  constructor() { this.t = 0; this.on = false; this.dur = 600; }
  hit() { this.t = 0; this.on = true; }
  tick(raw) {
    if (!this.on) return 1; this.t += raw;
    if (this.t > this.dur) { this.on = false; return 1; }
    const p = this.t / this.dur; return p < .25 ? .14 : .14 + (1 - .14) * ((p - .25) / .75);
  }
  get m() { if (!this.on) return 1; const p = this.t/this.dur; return p<.25?.14:.14+(1-.14)*((p-.25)/.75); }
}

class Camera {
  constructor() {
    this.x = WORLD_W / 2; this.y = FLOOR_Y - 160;
    this.zoom = CAM_ZOOM_MAX;
    this._tx = this.x; this._ty = this.y; this._tz = CAM_ZOOM_MAX;
  }
  update(p1, p2, dt) {
    const mx   = (p1.x + p2.x) / 2;
    const dist = Math.abs(p2.x - p1.x);
    const t    = Math.max(0, Math.min(1, (dist - CAM_DIST_MIN) / (CAM_DIST_MAX - CAM_DIST_MIN)));
    this._tz   = CAM_ZOOM_MAX - t * (CAM_ZOOM_MAX - CAM_ZOOM_MIN);
    const s    = 1 - Math.pow(1 - CAM_LERP, dt / 16.67);
    this.zoom += (this._tz - this.zoom) * s;
    const halfW    = (VW / 2) / this.zoom;
    const idealCamY = FLOOR_Y - (VH * 0.88 - VH / 2) / this.zoom;
    this._tx = Math.max(halfW, Math.min(WORLD_W - halfW, mx));
    this._ty = idealCamY - Math.max(0, FLOOR_Y - Math.min(p1.y, p2.y) - 60) * 0.25;
    this.x += (this._tx - this.x) * s;
    this.y += (this._ty - this.y) * s;
  }
  apply(ctx) {
    ctx.translate(VW / 2, VH / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function drawHUD(ctx, p1, p2, round, maxR, state, msg, myPid, rtt) {
  const w = VW, h = VH;
  ctx.save(); ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

  ctx.font = 'bold 13px "Courier New"'; ctx.textAlign = 'left';
  ctx.fillStyle = '#e63946'; ctx.shadowColor = '#e63946'; ctx.shadowBlur = 7;
  ctx.fillText('KNIGHT' + (myPid === 1 ? ' ◀' : ''), 20, 24);
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

  ctx.textAlign = 'right'; ctx.fillStyle = '#4ecdc4'; ctx.shadowColor = '#4ecdc4'; ctx.shadowBlur = 7;
  ctx.fillText((myPid === 2 ? '▶ ' : '') + 'THIEF', w - 20, 24);
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

  ctx.textAlign = 'center'; ctx.font = 'bold 12px "Courier New"';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(`ROUND ${round} / ${maxR}`, w / 2, 16);

  if (rtt != null) {
    const col = rtt < 60 ? '#44ff88' : rtt < 120 ? '#ffdd44' : '#ff4444';
    ctx.textAlign = 'right'; ctx.font = '10px "Courier New"';
    ctx.fillStyle = col; ctx.shadowBlur = 0;
    ctx.fillText(`${rtt}ms`, w - 8, h - 8);
  }

  const PW = 14, PH = 10, PG = 5, rowW = maxR * (PW + PG) - PG, rx = w / 2 - rowW / 2, ry = 22;
  for (let i = 0; i < maxR; i++) {
    const px = rx + i * (PW + PG);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(px, ry, PW, PH);
    if (i < p1.score)      { ctx.fillStyle = '#e63946'; ctx.fillRect(px, ry, PW, PH); }
    else if (i < p2.score) { ctx.fillStyle = '#4ecdc4'; ctx.fillRect(px, ry, PW, PH); }
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1; ctx.strokeRect(px, ry, PW, PH);
  }

  if (msg && msg.text && (state === 'round_end' || state === 'game_over')) {
    const age = msg.age || 0, alpha = Math.min(1, age / 120);
    ctx.globalAlpha = alpha; ctx.textAlign = 'center';
    ctx.font = 'bold 62px "Courier New"';
    ctx.strokeStyle = 'rgba(0,0,0,0.92)'; ctx.lineWidth = 12;
    ctx.strokeText(msg.text, w / 2, h / 2 - 14);
    ctx.shadowColor = msg.color || '#fff'; ctx.shadowBlur = 28;
    ctx.fillStyle = msg.color || '#fff'; ctx.fillText(msg.text, w / 2, h / 2 - 14);
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
    if (msg.sub) {
      ctx.font = 'bold 20px "Courier New"';
      ctx.fillStyle = 'rgba(230,230,230,0.9)';
      ctx.fillText(msg.sub, w / 2, h / 2 + 26);
    }
  }
  ctx.restore();
}

// ── Physics — used for CSP + local ───────────────────────────────────────────
// SERVER_DT must match server TICK_MS exactly so CSP replay is deterministic
const SERVER_DT = 1000 / 60;

// animName: which anim to play for this physics state
// Returns the new anim name so callers can decide whether to reset.
function _calcAnim(p) {
  if (p.attacking)           return 'attack';
  if (p.parrying)            return 'parry';
  if (p.crouching)           return 'crouch';
  if (!p.grounded)           return 'jump';
  if (p.sprinting)           return 'sprint';
  if (Math.abs(p.vx) > 0.1) return 'walk';
  return 'idle';
}

function applyPhysics(p, inp, dt, audio) {
  if (p.dead || !p.alive) return;

  const prevGrounded = p.grounded;
  const prevAttacking = p.attacking;
  p.attackCd   = Math.max(0, p.attackCd   - dt);
  p.parryCd    = Math.max(0, p.parryCd    - dt);
  p.parryTimer = Math.max(0, p.parryTimer - dt);

  const canSprint = inp.sprint && p.grounded && !p.attacking && !p.parrying;
  p.sprinting = canSprint;
  const speed = canSprint ? SPRINT_SPEED : MOVE_SPEED;

  const prevFacing = p.facingRight;
  p.vx = 0;
  if (inp.left)  { p.vx = -speed; p.facingRight = false; }
  if (inp.right) { p.vx =  speed; p.facingRight = true;  }

  p.crouching = !!(inp.crouch && p.grounded && !p.sprinting);
  if (p.crouching) p.vx = 0;

  if (inp.parry && p.grounded && !p.attacking && p.parryCd <= 0 && p.parryTimer <= 0) {
    p.parrying = true; p.parryTimer = PARRY_DUR; p.parryCd = PARRY_CD;
    if (audio) audio.playParry();
  }
  if (p.parryTimer <= 0) p.parrying = false;

  if (inp.jump && p.grounded) {
    p.vy = JUMP_VEL; p.grounded = false;
    if (audio) audio.playJump();
  }
  if (!p.grounded) p.vy += GRAVITY;
  p.x += p.vx; p.y += p.vy;

  if (p.y >= FLOOR_Y) {
    p.y = FLOOR_Y; p.vy = 0; p.grounded = true;
    if (!prevGrounded && audio) audio.playLand();
  } else { p.grounded = false; }

  if (p.x < 60) p.x = 60;
  if (p.x > WORLD_W - 60) p.x = WORLD_W - 60;

  const wasAttacking = prevAttacking;
  if (inp.attack && p.attackCd <= 0 && !p.attacking && !p.parrying) {
    p.attacking = true; p.attackTimer = 0; p.attackCd = ATTACK_CD;
    if (audio) { audio.playSwordSwing(); audio.playAttackGrunt(); }
  }
  if (p.attacking) {
    p.attackTimer += dt;
    if (p.attackTimer >= ATTACK_DUR[p.key]) { p.attacking = false; p.attackTimer = 0; }
  }

  // ── Sprite animation ─────────────────────────────────────────────────────
  if (!p.sprite) return;
  p.sprite.flipX = p.facingRight;

  const newAnim = _calcAnim(p);

  if (newAnim === 'attack' && !wasAttacking) {
    // Fresh attack — always reset to frame 0
    p.sprite.play('attack', true);
  } else if ((newAnim === 'walk' || newAnim === 'sprint') && newAnim !== p._prevAnim) {
    // Switched into walk/sprint — restart animation from frame 0 for visual clarity
    p.sprite.play(newAnim, true);
  } else if (newAnim !== p._prevAnim) {
    p.sprite.play(newAnim);
  }
  // If same anim continues, don't call play() — let update() loop it naturally

  p._prevAnim = newAnim;
  if (audio) audio.tickWalk(Math.abs(p.vx) > 0.1, p.grounded, p.sprinting);
}

// ── Opponent snapshot buffer (interpolation) ──────────────────────────────────
// Server broadcasts at 20Hz (~50ms interval). We render 80ms behind the head
// so we always have two frames to lerp between.
class SnapBuffer {
  constructor() { this.buf = []; }

  push(snap) {
    const t = performance.now();
    this.buf.push({ t, snap });
    // Keep 600ms of history
    const cutoff = t - 600;
    while (this.buf.length > 2 && this.buf[0].t < cutoff) this.buf.shift();
  }

  getInterpolated() {
    if (this.buf.length === 0) return null;
    const targetT = performance.now() - INTERP_DELAY;

    // Buffer not full yet — extrapolate backward from oldest snap using velocity
    if (this.buf[0].t >= targetT) {
      const s = this.buf[0].snap;
      const dtSec = Math.max(-0.08, (targetT - this.buf[0].t) / 1000);
      return { ...s, x: s.x + (s.vx || 0) * dtSec * 60, y: s.y + (s.vy || 0) * dtSec * 60 };
    }

    // Find bracket
    let a = this.buf[0], b = this.buf[0];
    for (let i = 1; i < this.buf.length; i++) {
      if (this.buf[i].t <= targetT) a = this.buf[i];
      else { b = this.buf[i]; break; }
    }

    // Past end of buffer — extrapolate forward from newest snap using velocity
    if (a === b) {
      const s = a.snap;
      const dtSec = Math.min(0.08, (targetT - a.t) / 1000);
      return { ...s, x: s.x + (s.vx || 0) * dtSec * 60, y: s.y + (s.vy || 0) * dtSec * 60 };
    }

    const span = b.t - a.t;
    const frac = span > 0 ? Math.min(1, (targetT - a.t) / span) : 0;
    const s = a.snap, e = b.snap;
    return {
      x:           s.x + (e.x - s.x) * frac,
      y:           s.y + (e.y - s.y) * frac,
      deadX:       (s.deadX||0) + ((e.deadX||0) - (s.deadX||0)) * frac,
      deadY:       (s.deadY||0) + ((e.deadY||0) - (s.deadY||0)) * frac,
      deadAngle:   (s.deadAngle||0) + ((e.deadAngle||0) - (s.deadAngle||0)) * frac,
      deadTimer:   e.deadTimer,
      facingRight: frac < 0.5 ? s.facingRight : e.facingRight,
      alive: e.alive, dead: e.dead,
      attacking: e.attacking, attackTimer: e.attackTimer,
      crouching: e.crouching, parrying: e.parrying, parryTimer: e.parryTimer,
      sprinting: e.sprinting, anim: e.anim, score: e.score,
      vx: e.vx, vy: e.vy,
    };
  }
}

// ── GAME ──────────────────────────────────────────────────────────────────────
export class Game {
  constructor(canvas, opts = {}) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.mode     = opts.mode || 'local';
    this.myPid    = opts.myPid || 1;
    this.input    = new InputManager(this.mode);
    this.audio    = opts.audio || new AudioManager();
    this.fx       = new Particles();
    this.shake    = new Shake();
    this.slow     = new SlowMo();
    this.cam      = new Camera();
    this.round    = 1;
    this.state    = this.mode === 'online' ? 'waiting' : 'countdown';
    this.msg      = null;
    this.cdVal    = 3; this.cdMs = 0;
    this.roundMs  = 0; this.hitDone = false;
    this.tutPhase = 0;
    this._showHitboxes = false;
    this._spawn(0, 0);
    this.running  = false;
    this._raf     = null;
    this._tickFn  = this._tick.bind(this);
    this._last    = 0;
    this.ws       = opts.socket || null;
    this.rtt      = null;

    // CSP state
    this._seq       = 0;
    this._inputHist = [];  // { seq, inp }
    this._oppBuf    = new SnapBuffer();
  }

  _spawn(s1, s2) {
    this.p1 = new Player(1, WORLD_W * 0.25, 'heavy');
    this.p2 = new Player(2, WORLD_W * 0.75, 'light');
    this.p1.score = s1; this.p2.score = s2;
    this.p1.facingRight = true;  this.p1.sprite.flipX = true;
    this.p2.facingRight = false; this.p2.sprite.flipX = false;
    this.cam = new Camera();
    this._seq = 0; this._inputHist = []; this._oppBuf = new SnapBuffer();
  }

  start() {
    this.running = true;
    // Ensure audio is unlocked — preloadAll() is idempotent
    if (!this.audio.initialized) {
      this.audio.preloadAll().catch(() => {});
    } else {
      // AudioContext may have auto-suspended (e.g. host waited in lobby with no sound).
      // resume() re-wakes it without rebuilding synths — no latency cost.
      this.audio.resume().catch(() => {});
    }
    this._hitboxKey = (e) => { if (e.code === 'Backslash') this._showHitboxes = !this._showHitboxes; };
    window.addEventListener('keydown', this._hitboxKey);
    this._last = performance.now();
    this._raf  = requestAnimationFrame(this._tickFn);
    if (this.mode === 'online' && this.ws) this._attachWS();
  }

  stop() {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this.audio.stopAmbience();
    this.input.destroy();
    if (this._hitboxKey) window.removeEventListener('keydown', this._hitboxKey);
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  _attachWS() {
    this.ws.onmessage = (e) => { try { this._onMsg(JSON.parse(e.data)); } catch (_) {} };
    this.ws.onclose = () => {
      if (!this.running) return;
      if (this.state !== 'game_over') {
        this.msg = { text: 'DISCONNECTED', sub: 'connection lost', color: '#ff6b6b', age: 0 };
        this.state = 'game_over';
        setTimeout(() => { if (this.running) this._exit(); }, 3000);
      }
    };
    this.ws.onerror = () => {};
  }

  _onMsg(msg) {
    switch (msg.type) {

      case 'ping':
        if (this.ws && this.ws.readyState === 1)
          this.ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
        break;

      case 'rtt':
        this.rtt = msg.rtt;
        break;

      case 'state': {
        // Only advance to a new game-state if it's not a terminal one we already set
        if (msg.state && this.state !== 'round_end' && this.state !== 'game_over')
          this.state = msg.state;
        if ((msg.state === 'countdown' || msg.state === 'playing') && this.msg && this.state !== 'game_over')
          this.msg = null;
        this.round = msg.round || this.round;
        if (msg.cdVal != null) this.cdVal = msg.cdVal;
        if (msg.cdMs  != null) this.cdMs  = msg.cdMs;

        const { me, opp } = msg;

        // ── Opponent: interpolation buffer ────────────────────────────────────
        if (opp) {
          this._oppBuf.push(opp);
          const oppP = this.myPid === 1 ? this.p2 : this.p1;
          if (opp.score != null) oppP.score = opp.score;
        }

        // ── My player: CSP reconciliation ─────────────────────────────────────
        if (me && me.seq != null) {
          const myP = this.myPid === 1 ? this.p1 : this.p2;

          // Dummy sprite proxy — reconciliation must not touch real sprite frames
          const dummySprite = { play(){}, update(){}, flipX: false, anim: 'idle' };
          const recon = {
            x: me.x, y: me.y, vx: me.vx, vy: me.vy,
            grounded: me.grounded, facingRight: me.facingRight,
            alive: me.alive, dead: me.dead,
            attacking: me.attacking, attackTimer: me.attackTimer || 0, attackCd: me.attackCd || 0,
            crouching: me.crouching || false,
            parrying: me.parrying || false, parryTimer: me.parryTimer || 0, parryCd: me.parryCd || 0,
            sprinting: me.sprinting || false, score: me.score,
            key: myP.key, sprite: dummySprite, _prevAnim: 'idle',
          };

          // Discard inputs the server has processed
          this._inputHist = this._inputHist.filter(h => h.seq > me.seq);

          // Replay unacked inputs on top of server state
          for (const h of this._inputHist) {
            applyPhysics(recon, h.inp, SERVER_DT, null);
          }

          // Apply reconciled physics state (never overwrite sprite or visual state)
          myP.x           = recon.x;
          myP.y           = recon.y;
          myP.vx          = recon.vx;
          myP.vy          = recon.vy;
          myP.grounded    = recon.grounded;
          myP.attacking   = recon.attacking;
          myP.attackTimer = recon.attackTimer;
          myP.attackCd    = recon.attackCd;
          myP.parrying    = recon.parrying;
          myP.parryTimer  = recon.parryTimer;
          myP.parryCd     = recon.parryCd;
          myP.crouching   = recon.crouching;
          myP.sprinting   = recon.sprinting;
          myP.facingRight = recon.facingRight;
          // Server-authoritative only:
          myP.score = me.score;
          myP.alive = me.alive;
          myP.dead  = me.dead;
          if (me.dead) {
            myP.deadX = me.deadX; myP.deadY = me.deadY;
            myP.deadAngle = me.deadAngle; myP.deadTimer = me.deadTimer;
          }
        }
        break;
      }

      case 'kill': {
        // Use server-provided kill position for effects — accurate regardless of interpolation lag
        const defX = msg.defX != null ? msg.defX : (msg.def === 1 ? this.p1.x : this.p2.x);
        const defY = msg.defY != null ? msg.defY : FLOOR_Y;
        const atkFacing = (msg.atk === 1 ? this.p1 : this.p2).facingRight;
        this.slow.hit(); this.shake.hit(12);
        this.fx.blood(defX, defY, atkFacing ? 1 : -1);
        this.audio.playDeathImpact();
        this.p1.score = msg.scores[1];
        this.p2.score = msg.scores[2];
        this.msg = {
          text:  (msg.atk === 1 ? 'KNIGHT' : 'THIEF') + ' WINS',
          sub:   `Round ${this.round}`,
          color: msg.atk === 1 ? '#e63946' : '#4ecdc4', age: 0,
        };
        this.state = 'round_end';
        break;
      }

      case 'parried':
        // Only play if we didn't already predict it locally (avoid double-sound from CSP)
        if (!(this.myPid === 2 ? this.p1 : this.p2).parrying) {
          this.audio.playParry();
        }
        break;

      case 'new_round': {
        this.round = msg.round || this.round;
        this.fx.clear(); this.shake = new Shake(); this.slow = new SlowMo();
        const s1 = this.p1.score, s2 = this.p2.score;
        this._spawn(s1, s2);
        this.msg = null; this.cdVal = 3; this.cdMs = 0; this.state = 'countdown';
        break;
      }

      case 'game_over': {
        const gs1 = msg.scores[1], gs2 = msg.scores[2];
        const text  = gs1 === gs2 ? 'DRAW!' : gs1 > gs2 ? 'KNIGHT WINS!' : 'THIEF WINS!';
        const color = gs1 === gs2 ? '#fff'  : gs1 > gs2 ? '#e63946' : '#4ecdc4';
        this.msg = { text, sub: `${gs1} — ${gs2}`, color, age: 0 };
        this.state = 'game_over';
        setTimeout(() => { if (this.running) this._exit(); }, 4000);
        break;
      }

      case 'opponent_left':
        this.msg = { text: 'OPPONENT LEFT', sub: 'returning to menu…', color: '#ff6b6b', age: 0 };
        this.state = 'game_over';
        setTimeout(() => { if (this.running) this._exit(); }, 3000);
        break;
    }
  }

  _sendInput(inp, seq) {
    if (!this.ws || this.ws.readyState !== 1) return;
    // Send every frame — suppressing movement inputs causes seq to skip,
    // which makes reconciliation replay 4–16 stale inputs instead of 1–2.
    // JSON payload is ~80 bytes; at 60Hz this is ~4.8KB/s upstream — negligible.
    this.ws.send(JSON.stringify({ type: 'input', input: { ...inp, seq } }));
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tickFn);
    const raw = Math.min(now - this._last, 50); this._last = now;
    const dt  = raw * this.slow.tick(raw);
    this._update(dt, raw);
    this._render();
    this.input.flush();
  }

  _update(dt, raw) {
    this.shake.tick(); this.fx.update();
    if (this.mode === 'online') { this._updateOnline(dt, raw); return; }
    this._updateLocal(dt, raw);
  }

  // ── ONLINE UPDATE ─────────────────────────────────────────────────────────
  _updateOnline(dt, raw) {
    const myP  = this.myPid === 1 ? this.p1 : this.p2;
    const oppP = this.myPid === 1 ? this.p2 : this.p1;

    if (this.state === 'playing' || this.state === 'countdown') {
      const inpCopy = this.state === 'playing'
        ? { ...this.input.p1 }
        : { left:false, right:false, jump:false, crouch:false, attack:false, parry:false, sprint:false };

      this._seq++;
      this._inputHist.push({ seq: this._seq, inp: inpCopy });
      if (this._inputHist.length > 120) this._inputHist.shift();

      // Client-side prediction: apply locally at fixed SERVER_DT with full audio
      applyPhysics(myP, inpCopy, SERVER_DT, this.audio);
      myP.sprite.update(dt);

      this._sendInput(inpCopy, this._seq);
    }

    // ── Opponent: smooth interpolated rendering ────────────────────────────
    const snap = this._oppBuf.getInterpolated();
    if (snap) {
      const prevAnim    = oppP.sprite.anim;
      const prevAttacking = oppP.attacking;

      oppP.x           = snap.x;
      oppP.y           = snap.y;
      oppP.vx          = snap.vx || 0;
      oppP.vy          = snap.vy || 0;
      oppP.facingRight = snap.facingRight;
      oppP.alive       = snap.alive;
      oppP.dead        = snap.dead;
      oppP.attacking   = snap.attacking;
      oppP.attackTimer = snap.attackTimer || 0;
      oppP.crouching   = snap.crouching;
      oppP.parrying    = snap.parrying;
      oppP.parryTimer  = snap.parryTimer || 0;
      oppP.sprinting   = snap.sprinting;
      if (oppP.dead) {
        oppP.deadX = snap.deadX; oppP.deadY = snap.deadY;
        oppP.deadAngle = snap.deadAngle; oppP.deadTimer = snap.deadTimer;
      }
      oppP.sprite.flipX = oppP.facingRight;

      // Drive opponent sprite from interpolated anim state
      const newAnim = snap.anim || 'idle';
      if (newAnim === 'attack' && !prevAttacking) {
        oppP.sprite.play('attack', true);
      } else if (newAnim !== prevAnim) {
        oppP.sprite.play(newAnim);
      }
    }
    oppP.sprite.update(dt);
    oppP.update(dt);

    if (this.msg) this.msg.age += raw;
    if (this.state === 'round_end' && this.msg && this.msg.age > 2400) this.msg = null;
    if (this.state !== 'waiting') this.cam.update(this.p1, this.p2, raw);
  }

  // ── LOCAL / TUTORIAL UPDATE ───────────────────────────────────────────────
  _updateLocal(dt, raw) {
    if (this.state === 'countdown') {
      this.cdMs += raw;
      while (this.cdMs >= 1000) {
        this.cdMs -= 1000; this.cdVal--;
        if (this.cdVal <= 0) { this.state = 'playing'; this.hitDone = false; this.cdVal = 0; }
      }
      this._localUpdatePlayers(dt, true);
      this.cam.update(this.p1, this.p2, raw); return;
    }
    if (this.state === 'playing') {
      this._localUpdatePlayers(dt, false);
      if (!this.hitDone) {
        const r12 = this._localHit(this.p1, this.p2);
        const r21 = this._localHit(this.p2, this.p1);
        if      (r12 === 'parried') { this.audio.playParry(); this._parryKnockback(this.p1, this.p2); }
        else if (r12)               { this._localKill(this.p1, this.p2); this.hitDone = true; }
        else if (r21 === 'parried') { this.audio.playParry(); this._parryKnockback(this.p2, this.p1); }
        else if (r21)               { this._localKill(this.p2, this.p1); this.hitDone = true; }
      }
      this.cam.update(this.p1, this.p2, raw);
    }
    if (this.state === 'round_end') {
      this._localUpdatePlayers(dt, true);
      this.roundMs += raw; if (this.msg) this.msg.age += raw;
      this.cam.update(this.p1, this.p2, raw);
      if (this.roundMs >= ROUND_DELAY) this._localNextRound();
    }
    if (this.state === 'game_over') {
      if (this.msg) this.msg.age += raw;
      this.cam.update(this.p1, this.p2, raw);
    }
  }

  _localUpdatePlayers(dt, lock) {
    const b = { left:false, right:false, jump:false, crouch:false, attack:false, parry:false, sprint:false };
    applyPhysics(this.p1, lock ? b : this.input.p1, dt, this.audio);
    if (this.mode === 'tutorial') this._aiUpdate(this.p2, dt);
    else applyPhysics(this.p2, lock ? b : this.input.p2, dt, null);
    this.p1.update(dt); this.p2.update(dt);
  }

  _aiUpdate(p, dt) {
    if (!p._aiMs) p._aiMs = 0;
    if (!p._aiIn) p._aiIn = { left:false, right:false, jump:false, attack:false, crouch:false, parry:false, sprint:false };
    p._aiMs += dt;
    if (p._aiMs >= 380) {
      p._aiMs = 0;
      const dx = this.p1.x - p.x, dist = Math.abs(dx);
      p._aiIn = { left:false, right:false, jump:false, attack:false, crouch:false, parry:false, sprint:false };
      if (dist > 160)     { dx > 0 ? (p._aiIn.right = true) : (p._aiIn.left = true); }
      else if (dist > 70) { if (Math.random() < .4) p._aiIn.attack = true; }
      else                { if (Math.random() < .6) p._aiIn.attack = true; else dx > 0 ? (p._aiIn.left = true) : (p._aiIn.right = true); }
      if (p.grounded && Math.random() < .08) p._aiIn.jump = true;
    }
    applyPhysics(p, p._aiIn, dt, null);
  }

  _localHit(atk, def) {
    if (!atk.attacking || !atk.alive || !def.alive) return false;
    const dir  = atk.facingRight ? 1 : -1;
    const hbA  = HB[atk.key];
    const grow = Math.min(atk.attackTimer / ATTACK_GROW_MS, 1);
    const tipX = atk.x + dir * (hbA.hw + SWORD_REACH[atk.key] * grow);
    const tipY = atk.y - hbA.hh * 0.6 + (atk.crouching ? hbA.hh * 0.35 : 0);
    const hbD  = HB[def.key];
    const yOff = def.crouching ? hbD.hh * 0.3 : 0;
    if (def.parrying) {
      const phb    = PARRY_HB[def.key];
      const pLeft  = def.facingRight ? def.x + hbD.hw            : def.x - hbD.hw - phb.fw;
      const pRight = def.facingRight ? def.x + hbD.hw + phb.fw   : def.x - hbD.hw;
      const pTop   = def.y - hbD.hh * 0.85;
      const pBot   = def.y - hbD.hh * 0.15;
      if (tipX >= pLeft && tipX <= pRight && tipY >= pTop && tipY <= pBot) return 'parried';
    }
    return tipX >= def.x - hbD.hw && tipX <= def.x + hbD.hw &&
           tipY >= def.y - hbD.hh + yOff && tipY <= def.y;
  }

  _parryKnockback(atk, def) {
    const pushDir = atk.facingRight ? -1 : 1;
    atk.vx = pushDir * 16; atk.vy = -5;
    atk.grounded = false; atk.attacking = false;
    atk.attackTimer = 0; atk.attackCd = ATTACK_CD;
    this.shake.hit(4);
    const hbD = HB[def.key];
    this._clashSpark(
      def.facingRight ? def.x + hbD.hw + 10 : def.x - hbD.hw - 10,
      def.y - hbD.hh * 0.6
    );
  }

  _clashSpark(x, y) {
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
      const s = 3 + Math.random() * 7;
      this.fx.p.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1,
        life: 1, decay: 0.04 + Math.random() * 0.025,
        r: 1.5 + Math.random() * 2.5,
        col: `hsl(${175 + Math.random() * 30},90%,${60 + Math.random() * 20}%)`,
      });
    }
  }

  _localKill(atk, def) {
    const dir = atk.facingRight ? 1 : -1;
    this.slow.hit(); this.shake.hit(12);
    this.fx.blood(def.x, def.y, dir);
    def.dead = true; def.alive = false;
    def.deadX = def.x; def.deadY = def.y;
    def.deadVx = dir * 5 + def.vx * .2; def.deadVy = -7;
    def.deadAngle = 0; def.deadTimer = 0;
    def.sprite.play('death', true);
    this.audio.playDeathImpact();
    atk.score++;
    this.msg = {
      text:  (atk.id === 1 ? 'KNIGHT' : 'THIEF') + ' WINS',
      sub:   `Round ${this.round}`,
      color: atk.id === 1 ? '#e63946' : '#4ecdc4', age: 0,
    };
    this.state = 'round_end'; this.roundMs = 0;
    if (this.mode === 'tutorial') this.tutPhase = Math.min(this.tutPhase + 1, 2);
  }

  _localNextRound() {
    const s1 = this.p1.score, s2 = this.p2.score;
    if (s1 >= MAJORITY || s2 >= MAJORITY || this.round >= MAX_ROUNDS) {
      const text  = s1 === s2 ? 'DRAW!' : s1 > s2 ? 'KNIGHT WINS!' : 'THIEF WINS!';
      const color = s1 === s2 ? '#fff'  : s1 > s2 ? '#e63946' : '#4ecdc4';
      this.msg = { text, sub: `${s1} — ${s2}`, color, age: 0 };
      this.state = 'game_over';
      setTimeout(() => { if (this.running) this._exit(); }, 4000);
      return;
    }
    this.round++;
    this.fx.clear(); this.shake = new Shake(); this.slow = new SlowMo();
    this.msg = null; this.roundMs = 0; this.cdVal = 3; this.cdMs = 0; this.hitDone = false;
    this._spawn(this.p1.score, this.p2.score); this.state = 'countdown';
  }

  _exit() { this.stop(); window.dispatchEvent(new CustomEvent('game:exit')); }

  // ── Render ────────────────────────────────────────────────────────────────
  _render() {
    const ctx = this.ctx, vw = VW, vh = VH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
    ctx.clearRect(0, 0, vw, vh);
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, vw, vh);

    if (this.state === 'waiting') {
      ctx.textAlign = 'center'; ctx.fillStyle = '#4ecdc4';
      ctx.font = 'bold 22px "Courier New"';
      ctx.fillText('Connected — waiting for opponent…', vw / 2, vh / 2);
      return;
    }

    ctx.save();
    const shk = this.shake.off();
    ctx.translate(shk.x, shk.y);
    this.cam.apply(ctx);

    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fillRect(0, FLOOR_Y, WORLD_W, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, FLOOR_Y + 3, WORLD_W, 8);
    ctx.fillStyle = 'rgba(78,205,196,0.12)';
    ctx.fillRect(0, 0, 6, FLOOR_Y + 3);
    ctx.fillRect(WORLD_W - 6, 0, 6, FLOOR_Y + 3);

    this.fx.draw(ctx);
    this.p1.draw(ctx);
    this.p2.draw(ctx);

    if (this._showHitboxes) {
      this.p1.drawHitboxes(ctx);
      this.p2.drawHitboxes(ctx);
    }
    ctx.restore();

    if (this.slow.on) {
      ctx.save(); ctx.shadowBlur = 0;
      const t = 1 - this.slow.m;
      const g = ctx.createRadialGradient(vw/2, vh/2, vh*.3, vw/2, vh/2, vh*.9);
      g.addColorStop(0, 'transparent'); g.addColorStop(1, `rgba(0,0,0,${t*.5})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
      ctx.restore();
    }

    if (this.state === 'countdown' || (this.state === 'playing' && this.cdVal === 0 && this.cdMs < 700)) {
      const label = this.cdVal > 0 ? String(this.cdVal) : 'FIGHT!';
      const fade  = this.state === 'playing' ? Math.max(0, 1 - this.cdMs / 500) : 1;
      ctx.save();
      ctx.shadowBlur = 0; ctx.globalAlpha = fade; ctx.textAlign = 'center';
      ctx.font = 'bold 90px "Courier New"';
      ctx.strokeStyle = 'rgba(0,0,0,0.92)'; ctx.lineWidth = 12;
      ctx.strokeText(label, vw / 2, vh / 2 + 22);
      ctx.shadowColor = '#4ecdc4'; ctx.shadowBlur = 30;
      ctx.fillStyle = '#fff'; ctx.fillText(label, vw / 2, vh / 2 + 22);
      ctx.restore();
    }

    drawHUD(ctx, this.p1, this.p2, this.round, MAX_ROUNDS, this.state, this.msg, this.myPid,
            this.mode === 'online' ? this.rtt : null);

    if (this.mode === 'tutorial') {
      const lines = [
        'A/D Move  W Jump  S Crouch  J Attack  K Parry  LShift Sprint',
        'Get close and thrust — one hit kills!',
        'Watch your spacing. First strike wins.',
      ];
      ctx.save(); ctx.shadowBlur = 0; ctx.globalAlpha = .85;
      ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(vw/2-340, vh-54, 680, 36);
      ctx.fillStyle = '#4ecdc4'; ctx.font = 'bold 12px "Courier New"'; ctx.textAlign = 'center';
      ctx.fillText(lines[Math.min(this.tutPhase, lines.length-1)], vw/2, vh-30);
      ctx.restore();
    }

    if (this.state === 'game_over') {
      ctx.save(); ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, vw, vh);
      if (this.msg && this.msg.text) {
        ctx.textAlign = 'center';
        ctx.font = 'bold 62px "Courier New"';
        ctx.strokeStyle = 'rgba(0,0,0,0.95)'; ctx.lineWidth = 13;
        ctx.strokeText(this.msg.text, vw/2, vh/2-14);
        ctx.shadowColor = this.msg.color || '#fff'; ctx.shadowBlur = 28;
        ctx.fillStyle = this.msg.color || '#fff';
        ctx.fillText(this.msg.text, vw/2, vh/2-14);
        ctx.shadowBlur = 0;
        if (this.msg.sub) {
          ctx.font = 'bold 20px "Courier New"';
          ctx.fillStyle = 'rgba(230,230,230,0.9)';
          ctx.fillText(this.msg.sub, vw/2, vh/2+26);
        }
        ctx.fillStyle = 'rgba(150,150,150,0.55)';
        ctx.font = '13px "Courier New"';
        ctx.fillText('returning to menu…', vw/2, vh/2+60);
      }
      ctx.restore();
    }

    if (this._showHitboxes) {
      ctx.save(); ctx.shadowBlur = 0;
      ctx.font = '11px "Courier New"'; ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(0,255,80,0.6)';
      ctx.fillText('HITBOXES  [\\] toggle  |  green=body  orange=attack  cyan=parry', vw-12, vh-10);
      ctx.restore();
    }
  }
}
