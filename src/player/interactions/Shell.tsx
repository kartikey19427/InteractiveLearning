import type { ReactNode } from 'react';

interface Props {
  title: string;
  intro: string;
  goalNote: string | null;
  completed: boolean;
  onNext: () => void;
  /** Left side of the footer when the goal isn't reached yet, e.g. "Step 1 of 3". */
  status?: string;
  children: ReactNode;
}

// The "Your turn" dock: header, scrolling body, and a footer pinned to the
// bottom with Skip / Continue (Continue unlocks once the goal is reached).
export default function Shell({ title, intro, goalNote, completed, onNext, status, children }: Props) {
  return (
    <>
      <div className="dock-head"><span className="chip on">Your turn</span><h2>{title}</h2></div>
      <div className="dock-body">
        <p className="intro">{intro}</p>
        {children}
      </div>
      <div className="dock-foot">
        <span className={`note ${goalNote ? 'ok' : ''}`}>{goalNote ?? status ?? ''}</span>
        <span className="sp" />
        <button className="btn ghost" type="button" onClick={onNext}>Skip</button>
        <button className="btn primary" type="button" disabled={!goalNote && !completed} onClick={onNext}>Continue</button>
      </div>
    </>
  );
}
