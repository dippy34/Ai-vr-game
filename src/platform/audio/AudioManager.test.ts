import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonsterMode, PlayerState, SimEvent, WorldState } from '../../core/types';
import { AudioManager } from './AudioManager';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const hand = () => ({ tracked: false, position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, curls: [0, 0, 0, 0, 0] as [number, number, number, number, number] });

function player(id: string, x: number, z: number, status: PlayerState['status'] = 'alive'): PlayerState {
  return {
    id,
    name: id,
    color: 0xffffff,
    isDesktop: true,
    status,
    spawn: { x, y: 0, z },
    spawnYaw: 0,
    pose: { head: { position: { x, y: 1.6, z }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, left: hand(), right: hand() },
    held: { left: null, right: null },
  };
}

function world(): WorldState {
  return {
    time: 0,
    phase: 'playing',
    levelSeed: 1,
    players: { me: player('me', 0, 0), a: player('a', 3, 0), b: player('b', -4, 2) },
    monster: { position: { x: 10, y: 0, z: 0 }, yaw: 0, mode: 'wander', target: null, targetPlayer: null, speed: 1, alert: 0 },
    items: [],
    camera: { holder: null, hand: null, position: { x: 0, y: 1, z: 0 }, yaw: 0, film: 6, lastFlashTime: -1e9 },
    fusesInserted: 0,
    fusesRequired: 3,
    exitOpen: false,
    lastHeard: null,
  };
}

const head = { position: { x: 0, y: 1.6, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
const p0 = { x: 1, y: 1, z: 1 };

const ALL_EVENTS: SimEvent[] = [
  { type: 'phase', phase: 'playing' },
  { type: 'flash', by: 'me', position: p0, direction: { x: 0, y: 0, z: -1 }, time: 0 },
  { type: 'dryFire', by: 'a', position: p0 },
  { type: 'pickup', by: 'a', what: 'camera', position: p0 },
  { type: 'pickup', by: 'a', what: 'fuse', position: p0 },
  { type: 'pickup', by: 'a', what: 'film', position: p0 },
  { type: 'drop', by: 'a', what: 'camera', position: p0 },
  { type: 'drop', by: 'a', what: 'fuse', position: p0 },
  { type: 'drop', by: 'a', what: 'film', position: p0 },
  { type: 'filmLoaded', by: 'a', amount: 3, total: 5, position: p0 },
  { type: 'fuseInserted', by: 'a', count: 1, required: 3, position: p0 },
  { type: 'fuseInserted', by: 'a', count: 3, required: 3, position: p0 },
  { type: 'exitOpened', position: p0 },
  { type: 'monsterAlert', mode: 'investigate', position: p0 },
  { type: 'monsterAlert', mode: 'chase', position: p0 },
  { type: 'playerCaught', id: 'a', position: p0 },
  { type: 'playerCaught', id: 'me', position: p0 },
  { type: 'playerEscaped', id: 'b' },
  { type: 'playerEscaped', id: 'me' },
  { type: 'phase', phase: 'won' },
  { type: 'phase', phase: 'lost' },
  { type: 'phase', phase: 'lobby' },
];

// ---------------------------------------------------------------------------------------------
// No WebAudio (plain node)
// ---------------------------------------------------------------------------------------------

describe('AudioManager without WebAudio', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('constructs with no args and every method is a safe no-op', async () => {
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    const am = new AudioManager();
    expect(am.getMicLevel()).toBe(0);
    const fakeStream = {} as MediaStream;
    expect(() => am.addRemoteVoice('a', fakeStream)).not.toThrow();
    expect(() => am.removeRemoteVoice('a')).not.toThrow();
    expect(() => am.removeRemoteVoice('nobody')).not.toThrow();
    expect(() => am.update(world(), 'me', head, 1 / 72)).not.toThrow();
    for (const ev of ALL_EVENTS) expect(() => am.playEvent(ev, 'me')).not.toThrow();
    expect(() => am.playFootstep({ x: 0, y: 0, z: 0 }, 0.18)).not.toThrow();
    await expect(am.unlock()).resolves.toBeUndefined();
    await expect(am.unlock()).resolves.toBeUndefined();
    await expect(am.startMic()).resolves.toBeNull();
    expect(am.getMicLevel()).toBe(0);
    // Still no-ops after a failed unlock.
    expect(() => am.update(world(), 'me', head, 1 / 72)).not.toThrow();
    for (const ev of ALL_EVENTS) expect(() => am.playEvent(ev, 'me')).not.toThrow();
  });

  it('survives garbage input', () => {
    const am = new AudioManager();
    expect(() => am.update(undefined as unknown as WorldState, 'me', undefined as never, NaN)).not.toThrow();
    expect(() => am.playEvent(undefined as unknown as SimEvent, 'me')).not.toThrow();
    expect(() => am.playFootstep(undefined as never, NaN)).not.toThrow();
  });

  it('does not throw when the AudioContext constructor throws', async () => {
    vi.stubGlobal('AudioContext', function Broken() {
      throw new Error('no audio device');
    });
    const am = new AudioManager();
    await expect(am.unlock()).resolves.toBeUndefined();
    expect(() => am.update(world(), 'me', head, 1 / 72)).not.toThrow();
    expect(() => am.playEvent({ type: 'exitOpened', position: p0 }, 'me')).not.toThrow();
  });

  it('returns null when the mic is denied', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.reject(new Error('NotAllowedError')) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const am = new AudioManager();
    await expect(am.startMic()).resolves.toBeNull();
    expect(am.getMicLevel()).toBe(0);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// Strict fake WebAudio: throws where browsers throw, so we catch scheduling bugs in node.
// ---------------------------------------------------------------------------------------------

interface Ev { time: number; end: number; curve: boolean }

/** Every error the fake throws is counted, even ones the code under test catches. */
let fakeErrors: string[] = [];
function fail(Kind: new (m: string) => Error, msg: string): never {
  fakeErrors.push(msg);
  throw new Kind(msg);
}

class FakeParam {
  private v: number;
  events: Ev[] = [];
  constructor(private ctx: FakeContext, v: number) { this.v = v; }
  get value(): number { return this.v; }
  set value(x: number) {
    this.finite(x);
    this.v = x;
    this.add(this.ctx.currentTime, 0, false);
  }
  private finite(...xs: number[]) {
    for (const x of xs) if (!Number.isFinite(x)) fail(TypeError, `non-finite ${x}`);
  }
  private add(time: number, dur: number, curve: boolean) {
    if (time < 0) fail(RangeError, 'negative time');
    for (const e of this.events) {
      if (e.curve && time >= e.time && time < e.end) fail(Error, 'NotSupportedError: event inside curve');
      if (curve && e.time >= time && e.time < time + dur) fail(Error, 'NotSupportedError: curve overlaps event');
    }
    this.events.push({ time, end: time + dur, curve });
  }
  setValueAtTime(x: number, t: number) { this.finite(x, t); this.add(t, 0, false); this.v = x; return this; }
  linearRampToValueAtTime(x: number, t: number) { this.finite(x, t); this.add(t, 0, false); return this; }
  exponentialRampToValueAtTime(x: number, t: number) {
    this.finite(x, t);
    if (x <= 0) fail(RangeError, 'exponential ramp to <= 0');
    this.add(t, 0, false);
    return this;
  }
  setTargetAtTime(x: number, t: number, tc: number) {
    this.finite(x, t, tc);
    if (tc < 0) fail(RangeError, 'negative time constant');
    this.add(t, 0, false);
    return this;
  }
  setValueCurveAtTime(values: ArrayLike<number>, t: number, d: number) {
    this.finite(t, d);
    if (values.length < 2) fail(Error, 'InvalidStateError: curve too short');
    if (!(d > 0)) fail(RangeError, 'duration');
    for (let i = 0; i < values.length; i++) this.finite(values[i]);
    this.add(t, d, true);
    return this;
  }
  cancelScheduledValues(t: number) { this.finite(t); this.events = this.events.filter((e) => e.time < t); return this; }
  cancelAndHoldAtTime(t: number) { return this.cancelScheduledValues(t); }
}

class FakeNode {
  outputs = new Set<unknown>();
  constructor(readonly ctx: FakeContext) { ctx.nodes++; }
  connect<T>(dest: T): T {
    if (!dest) fail(Error, 'connect to nothing');
    this.outputs.add(dest);
    return dest;
  }
  disconnect() { this.outputs.clear(); }
}

class FakeSource extends FakeNode {
  started = false;
  onended: (() => void) | null = null;
  start(when = 0) {
    if (this.started) fail(Error, 'InvalidStateError: start twice');
    if (!Number.isFinite(when) || when < 0) fail(RangeError, 'start time');
    this.started = true;
    this.ctx.liveSources++;
  }
  stop(when = 0) {
    if (!this.started) fail(Error, 'InvalidStateError: stop before start');
    if (!Number.isFinite(when) || when < 0) fail(RangeError, 'stop time');
  }
}

class FakeBuffer {
  private data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(c: number) { return this.data[c]; }
}

class FakeContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  nodes = 0;
  liveSources = 0;
  micAmplitude = 0.25;
  destination: FakeNode;
  listener: Record<string, FakeParam>;
  constructor() {
    this.destination = new FakeNode(this);
    this.listener = {};
    for (const k of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) this.listener[k] = new FakeParam(this, 0);
    FakeContext.last = this;
  }
  static last: FakeContext | null = null;
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  private p(v: number) { return new FakeParam(this, v); }
  createGain() { return Object.assign(new FakeNode(this), { gain: this.p(1) }); }
  createBiquadFilter() { return Object.assign(new FakeNode(this), { type: 'lowpass', frequency: this.p(350), Q: this.p(1), gain: this.p(0), detune: this.p(0) }); }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(this), { threshold: this.p(-24), knee: this.p(30), ratio: this.p(12), attack: this.p(0.003), release: this.p(0.25) });
  }
  createWaveShaper() { return Object.assign(new FakeNode(this), { curve: null, oversample: 'none' }); }
  createStereoPanner() { return Object.assign(new FakeNode(this), { pan: this.p(0) }); }
  createOscillator() { return Object.assign(new FakeSource(this), { type: 'sine', frequency: this.p(440), detune: this.p(0) }); }
  createBufferSource() { return Object.assign(new FakeSource(this), { buffer: null, loop: false, playbackRate: this.p(1), detune: this.p(0) }); }
  createBuffer(ch: number, len: number, sr: number) {
    if (!(len > 0)) fail(Error, 'NotSupportedError: empty buffer');
    return new FakeBuffer(ch, len, sr);
  }
  createPanner() {
    const n = new FakeNode(this);
    return Object.assign(n, {
      panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 1, maxDistance: 10000,
      coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0,
      positionX: this.p(0), positionY: this.p(0), positionZ: this.p(0),
      orientationX: this.p(1), orientationY: this.p(0), orientationZ: this.p(0),
    });
  }
  createMediaStreamSource() { return new FakeNode(this); }
  createAnalyser() {
    const ctx = this;
    return Object.assign(new FakeNode(this), {
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      getFloatTimeDomainData(arr: Float32Array) {
        for (let i = 0; i < arr.length; i++) arr[i] = ctx.micAmplitude * Math.sin(i * 0.3);
      },
    });
  }
}

function fakeStream(): MediaStream {
  const track = { readyState: 'live', getSettings: () => ({ autoGainControl: false }), applyConstraints: () => Promise.resolve() };
  return { getAudioTracks: () => [track], addEventListener() {}, removeEventListener() {} } as unknown as MediaStream;
}

describe('AudioManager with a strict fake WebAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs every code path without WebAudio errors and keeps one-shots bounded', async () => {
    fakeErrors = [];
    vi.stubGlobal('AudioContext', FakeContext);
    const getUserMedia = vi.fn(() => Promise.resolve(fakeStream()));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const am = new AudioManager();
    am.addRemoteVoice('a', fakeStream()); // before unlock: queued
    await am.unlock();
    await am.unlock(); // twice is fine
    const ctx = FakeContext.last!;
    expect(ctx.state).toBe('running');

    // Mic: AGC must be off; loud input registers, and the analyser is never routed audibly.
    const stream = await am.startMic();
    expect(stream).not.toBeNull();
    const constraints = (getUserMedia.mock.calls[0] as unknown[])[0] as { audio: MediaTrackConstraints };
    expect(constraints.audio.autoGainControl).toBe(false);
    expect(constraints.audio.echoCancellation).toBe(true);
    expect(constraints.audio.noiseSuppression).toBe(true);
    expect(am.getMicLevel()).toBeGreaterThan(0.5);

    am.addRemoteVoice('b', fakeStream());
    const st = world();
    const dt = 1 / 72;
    const modes: MonsterMode[] = ['wander', 'investigate', 'chase', 'feeding'];
    for (let f = 0; f < 72 * 40; f++) {
      ctx.currentTime += dt;
      st.time += dt;
      const sec = Math.floor(f / 72);
      st.monster.mode = modes[Math.floor(sec / 6) % modes.length];
      st.monster.speed = st.monster.mode === 'chase' ? 3.1 : st.monster.mode === 'feeding' ? 0 : 1.2;
      st.monster.alert = (Math.sin(f / 100) + 1) / 2;
      st.monster.position.x = 10 * Math.cos(f / 300);
      st.players.a.pose.head.position.x += 2.5 * dt; // walking remote
      st.players.b.pose.head.position.z += 3.3 * dt; // sprinting remote
      if (f === 72 * 10) st.players.a.status = 'caught';
      if (f === 72 * 20) st.players.me.status = 'caught';
      if (f % 50 === 0) am.playFootstep({ x: 0, y: 0, z: 0 }, 0.18);
      if (f % 97 === 0) am.playEvent(ALL_EVENTS[(f / 97) % ALL_EVENTS.length], 'me');
      am.update(st, 'me', head, dt);
      const pool = (am as unknown as { eng: { pool: { count: number } } }).eng.pool;
      expect(pool.count).toBeLessThanOrEqual(24);
    }
    // Burst of every event at once (voice stealing path).
    for (let i = 0; i < 3; i++) for (const ev of ALL_EVENTS) am.playEvent(ev, 'me');
    for (let f = 0; f < 72 * 12; f++) {
      ctx.currentTime += dt;
      am.update(st, 'me', head, dt);
    }
    // Teleport + removal paths.
    st.players.b.pose.head.position.z += 50;
    am.update(st, 'me', head, dt);
    delete (st.players as Record<string, PlayerState>).b;
    am.update(st, 'me', head, dt);
    am.removeRemoteVoice('a');
    am.removeRemoteVoice('b');

    expect(fakeErrors).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    // Sounds really were made (breath loops, steps, events...).
    expect(ctx.liveSources).toBeGreaterThan(1000);
    const pool = (am as unknown as { eng: { pool: { count: number } } }).eng.pool;
    expect(pool.count).toBeLessThanOrEqual(6);

    // Mic falls silent within MIC.release once the input stops.
    ctx.micAmplitude = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 400) am.getMicLevel();
    expect(am.getMicLevel()).toBe(0);
  });

  it('ignores events while the context is suspended (no backlog of stingers)', async () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const am = new AudioManager();
    await am.unlock();
    const ctx = FakeContext.last!;
    ctx.state = 'suspended';
    const before = ctx.nodes;
    for (const ev of ALL_EVENTS) am.playEvent(ev, 'me');
    am.playFootstep({ x: 0, y: 0, z: 0 }, 0.4);
    am.update(world(), 'me', head, 1 / 72);
    expect(ctx.nodes).toBe(before);
  });
});

describe('AudioManager device / context loss', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resumes a context suspended behind its back (Quest headset sleep) without a DOM gesture', async () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const am = new AudioManager();
    await am.unlock();
    const ctx = FakeContext.last!;
    expect(ctx.state).toBe('running');
    // The headset slept: the browser suspended the context. In VR there are no DOM clicks to
    // resume it from, but the page has had user activation, so resume() is allowed.
    ctx.state = 'suspended';
    const resume = vi.spyOn(ctx, 'resume');
    for (let f = 0; f < 72 * 3; f++) am.update(world(), 'me', head, 1 / 72);
    expect(resume).toHaveBeenCalled();
    expect(resume.mock.calls.length).toBeLessThanOrEqual(4); // throttled, not every frame
    expect(ctx.state).toBe('running');
  });

  it('rebuilds the mic meter on a new device after the old one was unplugged', async () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const streams: MediaStream[] = [];
    const getUserMedia = vi.fn(() => {
      const s = fakeStream();
      streams.push(s);
      return Promise.resolve(s);
    });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const am = new AudioManager();
    await am.unlock();
    const ctx = FakeContext.last!;
    const sources = vi.spyOn(ctx, 'createMediaStreamSource');
    const first = await am.startMic();
    expect(first).toBe(streams[0]);
    expect(sources).toHaveBeenLastCalledWith(streams[0]);
    // Asking again while the mic works hands back the same stream (no prompt, no new graph).
    expect(await am.startMic()).toBe(first);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // Unplugged: the track ends. The meter goes quiet and a new request gets a new device...
    (first!.getAudioTracks()[0] as { readyState: string }).readyState = 'ended';
    const t0 = performance.now();
    while (performance.now() - t0 < 400) am.getMicLevel();
    expect(am.getMicLevel()).toBe(0);
    const second = await am.startMic();
    expect(second).toBe(streams[1]);
    // ...whose audio the meter now actually reads.
    expect(sources).toHaveBeenLastCalledWith(streams[1]);
    const t1 = performance.now();
    while (performance.now() - t1 < 50) am.getMicLevel();
    expect(am.getMicLevel()).toBeGreaterThan(0.5);
  });
});
