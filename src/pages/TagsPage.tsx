/**
 * Vireek Tags — dashboard: stock, printable sheets, assign, rotate/revoke, scan analytics.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Copy, Plus, Printer, QrCode, RefreshCw, Ban } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TagAnalyticsPanel } from '@/components/tags/TagAnalyticsPanel';
import { TagAssignDialog } from '@/components/tags/TagAssignDialog';
import { TagPrintDialog } from '@/components/tags/TagPrintDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import type { PrintableTag } from '@/lib/tagLabelSheet';
import {
  formatTagToken, generateTags, isValidTagToken, listTags, normalizeTagToken, revokeTag, rotateTag, tagErrorMessage, tagTitle, tagUrl,
  type RotationReason, type TagRow, type TagStatus,
} from '@/lib/vireekTag';

const PAGE = 50;
const BADGE: Record<TagStatus, string> = {
  unassigned: 'bg-bg-tertiary text-text-secondary', active: 'bg-success-500/10 text-success-500',
  rotated: 'bg-warning-500/10 text-warning-500', revoked: 'bg-danger-500/10 text-danger-500',
};
const REASONS: { value: RotationReason; label: string }[] = [
  { value: 'damaged', label: 'Damaged or unreadable' }, { value: 'lost', label: 'Lost / removed' },
  { value: 'suspected_tamper', label: 'Suspected tampering' }, { value: 'scheduled', label: 'Scheduled refresh' },
];
const btn = 'focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50';
const field = 'rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

export function TagsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const assignParam = normalizeTagToken(params.get('assign') ?? '');
  const [tab, setTab] = useState<'inventory' | 'analytics'>('inventory');
  const [status, setStatus] = useState<TagStatus | 'all'>('all');
  const [rows, setRows] = useState<TagRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(24);
  const [label, setLabel] = useState('');
  const [company, setCompany] = useState<string>();
  const [print, setPrint] = useState<{ tags: PrintableTag[]; notice?: string } | null>(null);
  const [rotating, setRotating] = useState<TagRow | null>(null);
  const [reason, setReason] = useState<RotationReason>('damaged');
  const [revoking, setRevoking] = useState<TagRow | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase.from('profiles').select('company_name').eq('id', user.id).maybeSingle()
      .then(({ data }) => setCompany((data as { company_name?: string | null } | null)?.company_name ?? undefined));
  }, [user]);

  const load = useCallback(async (append = false, offset = 0) => {
    setLoading(true);
    try {
      const r = await listTags(status === 'all' ? null : status, PAGE, offset);
      setTotal(r.total);
      setRows((prev) => (append ? [...prev, ...r.tags] : r.tags));
    } catch (e) {
      toast(tagErrorMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  }, [status, toast]);

  useEffect(() => { void load(); }, [load]);

  const caption = (r: TagRow) => (r.status === 'active' ? tagTitle(r) : undefined);

  const generate = async () => {
    setBusy(true);
    try {
      const tags = await generateTags(count, label);
      toast(`${tags.length} tags created`, 'success');
      setPrint({ tags: tags.map((t) => ({ token: t.token })) });
      await load();
    } catch (e) {
      toast(tagErrorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const printStock = async () => {
    setBusy(true);
    try {
      const r = await listTags('unassigned', 200, 0);
      if (r.tags.length === 0) toast('No unused tags to print', 'info');
      else setPrint({ tags: r.tags.map((t) => ({ token: t.token })) });
    } catch (e) {
      toast(tagErrorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doRotate = async () => {
    if (!rotating) return;
    setBusy(true);
    try {
      const r = await rotateTag(rotating.id, reason);
      setPrint({ tags: [{ token: r.token, caption: tagTitle(rotating) }], notice: 'The old sticker is already disabled. Replace it with this one.' });
      setRotating(null);
      await load();
    } catch (e) {
      toast(tagErrorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (r: TagRow) => {
    try { await navigator.clipboard.writeText(tagUrl(r.token)); toast('Link copied', 'success'); } catch { toast('Could not copy the link', 'error'); }
  };

  return (
    <DashboardLayout activeLabel="Vireek Tags">
      <div className="mx-auto w-full max-w-5xl space-y-5 p-4 md:p-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-text-primary"><QrCode size={20} className="text-accent" aria-hidden="true" /> Vireek Tags</h1>
          <p className="text-sm text-text-secondary">Scannable service tags for installed equipment. Each tag opens a public page with the manual, warranty and a request-service button — and your full history for technicians.</p>
        </div>

        <div role="tablist" aria-label="Tags sections" className="flex gap-2">
          {(['inventory', 'analytics'] as const).map((t) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`focus-ring rounded-lg border px-3 py-1.5 text-sm font-medium capitalize ${tab === t ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{t}</button>
          ))}
        </div>

        {tab === 'analytics' ? <TagAnalyticsPanel /> : (
          <>
            <section className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark" aria-labelledby="gen-title">
              <h2 id="gen-title" className="mb-3 text-sm font-semibold text-text-primary">Create a sheet of tags</h2>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs font-medium text-text-secondary">How many (1–120)
                  <input type="number" min={1} max={120} value={count} onChange={(e) => setCount(Math.max(1, Math.min(120, Number(e.target.value) || 1)))} className={`${field} mt-1 block w-28`} />
                </label>
                <label className="min-w-[180px] flex-1 text-xs font-medium text-text-secondary">Batch name (optional)
                  <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Spring installs" className={`${field} mt-1 block w-full`} />
                </label>
                <button type="button" onClick={generate} disabled={busy} className="focus-ring inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"><Plus size={15} aria-hidden="true" /> Create &amp; print</button>
                <button type="button" onClick={printStock} disabled={busy} className={btn}><Printer size={13} aria-hidden="true" /> Reprint unused stock</button>
              </div>
            </section>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-medium text-text-secondary">Show{' '}
                <select value={status} onChange={(e) => setStatus(e.target.value as TagStatus | 'all')} className={`${field} ml-1`}>
                  <option value="all">All</option><option value="unassigned">Unused</option><option value="active">Active</option><option value="rotated">Rotated</option><option value="revoked">Revoked</option>
                </select>
              </label>
              <p className="text-xs text-text-secondary">{total} tag{total === 1 ? '' : 's'}</p>
            </div>

            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.id} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                        {tagTitle(r)}
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${BADGE[r.status]}`}>{r.status === 'unassigned' ? 'unused' : r.status}</span>
                        {r.report_count > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] text-warning-500"><AlertTriangle size={11} aria-hidden="true" /> {r.report_count} report{r.report_count === 1 ? '' : 's'}</span>}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-text-secondary">{formatTagToken(r.token)}{r.batch_label ? ` · ${r.batch_label}` : ''}</p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {r.scan_count} scan{r.scan_count === 1 ? '' : 's'}{r.last_scan_at ? ` · last ${new Date(r.last_scan_at).toLocaleDateString()}` : ''} · {r.request_count} request{r.request_count === 1 ? '' : 's'}
                        {r.rotation_reason ? ` · retired: ${r.rotation_reason.replace('_', ' ')}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(r.status === 'unassigned' || r.status === 'active') && <button type="button" className={btn} onClick={() => setPrint({ tags: [{ token: r.token, caption: caption(r) }] })}><Printer size={12} aria-hidden="true" /> Print</button>}
                      {r.status !== 'revoked' && r.status !== 'rotated' && <button type="button" className={btn} onClick={() => void copy(r)}><Copy size={12} aria-hidden="true" /> Link</button>}
                      {r.status === 'unassigned' && <button type="button" className={btn} onClick={() => setParams({ assign: r.token })}>Attach</button>}
                      {r.status === 'active' && <button type="button" className={btn} onClick={() => { setReason('damaged'); setRotating(r); }}><RefreshCw size={12} aria-hidden="true" /> Rotate</button>}
                      {(r.status === 'unassigned' || r.status === 'active') && <button type="button" className={btn} onClick={() => setRevoking(r)}><Ban size={12} aria-hidden="true" /> Revoke</button>}
                    </div>
                  </div>
                </li>
              ))}
              {loading && <li className="h-20 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" />}
              {!loading && rows.length === 0 && <li className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">No tags yet. Create your first sheet above.</li>}
            </ul>
            {rows.length < total && <button type="button" className={btn} disabled={loading} onClick={() => void load(true, rows.length)}>Load more</button>}
          </>
        )}
      </div>

      {print && <TagPrintDialog tags={print.tags} notice={print.notice} businessName={company} onClose={() => setPrint(null)} />}

      {isValidTagToken(assignParam) && (
        <TagAssignDialog
          token={assignParam}
          onClose={() => setParams({})}
          onDone={() => { setParams({}); void load(); }}
        />
      )}

      {rotating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="rot-title">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
            <h2 id="rot-title" className="text-base font-semibold text-text-primary">Rotate this tag</h2>
            <p className="mt-1 text-sm text-text-secondary">The current sticker stops working immediately. A new token is issued for the same machine — its history is untouched.</p>
            <label className="mt-3 block text-xs font-medium text-text-secondary">Reason
              <select value={reason} onChange={(e) => setReason(e.target.value as RotationReason)} className={`${field} mt-1 block w-full`}>
                {REASONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => setRotating(null)}>Cancel</button>
              <button type="button" disabled={busy} onClick={doRotate} className="focus-ring rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? 'Rotating…' : 'Rotate & print'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this tag?"
        description="Scanning it will show a “deactivated” page and it can’t be re-enabled. The machine’s passport and history are not affected."
        confirmLabel="Revoke tag"
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          try { await revokeTag(revoking.id); toast('Tag revoked', 'success'); await load(); } catch (e) { toast(tagErrorMessage(e), 'error'); } finally { setRevoking(null); }
        }}
      />
    </DashboardLayout>
  );
}
