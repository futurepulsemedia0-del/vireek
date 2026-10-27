/**
 * Site Sketches — /dashboard/site-sketches
 * Library of on-site floor plans and room measurements, attachable to jobs and quotes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, PencilRuler, Plus, Search, Trash2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FadeIn, SkeletonCardList } from '@/components/Skeleton';
import { SketchThumb } from '@/components/sketch/SiteSketchPanel';
import { formatArea, formatLength } from '@/lib/siteSketch';
import { deleteSiteSketch, listSiteSketches, sketchErrorMessage, type SketchListItem } from '@/lib/siteSketchApi';

type Filter = 'all' | 'job' | 'quote' | 'unattached';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'job', label: 'On a job' },
  { key: 'quote', label: 'On a quote' },
  { key: 'unattached', label: 'Unattached' },
];

export function SiteSketchesPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [items, setItems] = useState<SketchListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [deleting, setDeleting] = useState<SketchListItem | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setFailed(false);
    try {
      const rows = await listSiteSketches({ search: debounced, limit: 100 });
      if (id !== request.current) return;
      setItems(rows);
    } catch {
      if (id === request.current) setFailed(true);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      items.filter((s) =>
        filter === 'all' ? true : filter === 'job' ? !!s.job_id : filter === 'quote' ? !!s.quote_id : !s.job_id && !s.quote_id,
      ),
    [items, filter],
  );

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteSiteSketch(deleting.id);
      setItems((prev) => prev.filter((s) => s.id !== deleting.id));
      toast('Sketch deleted', 'success');
    } catch (err) {
      toast(sketchErrorMessage(err), 'error');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Site Sketches">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <PencilRuler size={24} aria-hidden="true" /> Site Sketches
          </h1>
          <p className="mt-1 text-sm text-text-secondary">Draw floor plans and measure rooms on site, then attach them to a job or quote.</p>
        </div>
        <Button size="sm" onClick={() => navigate('/dashboard/site-sketches/new')}>
          <Plus size={16} aria-hidden="true" /> New sketch
        </Button>
      </div>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sketches"
            aria-label="Search sketches"
            className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-9 pr-3 text-sm text-text-primary"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto" role="group" aria-label="Filter sketches">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`focus-ring min-h-[40px] whitespace-nowrap rounded-xl px-3 text-sm font-semibold ${filter === f.key ? 'bg-accent text-white' : 'border border-border bg-bg-secondary text-text-secondary hover:text-text-primary'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={2} />
      ) : failed ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load sketches" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={PencilRuler}
          title={debounced ? 'No sketches match your search' : 'No sketches yet'}
          description={debounced ? 'Try a different name.' : 'Sketch a room on site, type in the tape measurements, and attach it to the job or quote.'}
          action={debounced ? undefined : { label: 'Start your first sketch', onClick: () => navigate('/dashboard/site-sketches/new') }}
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={PencilRuler} title="Nothing in this filter" description="Switch the filter to see your other sketches." action={{ label: 'Show all', onClick: () => setFilter('all') }} />
      ) : (
        <FadeIn>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((s) => (
              <li key={s.id} className="flex items-stretch gap-2 rounded-2xl border border-border bg-bg-secondary p-3">
                <Link to={`/dashboard/site-sketches/${s.id}`} className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-xl">
                  <SketchThumb path={s.thumb} className="h-20 w-20" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-text-primary">{s.title}</span>
                    <span className="block text-xs text-text-secondary">
                      {s.area_mm2 > 0 ? formatArea(s.area_mm2, s.unit) : 'No rooms'} · {formatLength(s.wall_mm, s.unit)} walls
                    </span>
                    <span className="mt-1 block text-xs text-text-secondary">
                      {[s.job_id && 'Job', s.quote_id && 'Quote'].filter(Boolean).join(' + ') || 'Unattached'} · {new Date(s.updated_at).toLocaleDateString()}
                    </span>
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => setDeleting(s)}
                  aria-label={`Delete ${s.title}`}
                  className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center self-start rounded-xl text-text-secondary hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </FadeIn>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete this sketch?"
        description={deleting ? `"${deleting.title}" will be removed from any job or quote it is attached to. This can't be undone.` : ''}
        confirmLabel="Delete sketch"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
