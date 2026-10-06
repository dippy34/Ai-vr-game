/**
 * Web entry point: wires the platform layer (three.js renderer, WebXR/desktop input, WebAudio),
 * the DOM menus, and a Session together. Everything platform-specific is constructed here, so a
 * native shell would swap this file (and src/platform) and keep the rest.
 */

import { Game } from './game/game';
import { createSession, type SessionMode } from './game/session';
import { enterVR, exitVR, isVRSupported } from './game/xr';
import type { TransportKind } from './net';
import { AudioManager } from './platform/audio/AudioManager';
import { InputManager } from './platform/input/InputManager';
import { GameRenderer } from './platform/render/GameRenderer';
import { UI } from './ui/ui';

const appRoot = document.getElementById('app')!;
const uiRoot = document.getElementById('ui')!;

const renderer = new GameRenderer(appRoot);
const input = new InputManager(renderer.ctx, renderer.ctx.renderer.domElement);
const audio = new AudioManager();
const ui = new UI(uiRoot);
const game = new Game(renderer, input, audio, ui);

/** `?net=local` = multiplayer across tabs of one browser (no internet needed), for testing. */
const transportKind: TransportKind =
  new URLSearchParams(location.search).get('net') === 'local' ? 'local' : 'peerjs';

let vrSupported = false;
void isVRSupported().then((ok) => (vrSupported = ok));

input.setEnabled(false);
ui.showTitle();
audio.setMicSensitivity(ui.micSensitivity);
ui.onMicSensitivity = (db) => audio.setMicSensitivity(db);

// Handle for automated browser tests and console poking: dev server, or a build made with
// VITE_TEST_HOOKS=1 (never set for real deploys).
if (import.meta.env.DEV || import.meta.env.VITE_TEST_HOOKS === '1') {
  (window as unknown as { __mute: unknown }).__mute = { renderer, input, audio, ui, game };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The mic track we watch for 'ended' (device unplugged, taken by another app...). */
let watchedMic: MediaStreamTrack | null = null;
let lastMicRetry = -Infinity;

/**
 * Get (or keep) the microphone and hand it to the game. Returns the same stream while it works, so
 * calling it again is cheap; after the device went away it asks for the default one again.
 */
async function ensureMic(): Promise<void> {
  const mic = await audio.startMic();
  ui.setMicStatus(mic ? 'on' : 'blocked');
  game.setMicStream(mic);
  const track = mic?.getAudioTracks()[0] ?? null;
  if (!track || track === watchedMic) return;
  watchedMic = track;
  track.addEventListener(
    'ended',
    () => {
      if (watchedMic !== track) return;
      watchedMic = null;
      // At most one automatic retry every few seconds, in case a device keeps dropping out.
      const now = performance.now();
      if (now - lastMicRetry < 5000) {
        ui.setMicStatus('blocked');
        game.setMicStream(null);
        return;
      }
      lastMicRetry = now;
      setTimeout(() => void ensureMic().catch((e) => console.warn('[mic] re-acquire failed', e)), 500);
    },
    { once: true },
  );
}

async function begin(mode: SessionMode, name: string, code?: string): Promise<void> {
  ui.setBusy(true, mode === 'join' ? 'Joining…' : mode === 'host' ? 'Opening a room…' : 'Loading…');
  try {
    // Both need the click that got us here (browsers require a user gesture).
    await audio.unlock();
    // Every time: a mic that was unplugged (or denied) since the last game gets another chance.
    await ensureMic();
    const session = await createSession(mode, { name, isDesktop: !vrSupported, kind: transportKind, code });
    game.attach(session);
    ui.setBusy(false);
    ui.showLobby({ code: session.roomCode, isHost: session.isHost, vrSupported });
    ui.setLobbyPlayers(session.lobbyPlayers(), session.localId);
  } catch (e) {
    console.error(e);
    ui.setBusy(false);
    ui.showError(errorText(e));
  }
}

function playOnDesktop(): void {
  ui.hideMenus(true);
  game.setPaused(false);
  input.setEnabled(true);
}

function leave(): void {
  exitVR(renderer.ctx.renderer);
  game.detach();
  input.setEnabled(false);
  game.setPaused(false);
  ui.showTitle();
}

ui.onSolo = (name) => void begin('solo', name);
ui.onHost = (name) => void begin('host', name);
ui.onJoin = (name, code) => void begin('join', name, code);

ui.onEnterVR = () => {
  enterVR(renderer.ctx.renderer, () => {
    // Back from the headset: show the menu again.
    const session = game.current;
    if (session) {
      game.setPaused(true);
      ui.showPause(session.isHost, session.state.phase, vrSupported, session.roomCode);
    }
  })
    .then(() => {
      ui.hideMenus(false);
      game.setPaused(false);
    })
    .catch((e) => ui.showError(`Couldn't start VR: ${errorText(e)}`));
};

ui.onPlayDesktop = playOnDesktop;
ui.onResume = playOnDesktop;
ui.onLeave = leave;
ui.onStartRound = () => {
  game.startRound();
  if (!renderer.ctx.renderer.xr.isPresenting) playOnDesktop();
};

game.onMenu = () => {
  const session = game.current;
  // Esc while a menu (e.g. the lobby with the room code) is already up must not replace it.
  if (!session || ui.isMenuOpen()) return;
  input.setEnabled(false);
  game.setPaused(true);
  ui.showPause(session.isHost, session.state.phase, vrSupported, session.roomCode);
};

game.onDisconnected = (reason) => {
  leave();
  ui.showError(reason);
};

// Installable / offline-capable (also the base for a store PWA wrapper later).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker failed', e));
  });
}
