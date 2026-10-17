import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { searchTopic } from '../api';

export function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 4.5 8 2l5 2.5L8 7 3 4.5Z" />
        <path d="M3 8l5 2.5L13 8" />
        <path d="M3 11.5 8 14l5-2.5" />
      </svg>
    </span>
  );
}

function CompactSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    try {
      const res = await searchTopic(text);
      setQ('');
      navigate(`/topic/${res.slug}`);
    } catch {
      navigate(`/?q=${encodeURIComponent(text)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form role="search" onSubmit={submit}>
      <label className="field">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="7" cy="7" r="5" /><path d="m11 11 3.5 3.5" strokeLinecap="round" /></svg>
        <span className="sr-only">Search another topic</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={busy ? 'Finding…' : 'Search another topic'} maxLength={200} />
      </label>
    </form>
  );
}

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Light/dark switch. The choice is remembered; until then it follows the system. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    // Keep the icon right if the system theme changes and nothing was chosen.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setTheme(currentTheme());
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
    setTheme(next);
  };
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button className="btn icon ghost" type="button" onClick={toggle} aria-label={label} title={label}>
      {theme === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
        </svg>
      )}
    </button>
  );
}

/** The bar shared by every screen: product mark, where you are, and actions. */
export default function TopBar({ crumb, search = false, children }: { crumb?: ReactNode; search?: boolean; children?: ReactNode }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand"><Logo />Interactive Learning</Link>
      {crumb && <div className="crumb">{crumb}</div>}
      <div className="sp" />
      {search && <CompactSearch />}
      {children}
      <ThemeToggle />
    </header>
  );
}
