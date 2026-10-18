// @vitest-environment happy-dom
import { act, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson } from '../lesson/types';
import type { FrameHandle } from './Stage';
import LessonPlayer, { type Narration, type NarrationState } from './LessonPlayer';

const stage = vi.hoisted(() => ({ frame: null as { current: FrameHandle | null } | null, tickOnCommit: false }));
vi.mock('./Stage', () => ({ default: function MockStage(props: { frame: typeof stage.frame; children: ReactNode }) {
  stage.frame = props.frame;
  useLayoutEffect(() => {
    if (stage.tickOnCommit) props.frame?.current?.tick?.(0.05);
  });
  return <div>{props.children}</div>;
} }));
vi.mock('../components/TopBar', () => ({ default: ({ children }: { children: ReactNode }) => <header>{children}</header> }));
vi.mock('../components/VoiceMenu', () => ({ default: () => null }));
vi.mock('./Timeline', () => ({ default: () => null }));

const lesson: Lesson = {
  title: 'Water', eyebrow: 'Science', summary: 'Water cycle', sources: [],
  steps: ['intro', 'evaporation'].map((id) => ({
    kind: 'video', id, title: id, tag: id, narration: [`${id} sentence one`, `${id} sentence two`],
    terms: [], scene: { duration: 10, elements: [] },
  })),
};

function Harness({ state = 'preparing', clips = false }: { state?: NarrationState; clips?: boolean }) {
  const [on, setOn] = useState(localStorage.getItem('voice') !== 'off');
  const narration = useMemo<Narration>(() => ({ voice: 'max', provider: 'elevenlabs', clips: clips ? {
      intro: { url: '/intro.mp3', bounds: [5, 10] },
      evaporation: { url: '/evaporation.mp3', bounds: [5, 10] },
    } : {} as Narration['clips'] }), [clips]);
  return <LessonPlayer lesson={lesson} voiceId="max" onReadAloudChange={setOn}
    narrationState={on ? state : 'none'} narration={narration} />;
}

let root: Root;
let host: HTMLDivElement;
let audio: { src: string; currentTime: number; paused: boolean; ended: boolean; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
let speak: ReturnType<typeof vi.fn>;
function render(state: NarrationState = 'preparing', clips = false) {
  act(() => root.render(<Harness state={state} clips={clips} />));
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(button, text).toBeTruthy();
  act(() => button!.click());
}
function tick() { act(() => stage.frame?.current?.tick?.(0.05)); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  speak = vi.fn();
  vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn() });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    text: string;
    constructor(text: string) { this.text = text; }
  });
  audio = { src: '', currentTime: 0, paused: true, ended: false,
    play: vi.fn(() => { audio.paused = false; return Promise.resolve(); }),
    pause: vi.fn(() => { audio.paused = true; }),
  };
  vi.stubGlobal('Audio', class { constructor() { return audio; } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  stage.frame = null;
  stage.tickOnCommit = false;
  vi.unstubAllGlobals();
});

describe('Read Aloud across chapter changes', () => {
  it.each(['ready', 'preparing'] as const)('starts browser speech despite stale %s ElevenLabs props during a voice switch', (state) => {
    render('ready', true);
    expect(audio.play).toHaveBeenCalled();
    act(() => root.render(<LessonPlayer key="browser" lesson={lesson} voiceId="browser"
      narrationState={state} narration={{ voice: 'max', provider: 'elevenlabs',
        clips: { intro: { url: '/intro.mp3', bounds: [5, 10] } } }} />));
    audio.play.mockClear();
    tick();
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'intro sentence one' }));
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.paused).toBe(true);
  });
  it('does not lock in browser speech if a frame ticks as a saved recording arrives', () => {
    render();
    tick();
    stage.tickOnCommit = true;
    render('ready', true);
    tick();
    expect(speak).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalled();
    expect(audio.paused).toBe(false);
  });
  it('waits for the selected recording after opening another lesson with Read Aloud off', () => {
    render('ready', true);
    click('Read aloud: On');
    act(() => root.unmount());
    root = createRoot(host);
    render();
    click('Next');
    tick();
    click('Read aloud: Off');
    tick();
    expect(speak).not.toHaveBeenCalled();
    audio.play.mockClear();
    render('ready', true);
    expect(audio.play).toHaveBeenCalled();
    expect(audio.src).toContain('evaporation.mp3');
  });

  it('starts browser narration when waiting ends without a recording', () => {
    render();
    tick();
    expect(speak).not.toHaveBeenCalled();
    render('fallback');
    tick();
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'intro sentence one' }));
  });

  it('resumes a cached recording when Read Aloud is enabled in another chapter', () => {
    render('ready', true);
    click('Read aloud: On');
    click('Next');
    tick();
    audio.play.mockClear();
    click('Read aloud: Off');
    expect(audio.play).toHaveBeenCalled();
    expect(audio.src).toContain('evaporation.mp3');
    expect(audio.paused).toBe(false);
  });

  it('speaks the new chapter after browser narration is disabled and enabled', () => {
    render('none');
    tick();
    click('Read aloud: On');
    click('Next');
    tick();
    speak.mockClear();
    click('Read aloud: Off');
    tick();
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'evaporation sentence one' }));
  });
});
