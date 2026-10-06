import * as THREE from 'three';
import { PLAYER, RENDER } from '../../config';
import type {
  FlashEvent,
  Handedness,
  LevelData,
  PlayerId,
  PlayerPose,
  WorldState,
} from '../../core/types';
import type { IGameRenderer, RenderContext } from '../types';
import { FlashEffect } from './FlashEffect';
import { HandFactory, type Hand } from './hands';
import { LevelView } from './LevelView';
import { MessagePanel } from './MessagePanel';
import { MonsterModel } from './MonsterModel';
import { ModelLibrary } from './assets';
import { SkinnedMonster } from './SkinnedMonster';
import { FURNITURE_MODEL_NAMES } from './FurnitureModels';
import { NoiseMeter } from './NoiseMeter';
import { CameraProp, FilmProp, FuseProp, type HoldStyle, type Prop } from './Props';
import { AvatarKit, RemoteAvatar } from './RemoteAvatar';
import { DRESSING_PREFIX } from './Dressing';
import { setTextureAnisotropy } from './textures';
import { paint, segmentHitsAabb, setQ, setV } from './util';

/**
 * three.js's physically based lights divide diffuse by PI, so a hemisphere light of intensity I lights
 * an albedo-a surface to a*I/PI. We multiply by PI so RENDER.ambientIntensity reads as "fraction of
 * surface color you see in the dark".
 */
const AMBIENT_SCALE = Math.PI;
/**
 * "Dark-adapted eyes": a very faint, short-range light at the local head. Uniform ambient + linear
 * fog can't make things visible at arm's length yet black at 3 m; this does (silhouettes and wet
 * glints on the monster only up close). Local only, so it never reveals hand signs to others.
 */
const NEAR_LIGHT = { intensity: 0.016, distance: 2.2, decay: 2 };
const FOG_COLOR = 0x04060b;
const AFTERIMAGE_MIN_DOT = 0.1;
/** GLB models the renderer knows how to use (public/models/<name>.glb). */
const MODEL_NAMES = [
  'monster', 'hand_left', 'hand_right', 'avatar_head', 'avatar_body',
  'camera', 'fuse', 'film', 'fusebox', 'door', ...FURNITURE_MODEL_NAMES,
];
/** Every GLB in the manifest with one of these prefixes is loaded too (set dressing). */
const MODEL_PREFIXES = [DRESSING_PREFIX];
/** Models that are baked into the level, so the level is rebuilt when they arrive. */
const isLevelModel = (n: string): boolean => n.startsWith('furniture_') || n.startsWith(DRESSING_PREFIX) || n === 'fusebox' || n === 'door' || n === 'fuse';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** three.js renderer for MUTE. */
export class GameRenderer implements IGameRenderer {
  readonly ctx: RenderContext;
  private readonly container: HTMLElement;
  private readonly hemi: THREE.HemisphereLight;
  private readonly nearLight: THREE.PointLight;
  private level: LevelView | null = null;
  private levelData: LevelData | null = null;
  private readonly localHandMat: THREE.MeshLambertMaterial;
  private localLeft: Hand;
  private localRight: Hand;
  /** Makes GLB hands once loaded, procedural ones until then. */
  private readonly hands = new HandFactory();
  /** Makes GLB avatar heads/bodies once loaded, procedural ones until then. */
  private readonly avatarKit = new AvatarKit();
  private readonly ghostMat: THREE.MeshBasicMaterial;
  private readonly avatars = new Map<PlayerId, RemoteAvatar>();
  private readonly pendingPoses = new Map<PlayerId, PlayerPose>();
  private monster: MonsterModel | SkinnedMonster;
  /** Blender GLB models; each one replaces its procedural fallback once loaded. */
  readonly models = new ModelLibrary();
  private readonly items = new Map<number, Prop>();
  private readonly seenItems = new Set<number>();
  private cameraProp: CameraProp;
  private readonly flashFx: FlashEffect;
  private readonly meter: NoiseMeter;
  private readonly message: MessagePanel;
  private readonly dynamic = new THREE.Group();
  private readonly headPos = new THREE.Vector3(0, PLAYER.eyeHeight, 0);
  private readonly headQuat = new THREE.Quaternion();
  private time = 0;
  private readonly onResize = (): void => this.resize();

  /** Creates the WebGLRenderer (xr.enabled = true) and appends its canvas to `container`. */
  constructor(container: HTMLElement) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;
    renderer.setClearColor(0x000000, 1);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.xr.setFoveation(1);
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);
    setTextureAnisotropy(renderer.capabilities.getMaxAnisotropy());

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(FOG_COLOR, RENDER.fogNear, RENDER.fogFar);
    const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 60);
    camera.position.set(0, PLAYER.eyeHeight, 0);
    const rig = new THREE.Group();
    rig.name = 'rig';
    rig.add(camera);
    scene.add(rig);
    this.ctx = { renderer, scene, camera, rig };

    this.hemi = new THREE.HemisphereLight(0xa4b4d4, 0x3a3530, RENDER.ambientIntensity * AMBIENT_SCALE);
    scene.add(this.hemi);
    this.nearLight = new THREE.PointLight(0xb4c0dc, NEAR_LIGHT.intensity, NEAR_LIGHT.distance, NEAR_LIGHT.decay);
    this.nearLight.name = 'nearSight';
    scene.add(this.nearLight);

    this.dynamic.name = 'dynamic';
    scene.add(this.dynamic);

    // Local hands: faintly self-lit so you can see your own hands in the dark.
    this.localHandMat = new THREE.MeshLambertMaterial({ color: 0xb8a493, emissive: 0x16120f, emissiveIntensity: 1 });
    this.localLeft = this.hands.create('left', this.localHandMat);
    this.localRight = this.hands.create('right', this.localHandMat);
    this.localLeft.visible = this.localRight.visible = false;
    this.dynamic.add(this.localLeft.mesh, this.localRight.mesh);

    this.ghostMat = new THREE.MeshBasicMaterial({
      color: 0x8a1e1e, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.ghostMat.userData.shared = true;

    this.monster = new MonsterModel();
    this.dynamic.add(this.monster.object);

    this.cameraProp = new CameraProp();
    this.cameraProp.group.visible = false;
    this.dynamic.add(this.cameraProp.group);

    this.flashFx = new FlashEffect(scene, camera);
    this.meter = new NoiseMeter();
    this.dynamic.add(this.meter.mesh);
    this.message = new MessagePanel();
    scene.add(this.message.mesh);

    this.resize();
    window.addEventListener('resize', this.onResize);

    void this.models.load(MODEL_NAMES, MODEL_PREFIXES).then(() => this.applyModels());
  }

  /** Swap procedural stand-ins for the Blender models that loaded. */
  private applyModels(): void {
    const monster = this.models.get('monster');
    const inst = monster && SkinnedMonster.usable(monster) ? this.models.instance('monster') : null;
    if (monster && inst) {
      const old = this.monster;
      const next = new SkinnedMonster(monster, inst);
      this.dynamic.remove(old.object);
      old.dispose();
      this.monster = next;
      this.dynamic.add(next.object);
    }
    // Rigged hands: replace the local ones; remote avatars get rebuilt with them next frame.
    let rebuildAvatars = this.avatarKit.use(this.models);
    if (this.hands.use(this.models)) {
      rebuildAvatars = true;
      for (const side of ['left', 'right'] as const) {
        const old = side === 'left' ? this.localLeft : this.localRight;
        const next = this.hands.create(side, this.localHandMat);
        next.visible = old.visible;
        this.dynamic.remove(old.mesh);
        old.dispose();
        this.dynamic.add(next.mesh);
        if (side === 'left') this.localLeft = next;
        else this.localRight = next;
      }
    }
    if (rebuildAvatars) {
      for (const av of this.avatars.values()) {
        this.dynamic.remove(av.group);
        av.dispose();
      }
      this.avatars.clear();
    }
    // Item props: the camera now, fuses/film get recreated by updateItems() next frame.
    if (this.models.has('camera')) {
      const old = this.cameraProp;
      const next = new CameraProp(this.models);
      next.group.visible = old.group.visible;
      this.dynamic.remove(old.group);
      old.dispose();
      this.cameraProp = next;
      this.dynamic.add(next.group);
    }
    if (this.models.has('fuse') || this.models.has('film')) this.clearItems();
    // A level built before the models arrived gets rebuilt with them.
    if (this.levelData && this.models.names().some(isLevelModel)) this.loadLevel(this.levelData);
  }

  private clearItems(): void {
    for (const p of this.items.values()) {
      this.dynamic.remove(p.group);
      p.dispose();
    }
    this.items.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Level
  // -------------------------------------------------------------------------------------------

  loadLevel(level: LevelData): void {
    if (this.level) {
      this.ctx.scene.remove(this.level.group);
      this.level.dispose();
      this.level = null;
    }
    this.clearItems();
    this.flashFx.clearAfterimages();
    this.levelData = level;
    this.level = new LevelView(level, this.models);
    this.ctx.scene.add(this.level.group);
    // Compile every shader now (incl. afterimage + whiteout) so the first flash doesn't hitch.
    this.flashFx.setWarmupVisible(true);
    const hidden: THREE.Object3D[] = [];
    this.dynamic.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    try {
      this.ctx.renderer.compile(this.ctx.scene, this.ctx.camera);
    } catch {
      // compile() is an optimization only.
    }
    for (const o of hidden) o.visible = false;
    this.flashFx.setWarmupVisible(false);
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------------------------

  update(state: WorldState, localId: PlayerId, localPose: PlayerPose, dt: number): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    setV(this.headPos, localPose.head.position);
    setQ(this.headQuat, localPose.head.rotation);
    // Slightly in front of the eyes so your own hands/arms catch it too.
    this.nearLight.position.set(0, -0.1, -0.15).applyQuaternion(this.headQuat).add(this.headPos);

    this.level?.update(state, dt, this.time);
    const fog = this.ctx.scene.fog;
    if (this.level && fog instanceof THREE.Fog) {
      // Anything beyond the fog's far depth is flat fog color: don't draw those static chunks.
      // Margin: the XR eyes sit a few cm off the head and the view direction keeps moving.
      this.level.cullFogged(this.headPos, _d.set(0, 0, -1).applyQuaternion(this.headQuat), fog.far + 1.5);
    } else {
      this.level?.cullFogged(this.headPos, _d.set(0, 0, -1), Infinity);
    }

    // Local hands straight from the freshest local pose (zero lag).
    this.localLeft.setPose(localPose.left);
    this.localRight.setPose(localPose.right);

    this.updateAvatars(state, localId, dt);
    this.monster.update(state.monster, dt);
    this.updateItems(state, localId, localPose);
    this.flashFx.update(this.time);

    // Noise meter on the inside of the local left wrist.
    setV(_a, localPose.left.position);
    setQ(_q, localPose.left.rotation);
    const me = state.players[localId];
    this.meter.update(_a, _q, localPose.left.tracked && (!me || me.status === 'alive'), dt);

    this.message.update(this.headPos, this.headQuat, dt);
  }

  private updateAvatars(state: WorldState, localId: PlayerId, dt: number): void {
    for (const [id, av] of this.avatars) {
      if (id === localId || !state.players[id]) {
        this.dynamic.remove(av.group);
        av.dispose();
        this.avatars.delete(id);
      }
    }
    for (const id in state.players) {
      if (id === localId) continue;
      const p = state.players[id];
      let av = this.avatars.get(id);
      if (!av) {
        av = new RemoteAvatar(id, p.color, this.ghostMat, this.hands, this.avatarKit);
        this.avatars.set(id, av);
        this.dynamic.add(av.group);
        const pending = this.pendingPoses.get(id);
        if (pending) av.setTarget(pending, true, this.time);
      }
      this.pendingPoses.delete(id);
      av.setColor(p.color);
      av.setStatus(p.status);
      av.setTarget(p.pose, false, this.time);
      av.update(dt);
    }
  }

  /** World transform of a player's hand (local: freshest pose, remote: smoothed), or null. */
  private handFrame(pid: PlayerId | null, hand: Handedness | null, localId: PlayerId, localPose: PlayerPose,
    outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    if (!pid || !hand) return false;
    if (pid === localId) {
      const h = localPose[hand];
      if (!h.tracked) return false;
      setV(outPos, h.position);
      setQ(outQuat, h.rotation);
      return true;
    }
    const av = this.avatars.get(pid);
    if (!av || !av.hands[hand].tracked || av.status === 'escaped') return false;
    outPos.copy(av.hands[hand].pos);
    outQuat.copy(av.hands[hand].quat);
    return true;
  }

  private updateItems(state: WorldState, localId: PlayerId, localPose: PlayerPose): void {
    const seen = this.seenItems;
    seen.clear();
    for (const it of state.items) {
      seen.add(it.id);
      let prop = this.items.get(it.id);
      if (!prop) {
        prop = it.kind === 'fuse' ? new FuseProp(this.models) : new FilmProp(this.models);
        this.items.set(it.id, prop);
        this.dynamic.add(prop.group);
      }
      prop.group.visible = it.where !== 'used';
      if (it.where === 'used') continue;
      if (it.where === 'held' && this.handFrame(it.holder, it.hand, localId, localPose, _a, _q)) {
        prop.placeInHand(it.hand!, _a, _q, this.holdStyle(state, it.holder!, localId));
      } else {
        prop.placeInWorld(it.position.x, it.position.y, it.position.z, it.yaw);
      }
      prop.setGlint(prop.group.position.distanceTo(this.headPos));
    }
    for (const [id, prop] of this.items) {
      if (!seen.has(id)) {
        this.dynamic.remove(prop.group);
        prop.dispose();
        this.items.delete(id);
      }
    }
    const cam = state.camera;
    const cp = this.cameraProp;
    cp.group.visible = true;
    cp.setFilm(cam.film);
    if (cam.holder && this.handFrame(cam.holder, cam.hand, localId, localPose, _a, _q)) {
      cp.placeInHand(cam.hand!, _a, _q, this.holdStyle(state, cam.holder, localId));
    } else {
      cp.placeInWorld(cam.position.x, cam.position.y, cam.position.z, cam.yaw);
    }
    cp.update(this.time, cp.group.position.distanceTo(this.headPos));
  }

  /** Desktop hands rest palm down; VR hands hold things in a natural grip. */
  private holdStyle(state: WorldState, holder: PlayerId, localId: PlayerId): HoldStyle {
    if (holder === localId) return this.ctx.renderer.xr.isPresenting ? 'grip' : 'palmDown';
    return state.players[holder]?.isDesktop ? 'palmDown' : 'grip';
  }

  setRemotePose(id: PlayerId, pose: PlayerPose): void {
    const av = this.avatars.get(id);
    if (av) av.setTarget(pose, true, this.time);
    else this.pendingPoses.set(id, pose);
  }

  // -------------------------------------------------------------------------------------------
  // Flash + afterimages
  // -------------------------------------------------------------------------------------------

  flash(event: FlashEvent, state: WorldState, localId: PlayerId, localPose: PlayerPose): void {
    const origin = new THREE.Vector3(event.position.x, event.position.y, event.position.z);
    const dir = new THREE.Vector3(event.direction.x, event.direction.y, event.direction.z);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    dir.normalize();
    const blockers = this.level ? this.level.blockers() : [];

    /** 0 = not captured, else brightness 0.45..1 by distance. */
    const captured = (p: THREE.Vector3): number => {
      _d.subVectors(p, origin);
      const dist = _d.length();
      if (dist > RENDER.flashRange) return 0;
      if (dist > 1e-4 && _d.dot(dir) / dist <= AFTERIMAGE_MIN_DOT) return 0;
      for (const b of blockers) if (segmentHitsAabb(origin, p, b, 0.08)) return 0;
      return Math.max(0.45, Math.min(1, 1.12 - (dist / RENDER.flashRange) * 0.7));
    };

    const parts: THREE.BufferGeometry[] = [];
    const halo: THREE.BufferGeometry[] = [];
    const push = (list: THREE.BufferGeometry[], from: number, k: number): void => {
      const c = new THREE.Color(k, k, k);
      for (let i = from; i < list.length; i++) paint(list[i], c);
    };
    for (const id in state.players) {
      const pl = state.players[id];
      if (pl.status !== 'alive') continue;
      let pose: PlayerPose = pl.pose;
      if (id === localId) pose = localPose;
      else {
        const av = this.avatars.get(id);
        if (av?.target) pose = av.target;
      }
      // Head.
      setV(_a, pose.head.position);
      let k = captured(_a);
      if (k > 0) {
        setQ(_q, pose.head.rotation);
        const from = parts.length;
        this.avatarKit.bakeHead(_a, _q, parts);
        push(parts, from, k * 0.85);
      }
      // Hands with their exact finger curls right now.
      for (const side of ['left', 'right'] as const) {
        const h = pose[side];
        if (!h.tracked) continue;
        setV(_a, h.position);
        k = captured(_a);
        if (k <= 0) continue;
        setQ(_q, h.rotation);
        let from = parts.length;
        this.hands.bakePose(side, _a, _q, h.curls, parts, 1.04);
        push(parts, from, k);
        from = halo.length;
        this.hands.bakePose(side, _a, _q, h.curls, halo, 1.45);
        push(halo, from, k);
      }
    }
    // The monster: test a few points along its body so a partly hidden monster still shows.
    const mp = state.monster.position;
    let mk = 0;
    for (const y of [0.6, 1.3, 2.0]) mk = Math.max(mk, captured(_b.set(mp.x, mp.y + y, mp.z)));
    if (mk > 0) {
      const from = parts.length;
      this.monster.bake(parts, 1.03);
      push(parts, from, mk);
    }
    this.flashFx.addAfterimage(parts, halo, this.time);

    // How much does this flash blind the local viewer? (capped to ~70 ms by FlashEffect)
    setV(_a, localPose.head.position);
    let white = 0;
    if (event.by === localId) {
      white = 0.16;
    } else {
      _d.subVectors(_a, origin);
      const dist = Math.max(0.05, _d.length());
      _d.multiplyScalar(1 / dist);
      let los = dist <= RENDER.flashRange;
      for (const b of blockers) if (los && segmentHitsAabb(origin, _a, b, 0.08)) los = false;
      if (los) {
        const aim = Math.max(0, _d.dot(dir));
        setQ(_q, localPose.head.rotation);
        const look = -_b.set(0, 0, -1).applyQuaternion(_q).dot(_d);
        const lookK = Math.max(0, Math.min(1, (look + 0.2) / 1.2));
        white = 0.05 + 0.85 * Math.pow(aim, 3) * lookK * Math.pow(1 - dist / RENDER.flashRange, 0.6);
      }
    }
    this.flashFx.fire(this.time, origin, dir, white);
    this.cameraProp.flashed(this.time);
  }

  setLocalNoiseLevel(level: number): void {
    this.meter.setLevel(level);
  }

  showMessage(text: string, seconds?: number): void {
    this.message.show(text, seconds ?? 3);
  }

  render(): void {
    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  }

  // -------------------------------------------------------------------------------------------
  // Extras (not part of IGameRenderer)
  // -------------------------------------------------------------------------------------------

  /** Draw calls / triangles of the last rendered frame (for a perf HUD). */
  stats(): { calls: number; triangles: number; geometries: number; textures: number; programs: number } {
    const info = this.ctx.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    };
  }

  /** Resize to the container (no-op while an XR session is presenting). */
  resize(): void {
    const r = this.ctx.renderer;
    if (r.xr.isPresenting) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    r.setSize(w, h, true);
    this.ctx.camera.aspect = w / Math.max(1, h);
    this.ctx.camera.updateProjectionMatrix();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.level) {
      this.ctx.scene.remove(this.level.group);
      this.level.dispose();
    }
    for (const av of this.avatars.values()) av.dispose();
    for (const p of this.items.values()) p.dispose();
    this.cameraProp.dispose();
    this.monster.dispose();
    this.localLeft.dispose();
    this.localRight.dispose();
    this.localHandMat.dispose();
    this.ghostMat.dispose();
    this.flashFx.dispose();
    this.meter.dispose();
    this.message.dispose();
    this.ctx.renderer.dispose();
    this.ctx.renderer.domElement.remove();
  }
}
