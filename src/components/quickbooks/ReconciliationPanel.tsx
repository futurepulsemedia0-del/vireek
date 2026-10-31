import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, History, Loader2, ScanSearch } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  BUCKET_LABEL,
  RECON_BUCKETS,
  downloadCsv,
  findingsToCsv,
  formatCents,
  latestReconRun,
  listFindingEvents,
  listFindings,
  setFindingStatus,
  startReconciliation,
  type FindingStatus,
  type ReconBucket,
  type ReconEvent,
  type ReconFindingRow,
  type ReconRun,
} from '@/lib/quickbooksRecon';
import { timeAgo, type QboConnection } from '@/lib/quickbooks';

const SEVERITY_STYLE: Record<ReconFindingRow['severity'], string> = {
  critical: 'bg-error-500/10 text-error-500',
  high: 'bg-error-500/10 text-error-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};
const selectCls = 'rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none';

function Facts({ title, data }: { title: string; data: Record<string, unknown> | null }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg-primary p-3">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</p>
      {data ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {Object.entries(data).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-secondary">{k.replace(/_/g, ' ')}</dt>
              <dd className="truncate text-text-primary" title={String(v ?? '')}>{k.endsWith('_cents') && typeof v === 'number' ? formatCents(v) : String(v ?? '—')}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-text-secondary">No record on this side.</p>
      )}
    </div>
  );
}

function FindingCard({ f, onChanged }: { f: ReconFindingRow; onChanged: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<ReconEvent[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listFindingEvents(f.id).then((e) => !cancelled && setEvents(e)).catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [open, f.id, f.status]);

  const act = async (status: 'open' | 'resolved') => {
    setBusy(true);
    try {
      await setFindingStatus(f.id, status, note);
      toast(status === 'resolved' ? 'Marked as resolved.' : 'Reopened.', 'success');
      setResolving(false);
      setNote('');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the finding.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const v = f.evidence.vireek;
  const q = f.evidence.qbo;
  const ref = [v?.invoice_number, q?.doc_number].filter(Boolean).join(' · ') || '—';

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[f.severity]}`}>{f.severity}</span>
        <span className="text-sm font-semibold text-text-primary">{BUCKET_LABEL[f.bucket]}</span>
        <span className="text-sm text-text-secondary">{ref}</span>
        {f.has_payments && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">has payments</span>}
        {f.status !== 'open' && <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-xs font-medium text-success-500">{f.status}</span>}
        <span className="ml-auto text-sm font-semibold text-text-primary">{formatCents(f.cents_at_stake)}</span>
      </div>
      <p className="mt-2 text-sm text-text-secondary">{f.suggested_action}</p>
      {f.resolution_note && <p className="mt-2 rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary">Note: {f.resolution_note}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Evidence &amp; history
        </button>
        {f.status === 'open' && !resolving && (
          <button type="button" onClick={() => setResolving(true)} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-primary">Mark resolved…</button>
        )}
        {f.status === 'resolved' && (
          <button type="button" disabled={busy} onClick={() => void act('open')} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">Reopen</button>
        )}
      </div>

      {resolving && (
        <div className="mt-3 space-y-2">
          <label className="block text-sm font-medium text-text-primary" htmlFor={`note-${f.id}`}>What was done? (required, shown in the audit log)</label>
          <textarea id={`note-${f.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none" />
          <div className="flex gap-2">
            <button type="button" disabled={busy || note.trim().length < 3} onClick={() => void act('resolved')} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save as resolved'}</button>
            <button type="button" onClick={() => setResolving(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-primary">Cancel</button>
          </div>
          <p className="text-xs text-text-secondary">This only records your decision. It does not change QuickBooks, the invoice or any payment.</p>
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Facts title="Vireek" data={v} />
            <Facts title="QuickBooks" data={q} />
          </div>
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary"><History size={12} /> Audit log</p>
            {!events ? <p className="text-xs text-text-secondary">Loading…</p> : events.length === 0 ? <p className="text-xs text-text-secondary">No events.</p> : (
              <ul className="space-y-1 text-xs text-text-primary">
                {events.map((e) => (
                  <li key={e.id}><span className="font-medium">{e.action}</span> · {timeAgo(e.created_at)}{e.note ? ` · ${e.note}` : ''}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function ReconciliationPanel({ conn }: { conn: QboConnection }) {
  const { toast } = useToast();
  const [run, setRun] = useState<ReconRun | null>(null);
  const [rows, setRows] = useState<ReconFindingRow[]>([]);
  const [status, setStatus] = useState<FindingStatus | 'all'>('open');
  const [bucket, setBucket] = useState<ReconBucket | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [r, f] = await Promise.all([latestReconRun(conn.id), listFindings(conn.id, status)]);
        setRun(r);
        setRows(f);
        setFailed(false);
      } catch {
        if (!silent) setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [conn.id, status],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const running = run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(true), 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const start = async () => {
    setStarting(true);
    try {
      await startReconciliation(conn.id);
      toast('Audit started. It only reads; nothing is changed in QuickBooks.', 'success');
      await load(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the audit.', 'error');
    } finally {
      setStarting(false);
    }
  };

  const shown = useMemo(() => (bucket === 'all' ? rows : rows.filter((r) => r.bucket === bucket)), [rows, bucket]);
  const perBucket = useMemo(() => {
    const m = new Map<ReconBucket, { count: number; cents: number }>();
    for (const b of RECON_BUCKETS) m.set(b, { count: 0, cents: 0 });
    for (const r of rows) {
      const x = m.get(r.bucket)!;
      x.count += 1;
      x.cents += r.cents_at_stake;
    }
    return m;
  }, [rows]);
  const totalCents = shown.reduce((s, r) => s + r.cents_at_stake, 0);
  const matched = run?.summary?.matched;

  const exportCsv = () => {
    downloadCsv(`quickbooks-reconciliation-${new Date().toISOString().slice(0, 10)}.csv`, findingsToCsv(shown.map((r) => ({ ...r, evidence: r.evidence }))));
  };

  return (
    <section className="space-y-4" aria-labelledby="qbo-recon">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="qbo-recon" className="flex items-center gap-2 text-lg font-semibold text-text-primary"><ScanSearch size={18} /> Reconciliation audit</h2>
          <p className="text-sm text-text-secondary">Compares imported invoices with QuickBooks. Read-only: it never edits, voids or sends anything.</p>
        </div>
        <button type="button" onClick={() => void start()} disabled={starting || running} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {running || starting ? <Loader2 size={16} className="animate-spin" /> : <ScanSearch size={16} />} {running ? 'Auditing…' : 'Run audit'}
        </button>
        <button type="button" onClick={exportCsv} disabled={!shown.length} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-text-primary disabled:opacity-50"><Download size={16} /> CSV</button>
      </div>

      {loading ? (
        <div className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading reconciliation" />
      ) : failed ? (
        <p className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary"><AlertTriangle size={14} className="mr-1 inline text-warning-500" />Couldn't load the audit. <button type="button" className="font-medium text-accent hover:underline" onClick={() => void load()}>Try again</button></p>
      ) : !run ? (
        <p className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 p-6 text-center text-sm text-text-secondary">No audit yet. Run one to see what differs between your imported invoices and QuickBooks.</p>
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            Last audit {timeAgo(run.finished_at ?? run.started_at)} · {run.status}
            {matched ? ` · ${matched.count} matched (${formatCents(matched.cents)})` : ''}
            {run.summary?.skipped_count ? ` · ${run.summary.skipped_count} skipped (not comparable)` : ''}
            {run.summary?.note === 'no_imported_invoices' ? ' · no imported invoices to audit' : ''}
          </p>
          {run.error && <p className="text-sm text-warning-500">{run.error}</p>}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {RECON_BUCKETS.map((b) => {
              const x = perBucket.get(b)!;
              const active = bucket === b;
              return (
                <button key={b} type="button" onClick={() => setBucket(active ? 'all' : b)} aria-pressed={active} className={`rounded-xl border p-3 text-left ${active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'}`}>
                  <span className="block text-xs text-text-secondary">{BUCKET_LABEL[b]}</span>
                  <span className="block text-lg font-semibold text-text-primary">{x.count}</span>
                  <span className="block text-xs text-text-secondary">{formatCents(x.cents)}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-text-secondary">Show
              <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as FindingStatus | 'all')}>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="cleared">Cleared (no longer detected)</option>
                <option value="all">All</option>
              </select>
            </label>
            <span className="text-sm text-text-secondary">{shown.length} findings · {formatCents(totalCents)} at stake</span>
          </div>

          {shown.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 p-6 text-center text-sm text-text-secondary"><CheckCircle2 size={16} className="mr-1 inline text-success-500" />Nothing to review here.</p>
          ) : (
            <ul className="space-y-3">{shown.map((f) => <FindingCard key={f.id} f={f} onChanged={() => void load(true)} />)}</ul>
          )}
        </>
      )}
    </section>
  );
}
