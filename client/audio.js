// audio.js — BGM starts instantly on first gesture; SFX decoded in background
export class AudioManager {
  constructor() {
    this.ctx         = null;
    this.sfxGain     = null;
    this.bgGain      = null;
    this.bgmFilter   = null;
    this.initialized = false;   // true once AudioContext + buses exist
    this.sfxReady    = false;   // true once SFX buffers are decoded
    this._buffers    = {};
    this._pools      = {};
    this._bgmSource  = null;

    // Single BGM track — loops forever
    this.bgmTrack = 'assets/1__Bright_Moments.wav';

    this.sfxDefs = {
      swing:  { url: 'assets/WEAPSwrd_MetalwWhoosh_HoveAud_SwordCombat_06.wav',        pool: 4, vol: 1.0 },
      hit:    { url: 'assets/WEAPSwrd_SwordStabCombowRing_HoveAud_SwordCombat_17.wav', pool: 4, vol: 1.0 },
      gore:   { url: 'assets/GOREStab_SwordStabGore_HoveAud_SwordCombat_17.wav',       pool: 4, vol: 1.0 },
      grunt:  { url: 'assets/VOXEfrt_ActionGrunt_HoveAud_SwordCombat_23.wav',          pool: 4, vol: 0.7 },
      damage: { url: 'assets/VOXScrm_DamageGrunt_HoveAudio_SwordCombat_13.wav',        pool: 4, vol: 0.9 },
    };
  }

  // ── Phase 1: Create AudioContext + buses + kick off BGM immediately ────────────
  // Must be called from a user gesture (keydown / click).
  async initAudio() {
    if (this.initialized) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // SFX gain bus
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.9;
    this.sfxGain.connect(this.ctx.destination);

    // BGM bus — lowpass + gain
    this.bgmFilter = this.ctx.createBiquadFilter();
    this.bgmFilter.type = 'lowpass';
    this.bgmFilter.frequency.value = 1400;
    this.bgGain = this.ctx.createGain();
    this.bgGain.gain.value = 0.42;
    this.bgmFilter.connect(this.bgGain);
    this.bgGain.connect(this.ctx.destination);

    this.initialized = true;

    // BGM fetch+decode runs now; SFX decodes in parallel — neither blocks the other
    this._startBGM();
    this._initSFX();
  }

  // ── Phase 2 (background): decode all SFX, build pre-wired pools ───────────────
  async _initSFX() {
    await Promise.allSettled(
      Object.entries(this.sfxDefs).map(async ([key, def]) => {
        try {
          const buf = await this._fetchDecode(def.url);
          this._buffers[key] = buf;
          this._pools[key] = [];
          for (let i = 0; i < def.pool; i++) {
            this._pools[key].push(this._makeNode(buf, def.vol));
          }
        } catch (e) {
          console.warn('[audio] SFX failed:', key, e);
        }
      })
    );
    this.sfxReady = true;
  }

  // Legacy shim — game.js calls audio.init(); keep it working.
  async init() {
    await this.initAudio();
  }

  // ── BGM ───────────────────────────────────────────────────────────────────────
  async _startBGM() {
    if (!this.initialized || this._bgmSource) return;
    try {
      if (!this._buffers['bgm']) {
        this._buffers['bgm'] = await this._fetchDecode(this.bgmTrack);
      }
      if (this._bgmSource) return;   // guard: could be called twice while awaiting
      const src = this.ctx.createBufferSource();
      src.buffer = this._buffers['bgm'];
      src.loop = true;               // loop forever — no track switching
      src.connect(this.bgmFilter);
      src.start(0);
      this._bgmSource = src;
    } catch (e) {
      console.warn('[audio] BGM failed:', e);
    }
  }

  // Called by game.start() — BGM may already be running from lobby gesture; guard handles it.
  startAmbience() {
    if (!this.initialized) return;
    if (this._bgmSource) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().then(() => this._startBGM());
    } else {
      this._startBGM();
    }
  }

  stopAmbience() {
    if (this._bgmSource) {
      try { this._bgmSource.stop(); } catch (_) {}
      this._bgmSource = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  async _fetchDecode(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return await this.ctx.decodeAudioData(ab);
  }

  _makeNode(buffer, vol) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(this.sfxGain);
    return { src, g, vol, buffer, used: false };
  }

  // ── SFX ───────────────────────────────────────────────────────────────────────
  _playSFX(key, volMul = 1) {
    if (!this.sfxReady) return;    // still decoding — silently skip
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const pool = this._pools[key];
    const def  = this.sfxDefs[key];
    const buf  = this._buffers[key];
    if (!pool || !buf) return;

    let node = pool.find(n => !n.used);
    if (!node) {
      node = this._makeNode(buf, def.vol * volMul);
      pool.push(node);
    }
    node.used = true;
    node.g.gain.value = def.vol * volMul;
    node.src.start(0);
    node.src.onended = () => {
      const idx = pool.indexOf(node);
      if (idx !== -1) pool[idx] = this._makeNode(buf, def.vol);
    };
  }

  // ── Public SFX API ────────────────────────────────────────────────────────────
  playSwordSwing()  { this._playSFX('swing'); }
  playDeathImpact() {
    this._playSFX('gore');
    if (this.sfxReady && this._buffers['damage']) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._buffers['damage'];
      const g = this.ctx.createGain(); g.gain.value = 0.85;
      src.connect(g); g.connect(this.sfxGain);
      src.start(this.ctx.currentTime + 0.08);
    }
  }
  playAttackGrunt() { this._playSFX('grunt'); }
  playSwordHit()    { this._playSFX('hit'); }
  playJump()        {}
  playWin()         {}
}
