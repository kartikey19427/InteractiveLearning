import { useEffect, useRef, useState } from 'react';
import type { QuizStep } from '../../lesson/types';
import { drawElements } from '../../lesson/scene';
import type { StepProps } from '../LessonPlayer';

export default function Quiz({ step, frame, baseEnv, onGoal, onRestart, notify }: StepProps<QuizStep> & { onRestart: () => void }) {
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(false);
  const nextBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const scene = step.scene;
    frame.current = {
      background: scene?.background,
      draw(rc) { if (scene) drawElements(rc, scene.elements, baseEnv); },
    };
    return () => { frame.current = null; };
  }, [step, frame, baseEnv]);

  useEffect(() => { if (picked !== null) nextBtn.current?.focus(); }, [picked]);

  const q = step.questions[i];

  if (finished) {
    return (
      <>
        <div className="phead"><span className="chip ix">Lesson complete</span><h2>You scored {score} of {step.questions.length}</h2></div>
        <p className="intro">Go back to any chapter to replay it, or try the activities again with different settings.</p>
        <div className="ixbar"><span className="sp" /><button className="btn primary" type="button" onClick={onRestart}>Restart lesson</button></div>
      </>
    );
  }

  const choose = (k: number) => {
    if (picked !== null) return;
    setPicked(k);
    if (k === q.answer) { setScore((s) => s + 1); notify('Correct!', 'ok'); }
    else notify('Not quite. The right answer is highlighted in green.', 'bad');
  };

  const next = () => {
    if (i < step.questions.length - 1) { setI(i + 1); setPicked(null); }
    else { setFinished(true); onGoal(); notify(`Lesson complete: ${score} of ${step.questions.length} correct`, 'win'); }
  };

  return (
    <>
      <div className="phead"><span className="chip ix">Question {i + 1} of {step.questions.length}</span><h2>{q.question}</h2></div>
      <div className="opts">
        {q.options.map((o, k) => (
          <button
            key={o}
            type="button"
            disabled={picked !== null}
            className={`btn ${picked !== null && k === q.answer ? 'right' : ''} ${picked === k && k !== q.answer ? 'wrong' : ''}`}
            onClick={() => choose(k)}
          >
            {o}
          </button>
        ))}
      </div>
      {picked !== null && <p className="why">{q.explanation}</p>}
      <div className="ixbar">
        <span className="sp" />
        {picked !== null && (
          <button ref={nextBtn} className="btn primary" type="button" onClick={next}>
            {i < step.questions.length - 1 ? 'Next question' : 'Finish'}
          </button>
        )}
      </div>
    </>
  );
}
