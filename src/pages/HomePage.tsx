import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listTopics, searchTopic, type TopicSummary } from '../api';

const EXAMPLES = ['How mushrooms reproduce', 'Photosynthesis', 'How vaccines train the immune system', 'Plate tectonics'];

export default function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topics, setTopics] = useState<TopicSummary[] | null>(null);

  useEffect(() => {
    listTopics().then(setTopics).catch(() => setTopics([]));
  }, []);

  const go = async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await searchTopic(text);
      navigate(`/topic/${res.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void go(query);
  };

  const ready = topics?.filter((t) => t.status === 'ready') ?? [];

  return (
    <main className="home">
      <header>
        <div className="eyebrow">Interactive Learning</div>
        <h1>What do you want to understand?</h1>
        <p>Search any topic. You get a narrated lesson with hands-on experiments and a quiz. New topics are researched and built for you, then saved so they open instantly next time.</p>
      </header>

      <form className="search" onSubmit={submit} role="search">
        <label htmlFor="q" className="sr-only">Topic</label>
        <input
          id="q"
          type="search"
          placeholder="e.g. how mushrooms reproduce"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          maxLength={200}
        />
        <button className="btn primary" type="submit" disabled={busy || !query.trim()}>
          {busy ? 'Finding…' : 'Learn it'}
        </button>
      </form>
      {error && <p className="verdict no" role="alert">{error}</p>}

      <div className="examples">
        <span className="k">Try</span>
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="btn sm" onClick={() => { setQuery(ex); void go(ex); }} disabled={busy}>{ex}</button>
        ))}
      </div>

      {ready.length > 0 && (
        <section className="library">
          <h2>Ready to open</h2>
          <ul>
            {ready.map((t) => (
              <li key={t.slug}><Link to={`/topic/${t.slug}`}>{t.title}</Link></li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
