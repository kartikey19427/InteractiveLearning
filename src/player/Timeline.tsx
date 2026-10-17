import { useEffect, useRef } from 'react';
import type { Step } from '../lesson/types';

interface Props {
  steps: Step[];
  timing: { total: number }[];
  index: number;
  progressOf: (i: number) => number;
  onPick: (i: number) => void;
  /** Seconds into the current video step. */
  elapsed: () => number;
}

const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Segmented timeline plus the running time. Both update from their own
// animation loop so the whole player doesn't re-render every frame.
export default function Timeline({ steps, timing, index, progressOf, onPick, elapsed }: Props) {
  const bars = useRef<(HTMLElement | null)[]>([]);
  const time = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const total = timing.reduce((a, t) => a + t.total, 0);
    const before = timing.slice(0, index).reduce((a, t) => a + t.total, 0);
    let raf = 0;
    let shown = '';
    const loop = () => {
      bars.current.forEach((b, i) => b?.style.setProperty('--p', `${Math.min(100, progressOf(i) * 100)}%`));
      const now = before + (timing[index]?.total ? Math.min(elapsed(), timing[index].total) : 0);
      const label = `${mmss(now)} / ${mmss(total)}`;
      if (label !== shown && time.current) { time.current.textContent = label; shown = label; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [progressOf, timing, index, elapsed]);

  return (
    <>
      <div className="tl" role="group" aria-label="Lesson timeline">
        {steps.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`${s.kind === 'video' ? '' : 'ix'} ${i === index ? 'cur' : ''}`}
            style={{ '--w': s.kind === 'video' ? Math.max(4, timing[i].total) : 8 } as React.CSSProperties}
            aria-label={`${s.title} (${s.kind === 'video' ? 'video' : 'you try it'})`}
            title={s.title}
            onClick={() => onPick(i)}
          >
            <i ref={(el) => { bars.current[i] = el; }} />
          </button>
        ))}
      </div>
      <span className="time" ref={time} aria-label="Narration time" />
    </>
  );
}
