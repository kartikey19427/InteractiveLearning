import { useEffect, useRef } from 'react';
import type { Step } from '../lesson/types';

interface Props {
  steps: Step[];
  timing: { total: number }[];
  index: number;
  progressOf: (i: number) => number;
  onPick: (i: number) => void;
}

// Segmented timeline. Progress bars update from their own animation loop so
// the whole player doesn't re-render every frame.
export default function Timeline({ steps, timing, index, progressOf, onPick }: Props) {
  const bars = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      bars.current.forEach((b, i) => b?.style.setProperty('--p', `${Math.min(100, progressOf(i) * 100)}%`));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [progressOf]);

  return (
    <div className="tl" role="group" aria-label="Lesson timeline">
      {steps.map((s, i) => (
        <button
          key={s.id}
          type="button"
          className={`${s.kind === 'video' ? '' : 'ix'} ${i === index ? 'cur' : ''}`}
          style={{ '--w': s.kind === 'video' ? timing[i].total : 8 } as React.CSSProperties}
          aria-label={`${s.title} (${s.kind === 'video' ? 'video' : 'you try it'})`}
          title={s.title}
          onClick={() => onPick(i)}
        >
          <i ref={(el) => { bars.current[i] = el; }} />
        </button>
      ))}
    </div>
  );
}
