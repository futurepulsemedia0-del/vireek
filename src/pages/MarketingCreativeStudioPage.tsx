import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, ImageIcon, Lock, RefreshCw, Sparkles, Star, TriangleAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { CreativeDetail } from '@/components/marketing-creative/CreativeDetail';
import {
  DEFAULT_BRAND,
  FORMATS,
  FORMAT_BY_ID,
  GOALS,
  MAX_GENERATIONS_PER_HOUR,
  STATUS_LABEL,
  TONES,
  addToCalendar,
  deleteCreative,
  fetchBrandColors,
  fetchCreatives,
  fetchSourceJobs,
  fetchSourceReviews,
  generateCreative,
  signedImageUrl,
  updateCreative,
  validateRequest,
  type BrandColors,
  type CalendarChannel,
  type CreativeFormat,
  type CreativeGoal,
  type CreativePatch,
  type CreativeRow,
  type CreativeTone,
  type SourceJob,
  type SourceReview,
  type SourceType,
} from '@/lib/marketingCreative';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

type LibraryFilter = 'all' | 'image' | 'article';

const SOURCE_TABS: { id: SourceType; label: string }[] = [
  { id: 'job', label: 'A completed job' },
  { id: 'review', label: 'A 5★ review' },
  { id: 'custom', label: 'My own idea' },
];

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const prettyService = (s: string | null) => (s ? s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) : 'Service call');

export default function MarketingCreativeStudioPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();

  // Every row is keyed by the ACCOUNT OWNER's id (differs from user.id for team members).
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_edit_business_profile;
  const businessName = profile?.company_name ?? '';

  // ---------- library ----------
  const [items, setItems] = useState<CreativeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  const requestId = useRef(0);

  // ---------- sources ----------
  const [jobs, setJobs] = useState<SourceJob[]>([]);
  const [reviews, setReviews] = useState<SourceReview[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const [brand, setBrand] = useState<BrandColors>(DEFAULT_BRAND);

  // ---------- create form ----------
  const [format, setFormat] = useState<CreativeFormat>('social_square');
  const [sourceType, setSourceType] = useState<SourceType>('job');
  const [jobId, setJobId] = useState('');
  const [reviewId, setReviewId] = useState('');
  const [topic, setTopic] = useState('');
  const [tone, setTone] = useState<CreativeTone>('friendly');
  const [goal, setGoal] = useState<CreativeGoal>('book_service');
  const [city, setCity] = useState('');
  const [offer, setOffer] = useState('');
  const [generating, setGenerating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ---------- detail ----------
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CreativeRow | null>(null);

  const load = useCallback(async () => {
    if (!ownerId) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchCreatives(ownerId);
      if (id === requestId.current) setItems(rows);
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : 'Could not load your creatives.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [ownerId]);

  const loadSources = useCallback(async () => {
    if (!ownerId) return;
    setSourcesLoading(true);
    setSourcesFailed(false);
    const [j, r, b] = await Promise.allSettled([fetchSourceJobs(ownerId), fetchSourceReviews(ownerId), fetchBrandColors(ownerId)]);
    if (j.status === 'fulfilled') setJobs(j.value);
    if (r.status === 'fulfilled') setReviews(r.value);
    if (b.status === 'fulfilled') setBrand(b.value);
    setSourcesFailed(j.status === 'rejected' || r.status === 'rejected');
    setSourcesLoading(false);
  }, [ownerId]);

  useEffect(() => {
    if (canAccess && ownerId) {
      void load();
      void loadSources();
    }
  }, [canAccess, ownerId, load, loadSources]);

  // Signed URLs for image thumbnails (fetched once per image).
  useEffect(() => {
    const missing = items.filter((i) => i.image_path && !requested.current.has(i.id));
    if (missing.length === 0) return;
    missing.forEach((i) => requested.current.add(i.id));
    void Promise.all(
      missing.map(async (i) => {
        const url = await signedImageUrl(i.image_path as string);
        return [i.id, url] as const;
      }),
    ).then((pairs) => {
      const next: Record<string, string> = {};
      for (const [id, url] of pairs) if (url) next[id] = url;
      if (Object.keys(next).length) setUrls((cur) => ({ ...cur, ...next }));
    });
  }, [items]);

  const visible = useMemo(() => (filter === 'all' ? items : items.filter((i) => i.kind === filter)), [items, filter]);
  const opened = useMemo(() => items.find((i) => i.id === openId) ?? null, [items, openId]);
  const isArticleFormat = FORMAT_BY_ID[format].kind === 'article';
  const needsCity = format === 'seo_local_page';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (generating) return;
    const req = {
      format,
      sourceType,
      sourceId: sourceType === 'job' ? jobId : sourceType === 'review' ? reviewId : null,
      tone,
      goal,
      topic,
      city,
      offer,
    };
    const checked = validateRequest(req);
    if (!checked.ok) {
      setFormError(checked.error);
      return;
    }
    setFormError(null);
    setGenerating(true);
    try {
      const row = await generateCreative(checked.value);
      setItems((cur) => [row, ...cur]);
      setOpenId(row.id);
      toast(row.kind === 'image' ? 'Your creative is ready to review.' : 'Your article is ready to review.', 'success');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not generate. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const save = async (patch: CreativePatch): Promise<boolean> => {
    if (!opened || !ownerId) return false;
    setBusy(true);
    try {
      const row = await updateCreative(opened.id, ownerId, patch);
      setItems((cur) => cur.map((i) => (i.id === row.id ? row : i)));
      toast(patch.status ? (patch.status === 'approved' ? 'Approved.' : 'Moved back to draft.') : 'Changes saved.', 'success');
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save. Please try again.', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toCalendar = async (channel: CalendarChannel, scheduledAt: string | null): Promise<boolean> => {
    if (!opened || !ownerId) return false;
    setBusy(true);
    try {
      const calendarId = await addToCalendar(opened, ownerId, channel, scheduledAt);
      setItems((cur) => cur.map((i) => (i.id === opened.id ? { ...i, calendar_item_id: calendarId } : i)));
      toast('Added to your Content Calendar as a draft.', 'success');
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add to the calendar.', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || !ownerId) return;
    try {
      await deleteCreative(pendingDelete, ownerId);
      setItems((cur) => cur.filter((i) => i.id !== pendingDelete.id));
      if (openId === pendingDelete.id) setOpenId(null);
      toast('Deleted.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete. Please try again.', 'error');
    } finally {
      setPendingDelete(null);
    }
  };

  // ---------- gates ----------
  if (authLoading || profileLoading) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-7xl space-y-4 px-4 py-8" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-96 w-full" />
        </div>
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl px-4 py-16">
          <EmptyState
            icon={Lock}
            title="You don't have access to the Creative Studio"
            description="The Creative Studio creates content that represents your business publicly, so it's limited to the account owner and roles that can edit the business profile. Ask your account owner to grant access."
          />
        </div>
      </DashboardLayout>
    );
  }

  const noJobs = !sourcesLoading && jobs.length === 0;
  const noReviews = !sourcesLoading && reviews.length === 0;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
        <header className="mb-6">
          <div className="flex items-center gap-3">
            <Sparkles className="h-7 w-7 text-accent" aria-hidden />
            <h1 className="text-2xl font-bold text-text-primary">Creative Studio</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-text-secondary">
            Turn your real work into marketing: ad and social images, blog posts and local SEO pages built from jobs you completed and reviews customers wrote.
            Everything is a draft you review first — nothing is published automatically.
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          {/* ---------------- Create ---------------- */}
          <section aria-labelledby="create-heading">
            <Card className="!p-5 hover:translate-y-0 lg:sticky lg:top-4">
              <h2 id="create-heading" className="mb-4 text-lg font-semibold text-text-primary">Create</h2>
              <form onSubmit={submit} noValidate className="space-y-4">
                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium text-text-primary">What do you want to make?</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {FORMATS.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        aria-pressed={format === f.id}
                        onClick={() => setFormat(f.id)}
                        className={`focus-ring min-h-[56px] rounded-xl border p-2.5 text-left transition-colors ${
                          format === f.id ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40'
                        }`}
                      >
                        <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                          {f.kind === 'image' ? <ImageIcon className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : <FileText className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
                          {f.label}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-secondary">{f.hint}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>

                <div>
                  <p className="mb-1.5 text-sm font-medium text-text-primary">Base it on</p>
                  <div role="tablist" aria-label="Source" className="flex gap-1 rounded-xl bg-bg-tertiary p-1">
                    {SOURCE_TABS.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={sourceType === t.id}
                        onClick={() => setSourceType(t.id)}
                        className={`focus-ring min-h-[36px] flex-1 rounded-lg px-2 text-xs font-medium transition-colors sm:text-sm ${
                          sourceType === t.id ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3">
                    {sourcesLoading && sourceType !== 'custom' ? (
                      <Skeleton className="h-12 w-full" />
                    ) : sourcesFailed && sourceType !== 'custom' ? (
                      <p className="flex items-center gap-2 text-sm text-danger" role="alert">
                        <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden /> Could not load your jobs and reviews.
                        <button type="button" className="focus-ring rounded font-medium text-accent underline" onClick={() => void loadSources()}>Retry</button>
                      </p>
                    ) : sourceType === 'job' ? (
                      noJobs ? (
                        <p className="text-sm text-text-secondary">No completed jobs yet. Finish a job, or switch to “My own idea”.</p>
                      ) : (
                        <div>
                          <label htmlFor="creative-job" className="mb-1.5 block text-sm font-medium text-text-primary">Completed job</label>
                          <select id="creative-job" className={selectClass} value={jobId} onChange={(e) => setJobId(e.target.value)}>
                            <option value="">Choose a job…</option>
                            {jobs.map((j) => (
                              <option key={j.id} value={j.id}>
                                {prettyService(j.service_type)} · {fmtDate(j.completed_at ?? j.scheduled_datetime)}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-xs text-text-secondary">Only the service type and season are used — never the customer's name or address.</p>
                        </div>
                      )
                    ) : sourceType === 'review' ? (
                      noReviews ? (
                        <p className="text-sm text-text-secondary">No 4–5★ reviews with a written comment yet. They'll appear here once customers leave them.</p>
                      ) : (
                        <div role="radiogroup" aria-label="Review" className="max-h-56 space-y-2 overflow-y-auto pr-1">
                          {reviews.map((r) => (
                            <button
                              key={r.id}
                              type="button"
                              role="radio"
                              aria-checked={reviewId === r.id}
                              onClick={() => setReviewId(r.id)}
                              className={`focus-ring w-full rounded-xl border p-2.5 text-left transition-colors ${reviewId === r.id ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40'}`}
                            >
                              <span className="flex items-center gap-1 text-xs text-text-secondary">
                                <span className="flex" aria-label={`${r.rating} out of 5 stars`}>
                                  {Array.from({ length: r.rating }).map((_, i) => (
                                    <Star key={i} className="h-3.5 w-3.5 fill-warning-500 text-warning-500" aria-hidden />
                                  ))}
                                </span>
                                <span className="capitalize">{r.platform}</span> · {fmtDate(r.reviewed_at)}
                              </span>
                              <span className="mt-1 line-clamp-2 block text-sm text-text-primary">{r.body}</span>
                            </button>
                          ))}
                        </div>
                      )
                    ) : (
                      <Textarea
                        label="What's it about?"
                        rows={3}
                        value={topic}
                        maxLength={300}
                        placeholder="e.g. Fall furnace tune-ups before the first cold snap"
                        onChange={(e) => setTopic(e.target.value)}
                      />
                    )}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <div>
                    <label htmlFor="creative-tone" className="mb-1.5 block text-sm font-medium text-text-primary">Tone</label>
                    <select id="creative-tone" className={selectClass} value={tone} onChange={(e) => setTone(e.target.value as CreativeTone)}>
                      {TONES.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="creative-goal" className="mb-1.5 block text-sm font-medium text-text-primary">Goal</label>
                    <select id="creative-goal" className={selectClass} value={goal} onChange={(e) => setGoal(e.target.value as CreativeGoal)}>
                      {GOALS.map((g) => (
                        <option key={g.id} value={g.id}>{g.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <Input
                  label={needsCity ? 'City or service area' : 'City or service area (optional)'}
                  required={needsCity}
                  value={city}
                  maxLength={80}
                  onChange={(e) => setCity(e.target.value)}
                />
                <Input
                  label="Offer (optional)"
                  value={offer}
                  maxLength={160}
                  onChange={(e) => setOffer(e.target.value)}
                  helperText="Only type a real offer. Without one, the AI will not mention any discount or price."
                />

                {formError && (
                  <p role="alert" className="flex items-start gap-2 text-sm text-danger">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {formError}
                  </p>
                )}

                <Button type="submit" className="w-full" disabled={generating}>
                  <Sparkles className="h-4 w-4" aria-hidden /> {generating ? 'Creating…' : isArticleFormat ? 'Write article' : 'Create image + copy'}
                </Button>
                {generating && (
                  <p role="status" className="text-center text-xs text-text-secondary">
                    {isArticleFormat ? 'Writing and structuring your article — this can take up to a minute.' : 'Writing copy and creating your image — this can take up to a minute.'}
                  </p>
                )}
                <p className="text-center text-xs text-text-secondary">Limit: {MAX_GENERATIONS_PER_HOUR} creations per hour. AI output can contain mistakes — always review.</p>
              </form>
            </Card>
          </section>

          {/* ---------------- Library ---------------- */}
          <section aria-labelledby="library-heading" className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="library-heading" className="text-lg font-semibold text-text-primary">Your library</h2>
              <div role="group" aria-label="Filter library" className="flex gap-1.5">
                {(['all', 'image', 'article'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                    className={`focus-ring inline-flex min-h-[32px] items-center rounded-full border px-3 text-xs font-medium transition-colors ${
                      filter === f ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {f === 'all' ? 'All' : f === 'image' ? 'Images' : 'Articles'}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading your library">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-64 w-full" />
                ))}
              </div>
            ) : error ? (
              <Card className="!p-5 hover:translate-y-0">
                <p className="flex items-start gap-2 text-sm text-danger" role="alert">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
                </p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Retry
                </Button>
              </Card>
            ) : items.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="Nothing created yet"
                description="Pick a format on the left and base it on a job you finished or a review a customer wrote. Your first creative takes about a minute."
              />
            ) : visible.length === 0 ? (
              <p className="py-10 text-center text-sm text-text-secondary">Nothing matches this filter.</p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {visible.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(c.id)}
                      className="focus-ring group block w-full overflow-hidden rounded-2xl border border-border bg-bg-secondary text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card-hover"
                    >
                      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-bg-tertiary">
                        {c.kind === 'image' ? (
                          urls[c.id] ? (
                            <img src={urls[c.id]} alt="" loading="lazy" className="h-full w-full object-cover" />
                          ) : (
                            <Skeleton className="h-full w-full" />
                          )
                        ) : (
                          <FileText className="h-10 w-10 text-text-secondary" aria-hidden />
                        )}
                      </div>
                      <div className="p-3">
                        <p className="line-clamp-2 text-sm font-semibold text-text-primary">{c.title}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-text-secondary">
                          <span>{FORMAT_BY_ID[c.format].label}</span>
                          <span aria-hidden>·</span>
                          <span className={c.status === 'approved' ? 'font-medium text-success-500' : ''}>{STATUS_LABEL[c.status]}</span>
                          {c.warnings.length > 0 && (
                            <span className="inline-flex items-center gap-1 text-warning-500">
                              <TriangleAlert className="h-3 w-3" aria-hidden /> {c.warnings.length} to check
                            </span>
                          )}
                        </p>
                        <p className="mt-1 text-xs text-text-secondary">{fmtDate(c.created_at)}</p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {opened && (
        <CreativeDetail
          key={opened.id}
          creative={opened}
          imageUrl={urls[opened.id] ?? null}
          businessName={businessName}
          brand={brand}
          busy={busy}
          onClose={() => setOpenId(null)}
          onSave={save}
          onAddToCalendar={toCalendar}
          onDelete={() => setPendingDelete(opened)}
          onNotify={(m, t = 'info') => toast(m, t)}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this creative?"
        description="This permanently removes it and its image from your library. Anything already on your calendar stays there."
        confirmLabel="Yes, delete it"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardLayout>
  );
}
