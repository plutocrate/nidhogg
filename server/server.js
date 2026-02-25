// server.js — Authoritative game server
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import * as http from 'http';
import * as fs   from 'fs';
import { WebSocketServer } from 'ws';
import { createHash } from 'crypto';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(__dirname, '../client');
const PORT       = process.env.PORT || 3000;

const MIME = {
  '.html':'text/html', '.js':'application/javascript',
  '.css':'text/css',   '.png':'image/png',
  '.jpg':'image/jpeg', '.wav':'audio/wav',
  '.ico':'image/x-icon','.svg':'image/svg+xml',
};
// ── Cache-busting version hash ────────────────────────────────────────────────
// Hash is computed from the content of all client JS files at startup.
// Whenever any JS file changes (new deploy), the hash changes, forcing browsers
// to fetch fresh copies — even if they cached the old ones.
function computeBuildHash() {
  const jsFiles = ['main.js', 'game.js', 'audio.js', 'input.js'];
  const h = createHash('sha1');
  for (const f of jsFiles) {
    try { h.update(fs.readFileSync(join(CLIENT_DIR, f))); }
    catch (_) {}
  }
  return h.digest('hex').slice(0, 12);
}
const BUILD_HASH = computeBuildHash();
console.log(`[server] build hash: ${BUILD_HASH}`);

// Inject ?v=HASH into main.js script tag so each deploy busts the browser cache.
// index.html itself is served with no-cache so it always reflects the latest hash.
function injectVersion(html) {
  return html
    .replace(
      /(<script[^>]+src="main\.js)(")/,
      `$1?v=${BUILD_HASH}$2`
    );
}

const httpServer = http.createServer((req, res) => {
  // Strip query string (e.g. ?v=abc123) — it exists only for cache-busting
	let urlPath = req.url.split('?')[0];

// remove leading slash ❗❗❗
if (urlPath.startsWith('/')) {
  urlPath = urlPath.slice(1);
}

// default route
if (urlPath === '') {
  urlPath = 'index.html';
}

const filePath = join(CLIENT_DIR, urlPath);
  const ext  = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }

    const headers = { 'Content-Type': mime };

    if (ext === '.html') {
      // HTML: never cache — always re-fetch so the injected hash stays current
      headers['Cache-Control'] = 'no-store';
      data = Buffer.from(injectVersion(data.toString()));
    } else if (ext === '.js') {
      // JS files: revalidate every request (304 if unchanged, full fetch if new deploy)
      // The ?v= query string ensures a brand-new URL on every deploy, so browsers
      // that have an old ?v= URL will always request the new one.
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      // (immutable because the URL itself changes with every deploy via ?v=HASH)
    } else if (ext === '.png' || ext === '.wav') {
      // Static assets (sprites, audio) rarely change — cache aggressively
      headers['Cache-Control'] = 'public, max-age=86400';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }

    res.writeHead(200, headers);
    res.end(data);
  });
});

// ── GAME CONSTANTS — mirror client exactly ────────────────────────────────────
const WORLD_W     = 3200;
const FLOOR_Y     = 460;
const MOVE_SPEED  = 5.5;
const SPRINT_SPEED= 9.5;
const JUMP_VEL    = -19;
const GRAVITY     = 0.72;
const ATTACK_CD      = 480;
const PARRY_DUR      = 650;     // ms parry window active
const PARRY_CD       = 800;     // ms cooldown after parry
const ATTACK_GROW_MS = 350;     // ms to reach full sword reach
const TICK_MS     = 1000 / 60;
const ROUND_DELAY = 2800;
const MAX_ROUNDS  = 5;
const MAJORITY    = 3;

// Hitboxes — calibrated to new 48×48 sprite sheets
// HW/HH are half-widths in world pixels, anchor at feet (y = FLOOR_Y)
const HB = {
  heavy: { hw: 36, hh: 115 },   // HeavyBandit (P1 / knight)
  light: { hw: 32, hh: 110 },   // LightBandit (P2 / thief)
};
// Parry box: forward-facing rectangle that deflects incoming sword tips
const PARRY_HB = {
  heavy: { fw: 85, fh: 63 },
  light: { fw: 78, fh: 60 },
};
// How far sword tip extends beyond body edge
const SWORD_REACH = { heavy: 85, light: 78 };
const ATTACK_DUR  = { heavy: 900, light: 750 };

const BROADCAST_MS = 0;  // broadcast every tick (60 Hz)

// ── Server Player ─────────────────────────────────────────────────────────────
class SPlayer {
  constructor(id, x, char) {
    this.id = id; this.char = char;
    this.x = x; this.y = FLOOR_Y;
    this.vx = 0; this.vy = 0;
    this.grounded = true; this.facingRight = (id === 1);
    this.alive = true; this.dead = false;
    this.deadTimer = 0; this.deadVx = 0; this.deadVy = 0;
    this.deadAngle = 0; this.deadX = 0; this.deadY = 0;
    this.attacking = false; this.attackTimer = 0; this.attackCd = 0;
    this.crouching = false;
    this.parrying  = false; this.parryTimer = 0; this.parryCd = 0;
    this.sprinting = false;
    this.score = 0; this.anim = 'idle';
  }

  swordTip() {
    const dir      = this.facingRight ? 1 : -1;
    const hb       = HB[this.char];
    const growFrac = this.attacking ? Math.min(this.attackTimer / ATTACK_GROW_MS, 1) : 1;
    const curReach = this.attacking ? SWORD_REACH[this.char] * growFrac : SWORD_REACH[this.char];
    return {
      x: this.x + dir * (hb.hw + curReach),
      y: this.y - hb.hh * 0.6 + (this.crouching ? hb.hh * 0.35 : 0),
    };
  }

  bodyBox() {
    const hb   = HB[this.char];
    const yOff = this.crouching ? hb.hh * 0.3 : 0;
    return {
      left: this.x - hb.hw, right: this.x + hb.hw,
      top:  this.y - hb.hh + yOff, bottom: this.y,
    };
  }

  // Parry box: front-side only, from body edge outward by fw. Instant full size.
  parryBox() {
    const hb  = HB[this.char];
    const phb = PARRY_HB[this.char];
    const pLeft  = this.facingRight ? this.x + hb.hw          : this.x - hb.hw - phb.fw;
    const pRight = this.facingRight ? this.x + hb.hw + phb.fw : this.x - hb.hw;
    return {
      left:   pLeft,
      right:  pRight,
      top:    this.y - hb.hh * 0.85,
      bottom: this.y - hb.hh * 0.15,
    };
  }

  kill(hitDir) {
    if (!this.alive) return;
    this.alive = false; this.dead = true; this.deadTimer = 0;
    this.deadX = this.x; this.deadY = this.y;
    this.deadVx = hitDir * 5 + this.vx * 0.2; this.deadVy = -7;
    this.deadAngle = 0; this.anim = 'death';
  }

  update(dt, input) {
    if (this.dead) {
      this.deadTimer += dt;
      this.deadVy += 0.52; this.deadVx *= 0.96;
      this.deadX += this.deadVx; this.deadY += this.deadVy;
      this.deadAngle += this.deadVx * 0.06;
      if (this.deadY >= FLOOR_Y) { this.deadY = FLOOR_Y; this.deadVy = 0; this.deadVx *= 0.7; }
      return;
    }
    if (!this.alive) return;

    this.attackCd  = Math.max(0, this.attackCd  - dt);
    this.parryCd   = Math.max(0, this.parryCd   - dt);
    this.parryTimer= Math.max(0, this.parryTimer - dt);

    // Sprint
    const canSprint = input.sprint && this.grounded && !this.attacking && !this.parrying;
    this.sprinting  = canSprint;
    const speed     = canSprint ? SPRINT_SPEED : MOVE_SPEED;

    this.vx = 0;
    if (input.left)  { this.vx = -speed; this.facingRight = false; }
    if (input.right) { this.vx =  speed; this.facingRight = true;  }

    this.crouching = !!(input.crouch && this.grounded && !this.sprinting);
    if (this.crouching) this.vx = 0;

    // Parry
    if (input.parry && this.grounded && !this.attacking && this.parryCd <= 0 && this.parryTimer <= 0) {
      this.parrying   = true;
      this.parryTimer = PARRY_DUR;
      this.parryCd    = PARRY_CD;
    }
    if (this.parryTimer <= 0) this.parrying = false;

    if (input.jump && this.grounded) { this.vy = JUMP_VEL; this.grounded = false; }
    if (!this.grounded) this.vy += GRAVITY;
    this.x += this.vx;
    this.y += this.vy;

    if (this.y >= FLOOR_Y) { this.y = FLOOR_Y; this.vy = 0; this.grounded = true; }
    else { this.grounded = false; }
    if (this.x < 60) this.x = 60;
    if (this.x > WORLD_W - 60) this.x = WORLD_W - 60;

    // Attack (blocked while parrying)
    if (input.attack && this.attackCd <= 0 && !this.attacking && !this.parrying) {
      this.attacking = true; this.attackTimer = 0; this.attackCd = ATTACK_CD;
    }
    if (this.attacking) {
      this.attackTimer += dt;
      if (this.attackTimer >= ATTACK_DUR[this.char]) { this.attacking = false; this.attackTimer = 0; }
    }

    // Animation state (server-side — synced to client)
    if      (this.attacking)             this.anim = 'attack';
    else if (this.parrying)              this.anim = 'parry';
    else if (this.crouching)             this.anim = 'crouch';
    else if (!this.grounded)             this.anim = 'jump';
    else if (this.sprinting)             this.anim = 'sprint';
    else if (Math.abs(this.vx) > 0.1)   this.anim = 'walk';
    else                                 this.anim = 'idle';
  }

  snapshot() {
    return {
      id: this.id, char: this.char,
      x: this.x, y: this.y, vx: this.vx, vy: this.vy,
      grounded: this.grounded, facingRight: this.facingRight,
      alive: this.alive, dead: this.dead,
      deadX: this.deadX, deadY: this.deadY,
      deadAngle: this.deadAngle, deadTimer: this.deadTimer,
      attacking: this.attacking, attackTimer: this.attackTimer,
      crouching: this.crouching,
      parrying: this.parrying, parryTimer: this.parryTimer,
      sprinting: this.sprinting,
      anim: this.anim, score: this.score,
    };
  }
}

// ── Room ──────────────────────────────────────────────────────────────────────
class Room {
  constructor(code) {
    this.code = code; this.clients = [];
    this.inputs = { 1: blank(), 2: blank() };
    this.p1 = null; this.p2 = null;
    this.state = 'waiting'; this.round = 1;
    this.cdVal = 3; this.cdMs = 0;
    this.roundMs = 0; this.hitDone = false;
    this._timer = null; this._running = false;
    this._lastTick = 0; this._lastBroadcast = 0;
  }

  addClient(ws, pid) {
    this.clients.push({ ws, pid });
    ws.send(pack({ type: 'assign', pid, code: this.code }));
    if (this.clients.length === 2) this._startMatch();
    else ws.send(pack({ type: 'waiting', code: this.code }));
  }

  _startMatch() {
    this.p1 = new SPlayer(1, WORLD_W * 0.25, 'heavy');
    this.p2 = new SPlayer(2, WORLD_W * 0.75, 'light');
    this.p2.facingRight = false;
    this.state = 'countdown'; this.cdVal = 3; this.cdMs = 0;
    this._broadcast({ type: 'start', round: this.round });
    this._running = true;
    this._lastTick = Date.now();
    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  _respawn() {
    const s1 = this.p1.score, s2 = this.p2.score;
    this.p1 = new SPlayer(1, WORLD_W * 0.25, 'heavy'); this.p1.score = s1;
    this.p2 = new SPlayer(2, WORLD_W * 0.75, 'light'); this.p2.score = s2;
    this.p2.facingRight = false;
    this.hitDone = false; this.state = 'countdown'; this.cdVal = 3; this.cdMs = 0;
  }

  receiveInput(pid, input) {
    // Sanitize input — only accept known fields
    this.inputs[pid] = {
      left:   !!input.left,
      right:  !!input.right,
      jump:   !!input.jump,
      crouch: !!input.crouch,
      attack: !!input.attack,
      parry:  !!input.parry,
      sprint: !!input.sprint,
    };
  }

  _tick() {
    if (!this._running) return;
    const now = Date.now();
    const dt  = Math.min(now - this._lastTick, TICK_MS * 3);
    this._lastTick = now;

    if (this.state === 'countdown') {
      this.cdMs += dt;
      while (this.cdMs >= 1000) {
        this.cdMs -= 1000; this.cdVal--;
        if (this.cdVal <= 0) { this.state = 'playing'; this.hitDone = false; this.cdVal = 0; }
      }
      this.p1.update(dt, blank()); this.p2.update(dt, blank());
    } else if (this.state === 'playing') {
      this.p1.update(dt, this.inputs[1]);
      this.p2.update(dt, this.inputs[2]);
      if (!this.hitDone) {
        const r12 = this._checkHit(this.p1, this.p2);
        const r21 = this._checkHit(this.p2, this.p1);
        if      (r12 === 'parried') { this._broadcast({ type: 'parried', by: 2 }); }
        else if (r12)               { this._resolveKill(this.p1, this.p2); }
        else if (r21 === 'parried') { this._broadcast({ type: 'parried', by: 1 }); }
        else if (r21)               { this._resolveKill(this.p2, this.p1); }
      }
    } else if (this.state === 'round_end') {
      this.p1.update(dt, blank()); this.p2.update(dt, blank());
      this.roundMs += dt;
      if (this.roundMs >= ROUND_DELAY) this._nextRound();
    }

    if (now - this._lastBroadcast >= BROADCAST_MS && this.state !== 'game_over') {
      this._lastBroadcast = now;
      this._sendState();
    }
  }

  // Returns: false (miss), true (kill), or 'parried'
  _checkHit(atk, def) {
    if (!atk.attacking || !atk.alive || !def.alive) return false;
    const tip = atk.swordTip();

    // Parry checked FIRST — parry box is front-side only, full size instantly.
    if (def.parrying) {
      const pb = def.parryBox();
      if (tip.x >= pb.left && tip.x <= pb.right &&
          tip.y >= pb.top  && tip.y <= pb.bottom) {
        return 'parried';
      }
    }

    const box = def.bodyBox();
    const bodyHit = tip.x >= box.left && tip.x <= box.right &&
                    tip.y >= box.top  && tip.y <= box.bottom;
    return bodyHit ? true : false;
  }

  _resolveKill(atk, def) {
    const dir = atk.facingRight ? 1 : -1;
    def.kill(dir); atk.score++;
    this.hitDone = true; this.state = 'round_end'; this.roundMs = 0;
    this._broadcast({
      type: 'kill', atk: atk.id, def: def.id,
      scores: { 1: this.p1.score, 2: this.p2.score },
    });
  }

  _nextRound() {
    const s1 = this.p1.score, s2 = this.p2.score;
    if (s1 >= MAJORITY || s2 >= MAJORITY || this.round >= MAX_ROUNDS) {
      this.state = 'game_over';
      this._broadcast({ type: 'game_over', scores: { 1: s1, 2: s2 } });
      this.stop(); return;
    }
    this.round++; this.roundMs = 0;
    this._respawn();
    this._broadcast({ type: 'new_round', round: this.round });
  }

  _sendState() {
    this._broadcast({
      type: 'state', state: this.state, round: this.round,
      cdVal: this.cdVal, cdMs: this.cdMs,
      p1: this.p1.snapshot(), p2: this.p2.snapshot(),
    });
  }

  _broadcast(msg) {
    const s = pack(msg);
    for (const { ws } of this.clients) {
      if (ws.readyState === 1) ws.send(s);
    }
  }

  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  removeClient(ws) {
    this.clients = this.clients.filter(c => c.ws !== ws);
    if (this.clients.length > 0) this._broadcast({ type: 'opponent_left' });
    if (this.clients.length < 2) this.stop();
  }
}

function blank() {
  return { left:false, right:false, jump:false, crouch:false,
           attack:false, parry:false, sprint:false };
}
function pack(o) { return JSON.stringify(o); }
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

const wss  = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
const rooms = new Map();

setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.ping();
}, 20_000);
setInterval(() => {
  for (const [code, room] of rooms)
    if (room.clients.length === 0) { room.stop(); rooms.delete(code); }
}, 300_000);

wss.on('connection', (ws) => {
  let room = null, pid = null;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'create_room') {
        let code; do { code = genCode(); } while (rooms.has(code));
        room = new Room(code); rooms.set(code, room); pid = 1;
        room.addClient(ws, pid); return;
      }
      if (msg.type === 'join_room') {
        const code = (msg.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) { ws.send(pack({ type:'error', msg:'Room not found.' })); return; }
        if (r.clients.length >= 2) { ws.send(pack({ type:'error', msg:'Room is full.' })); return; }
        room = r; pid = 2; room.addClient(ws, pid); return;
      }
      if (!room) return;
      if (msg.type === 'input') room.receiveInput(pid, msg.input);
    } catch (_) {}
  });
  ws.on('close', () => {
    if (!room) return;
    room.removeClient(ws);
    if (room.clients.length === 0) rooms.delete(room.code);
  });
});

httpServer.listen(PORT, () => console.log(`⚔️  Nidhogg Bandit Duel ${PORT}`));
