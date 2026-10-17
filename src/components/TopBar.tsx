import { useState, type FormEvent, type ReactNode } from 'react';
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

/** The bar shared by every screen: product mark, where you are, and actions. */
export default function TopBar({ crumb, search = false, children }: { crumb?: ReactNode; search?: boolean; children?: ReactNode }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand"><Logo />Interactive Learning</Link>
      {crumb && <div className="crumb">{crumb}</div>}
      <div className="sp" />
      {search && <CompactSearch />}
      {children}
    </header>
  );
}
