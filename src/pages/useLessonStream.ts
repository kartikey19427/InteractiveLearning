import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getChapterNarration, getStep, type LessonMeta } from '../api';
import type { Lesson, Step } from '../lesson/types';
import type { Narration, NarrationState } from '../player/LessonPlayer';

/** How far ahead of the learner chapters (and their narration) are loaded: the current one and the next. */
export const LOOKAHEAD = 1;

type Fns = Record<string, { args: string[]; expr: string }>;

/**
 * Loads a lesson like a video stream: only the chapter being watched and the
 * next one, fetched (and their narration recorded) on demand. Chapters still
 * being written show as pending and are polled until they arrive.
 */
export function useLessonStream(slug: string, meta: LessonMeta | null, voiceId: string, voiceOn: boolean) {
  const [loaded, setLoaded] = useState<Record<number, Step>>({});
  const [fns, setFns] = useState<Fns>({});
  const [stalled, setStalled] = useState(false);
  const [index, setIndex] = useState(0);
  const [clips, setClips] = useState<Record<string, { url: string; bounds: number[] }>>({});
  const [chapterState, setChapterState] = useState<Record<string, NarrationState>>({});
  const inflight = useRef(new Set<string>());

  // A new lesson or voice starts from scratch.
  useEffect(() => { setLoaded({}); setFns({}); setStalled(false); inflight.current.clear(); }, [slug]);
  useEffect(() => { setClips({}); setChapterState({}); }, [slug, voiceId]);

  const outline = meta?.outline;
  const total = outline?.length ?? 0;

  const loadStep = useCallback(async (i: number) => {
    const key = `step:${i}`;
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    try {
      const r = await getStep(slug, i);
      if (r.ready && r.step) {
        setLoaded((m) => ({ ...m, [i]: r.step as Step }));
        if (r.functions) setFns((f) => (JSON.stringify(f) === JSON.stringify(r.functions) ? f : r.functions!));
      } else {
        setStalled(!!r.stalled);
      }
    } catch { /* retried by the poll below */ } finally {
      inflight.current.delete(key);
    }
  }, [slug]);

  const loadNarration = useCallback(async (stepId: string) => {
    // The browser voice (and "no voice") never needs the server: speak it live.
    if (!voiceId || voiceId === 'browser') {
      setChapterState((m) => (m[stepId] ? m : { ...m, [stepId]: 'none' }));
      return;
    }
    const key = `voice:${voiceId}:${stepId}`;
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    try {
      const r = await getChapterNarration(slug, stepId, voiceId || undefined);
      setChapterState((m) => (m[stepId] === r.state ? m : { ...m, [stepId]: r.state }));
      // Only the chosen voice's recordings are used; anything else falls back to the browser voice.
      if (r.state === 'ready' && r.clip) setClips((m) => (m[stepId] ? m : { ...m, [stepId]: r.clip! }));
    } catch {
      setChapterState((m) => ({ ...m, [stepId]: 'fallback' }));
    } finally {
      inflight.current.delete(key);
    }
  }, [slug, voiceId]);

  // Keep the current chapter and the next one loaded; poll while either is still being made.
  useEffect(() => {
    if (!total) return;
    let timer = 0;
    const tick = () => {
      let waiting = false;
      for (let i = index; i <= Math.min(total - 1, index + LOOKAHEAD); i++) {
        const st = loaded[i];
        if (!st) { void loadStep(i); waiting = true; continue; }
        if (st.kind === 'video' && voiceOn) {
          const s = chapterState[st.id];
          if (s === undefined || s === 'preparing') { void loadNarration(st.id); waiting = true; }
        }
      }
      if (waiting) timer = window.setTimeout(tick, 2500);
    };
    tick();
    return () => clearTimeout(timer);
  }, [index, total, loaded, chapterState, voiceOn, loadStep, loadNarration]);

  // The lesson as the player sees it: loaded chapters, and placeholders for the rest.
  const lesson = useMemo<Lesson | null>(() => {
    if (!meta || !outline) return null;
    const steps: Step[] = outline.map((o, i) => loaded[i] ?? {
      kind: 'pending', id: o.id, title: o.title, tag: o.tag, plannedKind: o.kind, stalled: stalled && i >= meta.steps_ready,
    });
    return {
      title: meta.title, eyebrow: meta.eyebrow, summary: meta.summary, palette: meta.palette ?? undefined,
      functions: { ...(meta.functions ?? {}), ...fns }, sources: meta.sources, note: meta.note ?? undefined, steps,
    };
    // `meta` changes on every poll of the topic; only rebuild when something the player uses changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.title, outline?.length, loaded, fns, stalled, meta?.steps_ready]);

  const narration = useMemo<Narration>(() => ({ provider: 'elevenlabs', voice: voiceId, clips }), [voiceId, clips]);
  const cur = lesson?.steps[index];
  const narrationState: NarrationState =
    cur?.kind !== 'video' ? 'none' : (chapterState[cur.id] ?? (voiceOn ? 'preparing' : 'none'));

  return { lesson, narration, narrationState, setIndex };
}
