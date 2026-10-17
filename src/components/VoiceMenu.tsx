import { useEffect, useRef, useState } from 'react';
import type { VoiceOption } from '../api';

interface Props {
  voices: VoiceOption[];
  selected: string;
  onChange: (id: string) => void;
  /** Called when the menu opens, so the lesson can pause before samples play. */
  onOpen?: () => void;
}

// Narration voice picker: each voice with a short description and a sample
// (a short clip recorded once and saved with the app, so listening costs nothing).
export default function VoiceMenu({ voices, selected, onChange, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const sample = useRef<HTMLAudioElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const current = voices.find((v) => v.id === selected) ?? voices[0];

  const stopSample = () => { sample.current?.pause(); setPlaying(null); };

  useEffect(() => {
    if (!open) { stopSample(); return; }
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  useEffect(() => () => sample.current?.pause(), []);

  const play = (v: VoiceOption) => {
    if (!v.sample_url) return;
    if (playing === v.id) { stopSample(); return; }
    if (!sample.current) sample.current = new Audio();
    sample.current.src = v.sample_url;
    sample.current.onended = () => setPlaying(null);
    void sample.current.play().catch(() => setPlaying(null));
    setPlaying(v.id);
  };

  if (!voices.length || !current) return null;
  return (
    <div className="voicemenu" ref={root}>
      <button
        className="btn"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 6v4h2.5l3.5 3V3L5 6H2.5Z" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5" /><path d="M12.8 3.5a6 6 0 0 1 0 9" />
        </svg>
        Voice: {current.name}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="voicemenu-pop" role="group" aria-label="Narration voice">
          <span className="lbl">Narration voice</span>
          <ul>
            {voices.map((v) => (
              <li key={v.id} className={v.id === current.id ? 'on' : ''}>
                <button className="pick" type="button" aria-pressed={v.id === current.id} onClick={() => { onChange(v.id); setOpen(false); }}>
                  <b>{v.name}{v.id === voices[0].id ? ' · default' : ''}</b>
                  <span>{v.description}</span>
                </button>
                <button
                  className="btn icon ghost"
                  type="button"
                  disabled={!v.sample_url}
                  onClick={() => play(v)}
                  aria-label={playing === v.id ? `Stop ${v.name} sample` : `Play ${v.name} sample`}
                  title={playing === v.id ? 'Stop sample' : 'Play sample'}
                >
                  {playing === v.id ? (
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4a.5.5 0 0 0 .8.4l6.6-4.2a.5.5 0 0 0 0-.8L3.8 1.4a.5.5 0 0 0-.8.4Z" fill="currentColor" /></svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <p className="note">Lessons are recorded in a new voice the first time you open them with it.</p>
        </div>
      )}
    </div>
  );
}
