// server.js — Authoritative game server
// Physics: 60Hz fixed tick
// State broadcast: 20Hz (every 3rd tick) — prevents flooding the WS queue
// Kill/parried events: sent immediately, outside the state broadcast cadence

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

function computeBuildHash() {
  const jsFiles = ['main.js', 'game.js', 'audio.js', 'input.js'];
  const h = createHash('sha1');
  for (const f of jsFiles) {
    try { h.update(fs.readFileSync(join(CLIENT_DIR, f))); } catch (_) {}
  }
  return h.digest('hex').slice(0, 12);
}
const BUILD_HASH = computeBuildHash();
console.log(`[server] build hash: ${BUILD_HASH}`);

function injectVersion(html) {
  return html.replace(/(<script[^>]+src="main\.js)(")/, `$1?v=${BUILD_HASH}$2`);
}

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/')) urlPath = urlPath.slice(1);
  if (urlPath === '') urlPath = 'index.html';
  const filePath = join(CLIENT_DIR, urlPath);
  const ext  = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Content-Type': mime };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-store';
      data = Buffer.from(injectVersion(data.toString()));
    } else if (ext === '.js') {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (ext === '.png' || ext === '.wav') {
      headers['Cache-Control'] = 'public, max-age=86400';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ── GAME CONSTANTS — must mirror client exactly ────────────────────────────────
const WORLD_W        = 3200;
const FLOOR_Y        = 460;
const SPRINT_SPEED   = 9.5;
const JUMP_VEL       = -19;
const GRAVITY        = 0.72;
const ATTACK_CD      = 480;
const PARRY_DUR      = 650;
const PARRY_CD       = 800;
const ATTACK_GROW_MS = 350;
const TICK_MS        = 1000 / 60;   // ~16.67ms physics
const BROADCAST_EVERY = 2;          // send state every N ticks = 30Hz
const ROUND_DELAY    = 2800;
const MAX_ROUNDS     = 5;
const MAJORITY       = 3;

const HB          = { heavy: { hw: 36, hh: 115 }, light: { hw: 32, hh: 110 } };
const PARRY_HB    = { heavy: { fw: 85, fh: 63  }, light: { fw: 78, fh: 60  } };
const SWORD_REACH = { heavy: 85, light: 78 };
const ATTACK_DUR  = { heavy: 900, light: 750 };

// ── Server Player ──────────────────────────────────────────────────────────────
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
    this.lastSeq = 0;
    // Held input state (continuous keys)
    this._held = blank();
    // Rising-edge queue for one-shot actions
    this._edges = [];
  }

  queueInput(input) {
    const prev = this._held;
    this._held = {
      left:   !!input.left,
      right:  !!input.right,
      jump:   !!input.jump,
      crouch: !!input.crouch,
      attack: !!input.attack,
      parry:  !!input.parry,
      sprint: !!input.sprint,
    };
    if (input.attack && !prev.attack && !this._edges.includes('attack')) this._edges.push('attack');
    if (input.jump   && !prev.jump   && !this._edges.includes('jump'))   this._edges.push('jump');
    if (input.parry  && !prev.parry  && !this._edges.includes('parry'))  this._edges.push('parry');
    if (input.seq != null) this.lastSeq = input.seq;
  }

  consumeInput() {
    const inp = { ...this._held };
    if (this._edges.includes('attack')) inp.attack = true;
    if (this._edges.includes('jump'))   inp.jump   = true;
    if (this._edges.includes('parry'))  inp.parry  = true;
    this._edges = [];
    return inp;
  }

  swordTip() {
    const dir  = this.facingRight ? 1 : -1;
    const hb   = HB[this.char];
    const grow = this.attacking ? Math.min(this.attackTimer / ATTACK_GROW_MS, 1) : 1;
    return {
      x: this.x + dir * (hb.hw + SWORD_REACH[this.char] * grow),
      y: this.y - hb.hh * 0.6 + (this.crouching ? hb.hh * 0.35 : 0),
    };
  }

  bodyBox() {
    const hb = HB[this.char], yOff = this.crouching ? hb.hh * 0.3 : 0;
    return { left: this.x - hb.hw, right: this.x + hb.hw, top: this.y - hb.hh + yOff, bottom: this.y };
  }

  parryBox() {
    const hb = HB[this.char], phb = PARRY_HB[this.char];
    return {
      left:   this.facingRight ? this.x + hb.hw          : this.x - hb.hw - phb.fw,
      right:  this.facingRight ? this.x + hb.hw + phb.fw : this.x - hb.hw,
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

  update(dt, inp) {
    if (this.dead) {
      this.deadTimer += dt; this.deadVy += 0.52; this.deadVx *= 0.96;
      this.deadX += this.deadVx; this.deadY += this.deadVy;
      this.deadAngle += this.deadVx * 0.06;
      if (this.deadY >= FLOOR_Y) { this.deadY = FLOOR_Y; this.deadVy = 0; this.deadVx *= 0.7; }
      return;
    }
    if (!this.alive) return;

    this.attackCd   = Math.max(0, this.attackCd   - dt);
    this.parryCd    = Math.max(0, this.parryCd    - dt);
    this.parryTimer = Math.max(0, this.parryTimer - dt);

    // Always sprint — no shift key required
    this.sprinting = !this.attacking && !this.parrying;
    const speed = SPRINT_SPEED;
    this.vx = 0;
    if (inp.left)  { this.vx = -speed; this.facingRight = false; }
    if (inp.right) { this.vx =  speed; this.facingRight = true;  }

    this.crouching = !!(inp.crouch && this.grounded);
    if (this.crouching) this.vx = 0;

    if (inp.parry && !this.attacking && this.parryCd <= 0 && this.parryTimer <= 0) {
      this.parrying = true; this.parryTimer = PARRY_DUR; this.parryCd = PARRY_CD;
    }
    if (this.parryTimer <= 0) this.parrying = false;

    if (inp.jump && this.grounded) { this.vy = JUMP_VEL; this.grounded = false; }
    if (!this.grounded) this.vy += GRAVITY;
    this.x += this.vx; this.y += this.vy;

    if (this.y >= FLOOR_Y) { this.y = FLOOR_Y; this.vy = 0; this.grounded = true; }
    else { this.grounded = false; }
    if (this.x < 60) this.x = 60;
    if (this.x > WORLD_W - 60) this.x = WORLD_W - 60;

    if (inp.attack && this.attackCd <= 0 && !this.attacking && !this.parrying) {
      this.attacking = true; this.attackTimer = 0; this.attackCd = ATTACK_CD;
    }
    if (this.attacking) {
      this.attackTimer += dt;
      if (this.attackTimer >= ATTACK_DUR[this.char]) { this.attacking = false; this.attackTimer = 0; }
    }

    if      (this.attacking)           this.anim = 'attack';
    else if (this.parrying)            this.anim = 'parry';
    else if (this.crouching)           this.anim = 'crouch';
    else if (!this.grounded)           this.anim = 'jump';
    else if (Math.abs(this.vx) > 0.1) this.anim = 'sprint';
    else                               this.anim = 'idle';
  }

  snapshot() {
    return {
      x: this.x, y: this.y, vx: this.vx, vy: this.vy,
      grounded: this.grounded, facingRight: this.facingRight,
      alive: this.alive, dead: this.dead,
      deadX: this.deadX, deadY: this.deadY, deadAngle: this.deadAngle, deadTimer: this.deadTimer,
      attacking: this.attacking, attackTimer: this.attackTimer, attackCd: this.attackCd,
      crouching: this.crouching,
      parrying: this.parrying, parryTimer: this.parryTimer, parryCd: this.parryCd,
      sprinting: this.sprinting, anim: this.anim, score: this.score,
      seq: this.lastSeq,
    };
  }
}

// ── Room ───────────────────────────────────────────────────────────────────────
class Room {
  constructor(code) {
    this.code = code; this.clients = [];
    this.p1 = null; this.p2 = null;
    this.state = 'waiting'; this.round = 1;
    this.cdVal = 3; this.cdMs = 0; this.roundMs = 0; this.hitDone = false;
    this._interval = null; this._timeout = null; this._running = false;
    this._lastTick = 0; this._acc = 0; this._tickCount = 0;
  }

  addClient(ws, pid) {
    this.clients.push({ ws, pid, rtt: 0, _pingTs: 0 });
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
    this._lastTick = Date.now(); this._acc = 0; this._tickCount = 0;
    // Use self-scheduling setTimeout instead of setInterval to prevent
    // the 40ms/sec drift caused by Math.floor(16.67) = 16ms interval
    this._scheduleNext();
  }

  _scheduleNext() {
    if (!this._running) return;
    const now = Date.now();
    const elapsed = now - this._lastTick;
    const delay = Math.max(0, TICK_MS - (elapsed % TICK_MS));
    this._timeout = setTimeout(() => this._loop(), delay);
  }

  _loop() {
    if (!this._running) return;
    const now = Date.now();
    const elapsed = Math.min(now - this._lastTick, TICK_MS * 4);
    this._lastTick = now;
    this._acc += elapsed;
    let steps = 0;
    while (this._acc >= TICK_MS && steps < 4) {
      this._tick(TICK_MS);
      this._acc -= TICK_MS;
      steps++;
    }
    // Prevent accumulator runaway — if more than 1 tick behind, reset
    if (this._acc > TICK_MS) this._acc = 0;
    this._scheduleNext();
  }

  _respawn() {
    const s1 = this.p1.score, s2 = this.p2.score;
    this.p1 = new SPlayer(1, WORLD_W * 0.25, 'heavy'); this.p1.score = s1;
    this.p2 = new SPlayer(2, WORLD_W * 0.75, 'light'); this.p2.score = s2;
    this.p2.facingRight = false;
    this.hitDone = false; this.state = 'countdown'; this.cdVal = 3; this.cdMs = 0;
  }

  receiveInput(pid, input) {
    const p = pid === 1 ? this.p1 : this.p2;
    if (p) p.queueInput(input);
  }

  _tick(dt) {
    if (!this._running) return;
    this._tickCount++;

    if (this.state === 'countdown') {
      this.cdMs += dt;
      while (this.cdMs >= 1000) {
        this.cdMs -= 1000; this.cdVal--;
        if (this.cdVal <= 0) { this.state = 'playing'; this.hitDone = false; this.cdVal = 0; }
      }
      if (this.p1) { this.p1.consumeInput(); this.p1.update(dt, blank()); }
      if (this.p2) { this.p2.consumeInput(); this.p2.update(dt, blank()); }

    } else if (this.state === 'playing') {
      const i1 = this.p1 ? this.p1.consumeInput() : blank();
      const i2 = this.p2 ? this.p2.consumeInput() : blank();
      if (this.p1) this.p1.update(dt, i1);
      if (this.p2) this.p2.update(dt, i2);
      if (!this.hitDone) {
        const r12 = this._checkHit(this.p1, this.p2);
        const r21 = this._checkHit(this.p2, this.p1);
        if (r12 === 'parried') {
          // Send parry immediately — don't wait for broadcast cadence
          this._broadcast({ type: 'parried', by: 2 });
        } else if (r12) {
          this._resolveKill(this.p1, this.p2);
          return; // state changed, skip normal broadcast this tick
        } else if (r21 === 'parried') {
          this._broadcast({ type: 'parried', by: 1 });
        } else if (r21) {
          this._resolveKill(this.p2, this.p1);
          return;
        }
      }

    } else if (this.state === 'round_end') {
      if (this.p1) { this.p1.consumeInput(); this.p1.update(dt, blank()); }
      if (this.p2) { this.p2.consumeInput(); this.p2.update(dt, blank()); }
      this.roundMs += dt;
      if (this.roundMs >= ROUND_DELAY) { this._nextRound(); return; }
    }

    // Throttled state broadcast: every BROADCAST_EVERY ticks (~20Hz)
    // This is the key fix for host lag — 20Hz × 2 msgs vs 60Hz × 2 msgs
    if (this._tickCount % BROADCAST_EVERY === 0 && this.state !== 'game_over') {
      this._sendState();
    }
  }

  _checkHit(atk, def) {
    if (!atk || !def || !atk.attacking || !atk.alive || !def.alive) return false;
    const tip = atk.swordTip();
    if (def.parrying) {
      const pb = def.parryBox();
      if (tip.x >= pb.left && tip.x <= pb.right && tip.y >= pb.top && tip.y <= pb.bottom) return 'parried';
    }
    const box = def.bodyBox();
    return tip.x >= box.left && tip.x <= box.right && tip.y >= box.top && tip.y <= box.bottom;
  }

  _resolveKill(atk, def) {
    const dir = atk.facingRight ? 1 : -1;
    def.kill(dir); atk.score++;
    this.hitDone = true; this.state = 'round_end'; this.roundMs = 0;
    // Send kill immediately — critical event, not throttled
    this._broadcast({ type: 'kill', atk: atk.id, def: def.id,
      scores: { 1: this.p1.score, 2: this.p2.score },
      // Include positions so client can place effects accurately
      defX: def.deadX, defY: def.deadY,
    });
    // Also send a state update immediately after kill so clients sync fast
    this._sendState();
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
    if (!this.p1 || !this.p2) return;
    const p1s = this.p1.snapshot();
    const p2s = this.p2.snapshot();
    const base = { type: 'state', state: this.state, round: this.round, cdVal: this.cdVal, cdMs: this.cdMs };
    for (const c of this.clients) {
      if (c.ws.readyState !== 1) continue;
      c.ws.send(pack({ ...base, me: c.pid === 1 ? p1s : p2s, opp: c.pid === 1 ? p2s : p1s }));
    }
  }

  _broadcast(msg) {
    const s = pack(msg);
    for (const { ws } of this.clients) if (ws.readyState === 1) ws.send(s);
  }

  sendPing(pid) {
    const c = this.clients.find(x => x.pid === pid);
    if (!c || c.ws.readyState !== 1) return;
    c._pingTs = Date.now();
    c.ws.send(pack({ type: 'ping', ts: c._pingTs }));
  }

  receivePong(pid) {
    const c = this.clients.find(x => x.pid === pid);
    if (!c || !c._pingTs) return;
    c.rtt = Date.now() - c._pingTs;
    c._pingTs = 0;
    if (c.ws.readyState === 1) c.ws.send(pack({ type: 'rtt', rtt: c.rtt }));
  }

  stop() {
    this._running = false;
    if (this._timeout)  { clearTimeout(this._timeout);   this._timeout  = null; }
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  removeClient(ws) {
    this.clients = this.clients.filter(c => c.ws !== ws);
    if (this.clients.length > 0) this._broadcast({ type: 'opponent_left' });
    if (this.clients.length < 2) this.stop();
  }
}

function blank() {
  return { left:false, right:false, jump:false, crouch:false, attack:false, parry:false };
}
function pack(o) { return JSON.stringify(o); }
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

const wss   = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
const rooms = new Map();

setInterval(() => {
  for (const room of rooms.values())
    for (const { pid } of room.clients)
      room.sendPing(pid);
}, 2000);

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
        if (!r) { ws.send(pack({ type: 'error', msg: 'Room not found.' })); return; }
        if (r.clients.length >= 2) { ws.send(pack({ type: 'error', msg: 'Room is full.' })); return; }
        room = r; pid = 2; room.addClient(ws, pid); return;
      }

      if (!room) return;
      if (msg.type === 'input')  { room.receiveInput(pid, msg.input); return; }
      if (msg.type === 'pong')   { room.receivePong(pid); return; }

    } catch (_) {}
  });

  ws.on('close', () => {
    if (!room) return;
    room.removeClient(ws);
    if (room.clients.length === 0) rooms.delete(room.code);
  });

  ws.on('error', () => {});
});

httpServer.listen(PORT, () => console.log(`⚔️  Nidhogg Grotto Duel :${PORT}`));
