import { useEffect, useRef, useState } from 'react';
import { useVoiceChoice } from './useVoiceChoice';
import { speakSample, stopSpeaking } from './samples';

// The home page's voice picker: one card per voice with a sample button.
// Shares its choice with the top-bar Voice menu.
export default function VoiceCards() {
  const { voices, voiceId, choose } = useVoiceChoice();
  const [playing, setPlaying] = useState<string | null>(null);
  const sample = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => sample.current?.pause(), []);

  if (!voices.length) return null;
  const play = (id: string, url: string | null) => {
    if (playing === id) { sample.current?.pause(); stopSpeaking(); setPlaying(null); return; }
    if (!url) {
      // The browser voice: speak the sample live, nothing is fetched.
      sample.current?.pause();
      setPlaying(id);
      speakSample(() => setPlaying((p) => (p === id ? null : p)));
      return;
    }
    stopSpeaking();
    if (!sample.current) sample.current = new Audio();
    sample.current.src = url;
    sample.current.onended = () => setPlaying(null);
    void sample.current.play().catch(() => setPlaying(null));
    setPlaying(id);
  };

  return (
    <section className="voicecards" aria-label="Narration voice">
      <span className="lbl">Narration voice</span>
      <div className="vc-row">
        {voices.map((v, i) => (
          <div key={v.id} className={`vc ${v.id === voiceId ? 'on' : ''}`}>
            <button className="pick" type="button" aria-pressed={v.id === voiceId} onClick={() => choose(v.id)}>
              <b>{v.name}{i === 0 ? ' · default' : ''}</b>
              {v.badge && <em className="badge">{v.badge}</em>}
              <span>{v.description}</span>
            </button>
            <button
              className="btn sm"
              type="button"
              onClick={() => play(v.id, v.sample_url ?? null)}
              aria-label={playing === v.id ? `Stop ${v.name} sample` : `Play ${v.name} sample`}
            >
              {playing === v.id ? 'Stop' : '▶ Sample'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
