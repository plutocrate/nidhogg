// audio.js — 100% synthesized SFX via Tone.js. Zero WAV files. Zero network deps.
// Tone.js is loaded from cdnjs in index.html (see below).
// Every sound fires on the client only — no server roundtrip, butter-smooth.
//
// PUBLIC API (unchanged — game.js needs zero edits):
//   await audio.preloadAll()
//   audio.playJump()
//   audio.playLand()
//   audio.playSwordSwing()
//   audio.playAttackGrunt()
//   audio.playDeathImpact()
//   audio.playParry()
//   audio.playSwordHit()
//   audio.tickWalk(moving, grounded, sprinting)
//   audio.startAmbience() / audio.stopAmbience()  — stubs
//   audio.init() / audio.initAudio()               — stubs
//   audio.initialized                              — boolean

const TONE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js';

let _toneLoaded = false;
let _toneLoadPromise = null;

function loadTone() {
  if (_toneLoaded) return Promise.resolve();
  if (_toneLoadPromise) return _toneLoadPromise;
  _toneLoadPromise = new Promise((resolve, reject) => {
    if (window.Tone) { _toneLoaded = true; return resolve(); }
    const s = document.createElement('script');
    s.src = TONE_CDN;
    s.onload  = () => { _toneLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('Tone.js CDN load failed'));
    document.head.appendChild(s);
  });
  return _toneLoadPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
export class AudioManager {
  constructor() {
    this.initialized  = false;
    this._loadPromise = null;
    this._T           = null; // Tone namespace (set after load)

    // Synth handles — created after Tone loads & AudioContext is resumed
    this._jumpSynth   = null;
    this._landSynth   = null;
    this._attackSynth = null;
    this._parrySynth  = null;
    this._deathSynth  = null;
    this._walkLoop    = null;
    this._walkActive  = false;
    this._walkKey     = null; // 'walk' | 'sprint'
  }

  // ── PRELOAD (idempotent) ─────────────────────────────────────────────────
  preloadAll() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad();
    return this._loadPromise;
  }

  async _doLoad() {
    try {
      await loadTone();
      this._T = window.Tone;

      // Resume AudioContext — must be called from a user-gesture stack.
      // preloadAll() is always invoked from a keydown/click in main.js.
      await this._T.start();

      this._buildSynths();
      this.initialized = true;
      console.log('[audio] Tone.js synths ready');
    } catch (err) {
      console.error('[audio] init failed:', err);
    }
  }

  // ── SYNTH CONSTRUCTION ───────────────────────────────────────────────────
  _buildSynths() {
    const T = this._T;

    // ── JUMP — short, airy whoosh upward
    // MetalSynth gives a sharp percussive ping with a rising frequency
    this._jumpSynth = new T.MetalSynth({
      frequency    : 260,
      envelope     : { attack: 0.001, decay: 0.12, release: 0.05 },
      harmonicity  : 5.1,
      modulationIndex: 16,
      resonance    : 2800,
      octaves      : 1.8,
      volume       : -14,
    }).toDestination();

    // ── LAND — thump on touchdown
    this._landSynth = new T.MembraneSynth({
      pitchDecay  : 0.04,
      octaves     : 4,
      envelope    : { attack: 0.001, decay: 0.18, sustain: 0, release: 0.08 },
      volume      : -9,
    }).toDestination();

    // ── ATTACK (sword swing) — metallic swipe
    // Synth + short noise burst routed together
    this._attackSynth = new T.MetalSynth({
      frequency    : 440,
      envelope     : { attack: 0.001, decay: 0.09, release: 0.04 },
      harmonicity  : 3.5,
      modulationIndex: 32,
      resonance    : 4000,
      octaves      : 1.2,
      volume       : -10,
    }).toDestination();

    // Distorted noise for the "whoosh" component
    this._swishNoise = new T.NoiseSynth({
      noise        : { type: 'white' },
      envelope     : { attack: 0.001, decay: 0.07, sustain: 0, release: 0.04 },
      volume       : -20,
    }).toDestination();

    // ── PARRY — bright metallic clang (clash of blades)
    this._parrySynth = new T.MetalSynth({
      frequency    : 700,
      envelope     : { attack: 0.001, decay: 0.35, release: 0.15 },
      harmonicity  : 8,
      modulationIndex: 48,
      resonance    : 5500,
      octaves      : 1.5,
      volume       : -6,
    }).toDestination();

    // Slightly detuned second partial for "spark" character
    this._parrySynth2 = new T.MetalSynth({
      frequency    : 660,
      envelope     : { attack: 0.001, decay: 0.22, release: 0.1 },
      harmonicity  : 6,
      modulationIndex: 40,
      resonance    : 4800,
      octaves      : 1.2,
      volume       : -12,
    }).toDestination();

    // ── DEATH — heavy crunching low boom + metallic ring-out
    this._deathBoom = new T.MembraneSynth({
      pitchDecay  : 0.08,
      octaves     : 8,
      envelope    : { attack: 0.001, decay: 0.55, sustain: 0, release: 0.2 },
      volume      : -4,
    }).toDestination();

    this._deathMetal = new T.MetalSynth({
      frequency    : 90,
      envelope     : { attack: 0.01, decay: 0.8, release: 0.4 },
      harmonicity  : 2,
      modulationIndex: 20,
      resonance    : 1200,
      octaves      : 2.5,
      volume       : -10,
    }).toDestination();

    // ── ATTACK GRUNT — low body-hit thump (fired alongside sword swing)
    this._gruntSynth = new T.MembraneSynth({
      pitchDecay  : 0.03,
      octaves     : 3,
      envelope    : { attack: 0.001, decay: 0.1, sustain: 0, release: 0.05 },
      volume      : -18,
    }).toDestination();

    // ── WALK — subtle rhythmic low click (looped via Tone.Loop)
    // We use a very short noise burst on a schedule rather than looped audio.
    this._walkNoise = new T.NoiseSynth({
      noise        : { type: 'brown' },
      envelope     : { attack: 0.001, decay: 0.055, sustain: 0, release: 0.02 },
      volume       : -28,
    }).toDestination();

    this._walkNoiseFast = new T.NoiseSynth({
      noise        : { type: 'brown' },
      envelope     : { attack: 0.001, decay: 0.04, sustain: 0, release: 0.015 },
      volume       : -24,
    }).toDestination();

    this._walkLoop = new T.Loop((time) => {
      if (!this._walkActive) return;
      const synth = this._walkKey === 'sprint' ? this._walkNoiseFast : this._walkNoise;
      synth.triggerAttackRelease('8n', time);
    }, '8n');

    // Don't start loop yet — _startWalk() handles that
  }

  // ── PUBLIC SFX API ───────────────────────────────────────────────────────

  playJump() {
    if (!this._jumpSynth) return;
    try {
      this._jumpSynth.triggerAttackRelease('C5', '16n');
    } catch (_) {}
  }

  playLand() {
    if (!this._landSynth) return;
    try {
      this._landSynth.triggerAttackRelease('C1', '32n');
    } catch (_) {}
  }

  playSwordSwing() {
    if (!this._attackSynth) return;
    try {
      const now = this._T.now();
      this._attackSynth.triggerAttackRelease('A5', '32n', now);
      this._swishNoise.triggerAttackRelease('16n', now + 0.01);
    } catch (_) {}
  }

  playAttackGrunt() {
    if (!this._gruntSynth) return;
    try {
      this._gruntSynth.triggerAttackRelease('G1', '32n');
    } catch (_) {}
  }

  playParry() {
    if (!this._parrySynth) return;
    try {
      const now = this._T.now();
      this._parrySynth.triggerAttackRelease('E6',  '8n', now);
      this._parrySynth2.triggerAttackRelease('D6', '8n', now + 0.01);
    } catch (_) {}
  }

  playDeathImpact() {
    if (!this._deathBoom) return;
    try {
      const now = this._T.now();
      this._deathBoom.triggerAttackRelease('C0',  '4n', now);
      this._deathMetal.triggerAttackRelease('A1', '4n', now + 0.05);
    } catch (_) {}
  }

  // Alias — same heavy impact sound for a sword hit
  playSwordHit() { this.playDeathImpact(); }

  // ── WALK / SPRINT LOOP ───────────────────────────────────────────────────
  // Called every game frame. Server-independent — runs only in the browser.

  tickWalk(moving, grounded, sprinting = false) {
    if (!this._walkLoop) return;
    const should = moving && grounded;
    const key    = sprinting ? 'sprint' : 'walk';

    if (!should) {
      if (this._walkActive) this._stopWalk();
      return;
    }
    if (this._walkActive && this._walkKey !== key) this._stopWalk();
    if (!this._walkActive) this._startWalk(key);
  }

  _startWalk(key) {
    if (this._walkActive) return;
    this._walkKey    = key;
    this._walkActive = true;
    this._walkLoop.interval = key === 'sprint' ? '8n' : '4n';
    this._walkLoop.start(0);
    this._T.Transport.start();
  }

  _stopWalk() {
    this._walkActive = false;
    this._walkKey    = null;
    // Don't stop Transport — other things may use it. Just let loop fire silently.
    this._walkLoop.stop();
  }

  // ── COMPAT STUBS ────────────────────────────────────────────────────────
  async init()      {}
  async initAudio() {}
  startAmbience()   {}
  stopAmbience()    {}
}
