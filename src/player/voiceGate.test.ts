import { describe, expect, it } from 'vitest';
import { VoiceGate, type VoiceKind } from './voiceGate';

// A fake sound source that records whether it's playing.
function fake(kind: VoiceKind, live: Set<VoiceKind>) {
  return { play: () => live.add(kind), stop: () => live.delete(kind) };
}

describe('VoiceGate', () => {
  it('never lets two narration sources play at once', () => {
    const live = new Set<VoiceKind>();
    const gate = new VoiceGate();
    const browser = fake('browser', live);
    const recorded = fake('recorded', live);

    // The bug: the lesson started on the browser voice, then a recording
    // arrived mid-chapter and started on top of it.
    gate.start('browser', browser); browser.play();
    gate.start('recorded', recorded); recorded.play();
    expect([...live]).toEqual(['recorded']);

    gate.start('browser', browser); browser.play();
    expect([...live]).toEqual(['browser']);
  });

  it('restarting the same source does not stop it', () => {
    const live = new Set<VoiceKind>();
    const gate = new VoiceGate();
    const recorded = fake('recorded', live);
    gate.start('recorded', recorded); recorded.play();
    gate.start('recorded', recorded);
    expect([...live]).toEqual(['recorded']);
  });

  it('stopAll silences everything', () => {
    const live = new Set<VoiceKind>();
    const gate = new VoiceGate();
    const browser = fake('browser', live);
    gate.start('browser', browser); browser.play();
    gate.stopAll();
    expect(live.size).toBe(0);
    expect(gate.playing).toBeNull();
  });
});
