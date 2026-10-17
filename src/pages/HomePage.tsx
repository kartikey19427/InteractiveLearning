import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { listTopics, searchTopic, type TopicSummary } from '../api';
import TopBar from '../components/TopBar';
import VoiceMenu from '../components/VoiceMenu';
import VoiceCards from '../components/VoiceCards';
import { useVoiceChoice } from '../components/useVoiceChoice';

const EXAMPLES = ['How mushrooms reproduce', 'Photosynthesis', 'How vaccines train the immune system', 'Supply and demand', 'How TCP works'];

interface Progress { index: number; done: number; total: number; at: number }

function readProgress(slug: string): Progress | null {
  try {
    const raw = localStorage.getItem(`progress:${slug}`);
    return raw ? (JSON.parse(raw) as Progress) : null;
  } catch {
    return null;
  }
}

// A simple cover for each lesson: the dark stage color with a few shapes
// placed from the slug, so cards are recognizable without real thumbnails.
function Cover({ slug }: { slug: string }) {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hues = ['#E6A94B', '#5DB7BF', '#CBB8F0', '#D86A8A', '#8CC265'];
  const pick = (n: number) => hues[(h >>> n) % hues.length];
  return (
    <svg viewBox="0 0 260 110" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
      <circle cx={40 + (h % 120)} cy={55} r={34} fill={pick(1)} opacity=".9" />
      <circle cx={150 + ((h >>> 4) % 70)} cy={40 + ((h >>> 8) % 30)} r={18} fill={pick(5)} opacity=".85" />
      <rect x={110 + ((h >>> 12) % 60)} y={70} width={90} height={10} rx={5} fill={pick(9)} opacity=".7" />
    </svg>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topics, setTopics] = useState<TopicSummary[] | null>(null);
  const voice = useVoiceChoice();

  useEffect(() => {
    document.title = 'Interactive Learning';
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

  // Lessons this browser has started first (most recent), then the rest.
  const ready = (topics ?? [])
    .filter((t) => t.status === 'ready')
    .map((t) => ({ t, p: readProgress(t.slug) }))
    .sort((a, b) => (b.p?.at ?? 0) - (a.p?.at ?? 0));
  const started = ready.filter((x) => x.p);

  return (
    <div className="app">
      <TopBar>
        <a className="btn ghost" href="#library">My lessons</a>
        <VoiceMenu voices={voice.voices} selected={voice.voiceId} onChange={voice.choose} />
      </TopBar>
      <main className="home">
        <span className="lbl">Learn anything, interactively</span>
        <h1>What do you want to understand today?</h1>
        <form className="bigsearch" onSubmit={submit} role="search">
          <label htmlFor="q" className="sr-only">Topic</label>
          <input
            id="q"
            type="search"
            placeholder="Search any topic, e.g. quantum entanglement"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            maxLength={200}
          />
          <button className="btn primary" type="submit" disabled={busy || !query.trim()}>
            {busy ? 'Finding…' : 'Build lesson'}
          </button>
        </form>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="examples">
          <span>Try</span>
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="chip" disabled={busy} onClick={() => { setQuery(ex); void go(ex); }}>{ex}</button>
          ))}
        </div>

        <VoiceCards />

        {ready.length > 0 && (
          <section className="library" id="library">
            <span className="lbl">{started.length ? 'Continue learning' : 'Ready to open'}</span>
            <div className="cards">
              {ready.map(({ t, p }) => {
                const pct = p ? Math.round((p.done / Math.max(1, p.total)) * 100) : 0;
                const meta = !p ? 'Not started' : p.done >= p.total ? 'Finished' : `Chapter ${p.index + 1} of ${p.total}`;
                return (
                  <Link key={t.slug} to={`/topic/${t.slug}`} className="card">
                    <div className="thumb"><Cover slug={t.slug} /></div>
                    <h3>{t.title}</h3>
                    <span className="meta">{meta}</span>
                    <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
