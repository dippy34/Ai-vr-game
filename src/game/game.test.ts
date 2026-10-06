/**
 * Game loop glue with fake platform objects: attach/detach cycles, mid-round joins and dt spikes.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLevel } from '../core/level';
import { GameSim } from '../core/sim';
import type { PlayerPose, SimEvent, WorldState } from '../core/types';
import type { IAudioManager, IGameRenderer, IInputManager, InputFrame, Readable } from '../platform/types';
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
  const notes: Readable[] = [];
  /** Input for the next frame (reset after it). */
  const next = { use: false, move: { x: 0, y: 0 } };
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
    readables: () => notes,
    render: vi.fn(),
  } as unknown as IGameRenderer;
  const hand = () => ({ tracked: true, position: { x: 0, y: 1.2, z: -0.3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, curls: [0, 0, 0, 0, 0] as [number, number, number, number, number] });
  const no = () => ({ left: false, right: false });
  const input = {
    mode: 'desktop',
    setEnabled: vi.fn(),
    setLean: vi.fn(),
    leaning: false,
    update: (): InputFrame => {
      rig.updateMatrixWorld(true);
      const p = camera.getWorldPosition(new THREE.Vector3());
      const q = camera.getWorldQuaternion(new THREE.Quaternion());
      const frame: InputFrame = {
        mode: 'desktop', move: { ...next.move }, sprint: false, sneak: false,
        head: { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } },
        left: hand(), right: hand(), grip: no(), gripPressed: no(), gripReleased: no(), triggerPressed: no(),
        usePressed: next.use, menuPressed: false,
      };
      next.use = false;
      next.move = { x: 0, y: 0 };
      return frame;
    },
  } satisfies IInputManager;
  const audio = {
    unlock: vi.fn(), startMic: vi.fn(), setMicSensitivity: vi.fn(), setLevel: vi.fn(), getMicLevel: () => 0,
    addRemoteVoice: vi.fn(), removeRemoteVoice: vi.fn(), update: vi.fn(), playEvent: vi.fn(), playFootstep: vi.fn(),
  } as unknown as IAudioManager;
  const messages: string[] = [];
  const ui = {
    hud: { showMessage: (t: string) => messages.push(t), setStatus: vi.fn(), setFilm: vi.fn(), setMicLevel: vi.fn(), setAim: vi.fn() },
    setMicLevel: vi.fn(),
    setLobbyPlayers: vi.fn(),
  } as unknown as UI;
  const game = new Game(renderer, input, audio, ui);
  let t = 0;
  const frames = (n: number, ms = 1000 / 60) => {
    for (let i = 0; i < n; i++) loop!((t += ms));
  };
  return { game, renderer, audio, messages, frames, rig, camera, hold, notes, next, input, ui };
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

  describe('desktop reading (lean in over a note)', () => {
    /** A playing round, looking 0.9 rad down; returns the eye and a point 1.1 m along the view. */
    function reading() {
      const f = fakes();
      const sim = new GameSim(createLevel(3));
      sim.addPlayer('me', 'Me', true);
      sim.startRound();
      const session = fakeSession(sim, 'me');
      f.game.attach(session);
      f.camera.rotation.x = -0.9;
      f.frames(2);
      const eye = f.camera.getWorldPosition(new THREE.Vector3());
      const look = new THREE.Vector3(0, 0, -1).applyQuaternion(f.camera.getWorldQuaternion(new THREE.Quaternion()));
      const at = (dist: number, side = 0) => {
        const p = eye.clone().addScaledVector(look, dist);
        return { x: p.x + side, y: p.y, z: p.z };
      };
      return { ...f, sim, session, at };
    }

    it('E on a note in your sights leans in over it; E again stands you up', () => {
      const { notes, next, frames, input, ui, at } = reading();
      notes.push({ position: at(1.1), readYaw: 0.5 });
      frames(1);
      expect(ui.hud.setAim).toHaveBeenLastCalledWith('E · read', false);
      next.use = true;
      frames(1);
      expect(input.setLean).toHaveBeenLastCalledWith(expect.objectContaining({ yaw: 0.5 }));
      const lean = input.setLean.mock.calls.at(-1)![0] as { position: { y: number } };
      expect(lean.position.y).toBeCloseTo(notes[0].position.y + 0.3, 5);
      frames(1);
      expect(ui.hud.setAim).toHaveBeenLastCalledWith('E · stand up', true);
      next.use = true;
      frames(1);
      expect(input.setLean).toHaveBeenLastCalledWith(null);
    });

    it('moving stands you up; far, off-center or no notes: E does not read', () => {
      const { notes, next, frames, input, at } = reading();
      notes.push({ position: at(1.1), readYaw: 0 });
      next.use = true;
      frames(1);
      next.move = { x: 0, y: 1 };
      frames(1);
      expect(input.setLean).toHaveBeenLastCalledWith(null);

      input.setLean.mockClear();
      notes.length = 0;
      notes.push({ position: at(2.5), readYaw: 0 }, { position: at(1.1, 0.6), readYaw: 0 });
      next.use = true;
      frames(1);
      expect(input.setLean).not.toHaveBeenCalled();
    });

    it('leaning in over a table moves only the eyes (the table does not push you away)', () => {
      const { frames, input, rig, camera } = reading();
      const overTable = (leaning: boolean) => {
        (input as { leaning: boolean }).leaning = leaning;
        const start = rig.position.clone();
        // Eyes 0.3 m over the foyer camera table (x -2.9..-2.3, z 6.1..6.9, top 0.75).
        camera.position.set(-2.55 - rig.position.x, 1.05, 6.4 - rig.position.z);
        frames(3);
        const moved = rig.position.distanceTo(start);
        rig.position.copy(start);
        camera.position.set(0, 1.6, 0);
        return moved;
      };
      expect(overTable(true)).toBeLessThan(1e-9);
      expect(overTable(false)).toBeGreaterThan(0.05);
    });

    it('a pickup more in the middle of your view wins over a note next to it', () => {
      const { notes, next, frames, input, session, sim, at } = reading();
      sim.state.camera.position = at(1.0);
      notes.push({ position: at(1.0, 0.12), readYaw: 0 });
      next.use = true;
      frames(1);
      expect(input.setLean).not.toHaveBeenCalled();
      expect(session.sendAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'grab' }));
    });
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
