// input.js — Input manager
// Online: P1 uses WASD + J(attack) + K(parry) + LShift(sprint)
// Local:  P1 = above,  P2 = Arrows + L(attack) + ;(parry) + RShift(sprint)

const KEY_MAP_P1 = {
  'KeyA':      'left',
  'KeyD':      'right',
  'KeyW':      'jump',
  'KeyS':      'crouch',
  'KeyJ':      'attack',
  'KeyK':      'parry',
  'ShiftLeft': 'sprint',
};

// P2 local-only controls (arrow keys cluster)
const KEY_MAP_P2_LOCAL = {
  'ArrowLeft':    'left',
  'ArrowRight':   'right',
  'ArrowUp':      'jump',
  'ArrowDown':    'crouch',
  'KeyL':         'attack',      // L = attack for P2
  'Semicolon':    'parry',       // ; = parry for P2
  'ShiftRight':   'sprint',      // RShift = sprint for P2
  // Legacy / numpad fallbacks
  'Numpad0':      'attack',
  'NumpadDecimal':'attack',
  'Numpad1':      'attack',
};

export class InputManager {
  /**
   * @param {'online'|'local'|'tutorial'} mode
   */
  constructor(mode = 'online') {
    this.mode = mode;
    this.p1 = this._blank(); this.p2 = this._blank();
    this.p1Pressed = this._blank(); this.p2Pressed = this._blank();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp   = this._onKeyUp.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
  }

  _blank() {
    return { left:false, right:false, jump:false, crouch:false,
             attack:false, parry:false, sprint:false };
  }

  _onKeyDown(e) {
    const a1 = KEY_MAP_P1[e.code];
    if (a1) {
      e.preventDefault();
      if (!this.p1[a1]) this.p1Pressed[a1] = true;
      this.p1[a1] = true;
    }

    if (this.mode === 'local' || this.mode === 'tutorial') {
      const a2 = KEY_MAP_P2_LOCAL[e.code];
      if (a2) {
        e.preventDefault();
        if (!this.p2[a2]) this.p2Pressed[a2] = true;
        this.p2[a2] = true;
      }
    }
  }

  _onKeyUp(e) {
    const a1 = KEY_MAP_P1[e.code];
    if (a1) this.p1[a1] = false;

    if (this.mode === 'local' || this.mode === 'tutorial') {
      const a2 = KEY_MAP_P2_LOCAL[e.code];
      if (a2) this.p2[a2] = false;
    }
  }

  flush() {
    for (const k of Object.keys(this.p1Pressed)) this.p1Pressed[k] = false;
    for (const k of Object.keys(this.p2Pressed)) this.p2Pressed[k] = false;
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
  }
}
