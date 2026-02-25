// audio.js — Client-side audio system
// =============================================================================
//
//  ASSET TO KEEP (delete all other .wav files):
//    assets/4__RoboTrance.wav   ← BGM, loops forever while the page is open
//
//  SFX are synthesized with Tone.js — NO other audio files are needed.
//
//  HOW IT STARTS
//    init() is called on the very first keydown or click anywhere on the page
//    (wired in main.js).  That single gesture unlocks the Web AudioContext,
//    builds all SFX instruments instantly, and begins streaming the BGM in
//    the background.  BGM starts playing as soon as the file finishes decoding
//    (~1-2s on a normal connection).  SFX are ready immediately.
//
//  NETWORK AUDIO
//    Zero.  Nothing audio-related is ever sent or received over the network.
//    SFX fire from local game-state transitions only (see game.js).
//
//  PUBLIC API (all methods are safe to call before init — they are no-ops)
//    audio.init()                 — call once on first user gesture
//    audio.playJump()             — short rising blip
//    audio.playSwordSwing()       — metallic whoosh
//    audio.playAttackGrunt()      — percussive vocal hit
//    audio.playSwordHit()         — sharp clang
//    audio.playDeathImpact()      — heavy thud + low drone
//    audio.tickWalk(bool, bool)   — call every frame; drives footstep loop
//    audio.startAmbience()        — no-op (BGM auto-starts; kept for compat)
//    audio.stopAmbience()         — no-op (kept for compat)
//
// =============================================================================

const BGM_URL  = 'assets/4__RoboTrance.wav';
const TONE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js';

// ── Load Tone.js once from CDN, cached after first load ──────────────────────
let _tonePromise = null;
function loadTone() {
  if (_tonePromise) return _tonePromise;
  _tonePromise = new Promise((resolve, reject) => {
    if (window.Tone) { resolve(window.Tone); return; }
    const s = document.createElement('script');
    s.src     = TONE_CDN;
    s.onload  = () => resolve(window.Tone);
    s.onerror = () => reject(new Error('Tone.js CDN load failed'));
    document.head.appendChild(s);
  });
  return _tonePromise;
}

// =============================================================================
export class AudioManager {
  constructor() {
    this.initialized  = false;
    this._T           = null;   // Tone namespace, set after loadTone()

    // BGM (uses raw Web Audio nodes so Tone instruments don't clash)
    this._bgmBuffer   = null;
    this._bgmSource   = null;
    this._bgmGainNode = null;
    this._bgmFilterNode = null;

    // Tone.js SFX — each key holds a trigger function () => void
    this._sfx         = {};

    // Walk loop (Tone.Loop)
    this._walkLoop    = null;
    this._walkPlaying = false;
  }

  // ── Initialise on first user gesture ─────────────────────────────────────
  async init()      { await this.initAudio(); }
  async initAudio() {
    if (this.initialized) return;
    this.initialized = true;   // guard against double-call

    try {
      // 1. Load Tone.js from CDN (cached after first load, ~90 KB gzipped)
      this._T = await loadTone();

      // 2. Unlock the AudioContext — MUST be inside the gesture handler
      await this._T.start();

      // 3. Build SFX instruments synchronously (no async — ready immediately)
      this._buildSFX();

      // 4. Fetch + decode BGM in background — does not block SFX
      this._startBGM();

    } catch (e) {
      console.warn('[audio] init error:', e);
      this.initialized = false;
    }
  }

  // Kept for API compatibility with game.js — BGM runs for page lifetime
  startAmbience() {}
  stopAmbience()  {}

  // ===========================================================================
  // SFX — built with Tone.js, zero latency after init
  // ===========================================================================
  _buildSFX() {
    const T = this._T;

    // Shared output limiter prevents clipping when multiple SFX overlap
    const out = new T.Limiter(-2).toDestination();

    // ── JUMP — bright rising pitch blip ─────────────────────────────────────
    // PolySynth so rapid presses don't choke each other
    const jumpSynth = new T.PolySynth(T.Synth, {
      oscillator : { type: 'triangle' },
      envelope   : { attack: 0.005, decay: 0.13, sustain: 0, release: 0.04 },
      volume     : -10,
    }).connect(out);

    this._sfx.jump = () => {
      const now = T.now();
      // Start at C5, glide up to G5 — gives a springy "boing" feel
      jumpSynth.triggerAttack('C5', now);
      jumpSynth.triggerRelease(['C5'], now + 0.13);
    };

    // ── SWORD SWING — brown-noise whoosh through sweeping bandpass ──────────
    const swingNoise = new T.NoiseSynth({
      noise    : { type: 'brown' },
      envelope : { attack: 0.008, decay: 0.20, sustain: 0, release: 0.06 },
      volume   : -7,
    });
    const swingBP = new T.Filter({ type: 'bandpass', Q: 2.5 }).connect(out);
    swingNoise.connect(swingBP);

    this._sfx.swing = () => {
      const now = T.now();
      // Sweep bandpass 300 Hz → 3000 Hz to simulate blade arc
      swingBP.frequency.setValueAtTime(300, now);
      swingBP.frequency.exponentialRampTo(3000, 0.18, now);
      swingNoise.triggerAttackRelease('16n', now);
    };

    // ── ATTACK GRUNT — low pitched membrane thump ───────────────────────────
    const gruntSynth = new T.MembraneSynth({
      pitchDecay : 0.045,
      octaves    : 4,
      envelope   : { attack: 0.001, decay: 0.09, sustain: 0, release: 0.05 },
      volume     : -13,
    }).connect(out);

    this._sfx.grunt = () => {
      gruntSynth.triggerAttackRelease('G2', '32n');
    };

    // ── SWORD HIT — sharp metallic clang ────────────────────────────────────
    const hitMetal = new T.MetalSynth({
      frequency      : 420,
      envelope       : { attack: 0.001, decay: 0.22, release: 0.08 },
      harmonicity    : 5.1,
      modulationIndex: 16,
      resonance      : 3800,
      octaves        : 1.5,
      volume         : -7,
    }).connect(out);

    this._sfx.hit = () => {
      hitMetal.triggerAttackRelease('32n');
    };

    // ── DEATH IMPACT — heavy thud + descending drone ─────────────────────────
    // Layer 1: deep membrane thud
    const deathThud = new T.MembraneSynth({
      pitchDecay : 0.09,
      octaves    : 6,
      envelope   : { attack: 0.001, decay: 0.40, sustain: 0, release: 0.2 },
      volume     : -5,
    }).connect(out);

    // Layer 2: descending sine tone — the "life leaving the body" drone
    const deathDrone = new T.PolySynth(T.Synth, {
      oscillator : { type: 'sine' },
      envelope   : { attack: 0.02, decay: 0.55, sustain: 0, release: 0.25 },
      volume     : -17,
    }).connect(out);

    this._sfx.death = () => {
      const now = T.now();
      deathThud.triggerAttackRelease('C1', '8n', now);
      // Scream tail starts slightly after the thud
      deathDrone.triggerAttack('A3', now + 0.06);
      deathDrone.releaseAll(now + 0.60);
    };

    // ── WALK FOOTSTEP — pink-noise click, looped while moving ───────────────
    const walkNoise = new T.NoiseSynth({
      noise    : { type: 'pink' },
      envelope : { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 },
      volume   : -24,
    });
    const walkLP = new T.Filter({ type: 'lowpass', frequency: 700 }).connect(out);
    walkNoise.connect(walkLP);

    // Loop fires every 8th note (at 120BPM = 250ms) — running cadence
    this._walkLoop = new T.Loop((time) => {
      walkNoise.triggerAttackRelease('32n', time);
    }, '8n');
    this._walkLoop.humanize = 0.012; // tiny random variation avoids robotic feel
  }

  // ===========================================================================
  // BGM — streams 4__RoboTrance.wav, loops forever
  // ===========================================================================
  async _startBGM() {
    try {
      // Use Tone's raw AudioContext so BGM and SFX share the same graph
      const ctx = this._T.context.rawContext;

      // BGM chain: source → lowpass → gain → destination
      // Low-pass keeps it warm and lets SFX punch through
      this._bgmFilterNode = ctx.createBiquadFilter();
      this._bgmFilterNode.type = 'lowpass';
      this._bgmFilterNode.frequency.value = 14000;

      this._bgmGainNode = ctx.createGain();
      this._bgmGainNode.gain.value = 0.34; // quiet enough for SFX to cut through

      this._bgmFilterNode.connect(this._bgmGainNode);
      this._bgmGainNode.connect(ctx.destination);

      // Fetch and decode the BGM file
      const res = await fetch(BGM_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab  = await res.arrayBuffer();
      this._bgmBuffer = await ctx.decodeAudioData(ab);

      // Start playback — loop forever
      const src    = ctx.createBufferSource();
      src.buffer   = this._bgmBuffer;
      src.loop     = true;
      src.connect(this._bgmFilterNode);
      src.start(0);
      this._bgmSource = src;

    } catch (e) {
      console.warn('[audio] BGM failed to load:', e);
    }
  }

  // ===========================================================================
  // PUBLIC SFX TRIGGERS
  // All guarded — safe to call before init() or if Tone failed to load.
  // ===========================================================================

  // Fires immediately on jump keypress — before server round-trip (prediction)
  playJump() {
    if (!this.initialized || !this._sfx.jump) return;
    try { this._sfx.jump(); } catch (_) {}
  }

  // Fires when local attack starts, or when remote player's attacking flag
  // transitions false → true (inferred from snapshot diff — no network audio)
  playSwordSwing() {
    if (!this.initialized || !this._sfx.swing) return;
    try { this._sfx.swing(); } catch (_) {}
  }

  // Short grunt that accompanies the swing
  playAttackGrunt() {
    if (!this.initialized || !this._sfx.grunt) return;
    try { this._sfx.grunt(); } catch (_) {}
  }

  // Metal clang — sword connecting with body (used by playSwordHit callers)
  playSwordHit() {
    if (!this.initialized || !this._sfx.hit) return;
    try { this._sfx.hit(); } catch (_) {}
  }

  // Death: hit clang as the killing blow lands, followed by thud + drone
  playDeathImpact() {
    if (!this.initialized) return;
    try { if (this._sfx.hit)   this._sfx.hit();   } catch (_) {}
    try { if (this._sfx.death) this._sfx.death();  } catch (_) {}
  }

  // ===========================================================================
  // WALK LOOP
  // Call every game frame from game.js.
  // Starts looping footstep ticks while the player is moving on the ground,
  // stops cleanly when they stop or jump.
  //
  // @param {boolean} moving   — true when |vx| > 0.1
  // @param {boolean} grounded — true when player is on the floor
  // ===========================================================================
  tickWalk(moving, grounded) {
    if (!this.initialized || !this._walkLoop) return;
    const should = moving && grounded;

    if (should && !this._walkPlaying) {
      // Tone.Transport must be running for Tone.Loop to fire
      this._T.getTransport().start();
      this._walkLoop.start(0);
      this._walkPlaying = true;
    } else if (!should && this._walkPlaying) {
      this._walkLoop.stop();
      this._walkPlaying = false;
    }
  }
}
