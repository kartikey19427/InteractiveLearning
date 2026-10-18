import { describe, expect, it } from 'vitest';
import {
  advanceClock, clipUsable, GIVE_UP_AFTER_MS, idleSpeech, RETRY_AFTER_MS, sentenceAt,
  type ClockInput, type SpeechClock,
} from './clock';

const DT = 1 / 60;
const BOUNDS = [3, 7, 10]; // three sentences: 0-3 s, 3-7 s, 7-10 s of scene time

const base = (over: Partial<ClockInput> = {}): ClockInput => ({
  t: 0, dt: DT, now: 0, bounds: BOUNDS, voice: true, audio: null, speech: idleSpeech(), ...over,
});

/**
 * Plays a whole chapter against a fake browser voice and records, every frame
 * the voice is talking, which sentence the animation is showing. Speech can be
 * slower or faster than the estimate, and can start late.
 */
function simulate(opts: { speakMs: number[]; startDelayMs?: number[]; estMs?: number }) {
  let t = 0;
  let now = 0;
  let speech: SpeechClock = idleSpeech();
  let requested = -1;
  const mismatches: string[] = [];
  for (let frame = 0; frame < 60 * 120 && t < BOUNDS[BOUNDS.length - 1]; frame++) {
    now += DT * 1000;
    // The fake engine: starts after a delay, talks for speakMs, then ends.
    if (speech.si >= 0 && !speech.failed) {
      const delay = opts.startDelayMs?.[speech.si] ?? 50;
      const startAt = speech.requestedAt + delay;
      if (!speech.started && !speech.ended && now >= startAt && delay < GIVE_UP_AFTER_MS) {
        speech = { ...speech, started: true, startAt };
      }
      if (speech.started && !speech.ended && now >= speech.startAt + opts.speakMs[speech.si]) {
        speech = { ...speech, ended: true };
      }
    }
    const talking = speech.started && !speech.ended ? speech.si : -1;
    const r = advanceClock({ t, dt: DT, now, bounds: BOUNDS, voice: true, audio: null, speech });
    if (r.t < t) mismatches.push(`time went backwards at frame ${frame}`);
    t = r.t;
    if (r.event === 'retry-speech') speech = { ...speech, retried: true, requestedAt: now };
    if (r.event === 'speech-unavailable') speech = { ...speech, failed: true };
    if (talking >= 0 && sentenceAt(BOUNDS, t) !== talking) {
      mismatches.push(`frame ${frame}: voice on sentence ${talking}, animation on ${sentenceAt(BOUNDS, t)}`);
    }
    // The player asks for the next sentence as soon as the animation reaches it.
    const si = sentenceAt(BOUNDS, t);
    if (si !== requested) {
      requested = si;
      speech = { ...idleSpeech(), si, requestedAt: now, ended: false, estMs: opts.estMs ?? 3000 };
    }
  }
  return { t, mismatches };
}

describe('sentenceAt', () => {
  it('finds the sentence for a time', () => {
    expect(sentenceAt(BOUNDS, 0)).toBe(0);
    expect(sentenceAt(BOUNDS, 2.99)).toBe(0);
    expect(sentenceAt(BOUNDS, 3)).toBe(1);
    expect(sentenceAt(BOUNDS, 99)).toBe(2);
  });
});

describe('browser voice keeps words and pictures in step', () => {
  it('when speech is slower than estimated', () => {
    const r = simulate({ speakMs: [6000, 7000, 5000], estMs: 2500 });
    expect(r.mismatches).toEqual([]);
    expect(r.t).toBeGreaterThanOrEqual(BOUNDS[2] - 0.05);
  });

  it('when speech is faster than estimated', () => {
    const r = simulate({ speakMs: [900, 1200, 800], estMs: 4000 });
    expect(r.mismatches).toEqual([]);
  });

  it('when the voice starts late (the bug that raced the animation ahead)', () => {
    // 2 s late: past the old 1.5 s cut-off, inside the new give-up time.
    const r = simulate({ speakMs: [3000, 4000, 3000], startDelayMs: [2000, 1600, 2500] });
    expect(r.mismatches).toEqual([]);
  });

  it('waits for the voice before moving, then asks again once, then gives up', () => {
    const sp: SpeechClock = { ...idleSpeech(), si: 0, requestedAt: 0, ended: false };
    expect(advanceClock(base({ t: 1, now: 500, speech: sp }))).toEqual({ t: 1 });
    expect(advanceClock(base({ t: 1, now: RETRY_AFTER_MS + 1, speech: sp })).event).toBe('retry-speech');
    expect(advanceClock(base({ t: 1, now: GIVE_UP_AFTER_MS + 1, speech: { ...sp, retried: true } })).event).toBe('speech-unavailable');
  });

  it('never runs past the sentence being spoken', () => {
    const sp: SpeechClock = { ...idleSpeech(), si: 0, requestedAt: 0, started: true, startAt: 0, ended: false, estMs: 1000 };
    // Far beyond the estimate, still talking: hold just before the boundary.
    const r = advanceClock(base({ t: 2.9, now: 60_000, speech: sp }));
    expect(r.t).toBeLessThan(BOUNDS[0]);
  });

  it('runs on the plain clock when speech is unavailable', () => {
    const sp: SpeechClock = { ...idleSpeech(), si: 0, failed: true };
    expect(advanceClock(base({ t: 1, speech: sp })).t).toBeCloseTo(1 + DT);
  });
});

describe('recorded narration', () => {
  it('follows the audio position and never goes backwards', () => {
    const audio = { ended: false, paused: false, currentTime: 4.2 };
    expect(advanceClock(base({ t: 1, audio })).t).toBe(4.2);
    expect(advanceClock(base({ t: 5, audio })).t).toBe(5);
  });

  it('holds while the audio is loading or paused', () => {
    expect(advanceClock(base({ t: 2, audio: { ended: false, paused: true, currentTime: 0 } })).t).toBe(2);
  });

  it('only trusts timings that fit the audio', () => {
    expect(clipUsable([6.5, 13.9, 18.4, 31], 4, 31.2)).toBe(true);
    expect(clipUsable([6.5, 13.9, 18.4, 31], 3)).toBe(false); // wrong sentence count
    expect(clipUsable([6.5, 6.5, 18.4, 31], 4)).toBe(false); // not increasing
    expect(clipUsable([6.5, 13.9, 18.4, 31], 4, 40)).toBe(false); // doesn't match the audio length
  });
});

describe('voice off', () => {
  it('uses the plain clock', () => {
    expect(advanceClock(base({ t: 1, voice: false })).t).toBeCloseTo(1 + DT);
  });
});
