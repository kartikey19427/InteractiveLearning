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
