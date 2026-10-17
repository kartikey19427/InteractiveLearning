// The lesson clock: how far the animation moves each frame. With narration on,
// the voice is the clock, so the animation can never run ahead of (or lag)
// what is being said. Kept pure and separate so it is covered by clock.test.ts.

/** Index of the sentence playing at time t, given each sentence's end time. */
export function sentenceAt(bounds: number[], t: number) {
  let i = 0;
  while (i < bounds.length - 1 && t >= bounds[i]) i++;
  return i;
}

/** State of the browser voice for the sentence it was last asked to say. */
export interface SpeechClock {
  si: number;
  requestedAt: number;
  started: boolean;
  startAt: number;
  ended: boolean;
  /** The browser can't speak right now; run on the plain clock instead. */
  failed: boolean;
  retried: boolean;
  /** Expected speaking time; refined by boundary events. */
  estMs: number;
  /** Progress through the sentence from the last boundary event, 0..1. */
  p: number;
}

/** The recorded narration's audio element, as far as the clock cares. */
export interface AudioClock {
  ended: boolean;
  paused: boolean;
  currentTime: number;
}

export interface ClockInput {
  t: number;
  dt: number;
  now: number;
  bounds: number[];
  voice: boolean;
  /** Present when this chapter plays recorded narration. */
  audio: AudioClock | null;
  speech: SpeechClock;
}

export type ClockEvent = 'retry-speech' | 'speech-unavailable';

/** Wait this long for the voice to start before asking again, then giving up. */
export const RETRY_AFTER_MS = 1200;
export const GIVE_UP_AFTER_MS = 3000;
/** Speed for finishing a sentence's animation after its words are done. */
export const CATCH_UP = 4;

export const idleSpeech = (): SpeechClock => ({
  si: -1, requestedAt: 0, started: false, startAt: 0, ended: true, failed: false, retried: false, estMs: 1, p: 0,
});

export function advanceClock(i: ClockInput): { t: number; event?: ClockEvent } {
  const { t, dt, now, bounds } = i;
  if (!i.voice) return { t: t + dt };

  // Recorded narration: the audio's own position is the time.
  if (i.audio) {
    if (i.audio.ended) return { t: t + dt };
    if (i.audio.paused) return { t };
    return { t: Math.max(t, i.audio.currentTime) };
  }

  // Browser voice: each sentence's slice of the animation spans the time it
  // takes to say that sentence.
  const sp = i.speech;
  if (sp.failed) return { t: t + dt };
  const si = sentenceAt(bounds, t);
  // The sentence hasn't been requested yet (it is, right after this frame): hold.
  if (sp.si !== si) return { t };
  const slotStart = si > 0 ? bounds[si - 1] : 0;
  const slotEnd = bounds[si] - 0.02;

  if (!sp.started) {
    if (sp.ended) return { t: t + dt }; // errored before speaking
    const waited = now - sp.requestedAt;
    if (waited > GIVE_UP_AFTER_MS) return { t, event: 'speech-unavailable' };
    if (waited > RETRY_AFTER_MS && !sp.retried) return { t, event: 'retry-speech' };
    return { t }; // the voice hasn't begun yet: wait for it
  }
  // Words done: finish this sentence's animation briskly, up to its boundary.
  if (sp.ended) return { t: Math.min(bounds[si], t + dt * CATCH_UP) };
  // Speaking: follow its progress, but never past this sentence while it talks.
  const p = Math.max(sp.p, Math.min(0.97, (now - sp.startAt) / sp.estMs));
  return { t: Math.min(slotEnd, Math.max(t, slotStart + p * (slotEnd - slotStart))) };
}

/**
 * Whether a recorded clip's sentence timings can be trusted for this audio:
 * one end time per sentence, strictly increasing, and the last one matching
 * the audio's length. Otherwise the player uses the browser voice instead.
 */
export function clipUsable(bounds: number[], sentences: number, duration?: number) {
  if (bounds.length !== sentences || bounds.length === 0) return false;
  for (let k = 0; k < bounds.length; k++) {
    const prev = k === 0 ? 0 : bounds[k - 1];
    if (!(bounds[k] > prev + 0.2)) return false;
  }
  if (duration !== undefined && Number.isFinite(duration)) {
    return Math.abs(duration - bounds[bounds.length - 1]) <= 1.5;
  }
  return true;
}
