// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { getChapterNarration, getStep, type LessonMeta } from '../api';
import { useLessonStream } from './useLessonStream';

vi.mock('../api', () => ({ getChapterNarration: vi.fn(), getStep: vi.fn() }));
const meta: LessonMeta = { title: 'Water', eyebrow: 'Science', summary: '', sources: [],
  outline: [{ id: 'intro', kind: 'video', title: 'Intro', tag: '' }], steps_ready: 1, complete: true };
const step = { kind: 'video' as const, id: 'intro', title: 'Intro', tag: '', narration: ['Water rises.'], terms: [], scene: { duration: 3, elements: [] } };
const clip = { url: '/max.wav', bounds: [3] };
let stream: ReturnType<typeof useLessonStream>;
function Harness({ voice }: { voice: string }) {
  const result = useLessonStream('water', meta, voice, true);
  useLayoutEffect(() => { stream = result; });
  return null;
}
const host = document.createElement('div');
let root = createRoot(host);
afterEach(() => { act(() => root.unmount()); root = createRoot(host); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('never exposes an ElevenLabs recording to the browser voice during the switch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(getStep).mockResolvedValue({ ready: true, chunk: [{ index: 0, step }] });
  vi.mocked(getChapterNarration).mockResolvedValue({ state: 'ready', clip });
  const observed: string[] = [];
  // Read render output before reset effects have run, as a remounted player does.
  function SwitchingHarness({ voice }: { voice: string }) {
    const s = useLessonStream('water', meta, voice, true);
    if (voice === 'browser') observed.push(...Object.keys(s.narration.clips));
    return null;
  }
  await act(async () => root.render(<SwitchingHarness voice="max" />));
  expect(getChapterNarration).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<SwitchingHarness voice="browser" />));
  expect(observed).toEqual([]);
  expect(getChapterNarration).toHaveBeenCalledTimes(1);
});

it('ignores an ElevenLabs response that finishes after switching to browser speech', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(getStep).mockResolvedValue({ ready: true, chunk: [{ index: 0, step }] });
  let resolve!: (value: Awaited<ReturnType<typeof getChapterNarration>>) => void;
  vi.mocked(getChapterNarration).mockReturnValue(new Promise((r) => { resolve = r; }));
  await act(async () => root.render(<Harness voice="max" />));
  await act(async () => root.render(<Harness voice="browser" />));
  await act(async () => resolve({ state: 'ready', clip }));
  expect(stream.narration.clips).toEqual({});
  expect(stream.narrationState).toBe('none');
});
