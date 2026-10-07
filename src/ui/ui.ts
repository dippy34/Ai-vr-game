/**
 * DOM menus + desktop HUD. Web-only (a native app would rebuild these screens with its own UI kit,
 * driven by the same callbacks).
 */

import { NOISE } from '../config';
import type { GamePhase } from '../core/types';
import type { LobbyPlayer } from '../net/protocol';
import './style.css';

type Handler = () => void;

const NAME_KEY = 'mute.playerName';
const SENS_KEY = 'mute.micSensitivityDb';
const SENS_RANGE = 15;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function button(label: string, cls = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', class: cls }, [label]);
  return b;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function loadSensitivity(): number {
  try {
    const v = Number(localStorage.getItem(SENS_KEY));
    return Number.isFinite(v) ? Math.max(-SENS_RANGE, Math.min(SENS_RANGE, Math.round(v))) : 0;
  } catch {
    return 0;
  }
}

function saveSensitivity(db: number): void {
  try {
    localStorage.setItem(SENS_KEY, String(db));
  } catch {
    /* private mode etc. */
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode etc. */
  }
}

/** Meter with tick marks at the reference loudness levels. */
function micMeter(): { root: HTMLElement; fill: HTMLElement } {
  const fill = el('div', { class: 'fill' });
  const root = el('div', { class: 'meter', title: 'How loud you are to the monster' }, [fill]);
  for (const v of [NOISE.whisper, NOISE.talk, NOISE.shout]) {
    const t = el('div', { class: 'tick' });
    t.style.left = `${v * 100}%`;
    root.append(t);
  }
  return { root, fill };
}

const CONTROLS: [string, string, string][] = [
  ['Move', 'Left stick', 'WASD'],
  ['Turn', 'Right stick / your body', 'Mouse'],
  ['Sneak (quiet)', 'Crouch for real', 'Hold C'],
  ['Run (loud)', 'Click left stick', 'Shift'],
  ['Grab / drop', 'Grip near it', 'E'],
  ['Light on / off', 'Left trigger', 'F'],
  ['Wind the light (loud)', 'Hold X, or shake your left hand', 'Hold R'],
  ['Hand signs', 'Your real hands', '1–6'],
  ['Talk', 'Just talk (careful)', 'Just talk'],
];

function controlsTable(): HTMLElement {
  const rows = CONTROLS.map(([a, vr, pc]) =>
    el('tr', {}, [el('td', {}, [a]), el('td', {}, [vr]), el('td', {}, [pc])]),
  );
  return el('table', { class: 'controls' }, [
    el('tr', {}, [el('td', {}, ['']), el('td', {}, ['VR']), el('td', {}, ['Desktop'])]),
    ...rows,
  ]);
}

function howToPlay(): HTMLElement {
  return el('details', {}, [
    el('summary', {}, ['How to play']),
    el('p', { class: 'muted' }, [
      'Something lives in this house. It is blind, but it hears everything: footsteps, your light winding, ',
      'and your real voice through your microphone. Whisper and it may not notice. Scream and it charges.',
    ]),
    el('p', { class: 'muted' }, [
      'Find the fuses, put them in the fuse box by the front door, and escape. It is pitch dark: everyone has ',
      'a wind-up Crank Light. Shine it on your hands to sign to each other. The light is safe (it is blind), ',
      'but the battery runs out, and winding it back up is LOUD.',
    ]),
    controlsTable(),
    el('p', { class: 'muted' }, ['Desktop signs: 1 point · 2 stop · 3 thumbs up · 4 fist · 5 three · 6 come here']),
  ]);
}

export interface LobbyInfo {
  code: string | null;
  isHost: boolean;
  vrSupported: boolean;
}

export class UI {
  // callbacks (set by main)
  onSolo: (name: string) => void = () => {};
  onHost: (name: string) => void = () => {};
  onJoin: (name: string, code: string) => void = () => {};
  onEnterVR: Handler = () => {};
  onPlayDesktop: Handler = () => {};
  onStartRound: Handler = () => {};
  onLeave: Handler = () => {};
  onResume: Handler = () => {};
  /** Mic sensitivity changed (dB offset). */
  onMicSensitivity: (db: number) => void = () => {};
  /** Saved mic sensitivity (dB offset), applied at startup. */
  readonly micSensitivity: number = loadSensitivity();

  readonly hud: Hud;

  private readonly title: HTMLElement;
  private readonly lobby: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly titleError: HTMLElement;
  private readonly titleButtons: HTMLButtonElement[];
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;

  private readonly lobbyCode: HTMLElement;
  private readonly lobbyCodeBlock: HTMLElement;
  private readonly lobbyPlayers: HTMLUListElement;
  private readonly lobbyMicStatus: HTMLElement;
  private readonly lobbyMeter: { root: HTMLElement; fill: HTMLElement };
  private readonly vrButton: HTMLButtonElement;
  private readonly startButton: HTMLButtonElement;
  private readonly lobbyError: HTMLElement;
  private readonly pauseStart: HTMLButtonElement;
  private readonly pauseVR: HTMLButtonElement;
  private readonly pauseInfo: HTMLElement;
  private readonly pauseError: HTMLElement;
  private readonly shareButton: HTMLButtonElement;

  constructor(root: HTMLElement) {
    // ---------- title ----------
    this.nameInput = el('input', { type: 'text', maxlength: '16', placeholder: 'Your name', autocomplete: 'off' });
    this.nameInput.value = loadName();
    this.codeInput = el('input', {
      type: 'text',
      maxlength: '8',
      placeholder: 'ROOM CODE',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
    });
    const joinParam = new URLSearchParams(location.search).get('join');
    if (joinParam) this.codeInput.value = joinParam.toUpperCase();

    const soloBtn = button('Play solo');
    const hostBtn = button('Host a game', 'primary');
    const joinBtn = button('Join');
    this.titleButtons = [soloBtn, hostBtn, joinBtn];
    this.titleError = el('p', { class: 'error', role: 'alert' });

    soloBtn.onclick = () => this.onSolo(this.name());
    hostBtn.onclick = () => this.onHost(this.name());
    joinBtn.onclick = () => {
      const code = this.codeInput.value.trim();
      if (!code) {
        this.showError('Type the room code your friend gave you.');
        this.codeInput.focus();
        return;
      }
      this.onJoin(this.name(), code);
    };
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinBtn.click();
    });

    this.title = el('div', { class: 'screen' }, [
      el('div', { class: 'panel' }, [
        el('h1', { class: 'logo' }, ['MUTE']),
        el('p', { class: 'tagline' }, ['It can’t see you. It can hear you.']),
        el('label', { for: 'mute-name' }, ['Name']),
        this.nameInput,
        el('h2', {}, ['Play']),
        el('div', { class: 'row' }, [soloBtn, hostBtn]),
        el('h2', {}, ['Join a friend']),
        el('div', { class: 'row' }, [this.codeInput, joinBtn]),
        this.titleError,
        el('p', { class: 'muted' }, [
          'Best with headphones and a microphone. Open this page in the Meta Quest browser for VR, ',
          'or play with keyboard + mouse.',
        ]),
        howToPlay(),
      ]),
    ]);
    this.nameInput.id = 'mute-name';

    // ---------- lobby ----------
    this.lobbyCode = el('div', { class: 'code' });
    this.shareButton = button('Copy invite link');
    this.shareButton.onclick = () => void this.copyInvite();
    this.lobbyCodeBlock = el('div', {}, [
      el('h2', {}, ['Room code']),
      this.lobbyCode,
      el('p', { class: 'muted' }, ['Friends open this page and type the code under “Join a friend”.']),
      this.shareButton,
    ]);
    this.lobbyPlayers = el('ul', { class: 'players' });
    this.lobbyMicStatus = el('p', { class: 'muted' }, ['Microphone: starting…']);
    this.lobbyMeter = micMeter();
    this.vrButton = button('Enter VR', 'primary');
    const desktopBtn = button('Play on this screen');
    this.startButton = button('Start round');
    const leaveBtn = button('Leave', 'danger');
    this.lobbyError = el('p', { class: 'error', role: 'alert' });
    this.vrButton.onclick = () => this.onEnterVR();
    desktopBtn.onclick = () => this.onPlayDesktop();
    this.startButton.onclick = () => this.onStartRound();
    leaveBtn.onclick = () => this.onLeave();

    this.lobby = el('div', { class: 'screen', hidden: '' }, [
      el('div', { class: 'panel' }, [
        el('h1', { class: 'logo', style: 'font-size:48px' }, ['MUTE']),
        this.lobbyCodeBlock,
        el('h2', {}, ['Players']),
        this.lobbyPlayers,
        el('h2', {}, ['Your voice']),
        this.lobbyMicStatus,
        this.lobbyMeter.root,
        el('p', { class: 'muted' }, ['Ticks: whisper · talk · shout. The monster hears what this meter hears.']),
        this.sensitivityControl(),
        el('h2', {}, ['Go']),
        el('div', { class: 'row' }, [this.vrButton, desktopBtn]),
        el('div', { class: 'row', style: 'margin-top:10px' }, [this.startButton, leaveBtn]),
        this.lobbyError,
        howToPlay(),
      ]),
    ]);

    // ---------- pause ----------
    const resumeBtn = button('Resume', 'primary');
    this.pauseStart = button('Start round');
    // Back into the headset mid-round (e.g. after taking it off or pressing the system button).
    this.pauseVR = button('Enter VR');
    this.pauseVR.hidden = true;
    const pauseLeave = button('Leave game', 'danger');
    this.pauseInfo = el('p', { class: 'muted' });
    this.pauseError = el('p', { class: 'error', role: 'alert' });
    resumeBtn.onclick = () => this.onResume();
    this.pauseStart.onclick = () => this.onStartRound();
    this.pauseVR.onclick = () => this.onEnterVR();
    pauseLeave.onclick = () => this.onLeave();
    this.pause = el('div', { class: 'screen', hidden: '' }, [
      el('div', { class: 'panel' }, [
        el('h1', { class: 'logo', style: 'font-size:48px' }, ['MUTE']),
        this.pauseInfo,
        el('div', { class: 'row' }, [resumeBtn, this.pauseStart]),
        el('div', { class: 'row', style: 'margin-top:10px' }, [this.pauseVR, pauseLeave]),
        this.pauseError,
        el('h2', {}, ['Controls']),
        controlsTable(),
      ]),
    ]);

    this.hud = new Hud();
    root.append(this.hud.root, this.title, this.lobby, this.pause);
  }

  /** Slider so every mic hits the same ticks: talking normally should land near the middle tick. */
  private sensitivityControl(): HTMLElement {
    const input = el('input', {
      type: 'range',
      min: String(-SENS_RANGE),
      max: String(SENS_RANGE),
      step: '1',
      'aria-label': 'Microphone sensitivity',
    });
    input.value = String(this.micSensitivity);
    const label = el('label', {}, []);
    const show = (db: number) => {
      label.textContent = `Mic sensitivity: ${db > 0 ? '+' : ''}${db} dB. Talk normally: the bar should reach the middle tick.`;
    };
    show(this.micSensitivity);
    input.addEventListener('input', () => {
      const db = Number(input.value) || 0;
      show(db);
      saveSensitivity(db);
      this.onMicSensitivity(db);
    });
    return el('div', { class: 'sens' }, [label, input]);
  }

  private name(): string {
    const n = this.nameInput.value.trim().slice(0, 16) || 'Survivor';
    saveName(n);
    return n;
  }

  private screens(): HTMLElement[] {
    return [this.title, this.lobby, this.pause];
  }

  private show(screen: HTMLElement | null): void {
    for (const s of this.screens()) s.hidden = s !== screen;
  }

  showTitle(): void {
    this.setBusy(false);
    this.hud.root.hidden = true;
    this.show(this.title);
  }

  setBusy(busy: boolean, label?: string): void {
    for (const b of this.titleButtons) b.disabled = busy;
    if (busy && label) this.titleError.textContent = label;
    else if (!busy) this.titleError.textContent = '';
    this.titleError.style.color = busy ? 'var(--dim)' : '';
  }

  showError(msg: string): void {
    this.titleError.style.color = '';
    this.titleError.textContent = msg;
    this.lobbyError.textContent = msg;
    this.pauseError.textContent = msg;
  }

  showLobby(info: LobbyInfo): void {
    this.lobbyCodeBlock.hidden = !info.code;
    this.lobbyCode.textContent = info.code ?? '';
    this.vrButton.disabled = !info.vrSupported;
    this.vrButton.title = info.vrSupported ? '' : 'No VR headset found. Open this page in the Meta Quest browser.';
    this.startButton.hidden = !info.isHost;
    this.lobbyError.textContent = '';
    this.hud.root.hidden = true;
    this.show(this.lobby);
  }

  setLobbyPlayers(players: LobbyPlayer[], localId: string): void {
    this.lobbyPlayers.replaceChildren(
      ...players.map((p) => {
        const dot = el('span', { class: 'dot' });
        dot.style.background = hex(p.color);
        return el('li', {}, [
          dot,
          p.name,
          el('span', { class: 'tag' }, [(p.id === localId ? 'you · ' : '') + (p.isDesktop ? 'desktop' : 'VR')]),
        ]);
      }),
    );
  }

  setMicStatus(status: 'on' | 'blocked'): void {
    this.lobbyMicStatus.textContent =
      status === 'on'
        ? 'Microphone: on. Say something and watch the meter.'
        : 'Microphone: blocked. You can still play, but you can’t talk (and the monster can’t hear you either, which is cheating a little).';
  }

  setMicLevel(level: number): void {
    this.lobbyMeter.fill.style.width = `${100 - Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;
    this.hud.setMicLevel(level);
  }

  /** Show the pause/round menu (desktop, or after leaving the headset). */
  showPause(isHost: boolean, phase: GamePhase, vrSupported = false, code: string | null = null): void {
    this.pauseStart.hidden = !isHost;
    this.pauseVR.hidden = !vrSupported;
    this.pauseError.textContent = '';
    this.pauseStart.textContent = phase === 'playing' ? 'Restart round' : phase === 'lobby' ? 'Start round' : 'Play again';
    // The lobby (with the room code) is gone once you're playing: keep the code findable for invites.
    const room = code ? ` Room code: ${code}.` : '';
    this.pauseInfo.textContent =
      (phase === 'lobby'
        ? isHost
          ? 'Everyone in? Start the round.'
          : 'Waiting for the host to start the round.'
        : phase === 'won'
          ? 'Someone got out.'
          : phase === 'lost'
            ? 'Nobody got out.'
            : 'Paused. (The monster is not.)') + room;
    this.show(this.pause);
  }

  /** Hide every menu (in-game). */
  hideMenus(showHud: boolean): void {
    this.show(null);
    this.hud.root.hidden = !showHud;
  }

  isMenuOpen(): boolean {
    return this.screens().some((s) => !s.hidden);
  }

  private async copyInvite(): Promise<void> {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('join', this.lobbyCode.textContent ?? '');
    try {
      await navigator.clipboard.writeText(url.toString());
      this.shareButton.textContent = 'Copied!';
    } catch {
      this.shareButton.textContent = url.toString();
    }
    setTimeout(() => (this.shareButton.textContent = 'Copy invite link'), 2500);
  }
}

/** Desktop heads-up display (VR uses in-world displays instead). */
export class Hud {
  readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly light: { root: HTMLElement; fill: HTMLElement; label: HTMLElement };
  private readonly meter: { root: HTMLElement; fill: HTMLElement };
  private readonly toast: HTMLElement;
  /** Small prompt under the crosshair ("E · read"). */
  private readonly aim: HTMLElement;
  private toastTimer = 0;
  private statusText = '';

  constructor() {
    this.status = el('div', { class: 'status' });
    const fill = el('div', { class: 'fill' });
    const label = el('div', { class: 'label' }, ['light']);
    this.light = { root: el('div', { class: 'light', hidden: '' }, [label, el('div', { class: 'bar' }, [fill])]), fill, label };
    this.meter = micMeter();
    this.toast = el('div', { class: 'toast' });
    this.aim = el('div', { class: 'aim' });
    this.root = el('div', { class: 'hud', hidden: '' }, [
      el('div', { class: 'crosshair' }),
      this.aim,
      this.status,
      this.light.root,
      el('div', { class: 'mic' }, [el('div', { class: 'label' }, ['your noise']), this.meter.root]),
      el('div', { class: 'hint' }, [
        'E grab/read · F light · hold R wind (loud) · 1–6 signs · Shift run · C sneak · Esc menu',
      ]),
      this.toast,
    ]);
  }

  setStatus(lines: string[]): void {
    // Called every frame. (Comparing with textContent never matched for multi-line text, since
    // <br> adds no text, so the HUD was rebuilt 60-90 times a second.)
    const text = lines.join('\n');
    if (this.statusText === text) return;
    this.statusText = text;
    this.status.replaceChildren(...lines.flatMap((l, i) => (i ? [el('br'), l] : [l])));
  }

  /**
   * What E does for what's under the crosshair ('' = nothing to say). While `reading` the
   * crosshair hides and the prompt moves down, off the note's text.
   */
  setAim(text: string, reading = false): void {
    if (this.aim.textContent !== text) this.aim.textContent = text;
    this.root.classList.toggle('reading', reading);
  }

  /** The Crank Light's battery (null hides it: not playing or not alive). */
  setLight(light: { charge: number; on: boolean; cranking: boolean } | null): void {
    const L = this.light;
    L.root.hidden = !light;
    if (!light) return;
    const pct = Math.round(Math.min(1, Math.max(0, light.charge)) * 100);
    const width = `${pct}%`;
    if (L.fill.style.width !== width) L.fill.style.width = width;
    const text = light.cranking ? 'winding…' : !light.on ? 'light off' : pct === 0 ? 'dead · hold R' : 'light';
    if (L.label.textContent !== text) L.label.textContent = text;
    L.root.classList.toggle('low', pct < 20);
    L.root.classList.toggle('off', !light.on);
    L.root.classList.toggle('winding', light.cranking);
  }

  setMicLevel(level: number): void {
    this.meter.fill.style.width = `${100 - Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;
  }

  showMessage(text: string, seconds = 3): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), seconds * 1000);
  }
}
