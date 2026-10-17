import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MatchStep, MatchToken } from '../../lesson/types';
import { evaluate, interpolate, type Env } from '../../lesson/expr';
import { drawElements, resolveColor } from '../../lesson/scene';
import type { StepProps } from '../LessonPlayer';
import { DEFAULT_PALETTE } from '../../lesson/palette';
import Shell from './Shell';

const R = 50;

interface Pos { x: number; y: number }
interface Fused { a: MatchToken; b: MatchToken; x: number; y: number; label: string }

function svgPoint(svg: SVGSVGElement, e: { clientX: number; clientY: number }) {
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

function Token({ colors, r, palette }: { colors: string[]; r: number; palette: Record<string, string> }) {
  const c = colors.map((x) => resolveColor(x, palette));
  return (
    <>
      {c.length > 1 ? (
        <>
          <path d={`M0 ${-r}A${r} ${r} 0 0 0 0 ${r}Z`} fill={c[0]} />
          <path d={`M0 ${-r}A${r} ${r} 0 0 1 0 ${r}Z`} fill={c[1]} />
        </>
      ) : (
        <circle r={r} fill={c[0]} />
      )}
    </>
  );
}

// Drag one token onto another; rules over the pair decide whether they combine.
export default function Match({ step, frame, overlay, baseEnv, onGoal, onNext, completed }: StepProps<MatchStep>) {
  const palette = { ...DEFAULT_PALETTE, ...(baseEnv.palette as Record<string, string> | undefined) };
  const [pos, setPos] = useState<Record<string, Pos>>(() => Object.fromEntries(step.tokens.map((t) => [t.id, { x: t.x, y: t.y }])));
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<{ text: string; ok: boolean }[]>([]);
  const [fused, setFused] = useState<Fused[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [anim, setAnim] = useState<string | null>(null);
  const [goalNote, setGoalNote] = useState<string | null>(null);
  const successes = useRef(0);
  const onGoalRef = useRef(onGoal);
  onGoalRef.current = onGoal;

  useEffect(() => {
    const scene = step.scene;
    frame.current = {
      background: scene?.background,
      draw(rc) { if (scene) drawElements(rc, scene.elements, baseEnv); },
    };
    return () => { frame.current = null; };
  }, [step, frame, baseEnv]);

  const envFor = (t: MatchToken): Env => ({ ...t.attrs, label: t.label, id: t.id });

  const attempt = (a: MatchToken, b: MatchToken) => {
    const env: Env = { ...baseEnv, a: envFor(a), b: envFor(b) };
    const rule = step.rules.find((r) => !!evaluate(r.when, env));
    const text = rule ? interpolate(rule.text, env) : `${a.label} + ${b.label}: nothing happens.`;
    setLog((l) => [...l, { text, ok: !!rule?.success }]);
    if (rule?.success) {
      const pa = pos[a.id], pb = pos[b.id];
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
      setAnim(`${a.id},${b.id}`);
      setPos((p) => ({ ...p, [a.id]: { x: mx, y: my }, [b.id]: { x: mx, y: my } }));
      setTimeout(() => {
        setGone((g) => new Set(g).add(a.id).add(b.id));
        setFused((f) => [...f, { a, b, x: mx, y: my, label: step.resultLabel ? interpolate(step.resultLabel, env) : '' }]);
      }, 380);
      successes.current += 1;
      if (successes.current >= step.goal.successes && !goalNote) {
        setGoalNote(step.goal.note);
        onGoalRef.current();
      }
    } else {
      setAnim(`${a.id},${b.id}`);
      setPos((p) => ({ ...p, [a.id]: { x: a.x, y: a.y }, [b.id]: { x: b.x, y: b.y } }));
    }
  };

  const onPointerDown = (e: React.PointerEvent<SVGGElement>, t: MatchToken) => {
    if (!overlay || gone.has(t.id)) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setAnim(null);
    const start = svgPoint(overlay, e);
    const p0 = pos[t.id];
    const dx = p0.x - start.x, dy = p0.y - start.y;
    let cur = p0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const q = svgPoint(overlay, ev);
      moved = true;
      cur = { x: Math.min(800 - R, Math.max(R, q.x + dx)), y: Math.min(450 - R - 30, Math.max(R, q.y + dy)) };
      setPos((p) => ({ ...p, [t.id]: cur }));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (!moved) return;
      const other = step.tokens.find((o) => o.id !== t.id && !gone.has(o.id) && Math.hypot(pos[o.id].x - cur.x, pos[o.id].y - cur.y) < R * 1.7);
      if (other) attempt(t, other);
      else { setAnim(t.id); setPos((p) => ({ ...p, [t.id]: { x: t.x, y: t.y } })); }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onKey = (e: React.KeyboardEvent, t: MatchToken) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (gone.has(t.id)) return;
    if (!sel) setSel(t.id);
    else if (sel === t.id) setSel(null);
    else {
      const a = step.tokens.find((x) => x.id === sel)!;
      setSel(null);
      attempt(a, t);
    }
  };

  const layer = overlay && createPortal(
    <g>
      {step.tokens.filter((t) => !gone.has(t.id)).map((t) => {
        const p = pos[t.id];
        const animating = anim?.split(',').includes(t.id);
        return (
          <g
            key={t.id}
            className="drag"
            tabIndex={0}
            role="button"
            aria-label={`${t.label}. Press Enter to select, then Enter on another to combine.`}
            style={{ transform: `translate(${p.x}px, ${p.y}px)`, transition: animating ? 'transform .35s ease' : 'none' }}
            onPointerDown={(e) => onPointerDown(e, t)}
            onKeyDown={(e) => onKey(e, t)}
          >
            <Token colors={t.colors} r={R} palette={palette} />
            <circle r={R} fill="none" stroke={sel === t.id ? '#B7A0EA' : '#F2EFE3'} strokeWidth={sel === t.id ? 6 : 3} />
            <text y={R + 24} textAnchor="middle">{t.label}</text>
          </g>
        );
      })}
      {fused.map((f) => (
        <g key={`${f.a.id}-${f.b.id}`} className="fade-in" transform={`translate(${f.x} ${f.y})`}>
          <rect x={-95} y={-38} width={190} height={76} rx={38} fill="rgba(242,239,227,.12)" stroke="#F2EFE3" strokeWidth={3} />
          {[[-40, f.a], [40, f.b]].map(([dx, tk]) => (
            <g key={(tk as MatchToken).id} transform={`translate(${dx} 0)`}>
              <Token colors={(tk as MatchToken).colors} r={24} palette={palette} />
              <circle r={24} fill="none" stroke="#F2EFE3" strokeWidth={2} />
            </g>
          ))}
          {f.label && <text y={70} textAnchor="middle">{f.label}</text>}
        </g>
      ))}
      {step.legend && <text x={400} y={436} textAnchor="middle" className="mu">{step.legend}</text>}
    </g>,
    overlay,
  );

  return (
    <Shell title={step.title} intro={step.intro} goalNote={goalNote} completed={completed} onNext={onNext}>
      <p className="q">{step.question}</p>
      <ul className="log">
        {log.length === 0 ? <li className="note">No attempts yet.</li> : log.map((l, i) => <li key={i} className={l.ok ? 'y' : 'n'}>{l.text}</li>)}
      </ul>
      {layer}
    </Shell>
  );
}
