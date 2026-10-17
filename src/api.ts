import type { Lesson } from './lesson/types';
import type { Narration } from './player/LessonPlayer';

export type LessonStatus = 'queued' | 'researching' | 'writing' | 'checking' | 'ready' | 'failed';

export interface TopicSummary {
  slug: string;
  title: string;
  status: LessonStatus;
  updated_at: string;
}

export interface TopicDetail extends TopicSummary {
  query: string;
  progress: string | null;
  error: string | null;
  lesson: Lesson | null;
  narration: Narration | null;
  narrating: boolean;
  narration_state: 'ready' | 'preparing' | 'fallback' | 'none';
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

export interface VoiceOption { id: string; name: string; description: string; preview_url: string | null }

export function listVoices() {
  return request<{ default: string | null; voices: VoiceOption[] }>('/voices');
}

export function listTopics() {
  return request<TopicSummary[]>('/topics');
}

export function retryTopic(slug: string) {
  return request<TopicDetail>(`/topics/${encodeURIComponent(slug)}/retry`, { method: 'POST' });
}
