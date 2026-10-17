import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MatchStep, MatchToken } from '../../lesson/types';
import { evaluate, interpolate, type Env } from '../../lesson/expr';
import { drawElements, resolveColor } from '../../lesson/scene';
import type { StepProps } from '../LessonPlayer';
import { DEFAULT_PALETTE } from '../../lesson/palette';
import Shell from './Shell';

interface Pos { x: number; y: number }
interface Fused { a: MatchToken; b: MatchToken; label: string }

// Stage regions: tokens live above TRAY_TOP, matched pairs collect in the tray below.
const AREA_TOP = 96; // leave the top band for the scene's own heading
const TRAY_TOP = 362;
const CHAR_W = 8.6; // approximate width of one label character in stage units

function svgPoint(svg: SVGSVGElement, e: { clientX: number; clientY: number }) {
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > maxChars) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

/**
 * Lay tokens out ourselves instead of trusting generated coordinates, which
 * often collide. The generated x values only decide which column a token is in
 * (e.g. items on the left, categories on the right); rows are spaced evenly.
 */
function layout(tokens: MatchToken[]) {
  let cols: MatchToken[][] = [];
  for (const t of [...tokens].sort((a, b) => a.x - b.x)) {
    const last = cols[cols.length - 1];
    if (last && Math.abs(t.x - last[0].x) < 120) last.push(t);
    else cols.push([t]);
  }
  if (cols.length > 3 || (cols.length === 1 && tokens.length > 3)) {
    const k = Math.min(3, Math.ceil(tokens.length / 2));
    const per = Math.ceil(tokens.length / k);
    cols = Array.from({ length: k }, (_, i) => tokens.slice(i * per, (i + 1) * per)).filter((c) => c.length);
  }
  cols.forEach((c) => c.sort((a, b) => a.y - b.y));
  const colW = 800 / cols.length;
  const rows = Math.max(...cols.map((c) => c.length));
  const cellH = (TRAY_TOP - AREA_TOP) / rows;
  const r = Math.max(16, Math.min(46, cellH * 0.3, colW * 0.16));
  const maxChars = Math.max(10, Math.floor((colW - 24) / CHAR_W));
  const pos: Record<string, Pos> = {};
  cols.forEach((col, i) => col.forEach((t, j) => {
    // Shift up a little so the label under the token stays inside its cell.
    pos[t.id] = { x: colW * (i + 0.5), y: AREA_TOP + cellH * (j + 0.5) - 12 };
  }));
  return { pos, r, maxChars };
}

function Token({ colors, r, palette }: { colors: string[]; r: number; palette: Record<string, string> }) {
  const c = colors.map((x) => resolveColor(x, palette));
  return c.length > 1 ? (
    <>
      <path d={`M0 ${-r}A${r} ${r} 0 0 0 0 ${r}Z`} fill={c[0]} />
      <path d={`M0 ${-r}A${r} ${r} 0 0 1 0 ${r}Z`} fill={c[1]} />
    </>
  ) : (
    <circle r={r} fill={c[0]} />
  );
}

// Drag one token onto another; rules over the pair decide whether they combine.
export default function Match({ step, frame, overlay, baseEnv, onGoal, onNext, completed, notify }: StepProps<MatchStep>) {
  const palette = { ...DEFAULT_PALETTE, ...(baseEnv.palette as Record<string, string> | undefined) };
  const home = useMemo(() => layout(step.tokens), [step.tokens]);
  const R = home.r;
  const [pos, setPos] = useState<Record<string, Pos>>(home.pos);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<{ text: string; ok: boolean }[]>([]);
  const [fused, setFused] = useState<Fused[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [anim, setAnim] = useState<string | null>(null);
  const [goalNote, setGoalNote] = useState<string | null>(null);
  // Ids flashing red (wrong pair, shaking) or green (right pair) on the stage.
  const [bad, setBad] = useState<string[]>([]);
  const [good, setGood] = useState<string[]>([]);
  const successes = useRef(0);
  const onGoalRef = useRef(onGoal);
  onGoalRef.current = onGoal;

  useEffect(() => {
    const scene = step.scene;
    frame.current = {
      background: scene?.background,
      draw(rc) {
        if (scene) drawElements(rc, scene.elements, baseEnv);
        // Faint divider above the tray of matched pairs.
        rc.ctx.strokeStyle = 'rgba(232,240,230,.12)';
        rc.ctx.lineWidth = 1;
        rc.ctx.beginPath();
        rc.ctx.moveTo(24, TRAY_TOP);
        rc.ctx.lineTo(776, TRAY_TOP);
        rc.ctx.stroke();
      },
    };
    return () => { frame.current = null; };
  }, [step, frame, baseEnv]);

  const envFor = (t: MatchToken): Env => ({ ...t.attrs, label: t.label, id: t.id });
  const sendHome = (...ts: MatchToken[]) =>
    setPos((p) => ({ ...p, ...Object.fromEntries(ts.map((t) => [t.id, home.pos[t.id]])) }));

  const attempt = (a: MatchToken, b: MatchToken) => {
    const env: Env = { ...baseEnv, a: envFor(a), b: envFor(b) };
    const rule = step.rules.find((r) => !!evaluate(r.when, env));
    const text = rule ? interpolate(rule.text, env) : `${a.label} + ${b.label}: nothing happens.`;
    setLog((l) => [...l, { text, ok: !!rule?.success }]);
    setAnim(`${a.id},${b.id}`);
    if (rule?.success) {
      setGood([a.id, b.id]);
      const done = successes.current + 1 >= step.goal.successes;
      notify(done ? step.goal.note : text, done ? 'win' : 'ok');
      const pa = pos[a.id], pb = pos[b.id];
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      setPos((p) => ({ ...p, [a.id]: mid, [b.id]: mid }));
      setTimeout(() => {
        setGone((g) => new Set(g).add(a.id).add(b.id));
        setFused((f) => [...f, { a, b, label: step.resultLabel ? interpolate(step.resultLabel, env) : `${a.label} + ${b.label}` }]);
      }, 380);
      successes.current += 1;
      if (successes.current >= step.goal.successes && !goalNote) {
        setGoalNote(step.goal.note);
        onGoalRef.current();
      }
    } else {
      setBad([a.id, b.id]);
      notify(text, 'bad');
      setTimeout(() => setBad([]), 650);
      // Let the shake play where they met, then snap back.
      setTimeout(() => sendHome(a, b), 450);
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
      cur = { x: Math.min(800 - R, Math.max(R, q.x + dx)), y: Math.min(450 - R, Math.max(R, q.y + dy)) };
      setPos((p) => ({ ...p, [t.id]: cur }));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (!moved) return;
      const other = step.tokens.find((o) => o.id !== t.id && !gone.has(o.id) && Math.hypot(pos[o.id].x - cur.x, pos[o.id].y - cur.y) < R * 1.8);
      if (other) attempt(t, other);
      else { setAnim(t.id); sendHome(t); }
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

  // Matched pairs as chips in rows along the bottom tray.
  const chips: { f: Fused; x: number; y: number; w: number }[] = [];
  {
    let x = 24, y = TRAY_TOP + 26;
    for (const f of fused) {
      const w = Math.min(752, 74 + f.label.length * CHAR_W * 0.9);
      if (x + w > 776) { x = 24; y += 40; }
      chips.push({ f, x, y, w });
      x += w + 10;
    }
  }

  const layer = overlay && createPortal(
    <g>
      {step.tokens.filter((t) => !gone.has(t.id)).map((t) => {
        const p = pos[t.id];
        const animating = anim?.split(',').includes(t.id);
        const lines = wrap(t.label, home.maxChars);
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
            <g className={bad.includes(t.id) ? 'shake' : ''}>
              <Token colors={t.colors} r={R} palette={palette} />
              <circle
                r={R}
                fill="none"
                stroke={bad.includes(t.id) ? '#F08A7C' : good.includes(t.id) ? '#6FCB91' : sel === t.id ? '#B7A0EA' : '#F2EFE3'}
                strokeWidth={bad.includes(t.id) || good.includes(t.id) || sel === t.id ? 6 : 2.5}
              />
            </g>
            <text y={R + 20} textAnchor="middle">
              {lines.map((l, i) => <tspan key={i} x={0} dy={i === 0 ? 0 : '1.15em'}>{l}</tspan>)}
            </text>
          </g>
        );
      })}
      <text x={776} y={30} textAnchor="end" className={fused.length >= step.goal.successes ? 'ok' : ''}>
        {fused.length >= step.goal.successes ? '✓ ' : ''}{fused.length} of {step.goal.successes} matched
      </text>
      {fused.length === 0 && (
        <text x={400} y={TRAY_TOP + 40} textAnchor="middle" className="mu">Matched pairs appear here</text>
      )}
      {chips.map(({ f, x, y, w }) => (
        <g key={`${f.a.id}-${f.b.id}`} className="fade-in" transform={`translate(${x} ${y})`}>
          <rect x={0} y={-15} width={w} height={30} rx={15} fill="rgba(111,203,145,.16)" stroke="#6FCB91" strokeWidth={1.5} />
          <g transform="translate(16 0)"><Token colors={f.a.colors} r={8} palette={palette} /></g>
          <g transform="translate(34 0)"><Token colors={f.b.colors} r={8} palette={palette} /></g>
          <text x={48} y={0} dominantBaseline="central" className="sm">✓ {f.label}</text>
        </g>
      ))}
    </g>,
    overlay,
  );

  return (
    <Shell title={step.title} intro={step.intro} goalNote={goalNote} completed={completed} onNext={onNext} status={`${fused.length} of ${step.goal.successes} matched`}>
      <p className="q">{step.question}</p>
      {step.legend && <p className="note">{step.legend}</p>}
      <div className="progress"><div className="bar"><i style={{ width: `${Math.min(1, fused.length / step.goal.successes) * 100}%` }} /></div><span>{fused.length} of {step.goal.successes} matched</span></div>
      <ul className="log">
        {log.length === 0 ? <li className="note">No attempts yet.</li> : log.map((l, i) => <li key={i} className={l.ok ? 'y' : 'n'}>{l.text}</li>)}
      </ul>
      {layer}
    </Shell>
  );
}
