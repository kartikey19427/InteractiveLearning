import type { ReactNode } from 'react';

interface Props {
  title: string;
  intro: string;
  goalNote: string | null;
  completed: boolean;
  onNext: () => void;
  children: ReactNode;
}

// Common frame for "Your turn" activities: heading, body, and the
// Skip / Continue bar that unlocks once the goal is reached.
export default function Shell({ title, intro, goalNote, completed, onNext, children }: Props) {
  return (
    <>
      <div className="phead"><span className="chip ix">Your turn</span><h2>{title}</h2></div>
      <p className="intro">{intro}</p>
      {children}
      <div className="ixbar">
        <span className={`note ${goalNote ? 'ok' : ''}`}>{goalNote ?? ''}</span>
        <span className="sp" />
        <button className="btn ghost" type="button" onClick={onNext}>Skip</button>
        <button className="btn primary" type="button" disabled={!goalNote && !completed} onClick={onNext}>Continue</button>
      </div>
    </>
  );
}
