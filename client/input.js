// input.js - QWERTY-normalized input system
// Maps physical key positions to QWERTY regardless of keyboard layout

// QWERTY key code to logical action mapping
// Using KeyCode (physical position) for layout independence
const KEY_MAP_P1 = {
  'KeyA': 'left',
  'KeyD': 'right',
  'KeyW': 'jump',
  'KeyS': 'crouch',
  'KeyJ': 'attack',
};

const KEY_MAP_P2 = {
  'ArrowLeft': 'left',
  'ArrowRight': 'right',
  'ArrowUp': 'jump',
  'ArrowDown': 'crouch',
  'Numpad0': 'attack',
  'Slash': 'attack',
  'NumpadDecimal': 'attack',
  'Numpad1': 'attack',
};

export class InputManager {
  constructor() {
    this.p1 = { left: false, right: false, jump: false, crouch: false, attack: false };
    this.p2 = { left: false, right: false, jump: false, crouch: false, attack: false };
    this.p1Pressed = { left: false, right: false, jump: false, crouch: false, attack: false };
    this.p2Pressed = { left: false, right: false, jump: false, crouch: false, attack: false };

    this._prevP1 = { ...this.p1 };
    this._prevP2 = { ...this.p2 };

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  _onKeyDown(e) {
    e.preventDefault();
    const action1 = KEY_MAP_P1[e.code];
    const action2 = KEY_MAP_P2[e.code];
    if (action1) {
      if (!this.p1[action1]) {
        this.p1Pressed[action1] = true;
      }
      this.p1[action1] = true;
    }
    if (action2) {
      if (!this.p2[action2]) {
        this.p2Pressed[action2] = true;
      }
      this.p2[action2] = true;
    }
  }

  _onKeyUp(e) {
    const action1 = KEY_MAP_P1[e.code];
    const action2 = KEY_MAP_P2[e.code];
    if (action1) this.p1[action1] = false;
    if (action2) this.p2[action2] = false;
  }

  // Call at end of each frame to clear single-frame press events
  flush() {
    for (const k of Object.keys(this.p1Pressed)) this.p1Pressed[k] = false;
    for (const k of Object.keys(this.p2Pressed)) this.p2Pressed[k] = false;
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
