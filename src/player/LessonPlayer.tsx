import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Lesson, Step, VideoStep } from '../lesson/types';
import { defineFunctions, type Env } from '../lesson/expr';
import { drawElements } from '../lesson/scene';
import Stage, { type FrameHandle } from './Stage';
import Timeline from './Timeline';
import Simulation from './interactions/Simulation';
import Match from './interactions/Match';
import Process from './interactions/Process';
import Quiz from './interactions/Quiz';
import { DEFAULT_PALETTE } from '../lesson/palette';


const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface Speech {
  si: number;
  text: string;
  requestedAt: number;
  started: boolean;
  startAt: number;
  ended: boolean;
  /** Expected speaking time; refined by boundary events. */
  estMs: number;
  /** Progress through the sentence from the last boundary event, 0..1. */
  p: number;
}

const idleSpeech = (): Speech => ({ si: -1, text: '', requestedAt: 0, started: false, startAt: 0, ended: true, estMs: 1, p: 0 });

// Playback length of each narration sentence, so scenes pace to the words.
function sentenceBounds(step: VideoStep) {
  let acc = 0;
  const bounds = step.narration.map((s) => {
    acc += Math.max(2.6, s.split(/\s+/).length * 0.36 + 0.9);
    return acc;
  });
  return { bounds, total: acc };
}

function sentenceAt(bounds: number[], t: number) {
  let i = 0;
  while (i < bounds.length - 1 && t >= bounds[i]) i++;
  return i;
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
  voice: string;
  clips: Record<string, { url: string; bounds: number[] }>;
}

export default function LessonPlayer({ lesson, narration }: { lesson: Lesson; narration?: Narration | null }) {
  const steps = lesson.steps;
  const palette = useMemo(() => ({ ...DEFAULT_PALETTE, ...lesson.palette }), [lesson.palette]);
  const fns = useMemo(() => defineFunctions(lesson.functions), [lesson.functions]);
  const timing = useMemo(
    () => steps.map((s) => {
      if (s.kind !== 'video') return { bounds: [], total: 0 };
      // With recorded narration, each sentence lasts exactly as long as it does in the audio.
      const clip = narration?.clips?.[s.id];
      if (clip && clip.bounds.length === s.narration.length) return { bounds: clip.bounds, total: clip.bounds[clip.bounds.length - 1] };
      return sentenceBounds(s);
    }),
    [steps, narration],
  );

  const [index, setIndex] = useState(0);
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
  const speech = useRef<Speech>(idleSpeech());
  // Learned speaking speed (characters per second), used to pace a sentence before boundary events arrive.
  const cps = useRef(14);

  const step = steps[index];
  const doneFn = useCallback((id: string) => {
    const i = steps.findIndex((s) => s.id === id);
    return i >= 0 && live.current.done.has(i);
  }, [steps]);
  const baseEnv = useMemo<Env>(() => ({ ...fns, done: doneFn, palette }), [fns, doneFn, palette]);

  const stopSpeech = () => { try { window.speechSynthesis?.cancel(); } catch { /* unsupported */ } };
  const speak = useCallback((text: string, si: number) => {
    if (!live.current.voice || !('speechSynthesis' in window)) return;
    const st: Speech = {
      si, text, requestedAt: performance.now(), started: false, startAt: 0, ended: false,
      estMs: (text.length / cps.current) * 1000, p: 0,
    };
    speech.current = st;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.onstart = () => { st.started = true; st.startAt = performance.now(); };
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
        st.ended = true;
        if (e.error === 'not-allowed') { setNeedsTap(true); setPlaying(false); }
      };
      speechSynthesis.speak(u);
    } catch {
      st.ended = true;
    }
  }, []);

  // Recorded narration (Gemini voice) for the current step, played through one audio element.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [badClips, setBadClips] = useState<Set<string>>(() => new Set());
  const clipFor = useCallback((s: Step) => {
    if (s.kind !== 'video') return undefined;
    const clip = narration?.clips?.[s.id];
    return clip && !badClips.has(s.id) && clip.bounds.length === s.narration.length ? clip : undefined;
  }, [narration, badClips]);
  const getAudio = () => {
    if (!audioRef.current) audioRef.current = new Audio();
    return audioRef.current;
  };
  const stopVoice = useCallback(() => {
    stopSpeech();
    audioRef.current?.pause();
  }, []);
  const startAudio = useCallback((s: Step, url: string, from: number) => {
    const a = getAudio();
    const abs = new URL(url, window.location.origin).href;
    if (a.src !== abs) { a.src = abs; a.onerror = () => setBadClips((b) => new Set(b).add(s.id)); }
    a.currentTime = from;
    a.play().catch((e: DOMException) => {
      if (e.name === 'NotAllowedError') { setNeedsTap(true); setPlaying(false); }
      else if (e.name !== 'AbortError') setBadClips((b) => new Set(b).add(s.id));
    });
  }, []);
  /** Start narration for the current step at the current time: recorded audio if there is some, else the browser voice. */
  const voiceStart = useCallback((s: Step) => {
    if (s.kind !== 'video' || !live.current.voice) return;
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
    tRef.current = 0;
    setSentence(0);
    setIndex(n);
    setVisit((v) => v + 1);
    setToast(null);
    if (steps[n].kind === 'video' && !reducedMotion) setPlaying(true);
  }, [steps, stopVoice]);

  // Video steps drive the stage directly; activities install their own frame.
  useEffect(() => {
    if (step.kind !== 'video') return;
    const { bounds, total } = timing[index];
    const clip = clipFor(step);
    let shown = -1;
    // Recorded narration: the audio is the clock, so start it with the step.
    if (clip && live.current.voice && live.current.playing) startAudio(step, clip.url, tRef.current);
    frame.current = {
      background: step.scene.background,
      tick(dt) {
        if (live.current.playing) {
          const t = tRef.current;
          const si = sentenceAt(bounds, t);
          const slotStart = si > 0 ? bounds[si - 1] : 0;
          const slotEnd = bounds[si] - 0.02;
          const sp = speech.current;
          let nt = t + dt;
          const a = audioRef.current;
          if (clip && live.current.voice) {
            // Follow the recording exactly; hold while it loads, run out the clock once it ends.
            if (a && a.ended) nt = t + dt;
            else if (a && !a.paused) nt = Math.max(t, a.currentTime);
            else nt = t;
          } else if (live.current.voice && sp.si === si) {
            // The voice drives the clock: each sentence's slice of the animation
            // plays across exactly the time it takes to say that sentence.
            const now = performance.now();
            if (!sp.started && !sp.ended && now - sp.requestedAt > 1500) {
              // The voice never started. Before any click the browser blocks speech,
              // so pause and ask for one; otherwise carry on without sound.
              sp.ended = true;
              if (!(navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) {
                setNeedsTap(true);
                setPlaying(false);
                return;
              }
            }
            if (sp.ended && !sp.started) nt = t + dt; // no voice available: plain clock
            else if (sp.ended) nt = t + dt * 4; // speech done: move briskly to the next sentence
            else if (!sp.started) nt = t; // wait for the voice to begin
            else {
              const p = Math.max(sp.p, Math.min(0.97, (now - sp.startAt) / sp.estMs));
              nt = Math.min(slotEnd, Math.max(t, slotStart + p * (slotEnd - slotStart)));
            }
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
        const t = (tRef.current / total) * step.scene.duration;
        drawElements(rc, step.scene.elements, { ...baseEnv, t });
      },
    };
    return () => { frame.current = null; audioRef.current?.pause(); };
    // `visit` re-runs this on Restart chapter, which restarts the recording too.
  }, [step, index, visit, timing, baseEnv, go, markDone, speak, steps.length, clipFor, startAudio]);

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

  const caption =
    step.kind === 'video' ? step.narration[sentence]
      : step.kind === 'quiz' ? `Answer ${step.questions.length} questions to finish the lesson.`
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

  return (
    <div className="lesson">
      <header>
        <div className="eyebrow">{lesson.eyebrow}</div>
        <h1>{lesson.title}</h1>
        <p>{lesson.summary}</p>
      </header>

      <div className="lesson-main">
      <section className="player" aria-label="Lesson player">
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
          {needsTap && step.kind === 'video' && (
            <button type="button" className="tap-sound" onClick={togglePlay}>▶ Play with sound</button>
          )}
        </Stage>
        <div className="caption" aria-live="polite">{caption}</div>
        <div className="controls">
          <button className="btn" type="button" disabled={index === 0} onClick={() => go(index - 1)}>Back</button>
          <button className="btn primary" type="button" disabled={step.kind !== 'video'} onClick={togglePlay}>
            {step.kind === 'video' ? (playing ? 'Pause' : 'Play') : 'Your turn'}
          </button>
          <button className="btn" type="button" disabled={index === steps.length - 1} onClick={() => go(index + 1)}>Next</button>
          <button className="btn ghost" type="button" onClick={() => go(index)}>Restart chapter</button>
          <label className="voice">
            <input type="checkbox" checked={voice} onChange={(e) => toggleVoice(e.target.checked)} /> Read aloud
          </label>
        </div>
        <Timeline steps={steps} timing={timing} index={index} progressOf={progressOf} onPick={go} />
        <div className="legend"><span>Video chapter</span><span className="lx">You try it</span></div>
      </section>

      <section className="panel" key={`${step.id}-${index}-${visit}`}>
        {step.kind === 'video' && (
          <>
            <div className="phead"><span className="chip">Video</span><h2>{step.title}</h2></div>
            <dl className="terms">
              {step.terms.map((t) => (
                <div key={t.term}><dt>{t.term}</dt><dd>{t.definition}</dd></div>
              ))}
            </dl>
          </>
        )}
        {step.kind === 'simulation' && <Simulation step={step} {...common} />}
        {step.kind === 'match' && <Match step={step} {...common} />}
        {step.kind === 'process' && <Process step={step} {...common} />}
        {step.kind === 'quiz' && (
          <Quiz step={step} {...common} onRestart={() => { setDone(new Set()); go(0); }} />
        )}
      </section>
      </div>

      <nav className="chap" aria-label="Chapters">
        <h2>Chapters</h2>
        <ol>
          {steps.map((s, i) => (
            <li key={s.id}>
              <button type="button" className={i === index ? 'cur' : ''} onClick={() => go(i)}>
                <span className="m">
                  {String(i + 1).padStart(2, '0')} · {s.kind === 'video' ? 'Video' : s.kind === 'quiz' ? 'Quiz' : 'Try it'}
                  {done.has(i) && <> · <b>done</b></>}
                </span>
                <span>{s.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {lesson.sources.length > 0 && (
        <section className="src">
          <strong>Sources</strong>
          <ul>
            {lesson.sources.map((s) => (
              <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>
            ))}
          </ul>
          {lesson.note && <p>{lesson.note}</p>}
        </section>
      )}
    </div>
  );
}
