import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, Eye, Link2, ShieldOff } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyStateInline } from '@/components/EmptyState';
import {
  EXPIRY_OPTIONS,
  PERIOD_OPTIONS,
  WIDGET_CATALOG,
  expiryLabel,
  sanitizePayload,
  shareUrl,
  snapshotFilename,
  snapshotStatus,
  validateOptions,
  type SnapshotStatus,
  type WidgetKey,
} from '@/lib/dashboardSnapshot';
import {
  createSnapshot,
  listSnapshotViews,
  listSnapshots,
  revokeSnapshot,
  type CreatedSnapshot,
  type SnapshotListItem,
  type SnapshotView,
} from '@/lib/dashboardSnapshotData';
import { buildSnapshotPdf } from '@/lib/dashboardSnapshotPdf';

const STATUS_STYLE: Record<SnapshotStatus, string> = {
  active: 'bg-success-500/10 text-success-500',
  expired: 'bg-bg-tertiary text-text-secondary',
  revoked: 'bg-danger-500/10 text-danger-500',
};

const DEFAULT_WIDGETS: WidgetKey[] = ['calls_total', 'missed_call_rate', 'jobs_completed', 'revenue_collected', 'call_volume_trend'];
const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

const shortUa = (ua: string | null) => {
  if (!ua) return 'Unknown device';
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome\//i.test(ua) ? 'Chrome' : /firefox\//i.test(ua) ? 'Firefox' : /safari\//i.test(ua) ? 'Safari' : 'Browser';
  const os = /iphone|ipad/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : /mac os/i.test(ua) ? 'macOS' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
};

export function DashboardSnapshotsPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<SnapshotListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const [title, setTitle] = useState('');
  const [audience, setAudience] = useState('');
  const [periodDays, setPeriodDays] = useState<number>(30);
  const [expiryDays, setExpiryDays] = useState<number>(14);
  const [widgets, setWidgets] = useState<WidgetKey[]>(DEFAULT_WIDGETS);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ result: CreatedSnapshot; title: string; audience: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const [openViews, setOpenViews] = useState<string | null>(null);
  const [views, setViews] = useState<SnapshotView[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await listSnapshots());
      setNow(Date.now());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load snapshots.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (key: WidgetKey) => setWidgets((w) => (w.includes(key) ? w.filter((k) => k !== key) : [...w, key]));

  const create = async () => {
    const v = validateOptions({ title, audience, periodDays, expiryDays, widgetKeys: widgets });
    if (!v.ok) {
      toast(v.errors[0], 'error');
      return;
    }
    setCreating(true);
    try {
      const result = await createSnapshot(v.value);
      setCreated({ result, title: v.value.title, audience: v.value.audience || null });
      setCopied(false);
      setTitle('');
      setAudience('');
      toast('Snapshot link created.', 'success');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the snapshot.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy. Select the link and copy it manually.', 'error');
    }
  };

  const revoke = async (item: SnapshotListItem) => {
    if (!window.confirm(`Revoke “${item.title}”? Anyone with the link will immediately lose access.`)) return;
    setRevoking(item.id);
    try {
      await revokeSnapshot(item.id);
      toast('Link revoked.', 'success');
      if (created?.result.id === item.id) setCreated(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not revoke the link.', 'error');
    } finally {
      setRevoking(null);
    }
  };

  const toggleViews = async (id: string) => {
    if (openViews === id) {
      setOpenViews(null);
      return;
    }
    setOpenViews(id);
    setViews([]);
    try {
      setViews(await listSnapshotViews(id));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load views.', 'error');
    }
  };

  const downloadPdf = (item: SnapshotListItem) => {
    const payload = sanitizePayload(item.payload);
    if (!payload) {
      toast('This snapshot cannot be exported.', 'error');
      return;
    }
    buildSnapshotPdf({ title: item.title, audience: item.audience, businessName: '' }, payload).save(snapshotFilename(item.title));
  };

  const url = created ? shareUrl(window.location.origin, created.result.token) : '';
  const group = (g: 'overview' | 'analytics') => WIDGET_CATALOG.filter((w) => w.group === g);

  return (
    <DashboardLayout activeLabel="Shared Snapshots">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Link2 size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Shared Snapshots</h1>
          <p className="text-sm text-text-secondary">Send partners, accountants or franchisors a read-only, expiring view of selected numbers.</p>
        </div>
      </div>

      <section className="mb-8 rounded-2xl border border-border bg-bg-secondary p-5">
        <h2 className="mb-4 text-sm font-semibold text-text-primary">New snapshot</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="snap-title" className="mb-1 block text-xs text-text-secondary">Title</label>
            <input id="snap-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Q3 performance update" className={field} />
          </div>
          <div>
            <label htmlFor="snap-aud" className="mb-1 block text-xs text-text-secondary">Prepared for (optional)</label>
            <input id="snap-aud" value={audience} onChange={(e) => setAudience(e.target.value)} maxLength={80} placeholder="Acme Accounting" className={field} />
          </div>
          <div>
            <label htmlFor="snap-period" className="mb-1 block text-xs text-text-secondary">Reporting period</label>
            <select id="snap-period" value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))} className={field}>
              {PERIOD_OPTIONS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="snap-exp" className="mb-1 block text-xs text-text-secondary">Link expires after</label>
            <select id="snap-exp" value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))} className={field}>
              {EXPIRY_OPTIONS.map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
            </select>
          </div>
        </div>

        {(['overview', 'analytics'] as const).map((g) => (
          <fieldset key={g} className="mt-4">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{g === 'overview' ? 'Overview' : 'Analytics'}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {group(g).map((w) => (
                <label key={w.key} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2.5 text-sm hover:border-accent">
                  <input type="checkbox" checked={widgets.includes(w.key)} onChange={() => toggle(w.key)} className="mt-0.5" />
                  <span>
                    <span className="block font-medium text-text-primary">{w.title}</span>
                    <span className="block text-xs text-text-secondary">{w.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}

        <p className="mt-4 text-xs text-text-secondary">
          Snapshots contain totals only — no customer names, phone numbers or transcripts — and are frozen when created.
        </p>
        <button
          type="button"
          onClick={create}
          disabled={creating}
          className="focus-ring mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create link'}
        </button>
      </section>

      {created && (
        <section className="mb-8 rounded-2xl border border-accent/40 bg-bg-secondary p-5" aria-live="polite">
          <h2 className="text-sm font-semibold text-text-primary">Link ready: {created.title}</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Copy it now. For security the full link is shown only once; you can always create another or revoke this one.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" className={`${field} font-mono text-xs`} />
            <button type="button" onClick={() => copy(url)} className="focus-ring inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => buildSnapshotPdf({ title: created.title, audience: created.audience, businessName: '' }, created.result.payload).save(snapshotFilename(created.title))}
              className="focus-ring inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-primary"
            >
              <Download size={14} /> PDF
            </button>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-text-primary">Your snapshots</h2>
        {loading ? (
          <p className="text-sm text-text-secondary">Loading…</p>
        ) : items.length === 0 ? (
          <EmptyStateInline text="No snapshots yet. Create your first link above." />
        ) : (
          <ul className="space-y-3">
            {items.map((s) => {
              const status = snapshotStatus(s, now);
              return (
                <li key={s.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-text-primary">{s.title}</h3>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[status]}`}>{status}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {s.audience ? `${s.audience} · ` : ''}Last {s.period_days} days · {s.widget_keys.length} widgets ·{' '}
                        {status === 'revoked' ? 'Revoked' : expiryLabel(s.expires_at, now)}
                      </p>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {s.view_count === 0
                          ? 'Not opened yet'
                          : `${s.view_count} view${s.view_count > 1 ? 's' : ''} · last ${new Date(s.last_viewed_at as string).toLocaleString()}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => toggleViews(s.id)} aria-expanded={openViews === s.id} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
                        <Eye size={12} /> Views
                      </button>
                      <button type="button" onClick={() => downloadPdf(s)} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
                        <Download size={12} /> PDF
                      </button>
                      {status === 'active' && (
                        <button type="button" onClick={() => revoke(s)} disabled={revoking === s.id} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-danger-500/40 px-2.5 py-1.5 text-xs font-medium text-danger-500 disabled:opacity-50">
                          <ShieldOff size={12} /> {revoking === s.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </div>
                  </div>
                  {openViews === s.id && (
                    <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-text-secondary">
                      {views.length === 0 ? <li>No views recorded.</li> : views.map((v) => (
                        <li key={v.id} className="flex justify-between gap-4">
                          <span>{new Date(v.viewed_at).toLocaleString()}</span>
                          <span>{shortUa(v.user_agent)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </DashboardLayout>
  );
}
