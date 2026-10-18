import { useEffect, useSyncExternalStore } from 'react';
import { listVoices, type VoiceOption } from '../api';

// One shared voice choice for every picker on the page (top-bar menu, home
// cards), remembered in this browser. Max (the server's default) until changed.
let voices: VoiceOption[] = [];
// Free options are offered alongside the ElevenLabs voices; none of them calls ElevenLabs.
let voiceId: string = (() => { try { return localStorage.getItem('voiceId') ?? ''; } catch { return ''; } })();
let loaded = false;
const listeners = new Set<() => void>();
let snapshot = { voices, voiceId };
const emit = () => { snapshot = { voices, voiceId }; listeners.forEach((l) => l()); };

function load() {
  if (loaded) return;
  loaded = true;
  listVoices().then((r) => {
    voices = r.voices;
    if (!(voiceId && r.voices.some((x) => x.id === voiceId))) voiceId = r.default ?? '';
    emit();
  }).catch(() => { loaded = false; });
}

export function chooseVoice(id: string) {
  try { localStorage.setItem('voiceId', id); } catch { /* storage unavailable */ }
  voiceId = id;
  emit();
}

export function useVoiceChoice() {
  useEffect(load, []);
  const s = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snapshot);
  return { voices: s.voices, voiceId: s.voiceId, choose: chooseVoice };
}
