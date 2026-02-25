// audio.js — Client-side only. Zero network audio.
// ─────────────────────────────────────────────────────────────────────────────
// ASSETS REQUIRED in client/assets/:
//   4__RoboTrance.wav                                     ← BGM (keep this)
//   GRASS_-_Walk_1.wav                                    ← walk footstep loop
//   GRASS_-_Hard_Walk_1.wav                               ← sprint footstep loop
//   GRASS_-_Pre_Jump_5.wav                                ← jump takeoff
//   GRASS_-_Post_Jump_5.wav                               ← jump landing
//   WEAPSwrd_SwordStab_HoveAud_SwordCombat_01.wav         ← attack swing
//   WEAPSwrd_SwordStabCombowRing_HoveAud_SwordCombat_11.wav ← death impact
//
// Parry clang is synthesized (no file). All other SFX load from the files above.
// BGM volume = 17% (50% of previous 34%) so SFX cut through clearly.
//
// PUBLIC API:
//   audio.init()
//   audio.playJump()            — takeoff sound
//   audio.playLand()            — landing sound
//   audio.playSwordSwing()      — attack swing
//   audio.playAttackGrunt()     — synthesized grunt alongside swing
//   audio.playDeathImpact()     — death sword + low thud
//   audio.playParry()           — synthesized metallic parry clang
//   audio.playSwordHit()        — alias → death impact clang only
//   audio.tickWalk(moving, grounded, sprinting)
//   audio.startAmbience()       — no-op (kept for compat)
//   audio.stopAmbience()        — no-op (kept for compat)
// ─────────────────────────────────────────────────────────────────────────────

const BGM_URL  = 'assets/4__RoboTrance.wav';
const BGM_GAIN = 0.17;   // 50% of the old 0.34

const SFX_FILES = {
  walk:       'assets/GRASS_-_Walk_1.wav',
  sprint:     'assets/GRASS_-_Hard_Walk_1.wav',
  preJump:    'assets/GRASS_-_Pre_Jump_5.wav',
  postJump:   'assets/GRASS_-_Post_Jump_5.wav',
  attack:     'assets/WEAPSwrd_SwordStab_HoveAud_SwordCombat_01.wav',
  death:      'assets/WEAPSwrd_SwordStabCombowRing_HoveAud_SwordCombat_11.wav',
};

const TONE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js';
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

export class AudioManager {
  constructor() {
    this.initialized  = false;
    this._ctx         = null;   // raw AudioContext
    this._T           = null;   // Tone namespace

    // BGM chain nodes
    this._bgmSrc      = null;
    this._bgmGain     = null;
    this._bgmFilter   = null;

    // Decoded SFX buffers
    this._buf         = {};

    // Walk loop state
    this._walkNode    = null;
    this._walkPlaying = false;
    this._walkKey     = null;   // 'walk' | 'sprint' — tracks which is playing

    // Tone.js synth triggers (parry clang, grunt, death thud)
    this._synth       = {};
  }

  // ── Must be called on first user gesture ─────────────────────────────────
  async init()      { await this.initAudio(); }
  async initAudio() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      // Load Tone for synthesized SFX
      this._T = await loadTone();
      await this._T.start();                    // unlock AudioContext on gesture
      this._ctx = this._T.context.rawContext;   // share one context everywhere

      // BGM disabled — SFX only
      this._buildSynths();
      this._loadSFX();    // non-blocking — files load in background
      // this._startBGM(); // BGM intentionally disabled
    } catch (e) {
      console.warn('[audio] init error:', e);
      this.initialized = false;
    }
  }

  startAmbience() {}   // no-op — BGM auto-starts on init
  stopAmbience()  {}   // no-op — BGM runs for page lifetime

  // ── BGM ────────────────────────────────────────────────────────────────────
  _buildBGMChain() {
    const ctx = this._ctx;
    // BGM goes: source → lowpass (warm) → gain → destination
    this._bgmFilter = ctx.createBiquadFilter();
    this._bgmFilter.type = 'lowpass';
    this._bgmFilter.frequency.value = 14000;
    this._bgmGain = ctx.createGain();
    this._bgmGain.gain.value = BGM_GAIN;
    this._bgmFilter.connect(this._bgmGain);
    this._bgmGain.connect(ctx.destination);
  }

  async _startBGM() {
    try {
      const buf = await this._fetch(BGM_URL);
      if (this._bgmSrc) return;
      const src  = this._ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      src.connect(this._bgmFilter);
      src.start(0);
      this._bgmSrc = src;
    } catch (e) { console.warn('[audio] BGM failed:', e); }
  }

  // ── SFX file loading ──────────────────────────────────────────────────────
  async _loadSFX() {
    await Promise.allSettled(
      Object.entries(SFX_FILES).map(async ([key, url]) => {
        try   { this._buf[key] = await this._fetch(url); }
        catch (e) { console.warn('[audio] SFX load failed:', key, e); }
      })
    );
  }

  async _fetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return this._ctx.decodeAudioData(await res.arrayBuffer());
  }

  // Fire a decoded buffer once at given volume (0–1)
  _play(key, vol = 1, delayS = 0) {
    const buf = this._buf[key];
    if (!buf || !this._ctx) return;
    if (this._ctx.state === 'suspended') this._ctx.resume();
    const src  = this._ctx.createBufferSource();
    src.buffer = buf;
    const g    = this._ctx.createGain();
    g.gain.value = vol;
    src.connect(g); g.connect(this._ctx.destination);
    src.start(this._ctx.currentTime + delayS);
  }

  // ── Tone.js synthesized sounds ────────────────────────────────────────────
  // Only for sounds with no asset file: parry clang, attack grunt, death thud.
  _buildSynths() {
    const T   = this._T;
    const out = new T.Limiter(-2).toDestination();

    // Attack grunt — short low membrane hit alongside swing
    const grunt = new T.MembraneSynth({
      pitchDecay : 0.04, octaves: 4,
      envelope   : { attack:0.001, decay:0.09, sustain:0, release:0.04 },
      volume     : -14,
    }).connect(out);
    this._synth.grunt = () => { try { grunt.triggerAttackRelease('G2','32n'); } catch(_){} };

    // Parry — sharp metallic clang
    const parry = new T.MetalSynth({
      frequency: 300,
      envelope  : { attack:0.001, decay:0.28, release:0.1 },
      harmonicity:3.0, modulationIndex:12,
      resonance:3000, octaves:1.1, volume:-6,
    }).connect(out);
    this._synth.parry = () => { try { parry.triggerAttackRelease('16n'); } catch(_){} };

    // Death thud — heavy low impact body hit (layered under death sword)
    const thud = new T.MembraneSynth({
      pitchDecay : 0.09, octaves: 6,
      envelope   : { attack:0.001, decay:0.38, sustain:0, release:0.18 },
      volume     : -6,
    }).connect(out);
    this._synth.thud = () => { try { thud.triggerAttackRelease('C1','8n'); } catch(_){} };
  }

  // ── PUBLIC SFX API ────────────────────────────────────────────────────────

  /** Grass pre-jump (takeoff) — called when jump is pressed while grounded */
  playJump() { this._play('preJump', 0.85); }

  /** Grass post-jump (landing) — called when player touches floor */
  playLand() { this._play('postJump', 0.80); }

  /** Attack swing from file */
  playSwordSwing() { this._play('attack', 0.88); }

  /** Short grunt alongside attack */
  playAttackGrunt() { this._synth.grunt?.(); }

  /** Death: sword stab sound + body thud 80ms later */
  playDeathImpact() {
    this._play('death', 0.90);
    setTimeout(() => this._synth.thud?.(), 80);
  }

  /** Parry clang — synthesized metallic ring */
  playParry() { this._synth.parry?.(); }

  /** Sword hit (reuses death stab — a strong clang) */
  playSwordHit() { this._play('death', 0.75); }

  // ── WALK / SPRINT LOOP ────────────────────────────────────────────────────
  // Call every game frame.
  // @param {boolean} moving    — |vx| > 0.1
  // @param {boolean} grounded  — on the floor
  // @param {boolean} sprinting — sprint key held
  tickWalk(moving, grounded, sprinting = false) {
    if (!this._ctx) return;
    const should = moving && grounded;
    const key    = sprinting ? 'sprint' : 'walk';
    const vol    = sprinting ? 0.75 : 0.55;

    // If sprinting mode flipped while loop is running, restart with correct sound
    if (this._walkPlaying && should && key !== this._walkKey) {
      this._stopWalk();
    }

    if (should && !this._walkPlaying) {
      this._startWalk(key, vol);
    } else if (!should && this._walkPlaying) {
      this._stopWalk();
    }
  }

  _startWalk(key, vol) {
    const buf = this._buf[key];
    if (!buf || this._walkPlaying) return;
    const src  = this._ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g    = this._ctx.createGain();
    g.gain.value = vol;
    src.connect(g); g.connect(this._ctx.destination);
    src.start();
    this._walkNode    = { src, g };
    this._walkPlaying = true;
    this._walkKey     = key;
    src.onended = () => { this._walkPlaying = false; this._walkNode = null; };
  }

  _stopWalk() {
    if (!this._walkPlaying || !this._walkNode) return;
    try {
      const { g, src } = this._walkNode;
      const now = this._ctx.currentTime;
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + 0.04);
      src.stop(now + 0.04);
    } catch (_) {}
    this._walkPlaying = false;
    this._walkKey     = null;
    this._walkNode    = null;
  }
}
