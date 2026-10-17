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

import { chooseVoice } from './voiceGate';

describe('chooseVoice: always Max unless it is not working', () => {
  const base = { voice: true, lockedBrowser: false, hasClip: false };
  it('waits for Max while it is being recorded, instead of using an older voice', () => {
    expect(chooseVoice({ ...base, state: 'preparing' })).toBe('wait');
  });
  it('plays Max as soon as this chapter is ready', () => {
    expect(chooseVoice({ ...base, state: 'preparing', hasClip: true })).toBe('recorded');
    expect(chooseVoice({ ...base, state: 'ready', hasClip: true })).toBe('recorded');
  });
  it('falls back only when Max failed or no voice service is set up', () => {
    expect(chooseVoice({ ...base, state: 'fallback' })).toBe('browser');
    expect(chooseVoice({ ...base, state: 'none' })).toBe('browser');
  });
  it('keeps the browser voice for the rest of a visit once it has started', () => {
    expect(chooseVoice({ ...base, state: 'preparing', hasClip: true, lockedBrowser: true })).toBe('browser');
  });
  it('does nothing with narration off', () => {
    expect(chooseVoice({ ...base, voice: false, state: 'preparing' })).toBe('off');
  });
});
