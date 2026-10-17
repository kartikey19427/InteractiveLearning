// At most one narration source plays at a time. Every way the player makes
// sound (browser voice, recorded audio) starts through the gate, which stops
// whatever was playing first. Covered by voiceGate.test.ts.

export type VoiceKind = 'browser' | 'recorded';

export interface VoiceSource {
  stop: () => void;
}

export class VoiceGate {
  private current: { kind: VoiceKind; source: VoiceSource } | null = null;

  /** Call right before a source starts making sound. */
  start(kind: VoiceKind, source: VoiceSource) {
    if (this.current && this.current.source !== source) this.current.source.stop();
    this.current = { kind, source };
  }

  stopAll() {
    this.current?.source.stop();
    this.current = null;
  }

  get playing(): VoiceKind | null {
    return this.current?.kind ?? null;
  }
}

export type NarrationState = 'ready' | 'preparing' | 'fallback' | 'none';

/**
 * Who reads the current chapter. The preferred recording (Max) is waited for
 * while it's being prepared; an older recording or the browser voice is used
 * only when the preferred one isn't coming (fallback/none), or once this visit
 * has already locked in the browser voice.
 */
export function chooseVoice(o: { voice: boolean; state: NarrationState; lockedBrowser: boolean; hasClip: boolean }): 'off' | 'wait' | 'recorded' | 'browser' {
  if (!o.voice) return 'off';
  if (o.hasClip && !o.lockedBrowser) return 'recorded';
  if (o.state === 'preparing' && !o.lockedBrowser) return 'wait';
  return 'browser';
}
