import type { Step } from './lesson/types';

export type LessonStatus = 'queued' | 'researching' | 'writing' | 'checking' | 'streaming' | 'stalled' | 'ready' | 'failed';

export interface TopicSummary {
  slug: string;
  title: string;
  status: LessonStatus;
  updated_at: string;
}

export interface OutlineItem { id: string; kind: string; title: string; tag: string }

/** A lesson without chapter bodies; chapters are fetched one at a time, like a stream. */
export interface LessonMeta {
  title: string;
  eyebrow: string;
  summary: string;
  palette?: Record<string, string>;
  functions?: Record<string, { args: string[]; expr: string }>;
  sources: { title: string; url: string }[];
  note?: string | null;
  outline: OutlineItem[];
  steps_ready: number;
  complete: boolean;
}

export interface TopicDetail extends TopicSummary {
  query: string;
  progress: string | null;
  error: string | null;
  lesson: LessonMeta | null;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch { /* not JSON */ }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

/** Find a saved lesson for the query, or start generating one. */
export function searchTopic(query: string) {
  return request<{ slug: string; status: LessonStatus; cached: boolean }>('/search', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

export function getTopic(slug: string, voice?: string) {
  const q = voice ? `?voice=${encodeURIComponent(voice)}` : '';
  return request<TopicDetail>(`/topics/${encodeURIComponent(slug)}${q}`);
}

export interface VoiceOption { id: string; name: string; description: string; sample_url: string | null; badge?: string | null }

export function listVoices() {
  return request<{ default: string | null; voices: VoiceOption[] }>('/voices');
}

export function listTopics() {
  return request<TopicSummary[]>('/topics');
}

export function retryTopic(slug: string) {
  return request<TopicDetail>(`/topics/${encodeURIComponent(slug)}/retry`, { method: 'POST' });
}

export function getStep(slug: string, index: number) {
  return request<{ ready: boolean; step?: Step; functions?: Record<string, { args: string[]; expr: string }>; stalled?: boolean; error?: string | null }>(
    `/topics/${encodeURIComponent(slug)}/steps/${index}`,
  );
}

export interface ChapterNarration {
  state: 'ready' | 'preparing' | 'fallback' | 'none';
  clip: { url: string; bounds: number[] } | null;
  provider?: string | null;
  voice?: string | null;
}

export function getChapterNarration(slug: string, stepId: string, voice?: string) {
  const q = voice ? `?voice=${encodeURIComponent(voice)}` : '';
  return request<ChapterNarration>(`/topics/${encodeURIComponent(slug)}/narration/${encodeURIComponent(stepId)}${q}`);
}
