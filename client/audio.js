// audio.js — Synthesized, client-side-only audio system
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN PRINCIPLES
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. NO NETWORK AUDIO — nothing is sent or received over the network.
//    Sounds are triggered purely from local game state transitions.
//
// 2. NO BACKGROUND MUSIC — only short gameplay SFX:
//      jump  · attack-swing · attack-grunt · sword-hit · death
//    plus a walk loop that runs only while a player is moving.
//
// 3. PROCEDURALLY GENERATED — zero external audio files.
//    All sounds are built from the Web Audio API directly (oscillators,
//    noise generators, envelope shapers).  Buffers are pre-rendered once
//    at init time and stored as AudioBuffers so playback is instantaneous.
//
// 4. INSTANT PLAYBACK — no async loading during gameplay.
//    Buffers are synthesized synchronously during initAudio() so the first
//    call to any play*() method fires with zero latency.
//
// 5. WALK LOOP — start/stop managed by AudioManager.
//    game.js calls tickWalk(isMoving, isGrounded) every frame.
//    The manager handles starting and stopping the looping node internally.
//
// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────
//
//   new AudioManager()
//   audio.init()              — call once on first user gesture
//   audio.initAudio()         — alias for init()
//
//   audio.playJump()          — short rising chirp
//   audio.playSwordSwing()    — whoosh
//   audio.playAttackGrunt()   — short vocal grunt
//   audio.playSwordHit()      — metallic clang
//   audio.playDeathImpact()   — low thud + scream tail
//
//   audio.tickWalk(moving, grounded)
//                             — call every game frame; manages walk loop
//
//   audio.startAmbience()     — no-op (BGM removed; kept for API compat)
//   audio.stopAmbience()      — no-op (BGM removed; kept for API compat)
//
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 44100;

export class AudioManager {
  constructor() {
    this.ctx         = null;
    this.masterGain  = null;
    this.initialized = false;

    // Pre-rendered AudioBuffer for every SFX
    this._buf = {};

    // Walk loop state
    this._walkNode    = null;   // currently playing BufferSourceNode
    this._walkPlaying = false;
  }

  // ── Init (must be called from a user gesture) ─────────────────────────────
  async init()      { await this.initAudio(); }
  async initAudio() {
    if (this.initialized) return;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // Single master gain bus — all SFX route here
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;
    this.masterGain.connect(this.ctx.destination);

    // Pre-render all buffers synchronously (no network, no async decode)
    this._buf.jump    = this._synthJump();
    this._buf.swing   = this._synthSwing();
    this._buf.grunt   = this._synthGrunt();
    this._buf.hit     = this._synthHit();
    this._buf.death   = this._synthDeath();
    this._buf.walk    = this._synthWalkTick();

    this.initialized = true;
  }

  // ── BGM stubs — kept for API compatibility with game.js ──────────────────
  // Background music has been removed per requirements.
  startAmbience() {}
  stopAmbience()  {}

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC SFX TRIGGERS
  // ─────────────────────────────────────────────────────────────────────────

  // Short rising chirp — play instantly when jump input is pressed.
  // Called from game.js prediction path so it fires before server round-trip.
  playJump() {
    this._play('jump', 0.55);
  }

  // Sword whoosh — play when local player starts an attack swing,
  // or when remote player's attacking flag transitions false→true.
  playSwordSwing() {
    this._play('swing', 0.80);
  }

  // Short grunt — accompanies sword swing.
  playAttackGrunt() {
    this._play('grunt', 0.45);
  }

  // Metallic clang — play on a successful hit (sword connects with body).
  // Currently triggered on the 'kill' event alongside death sounds.
  playSwordHit() {
    this._play('hit', 0.90);
  }

  // Death thud + scream tail — triggered by game state transition, never
  // sent over network.  Both local kills and received 'kill' events call this.
  playDeathImpact() {
    this._play('hit',   0.90);                           // impact clang
    this._playAt('death', 0.75, this.ctx.currentTime + 0.06); // body thud follows
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WALK LOOP
  // ─────────────────────────────────────────────────────────────────────────
  // Call every game frame with current movement state.
  // Starts looping footstep ticks when moving on ground; stops when not.
  //
  // @param {boolean} moving   — true if |vx| > 0.1
  // @param {boolean} grounded — true if player is on the floor
  tickWalk(moving, grounded) {
    if (!this.initialized) return;
    const shouldPlay = moving && grounded;

    if (shouldPlay && !this._walkPlaying) {
      this._startWalkLoop();
    } else if (!shouldPlay && this._walkPlaying) {
      this._stopWalkLoop();
    }
  }

  _startWalkLoop() {
    if (!this._buf.walk || this._walkPlaying) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._buf.walk;
    src.loop   = true;

    const g = this.ctx.createGain();
    g.gain.value = 0.30;
    src.connect(g);
    g.connect(this.masterGain);
    src.start();

    this._walkNode    = { src, g };
    this._walkPlaying = true;

    src.onended = () => {
      // Handles the case where the node is stopped externally
      this._walkPlaying = false;
      this._walkNode    = null;
    };
  }

  _stopWalkLoop() {
    if (!this._walkPlaying || !this._walkNode) return;
    try {
      // Short fade-out to avoid click artifacts
      const g   = this._walkNode.g;
      const now = this.ctx.currentTime;
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + 0.04);
      this._walkNode.src.stop(now + 0.04);
    } catch (_) {}
    this._walkPlaying = false;
    this._walkNode    = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INTERNAL PLAYBACK HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  // Play a pre-rendered buffer right now at the given volume (0–1).
  _play(key, vol = 1.0) {
    if (!this.initialized) return;
    this._playAt(key, vol, this.ctx.currentTime);
  }

  // Play a pre-rendered buffer at a specific AudioContext time.
  _playAt(key, vol, when) {
    if (!this.initialized) return;
    const buf = this._buf[key];
    if (!buf) return;
    if (this.ctx.state === 'suspended') { this.ctx.resume(); }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(this.masterGain);
    src.start(when);
    // BufferSourceNode is fire-and-forget — GC cleans up after onended
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SOUND SYNTHESIS — all sounds generated from scratch, no files
  // ─────────────────────────────────────────────────────────────────────────
  // Each method returns a fully rendered AudioBuffer.
  // Synthesis happens once at init time; playback is zero-cost thereafter.

  // ── Jump — rising pitched chirp + short sine tail ─────────────────────────
  // Character: bright, snappy, high-pitched "boing" to signal becoming airborne.
  _synthJump() {
    const sr  = SAMPLE_RATE;
    const dur = 0.18;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t    = i / sr;
      const env  = Math.exp(-t * 22);             // fast decay envelope
      // Frequency sweeps 420 Hz → 820 Hz over the attack
      const freq = 420 + 400 * Math.min(t / 0.04, 1);
      const phase = 2 * Math.PI * freq * t;
      // Mix sine + slight square for brightness
      const sine  = Math.sin(phase);
      const sq    = Math.sign(Math.sin(phase * 0.5)) * 0.18;
      d[i] = env * (sine + sq) * 0.6;
    }
    return buf;
  }

  // ── Sword swing — filtered noise burst with pitch sweep ──────────────────
  // Character: rushing air/metal whoosh — directional, quick.
  _synthSwing() {
    const sr  = SAMPLE_RATE;
    const dur = 0.28;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d   = buf.getChannelData(0);
    // White noise source
    const noise = new Float32Array(d.length);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    // Low-pass filter the noise manually (one-pole IIR)
    let lpState = 0;
    for (let i = 0; i < d.length; i++) {
      const t    = i / sr;
      // Attack-decay envelope: fast rise, medium decay
      const env  = t < 0.03
        ? t / 0.03
        : Math.exp(-(t - 0.03) * 14);
      // LP cutoff sweeps from 800 → 3000 Hz (simulates blade speed)
      const cutoff = 800 + 2200 * Math.min(t / 0.08, 1);
      const rc     = 1 / (2 * Math.PI * cutoff);
      const alpha  = (1 / sr) / (rc + 1 / sr);
      lpState      = lpState + alpha * (noise[i] - lpState);
      // Add a thin sine tone on top for metallic "edge"
      const tone   = Math.sin(2 * Math.PI * (900 + 800 * t / dur) * t) * 0.12;
      d[i]         = env * (lpState * 0.85 + tone);
    }
    return buf;
  }

  // ── Attack grunt — short vocal effort sound ───────────────────────────────
  // Character: breathy exertion, "huh" — voiced but clipped.
  _synthGrunt() {
    const sr  = SAMPLE_RATE;
    const dur = 0.14;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t   = i / sr;
      const env = t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) * 28);
      // Voiced formant: mix of 200 Hz fundamental + 600 Hz overtone
      const f0  = Math.sin(2 * Math.PI * 200 * t);
      const f1  = Math.sin(2 * Math.PI * 600 * t) * 0.4;
      // Slight breathiness via shaped noise
      const breath = (Math.random() * 2 - 1) * 0.15;
      // Soft clip to add voice character
      const raw = (f0 + f1 + breath) * env;
      d[i] = Math.tanh(raw * 2.5) * 0.5;
    }
    return buf;
  }

  // ── Sword hit — metallic clang + ring ────────────────────────────────────
  // Character: sharp impact with a ringing decay — steel on steel.
  _synthHit() {
    const sr  = SAMPLE_RATE;
    const dur = 0.35;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d   = buf.getChannelData(0);
    // Noise transient layer — the initial impact crack
    const noise = new Float32Array(d.length);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    for (let i = 0; i < d.length; i++) {
      const t    = i / sr;
      const impactEnv = Math.exp(-t * 80);        // very fast decay for crack
      const ringEnv   = Math.exp(-t * 9);          // slow decay for ring
      // Metallic inharmonic partials (ring)
      const ring = Math.sin(2 * Math.PI * 1200 * t) * 0.50
                 + Math.sin(2 * Math.PI * 1870 * t) * 0.30
                 + Math.sin(2 * Math.PI * 2540 * t) * 0.15
                 + Math.sin(2 * Math.PI * 3310 * t) * 0.05;
      d[i] = impactEnv * noise[i] * 0.70 + ringEnv * ring * 0.55;
    }
    return buf;
  }

  // ── Death — low body thud + fading scream tail ────────────────────────────
  // Character: weighty thud on landing, hollow tone implying finality.
  _synthDeath() {
    const sr  = SAMPLE_RATE;
    const dur = 0.55;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d   = buf.getChannelData(0);
    const noise = new Float32Array(d.length);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    let lpState = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      // Thud: punchy noise burst, very low frequency (80–120 Hz region)
      const thudEnv  = Math.exp(-t * 18);
      const alpha    = 0.012;                      // ~85 Hz pole
      lpState        = lpState + alpha * (noise[i] - lpState);
      const thud     = lpState * thudEnv * 1.4;
      // Falling pitch tone — 220 Hz sweeping down to 80 Hz
      const freq     = 220 * Math.pow(80 / 220, Math.min(t / 0.4, 1));
      const toneEnv  = Math.exp(-t * 5);
      const tone     = Math.sin(2 * Math.PI * freq * t) * toneEnv * 0.45;
      // Slight scratch noise — body hitting floor
      const scratch  = (Math.random() * 2 - 1) * Math.exp(-t * 40) * 0.25;
      d[i] = Math.tanh((thud + tone + scratch) * 1.8) * 0.7;
    }
    return buf;
  }

  // ── Walk tick — single soft footstep click ────────────────────────────────
  // Looped by tickWalk(). Sounds like a soft leather boot strike.
  // Loop period is set by the buffer duration (0.28s ≈ 214 BPM for fast run).
  _synthWalkTick() {
    const sr  = SAMPLE_RATE;
    // Total loop duration = step + silence padding.
    // At 60fps the loop fires ~214 times/min — close to a running cadence.
    const dur = 0.28;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * dur), sr);
    const d   = buf.getChannelData(0);
    // Only the first 40ms is the actual click; rest is silence for the loop gap
    const clickLen = Math.floor(sr * 0.040);
    const noise    = new Float32Array(clickLen);
    for (let i = 0; i < clickLen; i++) noise[i] = Math.random() * 2 - 1;
    let lpState = 0;
    for (let i = 0; i < clickLen; i++) {
      const t    = i / sr;
      const env  = Math.exp(-t * 110);            // very short, punchy
      const alpha = 0.06;                          // ~400 Hz pole — dull thud
      lpState     = lpState + alpha * (noise[i] - lpState);
      // Mix filtered noise (body) + tiny high click (heel)
      const click = (Math.random() * 2 - 1) * Math.exp(-t * 800) * 0.20;
      d[i] = (lpState * env * 0.85 + click) * 0.6;
    }
    // Remaining samples stay at 0 (silence gap)
    return buf;
  }
}
