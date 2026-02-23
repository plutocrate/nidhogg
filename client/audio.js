// audio.js - Audio manager using real WAV files
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.bgGain = null;
    this.sfxGain = null;
    this.initialized = false;
    this._buffers = {};

    this.bgmTracks = [
      'assets/1__Bright_Moments.wav',
      'assets/2__Cliffside_party_Drive.wav',
      'assets/3__Electric_Dancing.wav',
      'assets/4__RoboTrance.wav',
      'assets/5__Party_Knocking.wav',
      'assets/6__Expressive_Electronica.wav',
      'assets/7__Countdown_to_the_Beat_Drop.wav',
    ];
    this._bgmShuffle = [];
    this._bgmIndex = 0;
    this._bgmSource = null;
    this._bgmLoading = false;

    this.sfxFiles = {
      swing:  'assets/WEAPSwrd_MetalwWhoosh_HoveAud_SwordCombat_06.wav',
      hit:    'assets/WEAPSwrd_SwordStabCombowRing_HoveAud_SwordCombat_17.wav',
      gore:   'assets/GOREStab_SwordStabGore_HoveAud_SwordCombat_17.wav',
      grunt:  'assets/VOXEfrt_ActionGrunt_HoveAud_SwordCombat_23.wav',
      damage: 'assets/VOXScrm_DamageGrunt_HoveAudio_SwordCombat_13.wav',
    };
  }

  async init() {
    if (this.initialized) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.bgmFilter = this.ctx.createBiquadFilter();
    this.bgmFilter.type = 'lowpass';
    this.bgmFilter.frequency.value = 900;
    this.bgmFilter.Q.value = 0.5;

    this.bgGain = this.ctx.createGain();
    this.bgGain.gain.value = 0.45;
    this.bgmFilter.connect(this.bgGain);
    this.bgGain.connect(this.ctx.destination);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.85;
    this.sfxGain.connect(this.ctx.destination);

    const sfxLoads = Object.entries(this.sfxFiles).map(async ([key, url]) => {
      try {
        this._buffers[key] = await this._loadBuffer(url);
      } catch (e) { console.warn('SFX load failed:', url, e); }
    });
    await Promise.allSettled(sfxLoads);

    this._shuffleBGM();
    this.initialized = true;
  }

  async _loadBuffer(url) {
    const res = await fetch(url);
    const ab = await res.arrayBuffer();
    return await this.ctx.decodeAudioData(ab);
  }

  _shuffleBGM() {
    this._bgmShuffle = [...Array(this.bgmTracks.length).keys()];
    for (let i = this._bgmShuffle.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._bgmShuffle[i], this._bgmShuffle[j]] = [this._bgmShuffle[j], this._bgmShuffle[i]];
    }
    this._bgmIndex = 0;
  }

  async startBGM() {
    if (!this.initialized || this._bgmLoading) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this._playNextTrack();
  }

  async _playNextTrack() {
    if (!this.initialized) return;
    this._bgmLoading = true;
    if (this._bgmSource) { try { this._bgmSource.stop(); } catch(e) {} this._bgmSource = null; }

    const trackIdx = this._bgmShuffle[this._bgmIndex];
    const url = this.bgmTracks[trackIdx];
    try {
      let buf = this._buffers['bgm_' + trackIdx];
      if (!buf) {
        buf = await this._loadBuffer(url);
        this._buffers['bgm_' + trackIdx] = buf;
      }
      this._bgmSource = this.ctx.createBufferSource();
      this._bgmSource.buffer = buf;
      this._bgmSource.connect(this.bgmFilter);
      this._bgmSource.onended = () => {
        this._bgmIndex = (this._bgmIndex + 1) % this._bgmShuffle.length;
        if (this._bgmIndex === 0) this._shuffleBGM();
        this._playNextTrack();
      };
      this._bgmSource.start(0);
    } catch (e) { console.warn('BGM play failed:', e); }
    this._bgmLoading = false;
  }

  stopBGM() {
    if (this._bgmSource) { try { this._bgmSource.stop(); } catch(e) {} this._bgmSource = null; }
  }

  startAmbience() { this.startBGM(); }
  stopAmbience()  { this.stopBGM(); }

  _resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _playSFX(key, vol = 1) {
    if (!this.initialized) return;
    this._resume();
    const buf = this._buffers[key];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(this.sfxGain);
    src.start(0);
  }

  playSwordSwing()  { this._playSFX('swing', 1.0); }
  playSwordHit()    { this._playSFX('hit', 1.0); }
  playDeathImpact() { this._playSFX('gore', 1.0); setTimeout(() => this._playSFX('damage', 0.9), 80); }
  playAttackGrunt() { this._playSFX('grunt', 0.7); }
  playJump()        {}
  playWin()         {}
}
