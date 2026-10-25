import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileJson, Loader2, Lock, RefreshCw, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { FadeIn, SkeletonCard, SkeletonStatGrid } from '@/components/Skeleton';
import {
  DRIFT_META, EMPTY_SUMMARY, LANGUAGE_OPTIONS, RANGES, REASON_LABEL, STATUSES, STATUS_META,
  buildAuditBundle, buildCsv, deliveryRate, driftReasonText, exportFileName, formatOffset, languageLabel,
  needsAttention, rangeBounds, shortHash,
  type DriftCheck, type LedgerRow, type LedgerStatus, type LedgerSummary, type RangeKey, type VersionRow,
} from '@/lib/aiDisclosureLedger';
import {
  PAGE_SIZE, fetchAllForExport, fetchDriftChecks, fetchLedgerPage, fetchScriptConfig, fetchSummary, fetchVersions,
  runDriftCheck, saveScriptLanguage,
} from '@/lib/aiDisclosureLedgerApi';

const STALE_CHECK_MS = 6 * 60 * 60 * 1000;

const TONE: Record<'good' | 'warn' | 'bad' | 'neutral', string> = {
  good: 'bg-success-500/10 text-success-500',
  warn: 'bg-warning-500/10 text-warning-500',
  bad: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

function Badge({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) {
  return <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[tone]}`}>{children}</span>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: keyof typeof TONE }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tracking-tight ${tone === 'bad' ? 'text-danger' : 'text-text-primary'}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function RowItem({ row, open, onToggle }: { row: LedgerRow; open: boolean; onToggle: () => void }) {
  const meta = STATUS_META[row.status];
  const caller = row.calls?.caller_name || row.calls?.caller_phone || 'Unknown caller';
  return (
    <li className="rounded-xl border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="focus-ring flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-text-primary">{caller}</span>
          <span className="block truncate text-xs text-text-secondary">
            {fmtDate(row.call_started_at ?? row.created_at)} · {languageLabel(row.language)}
            {row.language_mismatch ? ` · caller spoke ${languageLabel(row.detected_language)}` : ''}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <ChevronDown size={16} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border px-4 py-4 text-sm" data-testid="ledger-row-detail">
          <p className="text-text-secondary">{meta.hint}</p>
          <div>
            <p className="text-xs font-medium text-text-secondary">Exact wording used ({REASON_LABEL[row.selection_reason]})</p>
            <p className="mt-1 rounded-lg bg-bg-tertiary px-3 py-2 text-text-primary" dir="auto">{row.disclosure_text}</p>
          </div>
          {row.evidence_excerpt ? (
            <div>
              <p className="text-xs font-medium text-text-secondary">What the assistant actually said</p>
              <p className="mt-1 rounded-lg bg-bg-tertiary px-3 py-2 text-text-primary" dir="auto">{row.evidence_excerpt}</p>
            </div>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
            <div><dt className="text-text-secondary">Said at</dt><dd className="font-medium text-text-primary">{formatOffset(row.offset_seconds)}</dd></div>
            <div><dt className="text-text-secondary">Timestamp (UTC)</dt><dd className="font-medium text-text-primary">{row.delivered_at ? row.delivered_at.replace('T', ' ').slice(0, 19) : '—'}</dd></div>
            <div><dt className="text-text-secondary">Match</dt><dd className="font-medium text-text-primary">{row.match_score === null ? '—' : `${Math.round(row.match_score * 100)}%`}</dd></div>
            <div><dt className="text-text-secondary">Transcript position</dt><dd className="font-medium text-text-primary">{row.transcript_char_offset === null ? '—' : `char ${row.transcript_char_offset}`}</dd></div>
            <div><dt className="text-text-secondary">Wording hash</dt><dd className="font-mono text-text-primary" title={row.disclosure_sha256}>{shortHash(row.disclosure_sha256)}</dd></div>
            <div><dt className="text-text-secondary">Transcript hash</dt><dd className="font-mono text-text-primary" title={row.transcript_sha256 ?? ''}>{shortHash(row.transcript_sha256)}</dd></div>
            <div className="col-span-2"><dt className="text-text-secondary">Call ID</dt><dd className="break-all font-mono text-text-primary">{row.vapi_call_id}</dd></div>
          </dl>
        </div>
      ) : null}
    </li>
  );
}

export function AiDisclosureLedgerPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { toast } = useToast();
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAccess = Boolean(isOwner || permissions?.can_edit_business_profile);

  const [range, setRange] = useState<RangeKey>('30d');
  const [status, setStatus] = useState<LedgerStatus | 'all'>('all');
  const [search, setSearch] = useState(params.get('call') ?? '');
  const [page, setPage] = useState(0);

  const [overviewState, setOverviewState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [summary, setSummary] = useState<LedgerSummary>(EMPTY_SUMMARY);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [drift, setDrift] = useState<DriftCheck[]>([]);
  const [script, setScript] = useState<{ script: string; language: string } | null>(null);

  const [rowsState, setRowsState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);
  const [savingLang, setSavingLang] = useState(false);
  const autoChecked = useRef(false);

  const bounds = useMemo(() => rangeBounds(range), [range]);

  const loadOverview = useCallback(async () => {
    if (!accountOwnerId) return;
    setOverviewState('loading');
    try {
      const b = rangeBounds(range);
      const [s, v, d, cfg] = await Promise.all([
        fetchSummary(b.from, b.to), fetchVersions(accountOwnerId), fetchDriftChecks(accountOwnerId), fetchScriptConfig(accountOwnerId),
      ]);
      setSummary(s); setVersions(v); setDrift(d); setScript(cfg);
      setOverviewState('ready');
    } catch {
      setOverviewState('error');
    }
  }, [accountOwnerId, range]);

  const loadRows = useCallback(async () => {
    if (!accountOwnerId) return;
    setRowsState('loading');
    try {
      const b = rangeBounds(range);
      const res = await fetchLedgerPage(accountOwnerId, { from: b.from, to: b.to, status, search, page });
      setRows(res.rows); setTotal(res.total);
      setRowsState('ready');
    } catch {
      setRowsState('error');
    }
  }, [accountOwnerId, range, status, search, page]);

  useEffect(() => { if (canAccess) void loadOverview(); }, [canAccess, loadOverview]);
  useEffect(() => { if (canAccess) void loadRows(); }, [canAccess, loadRows]);

  const latest = drift[0] ?? null;

  const checkNow = useCallback(async (silent = false) => {
    if (!accountOwnerId) return;
    setChecking(true);
    try {
      await runDriftCheck();
      setDrift(await fetchDriftChecks(accountOwnerId));
      if (!silent) toast('Checked your live assistant.', 'success');
    } catch {
      if (!silent) toast("Couldn't check your assistant right now. Please try again.", 'error');
    } finally {
      setChecking(false);
    }
  }, [accountOwnerId, toast]);

  // Opportunistic refresh: if the last check is old (or there is none), check once on open.
  useEffect(() => {
    if (overviewState !== 'ready' || autoChecked.current) return;
    autoChecked.current = true;
    const stale = !latest || Date.now() - Date.parse(latest.checked_at) > STALE_CHECK_MS;
    if (stale) void checkNow(true);
  }, [overviewState, latest, checkNow]);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Copied.', 'success'); } catch { toast("Couldn't copy. Select the text and copy it manually.", 'error'); }
  };

  const doExport = async (kind: 'csv' | 'json') => {
    if (!accountOwnerId) return;
    setExporting(kind);
    try {
      const { rows: all, truncated } = await fetchAllForExport(accountOwnerId, bounds.from, bounds.to);
      if (kind === 'csv') {
        download(exportFileName('csv', range), 'text/csv;charset=utf-8', buildCsv(all));
      } else {
        const bundle = await buildAuditBundle({ range: bounds, summary, versions, drift, rows: all });
        download(exportFileName('json', range), 'application/json', JSON.stringify(bundle, null, 2));
      }
      toast(truncated ? 'Exported the most recent part of this range (export limit reached). Narrow the range for the rest.' : 'Audit export ready.', truncated ? 'error' : 'success');
    } catch {
      toast("Couldn't build the export. Please try again.", 'error');
    } finally {
      setExporting(null);
    }
  };

  const changeLanguage = async (language: string) => {
    if (!accountOwnerId || !script) return;
    setSavingLang(true);
    try {
      await saveScriptLanguage(accountOwnerId, language);
      setScript({ ...script, language });
      toast('Script language saved.', 'success');
    } catch {
      toast("You don't have permission to change this, or it couldn't be saved.", 'error');
    } finally {
      setSavingLang(false);
    }
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="AI Disclosure Ledger">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            The disclosure ledger is compliance evidence. Ask your account owner for the "Edit Business Profile" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const rate = deliveryRate(summary);
  const attention = needsAttention(summary);
  const driftMeta = latest ? DRIFT_META[latest.status] : null;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = status !== 'all' || search.trim() !== '';
  const expected = script?.script ?? latest?.expected_text ?? '';

  return (
    <DashboardLayout activeLabel="AI Disclosure Ledger">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button" onClick={() => navigate('/dashboard/settings/assistant')} aria-label="Back to assistant settings"
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><ShieldCheck size={16} /></span>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">AI Disclosure Ledger</h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">Proof, call by call, that your assistant told every caller it is an AI.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="ledger-range" className="sr-only">Date range</label>
          <select
            id="ledger-range" value={range} onChange={(e) => { setRange(e.target.value as RangeKey); setPage(0); }}
            className="focus-ring min-h-[40px] rounded-xl border border-border bg-bg-secondary px-3 text-sm text-text-primary"
          >
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <Button type="button" variant="secondary" size="sm" disabled={exporting !== null} onClick={() => void doExport('csv')}>
            {exporting === 'csv' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export CSV
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={exporting !== null} onClick={() => void doExport('json')}>
            {exporting === 'json' ? <Loader2 size={15} className="animate-spin" /> : <FileJson size={15} />} Audit bundle
          </Button>
        </div>
      </div>

      {overviewState === 'loading' ? (
        <div aria-label="Loading disclosure ledger" className="space-y-4">
          <SkeletonCard rows={3} withIcon={false} />
          <SkeletonStatGrid count={4} />
        </div>
      ) : overviewState === 'error' ? (
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <p className="text-base font-semibold text-text-primary">Couldn't load the disclosure ledger</p>
          <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
          <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void loadOverview()}>Try again</Button>
        </div>
      ) : (
        <FadeIn>
          <section aria-labelledby="drift-heading" className="mb-4 rounded-2xl border border-border bg-bg-secondary p-5" data-testid="drift-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="drift-heading" className="text-lg font-semibold text-text-primary">Live assistant check</h2>
                <p className="mt-0.5 text-sm text-text-secondary">
                  {latest ? `${driftMeta?.help ?? ''} Last checked ${fmtDate(latest.checked_at)}.` : 'Not checked yet.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {driftMeta ? <Badge tone={driftMeta.tone}>{driftMeta.label}</Badge> : null}
                <Button type="button" variant="secondary" size="sm" disabled={checking} onClick={() => void checkNow(false)}>
                  {checking ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Check now
                </Button>
              </div>
            </div>
            {latest && latest.status !== 'in_sync' ? (
              <div role="alert" className="mt-4 rounded-xl border border-border bg-bg-primary p-4 text-sm">
                <p className="font-medium text-text-primary">{driftReasonText(latest.reason) || driftMeta?.help}</p>
                {latest.status === 'drift' || latest.status === 'no_first_message' ? (
                  <>
                    <p className="mt-3 text-xs font-medium text-text-secondary">Start your assistant's first message in Vapi with this exact sentence (or just <code className="rounded bg-bg-tertiary px-1">{'{{ai_disclosure}}'}</code>):</p>
                    <p className="mt-1 rounded-lg bg-bg-tertiary px-3 py-2 text-text-primary" dir="auto">{expected}</p>
                    <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => void copy(expected)}><Copy size={14} /> Copy sentence</Button>
                    {latest.live_first_message ? (
                      <>
                        <p className="mt-3 text-xs font-medium text-text-secondary">What your live assistant says today:</p>
                        <p className="mt-1 rounded-lg bg-bg-tertiary px-3 py-2 text-text-primary" dir="auto">{latest.live_first_message}</p>
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
            {script ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                <label htmlFor="script-language">Your disclosure sentence is written in</label>
                <select
                  id="script-language" value={script.language} disabled={savingLang} onChange={(e) => void changeLanguage(e.target.value)}
                  className="focus-ring min-h-[36px] rounded-lg border border-border bg-bg-primary px-2 text-sm text-text-primary"
                >
                  {LANGUAGE_OPTIONS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
                <span className="text-xs">Callers in other languages hear a built-in translation.</span>
              </div>
            ) : null}
          </section>

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Delivery rate" value={rate === null ? '—' : `${(rate * 100).toFixed(rate === 1 ? 0 : 1)}%`} hint={`${summary.total} calls tracked`} />
            <Tile label="Delivered" value={String(summary.delivered)} />
            <Tile label="Needs attention" value={String(attention)} hint="missing, partial or late" tone={attention > 0 ? 'bad' : undefined} />
            <Tile label="Couldn't verify" value={String(summary.no_transcript)} hint={summary.language_mismatch ? `${summary.language_mismatch} language mismatches` : 'no transcript returned'} />
          </div>

          <section aria-labelledby="calls-heading" className="rounded-2xl border border-border bg-bg-secondary p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 id="calls-heading" className="text-lg font-semibold text-text-primary">Calls</h2>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="ledger-status" className="sr-only">Filter by status</label>
                <select
                  id="ledger-status" value={status} onChange={(e) => { setStatus(e.target.value as LedgerStatus | 'all'); setPage(0); }}
                  className="focus-ring min-h-[40px] rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary"
                >
                  <option value="all">All statuses</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                </select>
                <label htmlFor="ledger-search" className="sr-only">Search by call ID</label>
                <input
                  id="ledger-search" type="search" value={search} placeholder="Search call ID" onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  className="focus-ring min-h-[40px] w-44 rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary placeholder:text-text-secondary/60"
                />
              </div>
            </div>

            {rowsState === 'loading' ? (
              <div aria-label="Loading calls"><SkeletonCard rows={4} withIcon={false} /></div>
            ) : rowsState === 'error' ? (
              <div role="alert" className="flex flex-col items-center py-10 text-center">
                <p className="text-base font-semibold text-text-primary">Couldn't load calls</p>
                <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadRows()}>Try again</Button>
              </div>
            ) : rows.length === 0 ? (
              filtered ? (
                <EmptyState
                  icon={ShieldCheck} title="No calls match these filters" description="Try another status or clear the search."
                  action={{ label: 'Clear filters', onClick: () => { setStatus('all'); setSearch(''); setPage(0); } }}
                />
              ) : (
                <EmptyState
                  icon={ShieldCheck} title="No calls verified yet"
                  description="After your assistant takes a call, the proof that it disclosed it is an AI appears here automatically."
                />
              )
            ) : (
              <>
                <ul className="space-y-2" aria-label="Disclosure proof per call">
                  {rows.map((r) => <RowItem key={r.id} row={r} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />)}
                </ul>
                <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
                  <span>Showing {page * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE + rows.length)} of {total}</span>
                  <span className="flex items-center gap-2">
                    <Button type="button" variant="secondary" size="sm" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></Button>
                    <span aria-live="polite">Page {page + 1} of {pageCount}</span>
                    <Button type="button" variant="secondary" size="sm" aria-label="Next page" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></Button>
                  </span>
                </div>
              </>
            )}
          </section>

          <details className="mt-4 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
            <summary className="cursor-pointer font-medium text-text-primary">Wording history ({versions.length})</summary>
            {versions.length === 0 ? (
              <p className="mt-2">No versions recorded yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {versions.map((v) => (
                  <li key={v.id} className="rounded-lg bg-bg-primary p-3">
                    <p className="text-xs">
                      v{v.version} · {languageLabel(v.language)} · {v.source === 'business_profile' ? 'Your script' : 'Built-in translation'} · {fmtDate(v.created_at)}
                      {v.is_current ? <span className="ml-2"><Badge tone="good">Current</Badge></span> : null}
                    </p>
                    <p className="mt-1 text-text-primary" dir="auto">{v.disclosure_text}</p>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
