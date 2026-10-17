import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, getTopic, retryTopic, type LessonStatus, type TopicDetail } from '../api';
import LessonPlayer from '../player/LessonPlayer';
import TopBar from '../components/TopBar';

const STAGES: { key: LessonStatus; label: string }[] = [
  { key: 'researching', label: 'Researching sources' },
  { key: 'writing', label: 'Writing scenes, activities and quiz' },
  { key: 'checking', label: 'Checking the lesson' },
];

/**
 * The lesson layout in skeleton form, with a card where the stage will be.
 * Used while a lesson is built and for errors, so nothing jumps when it arrives.
 */
function Skeleton({ title, crumb, action, children }: { title: string; crumb: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="app fixed">
      <TopBar crumb={<>{crumb} / <b>{title}</b></>}>{action}</TopBar>
      <div className="studio">
        <aside className="rail" aria-hidden="true">
          <div className="rail-head">
            <span className="lbl">Interactive lesson</span>
            <h1>{title}</h1>
            <div className="ln" style={{ width: '90%', marginTop: 6 }} />
            <div className="ln" style={{ width: '70%' }} />
          </div>
          <span className="lbl" style={{ padding: '0 6px' }}>Chapters</span>
          {[120, 150, 100, 140, 110].map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px' }}>
              <span className="sk" style={{ width: 22, height: 22, borderRadius: '50%', flex: 'none' }} />
              <span className="ln" style={{ width: w }} />
            </div>
          ))}
        </aside>
        <section className="center">
          <div className="sk skel-stage">{children}</div>
          <div className="sk" style={{ height: 30, width: '60%', flex: 'none' }} />
          <div className="sk" style={{ height: 56, flex: 'none' }} />
        </section>
        <div className="dock skel" aria-hidden="true">
          <div className="ln" style={{ width: '50%', height: 14 }} />
          <div className="ln" style={{ width: '95%' }} />
          <div className="ln" style={{ width: '80%' }} />
          <div className="act" style={{ marginTop: 8 }}>
            {[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 44 }} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

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
        // The preferred voice is being recorded chapter by chapter: keep picking up new chapters.
        else if (t.status === 'ready' && t.narration_state === 'preparing') timer = window.setTimeout(load, 2000);
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

  if (topic?.status === 'ready' && topic.lesson) {
    return <LessonPlayer lesson={topic.lesson} narration={topic.narration} narrationState={topic.narration_state} slug={topic.slug} />;
  }

  const title = topic?.title ?? slug.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

  if (error && !topic) {
    return (
      <Skeleton title={title} crumb="Lesson" action={<Link className="btn ghost" to="/">Back to search</Link>}>
        <div className="buildcard" role="alert">
          <span className="lbl">Couldn't open this lesson</span>
          <h2>{title}</h2>
          <p className="intro">{error}</p>
          <div><Link className="btn primary" to="/">Search another topic</Link></div>
        </div>
      </Skeleton>
    );
  }

  if (topic?.status === 'failed') {
    return (
      <Skeleton title={title} crumb="Lesson" action={<Link className="btn ghost" to="/">Back to search</Link>}>
        <div className="buildcard" role="alert">
          <span className="lbl">This lesson couldn't be built</span>
          <h2>{title}</h2>
          <p className="intro">{topic.error ?? 'Something went wrong while generating it.'}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" type="button" onClick={retry}>Try again</button>
            <Link className="btn" to="/">Search another topic</Link>
          </div>
        </div>
      </Skeleton>
    );
  }

  const cur = topic ? STAGES.findIndex((x) => x.key === topic.status) : -1;
  const pct = topic ? Math.round(((Math.max(cur, 0) + 0.5) / STAGES.length) * 100) : 5;
  return (
    <Skeleton title={title} crumb="Building" action={<Link className="btn ghost" to="/" title="The lesson keeps building and will be saved">Back to search</Link>}>
      <div className="buildcard" aria-live="polite">
        <span className="lbl">{topic ? 'Building your lesson' : 'Loading'}</span>
        <h2>{title}</h2>
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        <ol className="stages">
          {STAGES.map((s, i) => {
            const state = i < cur ? 'fin' : i === cur ? 'on' : '';
            return <li key={s.key} className={state}>{s.label}{state === 'on' && <span className="dots" />}</li>;
          })}
        </ol>
        <p className="note">{topic?.progress ?? 'It is saved when done, so it opens instantly next time.'}</p>
      </div>
    </Skeleton>
  );
}
