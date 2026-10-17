import type { Lesson } from './lesson/types';

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

export function getTopic(slug: string) {
  return request<TopicDetail>(`/topics/${encodeURIComponent(slug)}`);
}

export function listTopics() {
  return request<TopicSummary[]>('/topics');
}

export function retryTopic(slug: string) {
  return request<TopicDetail>(`/topics/${encodeURIComponent(slug)}/retry`, { method: 'POST' });
}
