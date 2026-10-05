import type { IInputManager, InputFrame, RenderContext } from '../types';

/** WebXR controllers + hand tracking + desktop keyboard/mouse. STUB — implemented by the input module. */
export class InputManager implements IInputManager {
  get mode(): 'xr' | 'desktop' {
    return this.ctx.renderer.xr.isPresenting ? 'xr' : 'desktop';
  }

  /** `domElement` receives pointer lock / mouse events on desktop. */
  constructor(private readonly ctx: RenderContext, domElement: HTMLElement) {
    void domElement;
  }

  update(dt: number): InputFrame {
    void dt;
    throw new Error('InputManager.update not implemented yet');
  }

  setEnabled(enabled: boolean): void { void enabled; }
}
