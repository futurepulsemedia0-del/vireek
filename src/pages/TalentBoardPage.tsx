import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, MapPin, RefreshCw, Search, Star } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CookieConsent } from '@/components/CookieConsent';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useSEO } from '@/lib/seo';
import { TRADES, formatDateRange, formatPay, listOpenPostings, locationLabel, ratingDisplay, tradeLabel, workTypeLabel, type PostingSummary } from '@/lib/talentNetwork';

const PAGE = 24;
const selectClass = 'w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-3 text-sm text-text-primary focus:border-accent focus:outline-none';

export function TalentBoardPage() {
  useSEO({
    title: 'Trade Jobs & Gig Work — Vireek Talent Network',
    description: 'Find HVAC, plumbing, electrical and other trade jobs and overflow gig work from local service businesses.',
    canonical: 'https://vireek.com/talent',
  });
  const [trade, setTrade] = useState('');
  const [kind, setKind] = useState('');
  const [region, setRegion] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PostingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset: number) => {
    setError(null);
    offset === 0 ? setLoading(true) : setMore(true);
    try {
      const data = await listOpenPostings({ trade, kind, region: region.trim(), query: query.trim(), offset, limit: PAGE });
      setRows((prev) => (offset === 0 ? data : [...prev, ...data]));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load jobs.');
    } finally {
      setLoading(false);
      setMore(false);
    }
  }, [trade, kind, region, query]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(0), 250);
    return () => window.clearTimeout(t);
  }, [load]);

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-24 pt-28">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-3xl font-bold text-text-primary sm:text-4xl">Trade jobs and gig work</h1>
          <p className="mt-3 max-w-2xl text-text-secondary">Verified-friendly work from local service businesses. Build one profile, apply anywhere.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/talent/me"><Button>My profile & applications</Button></Link>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input label="Search" icon={Search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title or company" maxLength={80} />
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="tb-trade">Trade</label>
              <select id="tb-trade" className={selectClass} value={trade} onChange={(e) => setTrade(e.target.value)}>
                <option value="">All trades</option>
                {TRADES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="tb-kind">Type</label>
              <select id="tb-kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">Jobs and gigs</option>
                <option value="job">Jobs</option>
                <option value="gig">Gig / overflow</option>
              </select>
            </div>
            <Input label="State" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="TX" maxLength={40} />
          </div>

          <div className="mt-8 space-y-3" aria-live="polite">
            {loading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-2xl" />)}
            {!loading && error && (
              <div role="alert" className="flex items-center justify-between rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-text-primary">
                {error}
                <Button variant="secondary" onClick={() => void load(0)}><RefreshCw size={14} className="mr-2" />Retry</Button>
              </div>
            )}
            {!loading && !error && rows.length === 0 && (
              <EmptyState icon={Briefcase} title="No openings match" description="Try a different trade or state, or check back soon." />
            )}
            {!loading && rows.map((p) => (
              <Link key={p.id} to={`/talent/jobs/${p.slug}`} className="block rounded-2xl border border-border bg-bg-secondary p-5 transition hover:border-accent">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">{p.title}</h2>
                    <p className="mt-0.5 text-sm text-text-secondary">{p.company_name} · {tradeLabel(p.trade)}</p>
                  </div>
                  <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent">{p.kind === 'gig' ? 'Gig / overflow' : workTypeLabel(p.employment_type)}</span>
                </div>
                <p className="mt-3 line-clamp-2 text-sm text-text-secondary">{p.summary}</p>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-secondary">
                  <span className="inline-flex items-center gap-1.5"><MapPin size={14} aria-hidden="true" />{locationLabel(p)}</span>
                  <span className="font-medium text-text-primary">{formatPay(p)}</span>
                  {p.kind === 'gig' && <span>{formatDateRange(p.starts_on, p.ends_on)}</span>}
                  <span className="inline-flex items-center gap-1.5"><Star size={14} aria-hidden="true" />{ratingDisplay(p.company_rating_avg, p.company_rating_count)}</span>
                </div>
              </Link>
            ))}
            {!loading && rows.length > 0 && rows.length % PAGE === 0 && (
              <div className="pt-2 text-center">
                <Button variant="secondary" disabled={more} onClick={() => void load(rows.length)}>{more ? 'Loading…' : 'Load more'}</Button>
              </div>
            )}
          </div>
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

export default TalentBoardPage;
