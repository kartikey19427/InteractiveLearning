import { useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';
import { DEFAULT_BG, STAGE_H, STAGE_W, type RenderCtx } from '../lesson/scene';

export interface FrameHandle {
  tick?: (dt: number) => void;
  draw: (rc: RenderCtx) => void;
  background?: string;
}

interface Props {
  frame: MutableRefObject<FrameHandle | null>;
  palette: Record<string, string>;
  tag: string;
  overlayRef: (el: SVGSVGElement | null) => void;
  overlayActive: boolean;
  children?: ReactNode;
}

// The 16:9 stage: a canvas redrawn every animation frame, plus an SVG layer on
// top for draggable pieces in activities.
export default function Stage({ frame, palette, tag, overlayRef, overlayActive, children }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    let k = 1;
    const fit = () => {
      const r = cv.getBoundingClientRect();
      const d = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(2, Math.round(r.width * d));
      cv.height = Math.max(2, Math.round(r.height * d));
      k = Math.max(0.2, r.width / STAGE_W);
      cv.parentElement?.style.setProperty('--fs', `${Math.min(30, Math.max(15, 13 / k))}px`);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(cv);
    fit();

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const f = frame.current;
      try {
        f?.tick?.(dt);
        ctx.setTransform(cv.width / STAGE_W, 0, 0, cv.width / STAGE_W, 0, 0);
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.fillStyle = f?.background ?? DEFAULT_BG;
        ctx.fillRect(0, 0, STAGE_W, STAGE_H);
        f?.draw({ ctx, k, palette: paletteRef.current });
      } catch (err) {
        console.error('Stage frame failed', err);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [frame]);

  return (
    <div className="stage">
      <canvas ref={canvas} aria-hidden="true" />
      <svg
        ref={overlayRef}
        className="overlay"
        viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
        role="group"
        aria-label="Interactive stage"
        style={{ display: overlayActive ? 'block' : 'none' }}
      />
      {tag && <div className="tag">{tag}</div>}
      {children}
    </div>
  );
}
