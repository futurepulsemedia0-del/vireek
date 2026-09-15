import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Sparkles,
  ChevronUp,
  Plus,
  X,
  Loader as Loader2,
  ArrowRight,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { EASE, viewport } from '@/lib/motion';
import {
  fetchRoadmapItems,
  fetchMyVotedItemIds,
  submitRoadmapItem,
  voteRoadmapItem,
  unvoteRoadmapItem,
  ROADMAP_STATUS_META,
  ROADMAP_CATEGORY_META,
  type RoadmapItem,
  type RoadmapStatus,
  type RoadmapCategory,
} from '@/lib/roadmap';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

const FILTERS: Array<{ value: 'all' | Exclude<RoadmapStatus, 'declined'>; label: string }> = [
  { value: 'all', label: 'All Ideas' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'shipped', label: 'Shipped' },
];

function SEO() {
  useEffect(() => {
    const title = 'Public Roadmap — Vote on What Ships Next | Vireek';
    const description =
      'See what the Vireek team is building next, submit a feature request, and vote on the ideas that matter most to your home service business.';
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
    document.title = title;
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

export function RoadmapPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [items, setItems] = useState<RoadmapItem[]>([]);
  const [votedIds, setVotedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [votingId, setVotingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('all');

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<RoadmapCategory>('feature');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await fetchRoadmapItems();
        if (active) setItems(data);
      } catch {
        if (active) toast('Could not load the roadmap — try refreshing', 'error');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.status === filter)),
    [items, filter]
  );

  async function handleVote(item: RoadmapItem) {
    if (!user) {
      toast('Sign in to vote on ideas', 'info');
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
        setItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, votes_count: Math.max(i.votes_count - 1, 0) } : i))
        );
      } else {
        await voteRoadmapItem(item.id, user.id);
        setVotedIds((prev) => new Set(prev).add(item.id));
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, votes_count: i.votes_count + 1 } : i)));
      }
    } catch {
      toast('Something went wrong — try again', 'error');
    } finally {
      setVotingId(null);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!title.trim() || !description.trim()) {
      toast('Add a title and a short description', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const created = await submitRoadmapItem({ title, description, category, userId: user.id });
      setItems((prev) => [created, ...prev]);
      setTitle('');
      setDescription('');
      setCategory('feature');
      setShowForm(false);
      toast('Idea submitted — thanks for shaping the roadmap!', 'success');
    } catch {
      toast('Could not submit your idea — try again', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Sparkles className="h-4 w-4 text-accent" />
                Public Roadmap
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Help Shape What We Build Next
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-text-secondary">
                Every idea here comes from contractors using Vireek. Vote on what matters to your business, or
                submit something we&rsquo;re missing.
              </p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
              className="mt-8 flex flex-wrap items-center justify-center gap-3"
            >
              {user ? (
                <Button variant="primary" size="sm" onClick={() => setShowForm((s) => !s)}>
                  {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {showForm ? 'Cancel' : 'Submit an Idea'}
                </Button>
              ) : (
                <Link to="/login" state={{ from: '/roadmap' }}>
                  <Button variant="primary" size="sm">
                    <Plus className="h-3.5 w-3.5" /> Sign In to Submit an Idea
                  </Button>
                </Link>
              )}
              <Link to="/changelog">
                <Button variant="secondary" size="sm">
                  See What&rsquo;s Shipped <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </motion.div>
          </div>
        </section>

        {/* Submit form */}
        {showForm && user && (
          <section className="px-6 pb-4">
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              transition={{ duration: 0.3, ease: EASE }}
              className="mx-auto max-w-2xl overflow-hidden"
            >
              <Card>
                <form onSubmit={handleSubmit} className="grid gap-5">
                  <div>
                    <label htmlFor="roadmap-title" className="mb-2 block text-sm font-semibold text-text-primary">
                      Title
                    </label>
                    <input
                      id="roadmap-title"
                      className={inputClass}
                      value={title}
                      maxLength={120}
                      placeholder="e.g. Two-way sync with QuickBooks line items"
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="roadmap-description" className="mb-2 block text-sm font-semibold text-text-primary">
                      Description
                    </label>
                    <textarea
                      id="roadmap-description"
                      className={`${inputClass} min-h-[110px] resize-y`}
                      value={description}
                      maxLength={600}
                      placeholder="What problem would this solve for your business?"
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="roadmap-category" className="mb-2 block text-sm font-semibold text-text-primary">
                      Category
                    </label>
                    <select
                      id="roadmap-category"
                      className={inputClass}
                      value={category}
                      onChange={(e) => setCategory(e.target.value as RoadmapCategory)}
                    >
                      {Object.entries(ROADMAP_CATEGORY_META).map(([value, meta]) => (
                        <option key={value} value={value}>
                          {meta.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" variant="primary" size="md" disabled={submitting} className="justify-self-start">
                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    {submitting ? 'Submitting…' : 'Submit Idea'}
                  </Button>
                </form>
              </Card>
            </motion.div>
          </section>
        )}

        {/* Filters */}
        <section className="px-6 pt-8">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`focus-ring rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                  filter === f.value
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/30 hover:text-text-primary'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </section>

        {/* List */}
        <section className="px-6 py-12 sm:py-16">
          <div className="mx-auto max-w-3xl">
            {loading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-16 text-center text-sm text-text-secondary">No ideas in this category yet.</p>
            ) : (
              <ul className="space-y-4">
                {filtered.map((item, idx) => {
                  const voted = votedIds.has(item.id);
                  const statusMeta =
                    item.status === 'declined' ? { label: 'Not Planned' } : ROADMAP_STATUS_META[item.status];
                  return (
                    <motion.li
                      key={item.id}
                      initial={{ opacity: 0, y: 14 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={viewport}
                      transition={{ duration: 0.4, ease: EASE, delay: Math.min(idx * 0.04, 0.2) }}
                      className="flex items-start gap-4 rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card dark:shadow-card-dark sm:p-6"
                    >
                      <button
                        onClick={() => handleVote(item)}
                        disabled={votingId === item.id}
                        className={`focus-ring flex min-w-[56px] flex-col items-center justify-center gap-0.5 rounded-xl border px-3 py-2.5 text-sm font-bold transition-colors disabled:opacity-50 ${
                          voted
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-border bg-bg-primary text-text-secondary hover:border-accent/30 hover:text-accent'
                        }`}
                      >
                        <ChevronUp className="h-4 w-4" />
                        {item.votes_count}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2.5 py-1 text-xs font-semibold text-text-secondary">
                            {ROADMAP_CATEGORY_META[item.category].label}
                          </span>
                          <span className="inline-flex items-center rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
                            {statusMeta.label}
                          </span>
                        </div>
                        <h3 className="mt-2.5 text-base font-semibold text-text-primary">{item.title}</h3>
                        <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{item.description}</p>
                      </div>
                    </motion.li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
