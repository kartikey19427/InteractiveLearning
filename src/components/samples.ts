// Voice samples. Recorded clips play from the app's files; the browser voice
// speaks its sample live (no API call). Both are free.
export const SAMPLE_LINE = "Every raindrop has made a long journey. Let's follow water from the ocean into the sky, and back again.";

export function speakSample(onEnd: () => void) {
  if (!('speechSynthesis' in window)) { onEnd(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(SAMPLE_LINE);
  u.onend = onEnd;
  u.onerror = onEnd;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  try { speechSynthesis.cancel(); } catch { /* unsupported */ }
}
