// audio.js — Zero-latency audio via pre-wired node pools + eager SFX decode
export class AudioManager {
  constructor() {
    this.ctx         = null;
    this.sfxGain     = null;
    this.bgGain      = null;
    this.bgmFilter   = null;
    this.initialized = false;
    this._buffers    = {};        // key → AudioBuffer
    this._pools      = {};        // key → array of {src,gain} pre-wired nodes
    this._bgmSource  = null;

    // Single BGM track — loops forever
    this.bgmTrack = 'assets/1__Bright_Moments.wav';

    // SFX files — all decoded at init, pool of 4 pre-wired nodes each
    this.sfxDefs = {
      swing:  { url: 'assets/WEAPSwrd_MetalwWhoosh_HoveAud_SwordCombat_06.wav',    pool: 4, vol: 1.0 },
      hit:    { url: 'assets/WEAPSwrd_SwordStabCombowRing_HoveAud_SwordCombat_17.wav', pool: 4, vol: 1.0 },
      gore:   { url: 'assets/GOREStab_SwordStabGore_HoveAud_SwordCombat_17.wav',   pool: 4, vol: 1.0 },
      grunt:  { url: 'assets/VOXEfrt_ActionGrunt_HoveAud_SwordCombat_23.wav',      pool: 4, vol: 0.7 },
      damage: { url: 'assets/VOXScrm_DamageGrunt_HoveAudio_SwordCombat_13.wav',    pool: 4, vol: 0.9 },
    };
  }

  async init() {
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

    // Decode ALL SFX in parallel — these are small files, done fast
    await Promise.allSettled(
      Object.entries(this.sfxDefs).map(async ([key, def]) => {
        try {
          const buf = await this._fetchDecode(def.url);
          this._buffers[key] = buf;
          // Pre-wire a pool of source nodes for zero-latency playback
          this._pools[key] = [];
          for (let i = 0; i < def.pool; i++) {
            this._pools[key].push(this._makeNode(buf, def.vol));
          }
        } catch (e) {
          console.warn('[audio] SFX failed:', key, e);
        }
      })
    );

    this.initialized = true;
  }

  // Fetch + decode audio
  async _fetchDecode(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab  = await res.arrayBuffer();
    return await this.ctx.decodeAudioData(ab);
  }

  // Create a single pre-wired {src, gainNode} ready to fire instantly
  _makeNode(buffer, vol) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(this.sfxGain);
    return { src, g, vol, buffer, used: false };
  }

  // Play from pool — grab next unused node, replace it with a fresh one for next call
  _playSFX(key, volMul = 1) {
    if (!this.initialized) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const pool = this._pools[key];
    if (!pool || pool.length === 0) return;

    const def  = this.sfxDefs[key];
    const buf  = this._buffers[key];
    if (!buf) return;

    // Find a node that hasn't been started yet
    let node = pool.find(n => !n.used);
    if (!node) {
      // All used — create a new one on the fly (rare)
      node = this._makeNode(buf, def.vol * volMul);
      pool.push(node);
    }

    node.used = true;
    node.g.gain.value = def.vol * volMul;
    node.src.start(0);

    // Replace the used node asynchronously so pool stays fresh
    node.src.onended = () => {
      const idx = pool.indexOf(node);
      if (idx !== -1) pool[idx] = this._makeNode(buf, def.vol);
    };
  }

  // ── BGM ──────────────────────────────────────────────────────────────────────
  async startAmbience() {
    if (!this.initialized) return;
    // Already playing — don't start a second source
    if (this._bgmSource) return;

    if (this.ctx.state === 'suspended') await this.ctx.resume();

    try {
      if (!this._buffers['bgm']) {
        this._buffers['bgm'] = await this._fetchDecode(this.bgmTrack);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = this._buffers['bgm'];
      src.loop = true;           // loop forever — no track-switching needed
      src.connect(this.bgmFilter);
      src.start(0);
      this._bgmSource = src;
    } catch (e) {
      console.warn('[audio] BGM failed:', e);
    }
  }

  stopAmbience() {
    if (this._bgmSource) {
      try { this._bgmSource.stop(); } catch (_) {}
      this._bgmSource = null;
    }
  }

  // ── Public SFX API ───────────────────────────────────────────────────────────
  playSwordSwing()  { this._playSFX('swing'); }
  playDeathImpact() {
    this._playSFX('gore');
    // Slight delay for the scream — use ctx.currentTime offset for zero-jank scheduling
    if (this.initialized && this._buffers['damage']) {
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
