import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Lesson, Step, VideoStep } from '../lesson/types';
import { defineFunctions, type Env } from '../lesson/expr';
import { activeShot, drawElements, drawShot } from '../lesson/scene';
import Stage, { type FrameHandle } from './Stage';
import Timeline from './Timeline';
import Simulation from './interactions/Simulation';
import Match from './interactions/Match';
import Process from './interactions/Process';
import Quiz from './interactions/Quiz';
import { DEFAULT_PALETTE } from '../lesson/palette';
import { advanceClock, clipUsable, idleSpeech, sentenceAt, type SpeechClock } from './clock';
import { chooseVoice, VoiceGate } from './voiceGate';
import TopBar from '../components/TopBar';
import VoiceMenu from '../components/VoiceMenu';
import type { VoiceOption } from '../api';


const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

type Speech = SpeechClock & { text: string };

// Playback length of each narration sentence, so scenes pace to the words.
function sentenceBounds(step: VideoStep) {
  let acc = 0;
  const bounds = step.narration.map((s) => {
    acc += Math.max(2.6, s.split(/\s+/).length * 0.36 + 0.9);
    return acc;
  });
  return { bounds, total: acc };
}


export interface StepProps<S extends Step> {
  step: S;
  frame: React.MutableRefObject<FrameHandle | null>;
  overlay: SVGSVGElement | null;
  baseEnv: Env;
  onGoal: () => void;
  onNext: () => void;
  completed: boolean;
  /** Show a short message over the stage, where the learner is looking. */
  notify: (text: string, tone: Tone) => void;
}

export type Tone = 'ok' | 'bad' | 'info' | 'win';

export interface Narration {
  provider?: 'elevenlabs' | 'gemini' | 'none';
  voice: string;
  clips: Record<string, { url: string; bounds: number[] }>;
}

import type { NarrationState } from './voiceGate';
export type { NarrationState };

const voiceKey = (n: Narration | null | undefined) => (n ? `${n.provider ?? 'gemini'}:${n.voice}` : null);

export default function LessonPlayer({
  lesson, narration: narrationProp, narrationState = 'none', slug, startIndex = 0, voices = [], voiceId = '',
  onVoiceChange, onIndexChange, onRetry, onReadAloudChange,
}: {
  lesson: Lesson; narration?: Narration | null; narrationState?: NarrationState; slug?: string;
  startIndex?: number; voices?: VoiceOption[]; voiceId?: string; onVoiceChange?: (id: string, atIndex: number) => void;
  /** The chapter on screen changed, so its content and the next one's can be loaded. */
  onIndexChange?: (index: number) => void;
  onRetry?: () => void;
  onReadAloudChange?: (on: boolean) => void;
}) {
  // One voice per visit: the first voice that speaks is locked in. Chapters of
  // that same recording keep arriving while it's prepared; any other voice is
  // ignored until the next visit.
  const [lock, setLock] = useState<string | null>(null);
  const narration: Narration | null =
    lock === 'browser' || (lock && voiceKey(narrationProp) !== lock) ? null : narrationProp ?? null;
  const steps = lesson.steps;
  const palette = useMemo(() => ({ ...DEFAULT_PALETTE, ...lesson.palette }), [lesson.palette]);
  const fns = useMemo(() => defineFunctions(lesson.functions), [lesson.functions]);
  const timing = useMemo(
    () => steps.map((s) => {
      if (s.kind !== 'video') return { bounds: [], total: 0 };
      // With recorded narration, each sentence lasts exactly as long as it does in the audio.
      const clip = narration?.clips?.[s.id];
      if (clip && clipUsable(clip.bounds, s.narration.length)) return { bounds: clip.bounds, total: clip.bounds[clip.bounds.length - 1] };
      return sentenceBounds(s);
    }),
    [steps, narration],
  );

  const [index, setIndex] = useState(() => Math.min(Math.max(0, startIndex), lesson.steps.length - 1));
  // Bumped on every navigation so revisiting or restarting a step remounts its activity.
  const [visit, setVisit] = useState(0);
  const [playing, setPlaying] = useState(!reducedMotion);
  const [voice, setVoice] = useState(() => {
    try { return localStorage.getItem('voice') !== 'off'; } catch { return true; }
  });
  // Browsers refuse speech until the page has had a click; then we ask for one.
  const [needsTap, setNeedsTap] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: Tone; key: number } | null>(null);
  const toastTimer = useRef(0);
  const notify = useCallback((text: string, tone: Tone) => {
    clearTimeout(toastTimer.current);
    setToast({ text, tone, key: Date.now() });
    toastTimer.current = window.setTimeout(() => setToast(null), tone === 'win' ? 4200 : 2800);
  }, []);
  const [sentence, setSentence] = useState(0);
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const [overlay, setOverlay] = useState<SVGSVGElement | null>(null);

  const frame = useRef<FrameHandle | null>(null);
  const tRef = useRef(0);
  const live = useRef({ index, playing, voice, done });
  live.current = { index, playing, voice, done };
  const speech = useRef<Speech>({ ...idleSpeech(), text: '' });
  // Set once the browser voice has failed to start; then lessons run on the plain clock.
  const speechBroken = useRef(false);
  // Learned speaking speed (characters per second), used to pace a sentence before boundary events arrive.
  const cps = useRef(14);

  const step = steps[index];
  const doneFn = useCallback((id: string) => {
    const i = steps.findIndex((s) => s.id === id);
    return i >= 0 && live.current.done.has(i);
  }, [steps]);
  const baseEnv = useMemo<Env>(() => ({ ...fns, done: doneFn, palette }), [fns, doneFn, palette]);

  const stopSpeech = () => { try { window.speechSynthesis?.cancel(); } catch { /* unsupported */ } };
  // Only one narration source may sound at a time; both start through this.
  const gate = useRef(new VoiceGate());
  const browserVoice = useRef({ stop: stopSpeech });
  const recordedVoice = useRef({ stop: () => audioRef.current?.pause() });
  const speak = useCallback((text: string, si: number, retried = false) => {
    if (!live.current.voice) return;
    const st: Speech = {
      si, text, requestedAt: performance.now(), started: false, startAt: 0, ended: false,
      failed: speechBroken.current || !('speechSynthesis' in window), retried,
      estMs: (text.length / cps.current) * 1000, p: 0,
    };
    speech.current = st;
    if (st.failed) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.onstart = () => {
        // Started after we gave up on it: silence it rather than talk over a
        // clock that has moved on.
        if (st.failed || speech.current !== st) { speechSynthesis.cancel(); return; }
        st.started = true;
        st.startAt = performance.now();
      };
      u.onboundary = (e) => {
        if (!st.started || !text.length) return;
        const p = Math.min(1, e.charIndex / text.length);
        st.p = Math.max(st.p, p);
        if (p > 0.15) st.estMs = (performance.now() - st.startAt) / p;
      };
      u.onend = () => {
        if (st.started) {
          const secs = (performance.now() - st.startAt) / 1000;
          if (secs > 0.5) cps.current = cps.current * 0.6 + (text.length / secs) * 0.4;
        }
        st.ended = true;
      };
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return; // we cancelled it
        st.ended = true;
        if (e.error === 'not-allowed') { setNeedsTap(true); setPlaying(false); }
      };
      gate.current.start('browser', browserVoice.current);
      setLock((l) => l ?? 'browser');
      speechSynthesis.speak(u);
    } catch {
      st.failed = true;
    }
  }, []);

  // Recorded narration (Gemini voice) for the current step, played through one audio element.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [badClips, setBadClips] = useState<Set<string>>(() => new Set());
  const clipFor = useCallback((s: Step) => {
    if (s.kind !== 'video') return undefined;
    const clip = narration?.clips?.[s.id];
    return clip && !badClips.has(s.id) && clipUsable(clip.bounds, s.narration.length) ? clip : undefined;
  }, [narration, badClips]);
  const getAudio = () => {
    if (!audioRef.current) audioRef.current = new Audio();
    return audioRef.current;
  };
  const stopVoice = useCallback(() => {
    gate.current.stopAll();
    stopSpeech();
    audioRef.current?.pause();
  }, []);
  const startAudio = useCallback((s: Step, url: string, from: number) => {
    const a = getAudio();
    const abs = new URL(url, window.location.origin).href;
    if (a.src !== abs) {
      a.src = abs;
      a.onerror = () => setBadClips((b) => new Set(b).add(s.id));
      // Timings that don't fit the audio would put words and pictures out of
      // step; use the browser voice for this chapter instead.
      a.onloadedmetadata = () => {
        const c = narration?.clips?.[s.id];
        if (s.kind === 'video' && c && !clipUsable(c.bounds, s.narration.length, a.duration)) {
          a.pause();
          setBadClips((b) => new Set(b).add(s.id));
        }
      };
    }
    a.currentTime = from;
    setLock((l) => l ?? voiceKey(narration));
    gate.current.start('recorded', recordedVoice.current);
    a.play().catch((e: DOMException) => {
      if (e.name === 'NotAllowedError') { setNeedsTap(true); setPlaying(false); }
      else if (e.name !== 'AbortError') setBadClips((b) => new Set(b).add(s.id));
    });
  }, [narration]);
  /** Start narration for the current step at the current time: recorded audio if there is some, else the browser voice. */
  const voiceStart = useCallback((s: Step) => {
    if (s.kind !== 'video' || !live.current.voice) return;
    if (waitingRef.current) return; // Max isn't ready yet; it starts by itself when it is
    const clip = clipFor(s);
    const b = timing[steps.indexOf(s)]?.bounds ?? [];
    if (clip) startAudio(s, clip.url, tRef.current);
    else { const si = sentenceAt(b, tRef.current); speak(s.narration[si], si); }
  }, [clipFor, startAudio, speak, timing, steps]);

  const markDone = useCallback((i: number) => {
    setDone((d) => (d.has(i) ? d : new Set(d).add(i)));
  }, []);

  const go = useCallback((i: number) => {
    const n = Math.max(0, Math.min(steps.length - 1, i));
    stopVoice();
    // Stop the old chapter's clock now; otherwise it ticks once more with the
    // time reset to 0 before React swaps it out, and speaks its first sentence
    // over the next chapter.
    frame.current = null;
    tRef.current = 0;
    setSentence(0);
    setIndex(n);
    setVisit((v) => v + 1);
    setToast(null);
    if (steps[n].kind === 'video' && !reducedMotion) setPlaying(true);
  }, [steps, stopVoice]);

  // Waiting for the preferred voice: its chapters are recorded one at a time,
  // and this chapter's isn't ready yet. The animation holds until it is.
  const curClip = step.kind === 'video' ? clipFor(step) : undefined;
  const waiting = step.kind === 'video' && chooseVoice({ voice, state: narrationState, lockedBrowser: lock === 'browser', hasClip: !!curClip }) === 'wait';
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  useEffect(() => {
    if (!waiting) return;
    // If it still isn't ready after a minute, carry on with the browser voice.
    const id = window.setTimeout(() => setLock((l) => l ?? 'browser'), 60_000);
    return () => clearTimeout(id);
  }, [waiting, index]);
  // Latest values for the frame below, so new chapters arriving don't restart the current one.
  const latest = useRef({ timing, clipFor, startAudio });
  latest.current = { timing, clipFor, startAudio };
  const boundsKey = step.kind === 'video' ? timing[index].bounds.join(',') : '';
  const curUrl = curClip?.url;

  // Video steps drive the stage directly; activities install their own frame.
  useEffect(() => {
    if (step.kind !== 'video') return;
    const { bounds, total } = latest.current.timing[index];
    const clip = latest.current.clipFor(step);
    const startAudio = latest.current.startAudio;
    let shown = -1;
    // Recorded narration: the audio is the clock, so start it with the step.
    if (clip && live.current.voice && live.current.playing) startAudio(step, clip.url, tRef.current);
    frame.current = {
      background: step.scene.background,
      tick(dt) {
        if (live.current.index !== index) return;
        if (waitingRef.current) return; // "Preparing narration…": hold until the voice is ready
        if (live.current.playing) {
          const t = tRef.current;
          const sp = speech.current;
          const a = audioRef.current;
          const { t: nt, event } = advanceClock({
            t, dt, now: performance.now(), bounds, voice: live.current.voice,
            audio: clip && live.current.voice && a ? a : null, speech: sp,
          });
          if (event === 'retry-speech') {
            // Browsers sometimes drop an utterance right after cancel(); ask once more.
            speak(sp.text, sp.si, true);
          } else if (event === 'speech-unavailable') {
            const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive;
            if (!active) {
              // Speech is blocked until the first click: pause and ask for one.
              speech.current = { ...idleSpeech(), text: '' };
              setNeedsTap(true);
              setPlaying(false);
              return;
            }
            sp.failed = true;
            speechBroken.current = true;
            try { speechSynthesis.cancel(); } catch { /* unsupported */ }
          }
          tRef.current = nt;
          if (nt >= total) {
            markDone(index);
            if (index < steps.length - 1) go(index + 1);
            else { tRef.current = total; setPlaying(false); }
            return;
          }
        }
        const si = sentenceAt(bounds, tRef.current);
        if (si !== shown) {
          shown = si;
          setSentence(si);
          if (live.current.playing && !(clip && live.current.voice)) speak(step.narration[si], si);
        }
      },
      draw(rc) {
        const shots = step.scene.shots;
        if (shots?.length) {
          // Shot-by-shot: the narration decides which shot is on, and how far into it we are.
          const T = tRef.current;
          const si = sentenceAt(bounds, T);
          const start = si > 0 ? bounds[si - 1] : 0;
          const len = Math.max(0.01, bounds[si] - start);
          const frac = Math.min(1, Math.max(0, (T - start) / len));
          const a = activeShot(shots, si, frac);
          if (a) {
            const span = Math.max(0.001, a.to - a.from);
            const p = Math.min(1, Math.max(0, (frac - a.from) / span));
            const sec = Math.max(0, T - (start + a.from * len));
            drawShot(rc, a.shot, { ...baseEnv, T }, p, sec);
          }
          return;
        }
        const t = (tRef.current / total) * step.scene.duration;
        drawElements(rc, step.scene.elements, { ...baseEnv, t });
      },
    };
    return () => { frame.current = null; audioRef.current?.pause(); };
    // `visit` re-runs this on Restart chapter, which restarts the recording too.
  }, [step, index, visit, boundsKey, curUrl, baseEnv, go, markDone, speak, steps.length]);

  useEffect(() => () => stopVoice(), [stopVoice]);

  const togglePlay = () => {
    const next = !playing;
    setPlaying(next);
    setNeedsTap(false);
    live.current.playing = next;
    if (next) voiceStart(step);
    else stopVoice();
  };

  const toggleVoice = (on: boolean) => {
    setVoice(on);
    onReadAloudChange?.(on);
    live.current.voice = on;
    try { localStorage.setItem('voice', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
    if (!on) { stopVoice(); setNeedsTap(false); }
    else if (playing) voiceStart(step);
  };

  const progressOf = useCallback((i: number) => {
    if (i < live.current.index || live.current.done.has(i)) return 1;
    if (i === live.current.index && timing[i].total > 0) return tRef.current / timing[i].total;
    return 0;
  }, [timing]);

  const elapsed = useCallback(() => tRef.current, []);

  const caption =
    step.kind === 'video' ? step.narration[sentence]
      : step.kind === 'quiz' ? `Answer ${step.questions.length} questions to finish the lesson.`
        : step.kind === 'pending' ? (step.stalled ? "This chapter couldn't be written yet." : 'Preparing this chapter…')
          : step.caption ?? 'Your turn: try it yourself.';

  const common = {
    frame,
    overlay,
    baseEnv,
    onGoal: () => markDone(index),
    onNext: () => go(index + 1),
    notify,
    completed: done.has(index),
  };

  // Remember progress per lesson (this browser only) for the search page's "Continue learning".
  useEffect(() => {
    if (!slug) return;
    try {
      localStorage.setItem(`progress:${slug}`, JSON.stringify({ index, done: done.size, total: steps.length, title: lesson.title, at: Date.now() }));
    } catch { /* storage unavailable */ }
  }, [slug, index, done, steps.length, lesson.title]);

  useEffect(() => { onIndexChange?.(index); }, [index, onIndexChange]);

  const crumbs = lesson.eyebrow.split('·').map((x) => x.trim()).filter((x) => x && !/^interactive lesson$/i.test(x));
  const kindLabel = (s: Step) => {
    const k = s.kind === 'pending' ? s.plannedKind : s.kind;
    return k === 'video' ? 'Video' : k === 'quiz' ? 'Quiz' : 'Try it';
  };
  // Which voice reads this chapter: the recording's provider, or the browser's own voice.
  const recorded = step.kind === 'video' && !!clipFor(step);
  const voiceName = !recorded ? 'browser'
    : narration?.provider === 'elevenlabs' ? 'ElevenLabs'
    : narration?.provider === 'gemini' ? `Gemini ${narration.voice}` : 'recording';

  return (
    <div className="app fixed">
      <TopBar crumb={<>{crumbs.map((c) => <span key={c}>{c} / </span>)}<b>{lesson.title}</b></>} search>
        <VoiceMenu
          voices={voices}
          selected={voiceId}
          onOpen={() => { if (playing) togglePlay(); }}
          onChange={(id) => { if (id !== voiceId) { stopVoice(); onVoiceChange?.(id, index); } }}
        />
        <button className="btn" type="button" aria-pressed={voice} onClick={() => toggleVoice(!voice)}>
          Read aloud: {voice ? 'On' : 'Off'}
        </button>
      </TopBar>

      <div className="studio">
        <aside className="rail" aria-label="Lesson outline">
          <div className="rail-head">
            <span className="lbl">Interactive lesson</span>
            <h1>{lesson.title}</h1>
            <p>{lesson.summary}</p>
          </div>
          <span className="lbl" style={{ padding: '0 6px' }}>Chapters · {index + 1} of {steps.length}</span>
          <ol className="chapters">
            {steps.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`ch ${i === index ? 'cur' : ''} ${done.has(i) && i !== index ? 'done' : ''}`}
                  aria-current={i === index ? 'step' : undefined}
                  onClick={() => go(i)}
                >
                  <b>{done.has(i) && i !== index ? '✓' : i + 1}</b>
                  <span className="t">{s.title}</span>
                  <span className="kind">{kindLabel(s)}</span>
                </button>
              </li>
            ))}
          </ol>
          {lesson.sources.length > 0 && (
            <div className="sources">
              <span className="lbl">Sources</span>
              <ul>
                {lesson.sources.map((src) => (
                  <li key={src.url}><a href={src.url} target="_blank" rel="noreferrer">{src.title}</a></li>
                ))}
              </ul>
              {lesson.note && <p>{lesson.note}</p>}
            </div>
          )}
        </aside>

        <section className="center" aria-label="Lesson player">
          <Stage
            frame={frame}
            palette={palette}
            tag={step.tag}
            overlayRef={setOverlay}
            overlayActive={step.kind === 'match' || step.kind === 'process'}
          >
            {toast && step.kind !== 'video' && (
              <div key={toast.key} className={`toast ${toast.tone}`} role="status">
                {toast.tone === 'ok' || toast.tone === 'win' ? '✓ ' : toast.tone === 'bad' ? '✗ ' : ''}{toast.text}
              </div>
            )}
            {step.kind === 'pending' && (
              <div className="preparing" role="status">
                {!step.stalled && <span className="spin" aria-hidden="true" />}
                {step.stalled ? "This chapter couldn't be written yet" : 'Preparing chapter…'}
              </div>
            )}
            {waiting && playing && (
              <div className="preparing" role="status"><span className="spin" aria-hidden="true" />Preparing narration…</div>
            )}
            {needsTap && step.kind === 'video' && (
              <button type="button" className="tap-sound" onClick={togglePlay}>▶ Play with sound</button>
            )}
          </Stage>
          <div className="caption" aria-live="polite"><p>{caption}</p></div>
          {voice && step.kind === 'video' && (
            <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.6 }}>Voice: {voiceName}</p>
          )}
          <div className="transport">
            <button className="btn" type="button" disabled={index === 0} onClick={() => go(index - 1)}>Back</button>
            <button
              className="btn primary icon"
              type="button"
              disabled={step.kind !== 'video'}
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              title={step.kind === 'video' ? (playing ? 'Pause' : 'Play') : 'Your turn: use the panel'}
            >
              {playing && step.kind === 'video' ? (
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="2" width="3" height="10" rx="1" fill="currentColor" /><rect x="8.5" y="2" width="3" height="10" rx="1" fill="currentColor" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 2.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L4.4 1.7a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>
              )}
            </button>
            <button className="btn" type="button" disabled={index === steps.length - 1} onClick={() => go(index + 1)}>Next</button>
            <Timeline steps={steps} timing={timing} index={index} progressOf={progressOf} onPick={go} elapsed={elapsed} />
            <button className="btn ghost" type="button" onClick={() => go(index)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" /><path d="M2.5 2.5v3h3" /></svg>
              <span className="restart-label">Restart chapter</span>
            </button>
          </div>
        </section>

        <section className="dock" key={`${step.id}-${index}-${visit}`} aria-label="Activity">
          {step.kind === 'video' && (
            <>
              <div className="dock-head"><span className="chip">Video</span><h2>{step.title}</h2></div>
              <div className="dock-body">
                <span className="lbl">Key terms</span>
                <dl className="terms">
                  {step.terms.map((t) => (
                    <div key={t.term}><dt>{t.term}</dt><dd>{t.definition}</dd></div>
                  ))}
                </dl>
              </div>
              <div className="dock-foot">
                <span className="note">Chapter {index + 1} of {steps.length}</span>
                <span className="sp" />
                <button className="btn" type="button" disabled={index === steps.length - 1} onClick={() => go(index + 1)}>Next chapter</button>
              </div>
            </>
          )}
          {step.kind === 'simulation' && <Simulation step={step} {...common} />}
          {step.kind === 'match' && <Match step={step} {...common} />}
          {step.kind === 'process' && <Process step={step} {...common} />}
          {step.kind === 'quiz' && (
            <Quiz step={step} {...common} onRestart={() => { setDone(new Set()); go(0); }} />
          )}
          {step.kind === 'pending' && (
            <>
              <div className="dock-head"><span className="chip">{kindLabel(step)}</span><h2>{step.title}</h2></div>
              <div className="dock-body" aria-live="polite">
                {step.stalled ? (
                  <>
                    <p className="intro">Writing stopped before this chapter. The chapters before it are ready to watch.</p>
                    {onRetry && <div><button className="btn primary" type="button" onClick={onRetry}>Try again</button></div>}
                  </>
                ) : (
                  <>
                    <p className="intro">This chapter is being prepared. It starts by itself when it's ready.</p>
                    <div className="ln" style={{ width: '90%' }} /><div className="ln" style={{ width: '75%' }} /><div className="ln" style={{ width: '60%' }} />
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
