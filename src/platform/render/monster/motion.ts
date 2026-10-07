/**
 * Turns the networked monster position/yaw (exact every frame on the host, ~12 Hz snapshots on
 * clients) into a smooth root motion with trustworthy velocity, acceleration and turn rate.
 *
 * New samples give a velocity estimate (delta / time since the previous sample), the raw position
 * is dead-reckoned a little past the last sample, and a critically damped spring with velocity
 * feed-forward follows it: no lag at constant speed, a short lag when it starts/stops (the body
 * uses `lead - pos` to anticipate: lean into a start before the feet catch up).
 */

import * as THREE from 'three';

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export class MotionTracker {
  /** Smoothed root (ground under the body center). */
  readonly pos = new THREE.Vector3();
  /** Smoothed root velocity (m/s). */
  readonly vel = new THREE.Vector3();
  /** Smoothed acceleration (m/s^2). */
  readonly accel = new THREE.Vector3();
  /** Where the sim (probably) is right now: leads `pos`. */
  readonly lead = new THREE.Vector3();
  /** Velocity estimate from the samples. */
  readonly leadVel = new THREE.Vector3();
  yaw = 0;
  /** Smoothed turn rate (rad/s, + = counter-clockwise from above = turning left). */
  yawRate = 0;
  /** Latest sim yaw (leads `yaw`). */
  rawYaw = 0;
  /** Seconds since the root last moved faster than 0.05 m/s (0 while moving). */
  stillFor = 0;
  /** Seconds since it has been moving (0 while still). */
  movingFor = 0;
  private readonly last = new THREE.Vector3();
  private sinceSample = 0;
  private initialized = false;
  private readonly prevVel = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();

  constructor(
    /** Position spring rate (rad/s). */
    private readonly omega = 11,
    private readonly yawOmega = 13,
  ) {}

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Feed the latest state. Returns true when it snapped (first frame or a teleport). */
  update(x: number, y: number, z: number, yaw: number, dt: number): boolean {
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    if (!this.initialized || dx * dx + dz * dz > 9) {
      this.initialized = true;
      this.pos.set(x, y, z);
      this.lead.copy(this.pos);
      this.last.copy(this.pos);
      this.vel.set(0, 0, 0);
      this.leadVel.set(0, 0, 0);
      this.accel.set(0, 0, 0);
      this.prevVel.set(0, 0, 0);
      this.yaw = this.rawYaw = yaw;
      this.yawRate = 0;
      this.sinceSample = 0;
      this.stillFor = 0;
      this.movingFor = 0;
      return true;
    }
    dt = Math.max(dt, 1e-4);
    this.sinceSample += dt;
    const moved = Math.abs(x - this.last.x) + Math.abs(y - this.last.y) + Math.abs(z - this.last.z) > 1e-6;
    if (moved) {
      const span = Math.min(Math.max(this.sinceSample, 1 / 120), 0.25);
      this._a.set((x - this.last.x) / span, (y - this.last.y) / span, (z - this.last.z) / span);
      this.leadVel.lerp(this._a, 0.6);
      this.last.set(x, y, z);
      this.sinceSample = 0;
    } else if (this.sinceSample > 0.2) {
      // No new position for a while: it stopped.
      this.leadVel.multiplyScalar(Math.exp(-dt * 12));
    }
    this.lead.copy(this.last).addScaledVector(this.leadVel, Math.min(this.sinceSample, 0.1));

    // Critically damped follow with velocity feed-forward (semi-implicit, sub-stepped).
    this.prevVel.copy(this.vel);
    const n = Math.ceil(dt / (1 / 90));
    const h = dt / n;
    const w = this.omega;
    for (let i = 0; i < n; i++) {
      this._a.subVectors(this.lead, this.pos).multiplyScalar(w * w);
      this._a.x += 2 * w * (this.leadVel.x - this.vel.x);
      this._a.y += 2 * w * (this.leadVel.y - this.vel.y);
      this._a.z += 2 * w * (this.leadVel.z - this.vel.z);
      this.vel.addScaledVector(this._a, h);
      this.pos.addScaledVector(this.vel, h);
      this.lead.addScaledVector(this.leadVel, h);
    }
    this.lead.copy(this.last).addScaledVector(this.leadVel, Math.min(this.sinceSample, 0.1));
    this._a.subVectors(this.vel, this.prevVel).multiplyScalar(1 / dt);
    this.accel.lerp(this._a, 1 - Math.exp(-dt * 10));

    // Yaw: same spring on the angle.
    this.rawYaw = yaw;
    const wy = this.yawOmega;
    for (let i = 0; i < n; i++) {
      const e = wrap(yaw - this.yaw);
      this.yawRate += (wy * wy * e - 2 * wy * this.yawRate) * h;
      this.yaw = wrap(this.yaw + this.yawRate * h);
    }

    if (this.speed > 0.05) {
      this.movingFor += dt;
      this.stillFor = 0;
    } else {
      this.stillFor += dt;
      this.movingFor = 0;
    }
    return false;
  }
}
