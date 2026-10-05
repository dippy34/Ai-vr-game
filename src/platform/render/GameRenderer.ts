import * as THREE from 'three';
import type { FlashEvent, LevelData, PlayerId, PlayerPose, WorldState } from '../../core/types';
import type { IGameRenderer, RenderContext } from '../types';

/** three.js renderer for MUTE. STUB — implemented by the render module. */
export class GameRenderer implements IGameRenderer {
  readonly ctx: RenderContext;

  /** Creates the WebGLRenderer (xr.enabled = true) and appends its canvas to `container`. */
  constructor(container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 100);
    const rig = new THREE.Group();
    rig.add(camera);
    scene.add(rig);
    this.ctx = { renderer, scene, camera, rig };
  }

  loadLevel(level: LevelData): void { void level; }
  update(state: WorldState, localId: PlayerId, localPose: PlayerPose, dt: number): void {
    void state; void localId; void localPose; void dt;
  }
  setRemotePose(id: PlayerId, pose: PlayerPose): void { void id; void pose; }
  flash(event: FlashEvent, state: WorldState, localId: PlayerId, localPose: PlayerPose): void {
    void event; void state; void localId; void localPose;
  }
  setLocalNoiseLevel(level: number): void { void level; }
  showMessage(text: string, seconds?: number): void { void text; void seconds; }
  render(): void {
    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  }
}
