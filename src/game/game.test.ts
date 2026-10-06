/**
 * Game loop glue with fake platform objects: attach/detach cycles, mid-round joins and dt spikes.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLevel } from '../core/level';
import { GameSim } from '../core/sim';
import type { PlayerPose, SimEvent, WorldState } from '../core/types';
import type { IAudioManager, IGameRenderer, IInputManager, InputFrame } from '../platform/types';
import type { UI } from '../ui/ui';
import { Game } from './game';
import type { Session, SessionCallbacks } from './session';

function fakes() {
  const camera = new THREE.PerspectiveCamera();
  const rig = new THREE.Group();
  rig.add(camera);
  camera.position.set(0, 1.6, 0);
  let loop: ((t: number) => void) | null = null;
  const hold = { messages: false };
  const renderer = {
    ctx: {
      renderer: { setAnimationLoop: (fn: (t: number) => void) => (loop = fn), xr: { isPresenting: false } },
      scene: new THREE.Scene(),
      camera,
      rig,
    },
    loadLevel: vi.fn(),
    update: vi.fn(),
    setRemotePose: vi.fn(),
    flash: vi.fn(),
    setLocalNoiseLevel: vi.fn(),
    showMessage: vi.fn(),
    holdingMessages: () => hold.messages,
    render: vi.fn(),
  } as unknown as IGameRenderer;
  const hand = () => ({ tracked: true, position: { x: 0, y: 1.2, z: -0.3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, curls: [0, 0, 0, 0, 0] as [number, number, number, number, number] });
  const no = () => ({ left: false, right: false });
  const input: IInputManager = {
    mode: 'desktop',
    setEnabled: vi.fn(),
    update: (): InputFrame => {
      rig.updateMatrixWorld(true);
      const p = camera.getWorldPosition(new THREE.Vector3());
      return {
        mode: 'desktop', move: { x: 0, y: 0 }, sprint: false, sneak: false,
        head: { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        left: hand(), right: hand(), grip: no(), gripPressed: no(), gripReleased: no(), triggerPressed: no(),
        usePressed: false, menuPressed: false,
      };
    },
  };
  const audio = {
    unlock: vi.fn(), startMic: vi.fn(), setMicSensitivity: vi.fn(), setLevel: vi.fn(), getMicLevel: () => 0,
    addRemoteVoice: vi.fn(), removeRemoteVoice: vi.fn(), update: vi.fn(), playEvent: vi.fn(), playFootstep: vi.fn(),
  } as unknown as IAudioManager;
  const messages: string[] = [];
  const ui = {
    hud: { showMessage: (t: string) => messages.push(t), setStatus: vi.fn(), setFilm: vi.fn(), setMicLevel: vi.fn() },
    setMicLevel: vi.fn(),
    setLobbyPlayers: vi.fn(),
  } as unknown as UI;
  const game = new Game(renderer, input, audio, ui);
  let t = 0;
  const frames = (n: number, ms = 1000 / 60) => {
    for (let i = 0; i < n; i++) loop!((t += ms));
  };
  return { game, renderer, audio, messages, frames, rig, hold };
}

/** A minimal Session around a GameSim, standing in for a client that joined a running round. */
function fakeSession(sim: GameSim, localId: string): Session & { closed: number; voiceHandlers: number } {
  const s = {
    isHost: false,
    localId,
    level: sim.level,
    roomCode: 'ABCDE',
    closed: 0,
    voiceHandlers: 0,
    voice: {
      setLocalStream: vi.fn(),
      onRemoteStream: () => void s.voiceHandlers++,
      onRemoteStreamEnded: () => void s.voiceHandlers++,
    },
    get state(): WorldState {
      return sim.state;
    },
    callbacks: null as unknown as SessionCallbacks,
    lobbyPlayers: () => [],
    sendPose: (p: PlayerPose) => sim.setPlayerPose(localId, p),
    sendVoice: vi.fn(),
    sendNoise: vi.fn(),
    sendAction: vi.fn(),
    startRound: vi.fn(),
    update: (dt: number) => {
      for (const e of sim.step(dt)) s.callbacks.onEvent(e);
    },
    close: () => void s.closed++,
  };
  return s;
}

afterEach(() => vi.restoreAllMocks());

describe('Game', () => {
  it('a player joining mid-round gets a real round summary (not 0:00)', () => {
    const { game, messages, frames } = fakes();
    const sim = new GameSim(createLevel(3));
    sim.addPlayer('host', 'Host', true);
    sim.startRound();
    sim.addPlayer('me', 'Me', true);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
    const session = fakeSession(sim, 'me');
    game.attach(session);
    frames(5);
    now.mockReturnValue(1_000_000 + 95_000);
    session.callbacks.onEvent({ type: 'phase', phase: 'won' } satisfies SimEvent);
    expect(messages.at(-1)).toMatch(/1:35 in the house/);
  });

  it('desktop HUD messages wait until the catch sequence lets go of the screen', () => {
    const { game, messages, frames, hold } = fakes();
    const sim = new GameSim(createLevel(3));
    sim.addPlayer('me', 'Me', true);
    sim.startRound();
    const session = fakeSession(sim, 'me');
    game.attach(session);
    frames(2);
    const before = messages.length;
    hold.messages = true;
    session.callbacks.onEvent({ type: 'phase', phase: 'lost' } satisfies SimEvent);
    frames(3);
    expect(messages.length).toBe(before);
    hold.messages = false;
    frames(1);
    expect(messages.length).toBe(before + 1);
    expect(messages.at(-1)).toMatch(/Nobody made it out/);
    frames(3);
    expect(messages.length).toBe(before + 1);
  });

  it('attach/detach cycles close sessions and leak nothing per cycle', () => {
    const { game, audio, frames } = fakes();
    const sessions: ReturnType<typeof fakeSession>[] = [];
    for (let i = 0; i < 5; i++) {
      const sim = new GameSim(createLevel(i));
      sim.addPlayer('me', 'Me', true);
      sim.addPlayer('other', 'O', false);
      const s = fakeSession(sim, 'me');
      sessions.push(s);
      game.attach(s); // attaching a new one detaches the old one
      frames(3);
    }
    game.detach();
    expect(sessions.map((s) => s.closed)).toEqual([1, 1, 1, 1, 1]);
    expect(sessions.map((s) => s.voiceHandlers)).toEqual([2, 2, 2, 2, 2]);
    expect(game.current).toBeNull();
    expect(audio.removeRemoteVoice).toHaveBeenCalledWith('other');
    frames(3); // the loop keeps rendering the title without a session
  });

  it('a long frame (tab hidden, then visible) is clamped before it reaches the sim', () => {
    const { game, frames } = fakes();
    const sim = new GameSim(createLevel(3));
    sim.addPlayer('me', 'Me', true);
    sim.startRound();
    game.attach(fakeSession(sim, 'me'));
    frames(2);
    const t0 = sim.state.time;
    frames(1, 60_000); // a minute in the background
    expect(sim.state.time - t0).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});
