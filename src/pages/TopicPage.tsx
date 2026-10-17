import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, getTopic, retryTopic, type LessonStatus, type TopicDetail } from '../api';
import LessonPlayer from '../player/LessonPlayer';

const STAGES: { key: LessonStatus; label: string }[] = [
  { key: 'researching', label: 'Researching the topic' },
  { key: 'writing', label: 'Writing scenes, activities and quiz' },
  { key: 'checking', label: 'Checking the lesson' },
];

export default function TopicPage() {
  const { slug = '' } = useParams();
  const [topic, setTopic] = useState<TopicDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const t = await getTopic(slug);
        if (!alive) return;
        // Don't remount the player when only narration changes.
        setTopic((prev) => (prev && prev.slug === t.slug && prev.lesson && t.lesson ? { ...t, lesson: prev.lesson } : t));
        setError(null);
        if (t.status !== 'ready' && t.status !== 'failed') timer = window.setTimeout(load, 2500);
        // Recorded narration arrives a little after the lesson; pick it up when it does.
        else if (t.status === 'ready' && !t.narration && t.narrating) timer = window.setTimeout(load, 8000);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof ApiError && err.status === 404 ? 'There is no lesson for this topic yet.' : 'Could not reach the server.');
        if (!(err instanceof ApiError)) timer = window.setTimeout(load, 4000);
      }
    };
    setTopic(null);
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [slug, attempt]);

  useEffect(() => {
    if (topic?.title) document.title = `${topic.title} · Interactive Learning`;
  }, [topic?.title]);

  const retry = async () => {
    try {
      await retryTopic(slug);
      setAttempt((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    }
  };

  return (
    <main className="wrap wide">
      <nav className="crumbs"><Link to="/">← Search another topic</Link></nav>

      {error && !topic && (
        <div className="center-state">
          <section className="panel">
            <div className="phead"><span className="chip">Problem</span><h2>Couldn't open this lesson</h2></div>
            <p className="intro" role="alert">{error}</p>
            <div className="ixbar"><span className="sp" /><Link className="btn primary" to="/">Search another topic</Link></div>
          </section>
        </div>
      )}
      {!topic && !error && <div className="center-state"><p className="note">Loading…</p></div>}

      {topic?.status === 'ready' && topic.lesson && <LessonPlayer lesson={topic.lesson} narration={topic.narration} />}

      {topic && topic.status !== 'ready' && topic.status !== 'failed' && (
        <div className="center-state">
        <section className="panel building" aria-live="polite">
          <div className="phead"><span className="chip ix">New topic</span><h2>Building “{topic.title}”</h2></div>
          <p className="intro">Nobody has asked about this yet, so it's being researched and turned into a lesson. It's saved once it's done, so it opens instantly after this.</p>
          <ol className="stages">
            {STAGES.map((s, i) => {
              const cur = STAGES.findIndex((x) => x.key === topic.status);
              const state = i < cur ? 'fin' : i === cur ? 'on' : '';
              return <li key={s.key} className={state}>{s.label}{state === 'on' && <span className="dots" />}</li>;
            })}
          </ol>
          {topic.progress && <p className="note">{topic.progress}</p>}
        </section>
        </div>
      )}

      {topic?.status === 'failed' && (
        <div className="center-state">
        <section className="panel">
          <div className="phead"><span className="chip">Problem</span><h2>This lesson couldn't be built</h2></div>
          <p className="intro">{topic.error ?? 'Something went wrong while generating it.'}</p>
          <div className="ixbar"><span className="sp" /><button className="btn primary" type="button" onClick={retry}>Try again</button></div>
        </section>
        </div>
      )}
    </main>
  );
}
