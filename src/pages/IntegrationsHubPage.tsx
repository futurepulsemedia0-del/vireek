import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight, Plug, ShieldCheck, Search, ChevronUp, Loader as Loader2 } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { INTEGRATIONS } from '@/lib/integrations';
import {
  fetchRoadmapItems,
  fetchMyVotedItemIds,
  requestIntegration,
  voteRoadmapItem,
  unvoteRoadmapItem,
  type RoadmapItem,
} from '@/lib/roadmap';

export function IntegrationsHubPage() {
  useSEO({
    title: 'Integrations | Vireek',
    description:
      'Connect Vireek to QuickBooks, Google Calendar, Stripe, and Zapier. Keep your books, calendar, billing, and other tools in sync with every call Sarah answers.',
    canonical: 'https://vireek.com/integrations',
  });

  const { user } = useAuth();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');

  const categories = useMemo(
    () => ['all', ...Array.from(new Set(INTEGRATIONS.map((i) => i.category))).sort()],
    []
  );

  const filteredIntegrations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...INTEGRATIONS]
      .filter((i) => activeCategory === 'all' || i.category === activeCategory)
      .filter(
        (i) =>
          !q ||
          i.name.toLowerCase().includes(q) ||
          i.tagline.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q)
      )
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'live' ? -1 : 1));
  }, [search, activeCategory]);

  const [requests, setRequests] = useState<RoadmapItem[]>([]);
  const [votedIds, setVotedIds] = useState<Set<string>>(new Set());
  const [votingId, setVotingId] = useState<string | null>(null);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestTitle, setRequestTitle] = useState('');
  const [submittingRequest, setSubmittingRequest] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const items = await fetchRoadmapItems();
        if (active) setRequests(items.filter((i) => i.category === 'integration').slice(0, 6));
      } catch {
        // This section is a nice-to-have on a marketing page — fail quiet.
      } finally {
        if (active) setRequestsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setVotedIds(new Set());
      return;
    }
    let active = true;
    fetchMyVotedItemIds(user.id)
      .then((ids) => active && setVotedIds(ids))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user]);

  async function handleToggleVote(item: RoadmapItem) {
    if (!user) {
      toast('Sign in to vote for an integration', 'info');
      return;
    }
    if (votingId) return;
    setVotingId(item.id);
    const alreadyVoted = votedIds.has(item.id);
    try {
      if (alreadyVoted) {
        await unvoteRoadmapItem(item.id, user.id);
        setVotedIds((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        setRequests((prev) =>
          prev.map((r) => (r.id === item.id ? { ...r, votes_count: Math.max(r.votes_count - 1, 0) } : r))
        );
      } else {
        await voteRoadmapItem(item.id, user.id);
        setVotedIds((prev) => new Set(prev).add(item.id));
        setRequests((prev) => prev.map((r) => (r.id === item.id ? { ...r, votes_count: r.votes_count + 1 } : r)));
      }
    } catch {
      toast('Something went wrong — try again', 'error');
    } finally {
      setVotingId(null);
    }
  }

  async function handleRequestSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user) {
      toast('Sign in to request an integration', 'info');
      return;
    }
    const title = requestTitle.trim();
    if (!title) return;
    setSubmittingRequest(true);
    try {
      const item = await requestIntegration(title);
      setRequests((prev) => {
        const withoutDup = prev.filter((r) => r.id !== item.id);
        return [...withoutDup, item].sort((a, b) => b.votes_count - a.votes_count).slice(0, 6);
      });
      setVotedIds((prev) => new Set(prev).add(item.id));
      setRequestTitle('');
      toast(`Thanks! "${title}" is now on our public roadmap — vote for it below.`, 'success');
    } catch {
      toast('Could not submit your request — try again', 'error');
    } finally {
      setSubmittingRequest(false);
    }
  }

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm backdrop-blur sm:mb-6 sm:px-4 sm:text-sm">
                <Plug className="h-4 w-4 text-accent" />
                Integrations
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-6xl">
                Vireek Fits Into The Tools You Already Use
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8 lg:text-xl">
                Connect your accounting, calendar, billing, and automation tools so every call Sarah
                answers turns into clean, synced data — with no manual re-entry.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:mt-10 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">
                    Start Free Trial
                  </Button>
                </Link>
                <Link
                  to="/trust"
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent sm:w-auto"
                >
                  <ShieldCheck className="h-4 w-4" /> Visit our Trust Center
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Integration cards */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Live today, more on the way</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Connect Your Stack</h2>
            </motion.div>

            {/* Search + category filter */}
            <div className="mx-auto mt-8 flex max-w-3xl flex-col gap-4 sm:mt-10">
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary/60" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search integrations (e.g. QuickBooks, calendar, CRM)…"
                  className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-3 pl-11 pr-4 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent sm:text-base"
                />
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setActiveCategory(cat)}
                    className={`focus-ring rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors sm:text-sm ${
                      activeCategory === cat
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/30 hover:text-text-primary'
                    }`}
                  >
                    {cat === 'all' ? 'All categories' : cat}
                  </button>
                ))}
              </div>
            </div>

            {filteredIntegrations.length === 0 && (
              <p className="mt-10 text-center text-sm text-text-secondary">
                No integrations match &ldquo;{search}&rdquo; — try a different search, or{' '}
                <a href="#request-integration" className="font-semibold text-accent hover:underline">
                  request it below
                </a>
                .
              </p>
            )}

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-8 grid gap-5 sm:mt-12 sm:grid-cols-2"
            >
              {filteredIntegrations.map((integration) => {
                const Icon = integration.icon;
                const isLive = integration.status === 'live';
                return (
                  <motion.div key={integration.slug} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                    <Link
                      to={`/integrations/${integration.slug}`}
                      className={`focus-ring group flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark sm:p-7 ${!isLive ? 'opacity-70' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                          <Icon className="h-5 w-5" />
                        </span>
                        <span className={`rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wider ${
                          isLive ? 'border-success-500/30 bg-success-500/10 text-success-500' : 'border-border bg-bg-tertiary text-text-secondary'
                        }`}>
                          {isLive ? 'Live now' : 'Coming soon'}
                        </span>
                      </div>
                      <h3 className="mt-4 text-lg font-bold text-text-primary sm:text-xl">{integration.name}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{integration.tagline}</p>
                      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
                        {isLive ? 'See how it works' : 'Learn more'}
                        <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </span>
                    </Link>
                  </motion.div>
                );
              })}
            </motion.div>
          </div>
        </section>

        {/* Request an integration + community-voted requests */}
        <section id="request-integration" className="px-5 pb-16 sm:px-6 sm:pb-24">
          <div className="relative mx-auto max-w-3xl overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:rounded-3xl sm:p-10">
            <div className="absolute inset-0 -z-10 bg-gradient-to-br from-accent/[0.04] via-transparent to-cta/[0.04]" />
            <div className="text-center">
              <h2 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl md:text-4xl">
                Don&rsquo;t see the tool you use?
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-text-secondary sm:text-base">
                Tell us what to build next. Every request lands on our public roadmap, where anyone can
                vote — the most-wanted integrations get built first.
              </p>
            </div>

            {user ? (
              <form onSubmit={handleRequestSubmit} className="mt-8 flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  value={requestTitle}
                  onChange={(e) => setRequestTitle(e.target.value)}
                  placeholder="Name the tool you want to connect (e.g. Xero, ServiceFusion…)"
                  maxLength={200}
                  className="focus-ring w-full flex-1 rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent sm:text-base"
                />
                <Button type="submit" variant="primary" disabled={submittingRequest || !requestTitle.trim()}>
                  {submittingRequest ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Request it'}
                </Button>
              </form>
            ) : (
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">
                    Sign In To Request
                  </Button>
                </Link>
                <Link
                  to="/contact"
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent sm:w-auto"
                >
                  Or talk to us
                </Link>
              </div>
            )}

            {!requestsLoading && requests.length > 0 && (
              <div className="mt-8 border-t border-border pt-6">
                <p className="mb-3 text-center text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  Most requested by customers
                </p>
                <ul className="flex flex-col gap-2">
                  {requests.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-4 py-3"
                    >
                      <span className="text-sm font-medium text-text-primary">{item.title}</span>
                      <button
                        type="button"
                        onClick={() => handleToggleVote(item)}
                        disabled={votingId === item.id}
                        className={`focus-ring flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                          votedIds.has(item.id)
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border text-text-secondary hover:border-accent/30 hover:text-text-primary'
                        }`}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                        {item.votes_count}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
