import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProcessStep } from '../../lesson/types';
import { drawElements, resolveColor } from '../../lesson/scene';
import type { StepProps } from '../LessonPlayer';
import { DEFAULT_PALETTE } from '../../lesson/palette';
import Shell from './Shell';

function svgPoint(svg: SVGSVGElement, e: { clientX: number; clientY: number }) {
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

// A fixed sequence of actions (drag two things together, press buttons) with
// the scene advancing one stage per completed action.
export default function Process({ step, frame, overlay, baseEnv, onGoal, onNext, completed, notify }: StepProps<ProcessStep>) {
  const palette = { ...DEFAULT_PALETTE, ...(baseEnv.palette as Record<string, string> | undefined) };
  const [stage, setStage] = useState(0);
  const [verdict, setVerdict] = useState<{ text: string; tone: '' | 'ok' | 'no' }>({ text: step.prompt, tone: '' });
  const [goalNote, setGoalNote] = useState<string | null>(null);
  const [tok, setTok] = useState(() => mergeTokens(step, 0));
  const since = useRef(0);
  const onGoalRef = useRef(onGoal);
  onGoalRef.current = onGoal;

  useEffect(() => {
    since.current = 0;
    setTok(mergeTokens(step, stage));
  }, [step, stage]);

  useEffect(() => {
    frame.current = {
      tick(dt) { since.current += dt; },
      draw(rc) {
        const env = { ...baseEnv, t: since.current, stage };
        drawElements(rc, step.base, env);
        drawElements(rc, step.stages[stage] ?? [], env);
      },
    };
    return () => { frame.current = null; };
  }, [step, frame, baseEnv, stage]);

  const complete = (i: number) => {
    const s = step.steps[i];
    setStage(i + 1);
    setVerdict({ text: s.done, tone: 'ok' });
    notify(i === step.steps.length - 1 ? step.goal.note : s.done, i === step.steps.length - 1 ? 'win' : 'ok');
    if (i === step.steps.length - 1) {
      setGoalNote(step.goal.note);
      onGoalRef.current();
    }
  };

  const press = (i: number) => {
    if (i === stage) { complete(i); return; }
    const early = step.steps[i].early;
    if (i > stage && early) { setVerdict({ text: early, tone: 'no' }); notify(early, 'bad'); }
  };

  const restart = () => {
    setStage(0);
    setVerdict({ text: step.prompt, tone: '' });
    setTok(mergeTokens(step, 0));
  };

  const current = step.steps[stage];
  const merging = current?.action.type === 'merge';

  const onPointerDown = (e: React.PointerEvent<SVGGElement>, which: 0 | 1) => {
    if (!overlay || !tok) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const start = svgPoint(overlay, e);
    const p0 = tok[which];
    const dx = p0.x - start.x, dy = p0.y - start.y;
    let latest = tok;
    const move = (ev: PointerEvent) => {
      const q = svgPoint(overlay, ev);
      const next = [...latest] as typeof latest;
      next[which] = { ...next[which], x: Math.min(770, Math.max(30, q.x + dx)), y: Math.min(420, Math.max(30, q.y + dy)) };
      latest = next;
      setTok(next);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (Math.hypot(latest[0].x - latest[1].x, latest[0].y - latest[1].y) < 58) complete(stage);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const layer = overlay && merging && tok && createPortal(
    <g>
      {tok.map((t, i) => (
        <g
          key={i}
          className="drag"
          tabIndex={0}
          role="button"
          aria-label={`${t.label}. Press Enter to combine.`}
          style={{ transform: `translate(${t.x}px, ${t.y}px)` }}
          onPointerDown={(e) => onPointerDown(e, i as 0 | 1)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); complete(stage); } }}
        >
          <circle r={46} fill="transparent" />
          <circle r={30} fill={resolveColor(t.color, palette)} stroke="#FFF" strokeWidth={2} />
          <text y=".35em" textAnchor="middle" className="big dk">{t.label}</text>
        </g>
      ))}
    </g>,
    overlay,
  );

  return (
    <Shell title={step.title} intro={step.intro} goalNote={goalNote} completed={completed} onNext={onNext} status={`Step ${Math.min(stage + 1, step.steps.length)} of ${step.steps.length}`}>
      <div className="steps">
        {step.steps.map((s, i) => (
          <span key={s.label} className={i < stage ? 'fin' : i === stage ? 'on' : ''}>{i + 1} {s.label}</span>
        ))}
      </div>
      <hr className="rule" />
      <p className={`verdict ${verdict.tone}`}>{verdict.text}</p>
      <div className="act">
        {step.steps.map((s, i) =>
          s.action.type === 'button' ? (
            <button
              key={s.label}
              className="btn"
              type="button"
              disabled={i < stage || (i > stage && !s.early)}
              onClick={() => press(i)}
            >
              {s.action.label}
            </button>
          ) : null,
        )}
        <button className="btn ghost" type="button" onClick={restart}>Start over</button>
      </div>
      {layer}
    </Shell>
  );
}

function mergeTokens(step: ProcessStep, stage: number) {
  const a = step.steps[stage]?.action;
  return a?.type === 'merge' ? a.tokens.map((t) => ({ ...t })) as [typeof a.tokens[0], typeof a.tokens[1]] : null;
}
