import type { HeadPose, PlayerId, SimEvent, Vec3, WorldState } from '../../core/types';
import type { IAudioManager } from '../types';

/** Procedural WebAudio sound + mic + spatial voice. STUB — implemented by the audio module. */
export class AudioManager implements IAudioManager {
  async unlock(): Promise<void> {}
  async startMic(): Promise<MediaStream | null> { return null; }
  getMicLevel(): number { return 0; }
  addRemoteVoice(peerId: PlayerId, stream: MediaStream): void { void peerId; void stream; }
  removeRemoteVoice(peerId: PlayerId): void { void peerId; }
  update(state: WorldState, localId: PlayerId, head: HeadPose, dt: number): void {
    void state; void localId; void head; void dt;
  }
  playEvent(event: SimEvent, localId: PlayerId): void { void event; void localId; }
  playFootstep(position: Vec3, loudness: number): void { void position; void loudness; }
}
