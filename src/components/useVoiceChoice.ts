import { useEffect, useState } from 'react';
import { listVoices, type VoiceOption } from '../api';

/** The narration voices on offer and the one picked in this browser (Max until changed). */
export function useVoiceChoice() {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceId, setVoiceId] = useState<string>(() => { try { return localStorage.getItem('voiceId') ?? ''; } catch { return ''; } });
  useEffect(() => {
    listVoices().then((r) => {
      setVoices(r.voices);
      setVoiceId((v) => (v && r.voices.some((x) => x.id === v) ? v : r.default ?? ''));
    }).catch(() => setVoices([]));
  }, []);
  const choose = (id: string) => {
    try { localStorage.setItem('voiceId', id); } catch { /* storage unavailable */ }
    setVoiceId(id);
  };
  return { voices, voiceId, choose };
}
