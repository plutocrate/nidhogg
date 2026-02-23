// server/server.js — Authoritative game server
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { dirname, join, extname } from 'path';
import * as http            from 'http';
import * as fs              from 'fs';
import { WebSocketServer }  from 'ws';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR  = join(__dirname, '../client');
const PORT        = process.env.PORT || 3000;

// ─── STATIC FILE SERVER ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css':  'text/css',  '.png': 'image/png',
  '.jpg':  'image/jpeg','.wav': 'audio/wav',
  '.ico':  'image/x-icon', '.svg': 'image/svg+xml',
};

const httpServer = http.createServer((req, res) => {
  // strip query string
  const urlPath = req.url.split('?')[0];
  const filePath = join(CLIENT_DIR, urlPath === '/' ? 'index.html' : urlPath);
  const ext  = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ─── GAME CONSTANTS (must match client) ─────────────────────────────────────
const W          = 960;
const H          = 540;
const FLOOR_Y    = 458;
const MOVE_SPEED = 4.8;    // px/frame
const JUMP_VEL   = -12.5;
const GRAVITY    = 0.72;
const ATTACK_CD  = 380;    // ms
const TICK_MS    = 1000 / 60;
const ROUND_DELAY= 2800;
const MAX_ROUNDS = 5;
const MAJORITY   = 3;

// ─── SERVER-SIDE PLAYER ──────────────────────────────────────────────────────
class SPlayer {
  constructor(id, x) {
    this.id   = id;
    this.x    = x;
    this.y    = FLOOR_Y;
    this.vx   = 0;
    this.vy   = 0;
    this.grounded    = true;
    this.facingRight = id === 1;
    this.alive       = true;
    this.dead        = false;   // tumbling corpse
    this.deadTimer   = 0;
    this.deadVx      = 0;
    this.deadVy      = 0;
    this.deadAngle   = 0;
    this.deadX       = 0;
    this.deadY       = 0;
    this.attacking   = false;
    this.attackCd    = 0;
    this.crouching   = false;
    this.score       = 0;
    this.anim        = 'idle';
  }

  swordTip() {
    const dir = this.facingRight ? 1 : -1;
    return {
      x: this.x + dir * 48 * 3 * 0.42,
      y: this.y - 10 + (this.crouching ? 14 : 0)
    };
  }

  kill(hitDir) {
    if (!this.alive) return;
    this.alive    = false;
    this.dead     = true;
    this.deadTimer= 0;
    this.deadX    = this.x; this.deadY = this.y;
    this.deadVx   = hitDir * 6 + this.vx * 0.15;
    this.deadVy   = -6;
    this.deadAngle= 0;
    this.anim     = 'death';
  }

  update(dt, input) {
    // tumble
    if (this.dead) {
      this.deadTimer += dt;
      this.deadVy += 0.48; this.deadVx *= 0.97;
      this.deadX  += this.deadVx; this.deadY += this.deadVy;
      this.deadAngle += this.deadVx * 0.065;
      if (this.deadY >= FLOOR_Y + 4) { this.deadY = FLOOR_Y + 4; this.deadVy = 0; this.deadVx *= 0.75; }
      return;
    }
    if (!this.alive) return;

    this.attackCd = Math.max(0, this.attackCd - dt);

    this.vx = 0;
    if (input.left)  { this.vx = -MOVE_SPEED; this.facingRight = false; }
    if (input.right) { this.vx =  MOVE_SPEED; this.facingRight = true; }
    this.crouching = !!(input.crouch && this.grounded);
    if (this.crouching) this.vx = 0;

    if (input.jump && this.grounded) { this.vy = JUMP_VEL; this.grounded = false; }
    if (!this.grounded) this.vy += GRAVITY;

    this.x += this.vx;
    this.y += this.vy;

    if (this.y >= FLOOR_Y) { this.y = FLOOR_Y; this.vy = 0; this.grounded = true; }
    else                   { this.grounded = false; }

    if (this.x < 50)     this.x = 50;
    if (this.x > W - 50) this.x = W - 50;

    // attack trigger
    if (input.attack && this.attackCd <= 0 && !this.attacking) {
      this.attacking = true;
      this.attackCd  = ATTACK_CD;
    }

    // animation
    if (this.attacking)       this.anim = 'attack';
    else if (this.crouching)  this.anim = 'crouch';
    else if (!this.grounded)  this.anim = 'jump';
    else if (Math.abs(this.vx) > 0.1) this.anim = 'run';
    else                      this.anim = 'idle';
  }

  snapshot() {
    return {
      id: this.id, x: this.x, y: this.y, vx: this.vx, vy: this.vy,
      grounded: this.grounded, facingRight: this.facingRight,
      alive: this.alive, dead: this.dead,
      deadX: this.deadX, deadY: this.deadY, deadAngle: this.deadAngle, deadTimer: this.deadTimer,
      attacking: this.attacking, crouching: this.crouching, anim: this.anim, score: this.score,
    };
  }
}

// ─── GAME ROOM ────────────────────────────────────────────────────────────────
class Room {
  constructor(id) {
    this.id      = id;
    this.clients = [];          // [{ws, pid}]
    this.inputs  = { 1: blank(), 2: blank() };
    this.p1      = null;
    this.p2      = null;
    this.state   = 'waiting';   // waiting|countdown|playing|round_end|game_over
    this.round   = 1;
    this.cdVal   = 3;
    this.cdMs    = 0;
    this.roundMs = 0;
    this.hitDone = false;
    this._timer  = null;
    this._lastTick = Date.now();
  }

  addClient(ws, pid) {
    this.clients.push({ ws, pid });
    ws.send(pack({ type:'assign', pid }));
    if (this.clients.length === 2) this._startMatch();
    else ws.send(pack({ type:'waiting' }));
  }

  _startMatch() {
    this.p1 = new SPlayer(1, W * 0.28);
    this.p2 = new SPlayer(2, W * 0.72);
    this.p2.facingRight = false;
    this.state   = 'countdown';
    this.cdVal   = 3; this.cdMs = 0;
    this._broadcast({ type:'start', round:this.round });
    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  _respawn() {
    const s1 = this.p1.score, s2 = this.p2.score;
    this.p1 = new SPlayer(1, W * 0.28); this.p1.score = s1;
    this.p2 = new SPlayer(2, W * 0.72); this.p2.score = s2;
    this.p2.facingRight = false;
    this.hitDone = false;
    this.state   = 'countdown';
    this.cdVal   = 3; this.cdMs = 0;
  }

  receiveInput(pid, input) { this.inputs[pid] = input; }

  _tick() {
    const now = Date.now();
    const dt  = now - this._lastTick;
    this._lastTick = now;

    if (this.state === 'countdown') {
      this.cdMs += dt;
      while (this.cdMs >= 1000) {
        this.cdMs -= 1000; this.cdVal--;
        if (this.cdVal <= 0) { this.state = 'playing'; this.hitDone = false; this.cdVal = 0; }
      }
      this.p1.update(dt, blank());
      this.p2.update(dt, blank());
      this._send_state();
      return;
    }

    if (this.state === 'playing') {
      this.p1.update(dt, this.inputs[1]);
      this.p2.update(dt, this.inputs[2]);

      if (!this.hitDone) {
        if (this._checkHit(this.p1, this.p2)) { this._resolveKill(this.p1, this.p2); }
        else if (this._checkHit(this.p2, this.p1)) { this._resolveKill(this.p2, this.p1); }
      }
      this._send_state();
      return;
    }

    if (this.state === 'round_end') {
      this.p1.update(dt, blank());
      this.p2.update(dt, blank());
      this.roundMs += dt;
      if (this.roundMs >= ROUND_DELAY) this._nextRound();
      this._send_state();
      return;
    }

    if (this.state === 'game_over') {
      this._send_state();
    }
  }

  _checkHit(atk, def) {
    if (!atk.attacking || !atk.alive || !def.alive) return false;
    const tip = atk.swordTip();
    const hw = 26, hh = 30;
    return tip.x >= def.x-hw && tip.x <= def.x+hw &&
           tip.y >= def.y-hh && tip.y <= def.y+hh;
  }

  _resolveKill(atk, def) {
    const dir = atk.facingRight ? 1 : -1;
    def.kill(dir);
    atk.score++;
    this.hitDone = true;
    this.state   = 'round_end';
    this.roundMs = 0;
    // attacking flag needs to persist so animation plays
    setTimeout(() => { atk.attacking = false; }, 400);
    this._broadcast({ type:'kill', atk:atk.id, def:def.id, scores:{1:this.p1.score,2:this.p2.score} });
  }

  _nextRound() {
    const s1 = this.p1.score, s2 = this.p2.score;
    if (s1 >= MAJORITY || s2 >= MAJORITY || this.round >= MAX_ROUNDS) {
      this.state = 'game_over';
      this._broadcast({ type:'game_over', scores:{1:s1,2:s2} });
      return;
    }
    this.round++;
    this.roundMs = 0;
    this._respawn();
    this._broadcast({ type:'new_round', round:this.round });
  }

  _send_state() {
    this._broadcast({
      type: 'state',
      state: this.state,
      round: this.round,
      cdVal: this.cdVal,
      cdMs:  this.cdMs,
      p1: this.p1.snapshot(),
      p2: this.p2.snapshot(),
    });
  }

  _broadcast(msg) {
    const s = pack(msg);
    for (const { ws } of this.clients) {
      if (ws.readyState === 1) ws.send(s);
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  removeClient(ws) {
    this.clients = this.clients.filter(c => c.ws !== ws);
    if (this.clients.length < 2) {
      this._broadcast({ type:'opponent_left' });
    }
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function blank() { return { left:false,right:false,jump:false,crouch:false,attack:false }; }
function pack(o) { return JSON.stringify(o); }

// ─── WEBSOCKET MATCHMAKING ───────────────────────────────────────────────────
const wss     = new WebSocketServer({ server: httpServer });
const rooms   = new Map();
let   waiting = null;   // room waiting for second player

wss.on('connection', (ws) => {
  let room = null;
  let pid  = null;

  if (!waiting) {
    room    = new Room(Date.now());
    rooms.set(room.id, room);
    waiting = room;
    pid     = 1;
  } else {
    room    = waiting;
    waiting = null;
    pid     = 2;
  }

  room.addClient(ws, pid);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') room.receiveInput(pid, msg.input);
    } catch (_) {}
  });

  ws.on('close', () => {
    room.removeClient(ws);
    room.stop();
    rooms.delete(room.id);
    if (waiting === room) waiting = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🗡️  Nidhogg Grotto Duel`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Open in two browser tabs to play\n`);
});
