import { useEffect, useRef, useState } from 'react';
import type { Rule, SimulationStep } from '../../lesson/types';
import { evaluate, type Env } from '../../lesson/expr';
import { drawElements } from '../../lesson/scene';
import type { StepProps } from '../LessonPlayer';
import Shell from './Shell';

function initialValues(step: SimulationStep) {
  const controls: Record<string, number> = {};
  for (const c of step.controls) controls[c.id] = c.initial;
  return { controls, state: { ...step.state } };
}

function firstRule(rules: Rule[] | undefined, env: Env) {
  return rules?.find((r) => !!evaluate(r.when, env))?.text ?? '';
}

// Slider-driven simulation: controls feed state variables that update every
// frame, and the scene, readouts and checklist read from that state.
export default function Simulation({ step, frame, baseEnv, onGoal, onNext, completed }: StepProps<SimulationStep>) {
  const sim = useRef(initialValues(step));
  const [controls, setControls] = useState(sim.current.controls);
  const [goalNote, setGoalNote] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const goalHit = useRef(false);
  const onGoalRef = useRef(onGoal);
  onGoalRef.current = onGoal;

  const env = (): Env => ({ ...baseEnv, ...sim.current.controls, ...sim.current.state });

  useEffect(() => {
    let acc = 0;
    frame.current = {
      background: step.scene.background,
      tick(dt) {
        const s = sim.current;
        for (const u of step.update) {
          const v = Number(evaluate(u.expr, { ...baseEnv, ...s.controls, ...s.state, dt }));
          if (Number.isFinite(v)) s.state[u.var] = v;
        }
        if (!goalHit.current && evaluate(step.goal.when, { ...baseEnv, ...s.controls, ...s.state })) {
          goalHit.current = true;
          setGoalNote(step.goal.note);
          onGoalRef.current();
        }
        acc += dt;
        if (acc > 0.1) { acc = 0; setTick((n) => n + 1); }
      },
      draw(rc) {
        drawElements(rc, step.scene.elements, { ...baseEnv, ...sim.current.controls, ...sim.current.state });
      },
    };
    return () => { frame.current = null; };
  }, [step, frame, baseEnv]);

  const setControl = (id: string, v: number) => {
    sim.current.controls = { ...sim.current.controls, [id]: v };
    setControls(sim.current.controls);
  };

  const applyPreset = (p: NonNullable<SimulationStep['presets']>[number]) => {
    if (p.reset) {
      sim.current = initialValues(step);
      setControls(sim.current.controls);
      return;
    }
    sim.current.controls = { ...sim.current.controls, ...p.set };
    setControls(sim.current.controls);
  };

  const e = env();
  const fmt = (id: string) => {
    const c = step.controls.find((x) => x.id === id)!;
    return `${controls[id]}${c.unit ?? ''}`;
  };

  return (
    <Shell title={step.title} intro={step.intro} goalNote={goalNote} completed={completed} onNext={onNext}>
      {step.predict && (
        <div>
          <p className="q">{step.predict.question}</p>
          <div className="choices">
            {step.predict.options.map((o, i) => (
              <button key={o.label} type="button" className={`btn ${pick === i ? 'picked' : ''}`} onClick={() => setPick(i)}>
                {o.label}
              </button>
            ))}
          </div>
          {pick !== null && (
            <p className={`verdict ${step.predict.options[pick].correct ? 'ok' : 'no'}`}>{step.predict.options[pick].feedback}</p>
          )}
        </div>
      )}

      {step.controls.map((c) => (
        <div className="ctrl" key={c.id}>
          <label htmlFor={`c-${step.id}-${c.id}`}>{c.label} <output>{fmt(c.id)}</output></label>
          <input
            id={`c-${step.id}-${c.id}`}
            type="range"
            min={c.min}
            max={c.max}
            step={c.step}
            value={controls[c.id]}
            onChange={(ev) => setControl(c.id, Number(ev.target.value))}
          />
        </div>
      ))}

      {step.checks && step.checks.length > 0 && (
        <ul className="checks">
          {step.checks.map((c) => {
            const warn = c.warn ? !!evaluate(c.warn, e) : false;
            const ok = !!evaluate(c.pass, e);
            return (
              <li key={c.label}>
                <span className={`st ${warn ? 'warn' : ok ? 'pass' : 'fail'}`}>{warn ? 'RISK' : ok ? 'OK' : 'NO'}</span>
                <span>{c.label}</span>
                {c.detail && <small>{c.detail}</small>}
              </li>
            );
          })}
        </ul>
      )}

      {step.readouts && step.readouts.length > 0 && (
        <div className="readout">
          {step.readouts.map((r) => (
            <div key={r.label}>
              <span className="k">{r.label}</span>
              {r.kind === 'bar' ? (
                <div className="bar">
                  <i style={{ width: `${Math.max(0, Math.min(1, Number(evaluate(r.value ?? '0', e)) || 0)) * 100}%` }} />
                </div>
              ) : (
                <div className="stat">{r.rules ? firstRule(r.rules, e) : String(evaluate(r.value ?? "''", e) ?? '')}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {step.verdict && <p className="verdict">{firstRule(step.verdict, e)}</p>}

      {step.presets && step.presets.length > 0 && (
        <div className="break">
          <span className="k">Break it</span>
          {step.presets.map((p) => (
            <button key={p.label} className="btn sm" type="button" onClick={() => applyPreset(p)}>{p.label}</button>
          ))}
        </div>
      )}
    </Shell>
  );
}
