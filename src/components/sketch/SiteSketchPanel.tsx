/**
 * Sketches attached to a job or a quote. Drop into JobDetailPage / QuoteDetailPage.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, PencilRuler, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Skeleton } from '@/components/Skeleton';
import { formatArea, safeThumbPath, formatLength } from '@/lib/siteSketch';
import { listSiteSketches, type SketchListItem } from '@/lib/siteSketchApi';

export function SketchThumb({ path, className = '' }: { path: string | null; className?: string }) {
  const d = safeThumbPath(path);
  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-bg-primary ${className}`} aria-hidden="true">
      {d ? (
        <svg viewBox="0 0 100 100" className="h-full w-full">
          <path d={d} fill="none" stroke="rgb(var(--text-primary))" strokeWidth={2.2} strokeLinecap="square" />
        </svg>
      ) : (
        <PencilRuler size={22} className="text-text-secondary" />
      )}
    </div>
  );
}

interface Props {
  jobId?: string;
  quoteId?: string;
  /** Whether the viewer may start a new sketch from here (job: edit access; quote: managers). */
  canCreate?: boolean;
}

export function SiteSketchPanel({ jobId, quoteId, canCreate }: Props) {
  const { isOwner, permissions } = useAuth();
  const manager = isOwner || permissions.can_view_all_jobs;
  const allowNew = quoteId ? manager : (canCreate ?? true);
  const [items, setItems] = useState<SketchListItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setState('loading');
    try {
      const rows = await listSiteSketches({ jobId, quoteId, limit: 20 });
      if (id !== request.current) return;
      setItems(rows);
      setState('ready');
    } catch {
      if (id === request.current) setState('error');
    }
  }, [jobId, quoteId]);

  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  const newHref = `/dashboard/site-sketches/new?${jobId ? `job=${jobId}` : `quote=${quoteId}`}`;
  const unitOf = (s: SketchListItem) => s.unit;

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5" aria-labelledby="site-sketch-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="site-sketch-heading" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <PencilRuler size={15} className="text-text-secondary" aria-hidden="true" /> Site sketches
        </h2>
        {allowNew && (
          <Link to={newHref} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">
            <Plus size={15} aria-hidden="true" /> New sketch
          </Link>
        )}
      </div>

      {state === 'loading' ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading sketches">
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : state === 'error' ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          <span className="flex items-center gap-2"><AlertTriangle size={15} aria-hidden="true" /> Could not load sketches.</span>
          <button type="button" onClick={() => void load()} className="focus-ring rounded-lg px-2 py-1 font-semibold underline">Retry</button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-secondary">
          {allowNew ? 'No sketches yet. Draw the floor plan on site and measure rooms right from your phone.' : 'No sketches attached.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <li key={s.id}>
              <Link to={`/dashboard/site-sketches/${s.id}`} className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-2.5 hover:border-accent/40">
                <SketchThumb path={s.thumb} className="h-14 w-14" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-text-primary">{s.title}</span>
                  <span className="block text-xs text-text-secondary">
                    {s.area_mm2 > 0 ? formatArea(s.area_mm2, unitOf(s)) : 'No rooms'} · {formatLength(s.wall_mm, unitOf(s))} of walls
                  </span>
                </span>
                <span className="shrink-0 text-xs text-text-secondary">{new Date(s.updated_at).toLocaleDateString()}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
