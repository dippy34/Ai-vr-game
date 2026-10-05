/** Entering/leaving immersive VR. */

import type * as THREE from 'three';

export async function isVRSupported(): Promise<boolean> {
  try {
    return !!(await navigator.xr?.isSessionSupported('immersive-vr'));
  } catch {
    return false;
  }
}

/**
 * Must be called from a user gesture (button click). `onEnd` fires when the headset session ends
 * (user pressed the Oculus button, took it off, etc).
 */
export async function enterVR(renderer: THREE.WebGLRenderer, onEnd: () => void): Promise<void> {
  if (!navigator.xr) throw new Error('WebXR is not available in this browser.');
  const session = await navigator.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
  });
  session.addEventListener('end', onEnd, { once: true });
  await renderer.xr.setSession(session);
}

export function exitVR(renderer: THREE.WebGLRenderer): void {
  void renderer.xr.getSession()?.end();
}
