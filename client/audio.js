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
    this._bgmIndex   = 0;
    this._bgmShuffle = [];
    this._bgmLoading = false;

    this.bgmTracks = [
      'assets/1__Bright_Moments.wav',
      'assets/2__Cliffside_party_Drive.wav',
      'assets/3__Electric_Dancing.wav',
      'assets/4__RoboTrance.wav',
      'assets/5__Party_Knocking.wav',
      'assets/6__Expressive_Electronica.wav',
      'assets/7__Countdown_to_the_Beat_Drop.wav',
    ];

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

    this._shuffleBGM();
    this.initialized = true;
  }

  // Fetch + decode audio — shared cache so BGM tracks are only fetched once
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
  _shuffleBGM() {
    this._bgmShuffle = [...Array(this.bgmTracks.length).keys()];
    for (let i = this._bgmShuffle.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._bgmShuffle[i], this._bgmShuffle[j]] = [this._bgmShuffle[j], this._bgmShuffle[i]];
    }
    this._bgmIndex = 0;
  }

  async _playNextTrack() {
    if (!this.initialized || this._bgmLoading) return;
    this._bgmLoading = true;
    if (this._bgmSource) { try { this._bgmSource.stop(); } catch(_){} this._bgmSource = null; }

    const trackIdx = this._bgmShuffle[this._bgmIndex % this._bgmShuffle.length];
    const url      = this.bgmTracks[trackIdx];
    const cacheKey = 'bgm_' + trackIdx;

    try {
      if (!this._buffers[cacheKey]) {
        this._buffers[cacheKey] = await this._fetchDecode(url);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = this._buffers[cacheKey];
      src.connect(this.bgmFilter);
      src.onended = () => {
        this._bgmIndex++;
        if (this._bgmIndex >= this._bgmShuffle.length) { this._bgmIndex=0; this._shuffleBGM(); }
        this._playNextTrack();
      };
      src.start(0);
      this._bgmSource = src;

      // Prefetch the next track while current plays (so no gap)
      const nextIdx = this._bgmShuffle[(this._bgmIndex + 1) % this._bgmShuffle.length];
      const nextKey = 'bgm_' + nextIdx;
      if (!this._buffers[nextKey]) {
        this._fetchDecode(this.bgmTracks[nextIdx])
          .then(b => { this._buffers[nextKey] = b; })
          .catch(()=>{});
      }
    } catch(e) { console.warn('[audio] BGM failed:', e); }
    this._bgmLoading = false;
  }

  startAmbience() {
    if (!this.initialized) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().then(()=>this._playNextTrack());
    else this._playNextTrack();
  }

  stopAmbience() {
    if (this._bgmSource) { try { this._bgmSource.stop(); } catch(_){} this._bgmSource = null; }
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
