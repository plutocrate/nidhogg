// audio.js — Deterministic local SFX. Zero BGM. Zero Tone.js. Zero network.
// =============================================================================
// EVERY ROOT CAUSE OF MISSING SFX — AND HOW EACH ONE IS FIXED HERE
// =============================================================================
//
// BUG 1 — AudioContext created lazily inside initAudio()
//   AudioContext was null until the first user gesture. Any sound triggered
//   before that would silently drop (_play returned early on !this._ctx).
//   FIX: AudioContext constructed immediately in constructor(). Browsers permit
//   creating a *suspended* AudioContext at any time without a gesture. We call
//   resume() inside preloadAll() which is always called from a gesture stack.
//
// BUG 2 — _loadSFX() was fire-and-forget, game started immediately after
//   game.js called audio.init() without awaiting it. The game loop could fire
//   playJump() before any WAV was decoded. Buffer lookup returned undefined,
//   _play() silently returned — first jump/attack/parry always missed.
//   FIX: preloadAll() returns a Promise that resolves only after EVERY buffer
//   is fetched AND decoded. main.js awaits this before calling game.start().
//
// BUG 3 — Tone.js loaded from CDN
//   If the CDN was slow or blocked, this._T was null. _buildSynths() never
//   ran. playParry(), playAttackGrunt(), playDeathImpact() all silently dropped.
//   FIX: Zero CDN dependencies. All synths use raw Web Audio API built inside
//   constructor() — always available synchronously before any play call.
//
// BUG 4 — Walk loop state corrupted by onended callback
//   src.onended = () => { this._walkPlaying = false; } — if the node ended
//   for any external reason (tab switch, browser GC quirk), _walkPlaying would
//   flip to false while _walkNode still referenced a dead node. The next
//   _startWalk() attempt would hit an inconsistent state and fail silently.
//   FIX: Walk state is tracked ONLY by our explicit flags set in _startWalk /
//   _stopWalk. No onended is ever registered.
//
// BUG 5 — Wrong filename
//   Previous SFX_FILES referenced _SwordCombat_11.wav but the actual uploaded
//   asset is _SwordCombat_17.wav. Fetch returned 404, buffer was never set,
//   death sound and playSwordHit() silently dropped every time.
//   FIX: Correct filename _17.wav used.
//
// BUG 6 — main.js called game.start() synchronously after audio.init()
//   audio.init() was async but startLocal() and startGame() never awaited it.
//   Even with a gesture having occurred, decoding ~4 MB of WAVs takes 50–300ms
//   — well within the window where the first in-game sound could fire.
//   FIX: main.js awaits sharedAudio.preloadAll() before game.start(). See the
//   companion main.js changes.
//
// DESIGN: Buffer pool
//   Each sound key has N GainNodes pre-wired to master output (built once,
//   reused forever). On every _play() call we create a fresh one-shot
//   AudioBufferSourceNode (cheap — just a pointer to the shared decoded
//   buffer), connect to the next pool slot, start. Supports full simultaneous
//   overlap with zero allocation pressure.
//
// DESIGN: Cache API for persistence
//   After first network fetch, raw Response bytes stored in Cache API.
//   Subsequent page loads serve all WAVs from local cache in <5ms.
//   localStorage cannot be used — it is string-only with a 5 MB total limit,
//   and base64-encoding WAV files would exceed it immediately.
//
// PUBLIC API — identical to previous; game.js needs ZERO changes:
//   await audio.preloadAll()         ← main.js MUST await before game.start()
//   audio.playJump()
//   audio.playLand()
//   audio.playSwordSwing()
//   audio.playAttackGrunt()
//   audio.playDeathImpact()
//   audio.playParry()
//   audio.playSwordHit()
//   audio.tickWalk(moving, grounded, sprinting)
//   audio.startAmbience()            ← no-op, compat stub
//   audio.stopAmbience()             ← no-op, compat stub
//   audio.init() / audio.initAudio() ← no-op, compat stubs
//   audio.initialized                ← boolean, read by game.js
// =============================================================================

// Bump this string whenever any WAV file on disk changes — forces cache refresh
const CACHE_KEY = 'nidhogg-sfx-v3';

// Exact filenames served by the Node.js static file server
const SFX_FILES = {
  walk:    'assets/GRASS_-_Walk_1.wav',
  sprint:  'assets/GRASS_-_Hard_Walk_1.wav',
  preJump: 'assets/GRASS_-_Pre_Jump_5.wav',
  land:    'assets/GRASS_-_Post_Jump_5.wav',
  attack:  'assets/WEAPSwrd_SwordStab_HoveAud_SwordCombat_01.wav',
  death:   'assets/WEAPSwrd_SwordStabCombowRing_HoveAud_SwordCombat_17.wav',
  parry:   'assets/Donk.wav',
};

// Max simultaneous overlapping instances per sound
const POOL = {
  walk:    1,   // single looping instance
  sprint:  1,   // single looping instance
  preJump: 3,
  land:    3,
  attack:  6,   // rapid attack spam must never drop
  death:   2,
  parry:   6,   // rapid parry must never drop
};

// Master volume per key (0–1)
const VOL = {
  walk:    0.55,
  sprint:  0.70,
  preJump: 0.85,
  land:    0.75,
  attack:  0.88,
  death:   0.92,
  parry:   1.00,
};

// =============================================================================
export class AudioManager {
  constructor() {
    // AudioContext constructed immediately — suspended state is allowed by spec.
    // We resume() inside preloadAll() which is called from a gesture handler.
    const AC = window.AudioContext || window.webkitAudioContext;
    this._ctx = AC ? new AC() : null;
    if (!AC) console.error('[audio] Web Audio API not supported in this browser');

    // Master gain — all sounds route through here
    this._master = null;
    if (this._ctx) {
      this._master = this._ctx.createGain();
      this._master.gain.value = 1.0;
      this._master.connect(this._ctx.destination);
    }

    // Decoded AudioBuffers — populated by preloadAll()
    this._buf = {};

    // Pool of pre-connected GainNodes per sound key
    this._pool    = {};  // key → GainNode[]
    this._poolIdx = {};  // key → number (round-robin cursor)

    // Walk/sprint loop — state tracked with explicit flags ONLY
    // onended is NEVER used for state management
    this._walkRef    = null;   // { src: AudioBufferSourceNode, gain: GainNode }
    this._walkActive = false;
    this._walkKey    = null;   // 'walk' | 'sprint'

    // Synthesized sounds — built immediately, zero CDN dependency
    this._grantFn = null;
    this._thudFn  = null;
    if (this._ctx) this._buildSynths();

    // Compat flags / dedup
    this.initialized  = false;
    this._loadPromise = null;
  }

  // ===========================================================================
  // PRELOAD — single mandatory entry point for main.js to await
  // Idempotent: multiple calls return the same Promise
  // ===========================================================================

  preloadAll() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad();
    return this._loadPromise;
  }

  async _doLoad() {
    if (!this._ctx) return; // no Web Audio support — silent mode, don't throw

    // resume() must be called from a user-gesture call stack.
    // preloadAll() is invoked from a keydown/click handler in main.js — valid.
    try { await this._ctx.resume(); } catch (e) {
      console.warn('[audio] context resume failed:', e);
    }

    // Open Cache API bucket — binary-safe, no size constraints
    let cache = null;
    try { cache = await caches.open(CACHE_KEY); } catch (_) {}

    // Load all files in parallel — allSettled ensures one failure can't abort all
    const entries = Object.entries(SFX_FILES);
    const results = await Promise.allSettled(
      entries.map(([key, url]) => this._loadOne(key, url, cache))
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected')
        console.error(`[audio] load failed for "${entries[i][0]}":`, r.reason);
    });

    // Build GainNode pools for every successfully loaded buffer
    this._buildPools();

    this.initialized = true;
    console.log('[audio] ready — buffers:', Object.keys(this._buf).sort().join(', '));
  }

  async _loadOne(key, url, cache) {
    let ab = null;

    // 1. Cache API — instant on repeat visits
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) ab = await hit.arrayBuffer();
      } catch (_) {} // cache miss — fall through to fetch
    }

    // 2. Network fetch — only when not in cache
    if (!ab) {
      const resp = await fetch(url); // throws on network failure
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);

      // Clone before consuming: one copy for cache, one for decode.
      // Calling .arrayBuffer() consumes the body; you cannot call it twice.
      const forCache = resp.clone();
      ab = await resp.arrayBuffer();
      if (cache) cache.put(url, forCache).catch(() => {}); // non-blocking
    }

    // 3. Decode to AudioBuffer
    // slice(0) creates an owned copy — Firefox neuters the source buffer after decode
    this._buf[key] = await this._ctx.decodeAudioData(ab.slice(0));
    // decodeAudioData throws on malformed data — bubbles to allSettled
  }

  // Build GainNode pool slots — called once after all decodes complete
  _buildPools() {
    for (const [key, count] of Object.entries(POOL)) {
      if (!this._buf[key]) continue; // buffer failed to load — skip silently
      const slots = [];
      for (let i = 0; i < count; i++) {
        const g = this._ctx.createGain();
        g.gain.value = VOL[key] ?? 1.0;
        g.connect(this._master);
        slots.push(g);
      }
      this._pool[key]    = slots;
      this._poolIdx[key] = 0;
    }
  }

  // ===========================================================================
  // SYNTHESIZED SOUNDS — pure Web Audio API, no external libraries
  // Built in constructor() so they're always available, even before preloadAll
  // ===========================================================================
  _buildSynths() {
    const ctx = this._ctx;
    const out = this._master; // captured by closure

    // Attack grunt: short low-frequency sine thump
    this._grantFn = () => {
      try {
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const lpf = ctx.createBiquadFilter();
        const env = ctx.createGain();
        lpf.type = 'lowpass';
        lpf.frequency.value = 180;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(100, t);
        osc.frequency.exponentialRampToValueAtTime(30, t + 0.09);
        env.gain.setValueAtTime(0.28, t);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
        osc.connect(lpf); lpf.connect(env); env.connect(out);
        osc.start(t); osc.stop(t + 0.13);
      } catch (_) {}
    };

    // Death thud: heavy low boom fired 80ms after the death WAV stab
    this._thudFn = () => {
      try {
        const t = ctx.currentTime + 0.08;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(60, t);
        osc.frequency.exponentialRampToValueAtTime(18, t + 0.36);
        env.gain.setValueAtTime(0.60, t);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
        osc.connect(env); env.connect(out);
        osc.start(t); osc.stop(t + 0.46);
      } catch (_) {}
    };
  }

  // ===========================================================================
  // CORE PLAYBACK
  // ===========================================================================

  _play(key) {
    if (!this._ctx) return;
    const buf   = this._buf[key];
    const slots = this._pool[key];

    if (!buf)            { console.warn(`[audio] buffer not ready: "${key}"`); return; }
    if (!slots?.length)  { console.warn(`[audio] no pool for: "${key}"`);      return; }

    // Auto-resume if browser suspended context (e.g. tab switch)
    if (this._ctx.state !== 'running') this._ctx.resume().catch(() => {});

    // Round-robin through pool slots
    const idx          = this._poolIdx[key];
    this._poolIdx[key] = (idx + 1) % slots.length;

    try {
      const src  = this._ctx.createBufferSource();
      src.buffer = buf;
      src.connect(slots[idx]);
      src.start(this._ctx.currentTime);
      // src is one-shot — auto-disconnects and GC'd after playback ends
    } catch (err) {
      console.error(`[audio] playback error "${key}":`, err);
    }
  }

  // ===========================================================================
  // PUBLIC SFX API — exact method names called by game.js (no changes needed)
  // ===========================================================================

  playJump()        { this._play('preJump'); }
  playLand()        { this._play('land'); }
  playSwordSwing()  { this._play('attack'); }
  playAttackGrunt() { this._grantFn?.(); }
  playDeathImpact() { this._play('death'); this._thudFn?.(); }
  playParry()       { this._play('parry'); }
  playSwordHit()    { this._play('death'); }

  // ===========================================================================
  // WALK / SPRINT LOOP
  // Called every game frame from _localPhysics() in game.js.
  // State is managed with explicit boolean flags — NEVER with onended.
  // ===========================================================================

  tickWalk(moving, grounded, sprinting = false) {
    if (!this._ctx) return;
    const should = moving && grounded;
    const key    = sprinting ? 'sprint' : 'walk';

    if (!should) {
      if (this._walkActive) this._stopWalk();
      return;
    }
    // Sound type changed mid-loop (walk ↔ sprint) — swap immediately
    if (this._walkActive && this._walkKey !== key) this._stopWalk();
    if (!this._walkActive) this._startWalk(key);
  }

  _startWalk(key) {
    const buf = this._buf[key];
    if (!buf) return; // buffer not loaded — silent but non-crashing

    if (this._ctx.state !== 'running') this._ctx.resume().catch(() => {});

    try {
      // Dedicated GainNode so we can fade this loop out independently of pool
      const gain = this._ctx.createGain();
      gain.gain.value = VOL[key] ?? 0.60;
      gain.connect(this._master);

      const src  = this._ctx.createBufferSource();
      src.buffer = buf;
      src.loop   = true;
      src.connect(gain);
      src.start(this._ctx.currentTime);

      // Set state AFTER successful start() — if start() throws we stay inactive
      this._walkRef    = { src, gain };
      this._walkActive = true;
      this._walkKey    = key;
      // ← no src.onended registration — ever
    } catch (err) {
      console.error('[audio] _startWalk error:', err);
      this._walkRef    = null;
      this._walkActive = false;
    }
  }

  _stopWalk() {
    // Clear state FIRST so re-entrant tickWalk() calls during fade-out
    // don't try to stop again or start a duplicate loop
    const ref        = this._walkRef;
    this._walkRef    = null;
    this._walkActive = false;
    this._walkKey    = null;
    if (!ref) return;

    try {
      const now = this._ctx.currentTime;
      ref.gain.gain.setValueAtTime(ref.gain.gain.value, now);
      ref.gain.gain.linearRampToValueAtTime(0, now + 0.03); // 30ms fade-out
      ref.src.stop(now + 0.04);
    } catch (_) {} // node may already be stopped — ignore
  }

  // ===========================================================================
  // COMPAT STUBS — called by existing game.js / main.js, safely no-op
  // ===========================================================================
  async init()      {}
  async initAudio() {}
  startAmbience()   {}
  stopAmbience()    {}
}
