/**
 * Vireek Outcome Clearinghouse - /dashboard/outcome-clearinghouse[/:recordId]
 *
 * One verifiable outcome record per job: Evidence + Measurements + Customer + Durability + Payment
 * -> confidence -> verified outcome -> dispute window -> settlement legs -> reputation, with an
 * immutable hash-chained audit trail. All logic is server-side (see the migration); pure helpers and
 * RPC wrappers live in src/lib/outcomeClearinghouse.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, Scale, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  BAND_LABEL,
  DISPUTE_REASONS,
  FLAG_LABELS,
  OUTCOME_TYPES,
  SOURCE_LABEL,
  STATUS_META,
  TONE_CLASS,
  addMeasurement,
  assessNow,
  clearingErrorMessage,
  confidenceTone,
  executeLeg,
  fetchDetail,
  fetchOverview,
  fetchReputation,
  formatCents,
  formatRemaining,
  formatSpec,
  getShareLinks,
  openDispute,
  openRecord,
  resolveDispute,
  rotateTokens,
  saveSettings,
  setPublic,
  settleGate,
  settleRecord,
  shortHash,
  validateMeasurement,
  verifyLedger,
  verifyUrl,
  voidRecord,
  windowRemainingMs,
  type Assessment,
  type ChainProof,
  type ClearingDetail,
  type ClearingOverview,
  type ClearingStatus,
  type DisputeReason,
  type DisputeResolution,
  type MeasurementInput,
  type OutcomeType,
  type ReputationRow,
  type ShareLinks,
} from '@/lib/outcomeClearinghouse';

const inputCls = 'focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary';
const btnPrimary = 'focus-ring rounded-xl bg-cta px-3 py-2 text-xs font-medium text-white disabled:opacity-50';
const btnGhost = 'focus-ring rounded-xl bg-bg-tertiary px-3 py-2 text-xs font-medium text-text-secondary disabled:opacity-50';
const card = 'rounded-2xl border border-border bg-bg-secondary p-5';

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

function StatusBadge({ status }: { status: ClearingStatus }) {
  const m = STATUS_META[status];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[m.tone]}`}>{m.label}</span>;
}

function ConfidenceBar({ value }: { value: number }) {
  const tone = confidenceTone(value);
  const color = tone === 'good' ? 'bg-success-500' : tone === 'warn' ? 'bg-warning-500' : 'bg-danger';
  return (
    <div className="flex items-center gap-2" aria-label={`Confidence ${value} of 100`}>
      <div className="h-2 w-24 rounded-full bg-bg-tertiary"><div className={`h-2 rounded-full ${color}`} style={{ width: `${value}%` }} /></div>
      <span className="text-xs font-medium text-text-primary">{value}</span>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xl font-semibold text-text-primary">{value}</p>
      <p className="text-xs text-text-secondary">{label}</p>
      {hint && <p className="mt-1 text-[10px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function Spinner({ text = 'Loading…' }: { text?: string }) {
  return <div className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" /> {text}</div>;
}

// =============================================================================================
// OVERVIEW
// =============================================================================================
type Tab = 'outcomes' | 'reputation' | 'policy';

function OverviewView() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const jobParam = params.get('job');
  const [data, setData] = useState<ClearingOverview | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('outcomes');
  const [filter, setFilter] = useState<ClearingStatus | 'all'>('all');
  const [rep, setRep] = useState<ReputationRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<ClearingOverview['settings'] | null>(null);
  const [openType, setOpenType] = useState<OutcomeType>('repair_restored');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const o = await fetchOverview();
      setData(o);
      setDraft(o.settings);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (tab !== 'reputation' || rep) return;
    fetchReputation().then(setRep).catch(() => { toast('Could not load reputation.', 'error'); setRep([]); });
  }, [tab, rep, toast]);

  // Deep link from a job: /dashboard/outcome-clearinghouse?job=<id> jumps to its record when it exists.
  const existing = data && jobParam ? data.records.find((r) => r.job_id === jobParam) : undefined;
  useEffect(() => { if (existing) navigate(`/dashboard/outcome-clearinghouse/${existing.id}`, { replace: true }); }, [existing, navigate]);
  const pendingCandidate = data && jobParam && !existing ? data.candidates.find((c) => c.job_id === jobParam) : undefined;

  const handleOpen = async (jobId: string) => {
    setBusy(true);
    try {
      const id = await openRecord(jobId, openType);
      navigate(`/dashboard/outcome-clearinghouse/${id}`);
    } catch (e) {
      toast(clearingErrorMessage(e, 'Could not open the outcome record.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await saveSettings(draft);
      toast('Clearing policy saved.', 'success');
      await load();
    } catch (e) {
      toast(clearingErrorMessage(e, 'Could not save the policy.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error || !data) {
    return (
      <div className={`${card} text-sm text-text-secondary`}>
        The Clearinghouse could not be loaded. Check that the migration <code>20270415000000_outcome_clearinghouse.sql</code> is applied.
        <div className="mt-3"><button className={btnGhost} onClick={() => void load()}>Retry</button></div>
      </div>
    );
  }

  const t = data.totals;
  const rows = data.records.filter((r) => filter === 'all' || r.status === filter);
  const tabs: Array<[Tab, string]> = [['outcomes', 'Outcomes'], ['reputation', 'Reputation']];
  if (data.is_manager) tabs.push(['policy', 'Policy']);

  return (
    <div className={`space-y-6 ${loading ? 'opacity-60' : ''}`}>
      {pendingCandidate && (
        <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4 text-sm">
          <p className="font-medium text-text-primary">No outcome record yet for {pendingCandidate.customer_name ?? 'this job'}.</p>
          <p className="mt-1 text-xs text-text-secondary">Opening one starts the confidence assessment and the audit ledger.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <select className={inputCls} value={openType} onChange={(e) => setOpenType(e.target.value as OutcomeType)}>
              {OUTCOME_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button className={btnPrimary} disabled={busy} onClick={() => void handleOpen(pendingCandidate.job_id)}>Open outcome record</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Outcome records" value={String(t.records)} />
        <Stat label="Verified" value={String(t.verified)} hint="In dispute window or ready to settle" />
        <Stat label="Settled" value={String(t.settled)} />
        <Stat label="Disputed" value={String(t.disputed)} />
        <Stat label="Avg confidence" value={t.avg_confidence === null ? '—' : String(t.avg_confidence)} />
        {data.money ? <Stat label="Payments cleared" value={formatCents(data.money.cleared_cents)} hint={`Held ${formatCents(data.money.held_cents)}`} /> : <Stat label="Needs attention" value={String(t.unverified + t.partially_verified)} />}
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`focus-ring rounded-xl px-3 py-1.5 text-xs font-medium ${tab === k ? 'bg-cta text-white' : 'bg-bg-tertiary text-text-secondary'}`}>{label}</button>
        ))}
      </div>

      {tab === 'outcomes' && (
        <div className="space-y-6">
          <div className={card}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-text-primary">Outcome records</p>
              <select className={`${inputCls} ml-auto py-1.5 text-xs`} value={filter} onChange={(e) => setFilter(e.target.value as ClearingStatus | 'all')}>
                <option value="all">All statuses</option>
                {(Object.keys(STATUS_META) as ClearingStatus[]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </select>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-text-secondary">{data.records.length === 0 ? 'No outcome records yet. Open one from a completed job below.' : 'No records match this filter.'}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="text-text-secondary"><tr><th className="py-2 pr-3">Customer / service</th><th className="pr-3">Status</th><th className="pr-3">Confidence</th><th className="pr-3">Technician</th><th className="pr-3">Window</th><th /></tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const rem = windowRemainingMs({ dispute_window_ends_at: r.dispute_window_ends_at });
                      return (
                        <tr key={r.id} className="border-t border-border">
                          <td className="py-2 pr-3"><p className="font-medium text-text-primary">{r.customer_name ?? '—'}</p><p className="text-text-secondary">{r.service_type ?? r.claim_statement}</p></td>
                          <td className="pr-3"><StatusBadge status={r.status} />{r.open_dispute && <span className="ml-1 text-danger">●</span>}</td>
                          <td className="pr-3"><ConfidenceBar value={r.confidence} /></td>
                          <td className="pr-3 text-text-secondary">{r.technician_name ?? '—'}</td>
                          <td className="pr-3 text-text-secondary">{r.status === 'verified' && rem !== null ? formatRemaining(rem) : '—'}</td>
                          <td className="text-right"><Link className="text-cta hover:underline" to={`/dashboard/outcome-clearinghouse/${r.id}`}>Open</Link></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={card}>
            <p className="mb-1 text-sm font-semibold text-text-primary">Completed jobs without an outcome record</p>
            <p className="mb-3 text-xs text-text-secondary">Opening a record runs the assessment against the job's evidence chain, guarantee and payments.</p>
            {data.candidates.length === 0 ? <p className="text-sm text-text-secondary">Every completed job already has a record.</p> : (
              <>
                <div className="mb-3"><select className={`${inputCls} py-1.5 text-xs`} value={openType} onChange={(e) => setOpenType(e.target.value as OutcomeType)}>{OUTCOME_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
                <ul className="divide-y divide-border">
                  {data.candidates.map((c) => (
                    <li key={c.job_id} className="flex items-center gap-3 py-2 text-xs">
                      <div className="min-w-0 flex-1"><p className="truncate font-medium text-text-primary">{c.customer_name ?? 'Customer'} · {c.service_type ?? 'Service'}</p><p className="truncate text-text-secondary">{c.address ?? ''}{c.technician_name ? ` · ${c.technician_name}` : ''}</p></div>
                      <button className={btnPrimary} disabled={busy} onClick={() => void handleOpen(c.job_id)}><Plus size={12} className="mr-1 inline" />Open</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'reputation' && (
        <div className={card}>
          <p className="mb-1 text-sm font-semibold text-text-primary">Outcome reputation</p>
          <p className="mb-4 text-xs text-text-secondary">Confidence-weighted and shrunk toward a neutral prior until a technician has 5 decided outcomes; upheld disputes subtract. Provisional scores are marked.</p>
          {!rep ? <Spinner /> : rep.length === 0 ? <p className="text-sm text-text-secondary">No decided outcomes yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead className="text-text-secondary"><tr><th className="py-2 pr-3">Technician</th><th className="pr-3">Score</th><th className="pr-3">Outcomes</th><th className="pr-3">Verified rate</th><th className="pr-3">Avg confidence</th><th>Disputes (upheld)</th></tr></thead>
                <tbody>
                  {rep.map((r) => (
                    <tr key={r.team_member_id ?? 'none'} className="border-t border-border">
                      <td className="py-2 pr-3 font-medium text-text-primary">{r.name}</td>
                      <td className="pr-3"><span className="font-semibold text-text-primary">{r.score}</span>{r.provisional && <span className="ml-1 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">provisional</span>}</td>
                      <td className="pr-3">{r.outcomes}</td>
                      <td className="pr-3">{Math.round(r.verified_rate * 100)}%</td>
                      <td className="pr-3">{r.avg_confidence}</td>
                      <td>{r.disputes} ({r.disputes_upheld})</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'policy' && data.is_manager && draft && (
        <div className={`${card} space-y-4`}>
          <p className="text-sm font-semibold text-text-primary">Clearing policy</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-text-secondary">Minimum confidence to verify (50-100)
              <input type="number" min={50} max={100} className={inputCls} value={draft.min_release_confidence} onChange={(e) => setDraft({ ...draft, min_release_confidence: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-secondary">Dispute window in days (0-90)
              <input type="number" min={0} max={90} className={inputCls} value={draft.dispute_window_days} onChange={(e) => setDraft({ ...draft, dispute_window_days: Number(e.target.value) })} />
            </label>
          </div>
          <label className="flex items-start gap-2 text-xs text-text-secondary"><input type="checkbox" checked={draft.auto_open} onChange={(e) => setDraft({ ...draft, auto_open: e.target.checked })} className="mt-0.5" />Automatically open an outcome record when a job is completed (checked every 15 minutes).</label>
          <label className="flex items-start gap-2 text-xs text-text-secondary"><input type="checkbox" checked={draft.auto_settle} onChange={(e) => setDraft({ ...draft, auto_settle: e.target.checked })} className="mt-0.5" />Automatically clear settlement legs once an outcome is verified and its dispute window has passed. Off by default: a manager clears each outcome.</label>
          <button className={btnPrimary} disabled={busy} onClick={() => void handleSaveSettings()}>Save policy</button>
        </div>
      )}
    </div>
  );
}

// =============================================================================================
// DETAIL
// =============================================================================================
const emptyMeasurement: MeasurementInput = { metricKey: '', label: '', unit: '', phase: 'after', value: '', expectedMin: '', expectedMax: '', source: 'technician', deviceRef: '' };

function DetailView({ id }: { id: string }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [d, setD] = useState<ClearingDetail | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<ChainProof | null>(null);
  const [links, setLinks] = useState<ShareLinks | null>(null);
  const [m, setM] = useState<MeasurementInput>(emptyMeasurement);
  const [dReason, setDReason] = useState<DisputeReason>('not_fixed');
  const [dText, setDText] = useState('');
  const [resNote, setResNote] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [legRef, setLegRef] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const x = await fetchDetail(id);
      setD(x);
      setChain(x.chain);
      setError(false);
    } catch {
      setError(true);
    }
  }, [id]);

  useEffect(() => { setD(null); setLinks(null); void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      after?.();
      await load();
    } catch (e) {
      toast(clearingErrorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className={`${card} text-sm text-text-secondary`}>This outcome record could not be loaded. <Link className="text-cta hover:underline" to="/dashboard/outcome-clearinghouse">Back to the Clearinghouse</Link></div>;
  if (!d) return <Spinner />;

  const rec = d.record;
  const a = rec.assessment as Partial<Assessment>;
  const open = d.disputes.find((x) => x.status === 'open');
  const closed = rec.status === 'settled' || rec.status === 'voided';
  const gate = settleGate(rec);
  const mv = validateMeasurement(m);
  const specPreview = mv.ok && mv.value !== undefined ? (mv.min === null && mv.max === null ? null : (mv.min === null || mv.value >= (mv.min ?? 0)) && (mv.max === null || mv.value <= (mv.max ?? 0))) : null;

  const submitMeasurement = () => {
    const v = validateMeasurement(m);
    if (!v.ok || v.value === undefined || !v.key) { toast(v.error ?? 'Check the reading.', 'error'); return; }
    void run(() => addMeasurement(id, { value: v.value as number, key: v.key as string, min: v.min ?? null, max: v.max ?? null, input: m }), 'Reading recorded and outcome re-assessed.', () => setM({ ...emptyMeasurement, phase: m.phase }));
  };

  const showLinks = async () => {
    try { setLinks(await getShareLinks(id)); } catch (e) { toast(clearingErrorMessage(e), 'error'); }
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('Link copied.', 'success'); } catch { toast('Could not copy - select and copy the link manually.', 'error'); }
  };

  return (
    <div className="space-y-6">
      <button className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary" onClick={() => navigate('/dashboard/outcome-clearinghouse')}><ArrowLeft size={14} /> All outcomes</button>

      {/* Header */}
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={rec.status} />
          <span className="text-xs text-text-secondary">{BAND_LABEL[rec.confidence_band]}</span>
          {rec.customer_confirmed_at && <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-xs text-success-500">Customer confirmed</span>}
          {rec.public_enabled && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">Shared</span>}
        </div>
        <p className="text-base font-semibold text-text-primary">{rec.claim_statement}</p>
        <p className="text-xs text-text-secondary">{d.job.customer_name ?? 'Customer'} · {d.job.service_type ?? 'Service'}{d.job.address ? ` · ${d.job.address}` : ''}{d.job.technician_name ? ` · ${d.job.technician_name}` : ''}</p>
        <div className="flex items-end gap-6">
          <div><p className="text-4xl font-semibold text-text-primary">{rec.confidence}<span className="text-base text-text-secondary"> / 100</span></p><p className="text-xs text-text-secondary">Verification threshold {a.threshold ?? '—'}</p></div>
          {rec.status === 'verified' && rec.dispute_window_ends_at && <p className="text-xs text-text-secondary">Dispute window: {formatRemaining(windowRemainingMs(rec) ?? 0)}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className={btnGhost} to={`/dashboard/evidence-chain`}>Open evidence chain</Link>
          {!closed && <button className={btnGhost} disabled={busy} onClick={() => void run(() => assessNow(id), 'Outcome re-assessed.')}>Re-assess now</button>}
        </div>
      </div>

      {/* Assessment */}
      <div className={card}>
        <p className="mb-3 text-sm font-semibold text-text-primary">How this confidence was computed</p>
        {!a.components ? <p className="text-sm text-text-secondary">Not assessed yet.</p> : (
          <div className="space-y-3">
            {a.components.map((c) => (
              <div key={c.key}>
                <div className="flex items-center justify-between text-xs"><span className="font-medium text-text-primary">{c.label}</span><span className="text-text-secondary">{c.points} / {c.weight}</span></div>
                <div className="mt-1 h-1.5 rounded-full bg-bg-tertiary"><div className="h-1.5 rounded-full bg-cta" style={{ width: `${Math.round(c.score * 100)}%` }} /></div>
                <p className="mt-1 text-[11px] text-text-secondary">{c.detail}</p>
              </div>
            ))}
            {a.hard_checks && (
              <div className="grid grid-cols-2 gap-2 pt-2 text-xs sm:grid-cols-3">
                {([['job_completed', 'Job completed'], ['chain_intact', 'Evidence chain intact'], ['result_proof', 'Result proven'], ['no_adverse_signal', 'No adverse signal'], ['no_open_dispute', 'No open dispute'], ['meets_threshold', 'Meets threshold']] as const).map(([k, label]) => (
                  <span key={k} className={`rounded-lg px-2 py-1 ${a.hard_checks?.[k] ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}>{a.hard_checks?.[k] ? '✓' : '✗'} {label}</span>
                ))}
              </div>
            )}
            {a.flags && a.flags.length > 0 && <ul className="list-disc pl-5 text-xs text-text-secondary">{a.flags.map((f) => <li key={f}>{FLAG_LABELS[f] ?? f}</li>)}</ul>}
            {a.provenance && <p className="text-[11px] text-text-secondary">Provenance: evidence head {shortHash(a.provenance.evidence_head_hash)} · {a.provenance.evidence_entries} evidence entries · {a.provenance.measurements} readings</p>}
          </div>
        )}
      </div>

      {/* Measurements */}
      <div className={card}>
        <p className="mb-3 text-sm font-semibold text-text-primary">Measurements</p>
        {d.measurements.length === 0 ? <p className="mb-3 text-sm text-text-secondary">No readings yet. Record a before and an after reading with an expected range to prove the result.</p> : (
          <div className="mb-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="text-text-secondary"><tr><th className="py-2 pr-3">Metric</th><th className="pr-3">Phase</th><th className="pr-3">Value</th><th className="pr-3">Expected</th><th className="pr-3">Source</th><th>Result</th></tr></thead>
              <tbody>{d.measurements.map((x) => (
                <tr key={x.id} className="border-t border-border">
                  <td className="py-2 pr-3 text-text-primary">{x.label}</td><td className="pr-3 capitalize">{x.phase}</td><td className="pr-3">{x.value}{x.unit ? ` ${x.unit}` : ''}</td><td className="pr-3">{formatSpec(x)}</td>
                  <td className="pr-3">{SOURCE_LABEL[x.source]}{x.device_ref ? ` (${x.device_ref})` : ''}</td>
                  <td>{x.within_spec === null ? '—' : x.within_spec ? <span className="text-success-500">In spec</span> : <span className="text-danger">Out of spec</span>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
        {!closed && (
          <div className="grid gap-2 sm:grid-cols-6">
            <input className={`${inputCls} sm:col-span-2`} placeholder="Label (e.g. Supply air temp)" value={m.label} onChange={(e) => setM({ ...m, label: e.target.value })} />
            <select className={inputCls} value={m.phase} onChange={(e) => setM({ ...m, phase: e.target.value as MeasurementInput['phase'] })}><option value="before">Before</option><option value="after">After</option><option value="monitor">Monitor</option></select>
            <input className={inputCls} placeholder="Value" inputMode="decimal" value={m.value} onChange={(e) => setM({ ...m, value: e.target.value })} />
            <input className={inputCls} placeholder="Unit" value={m.unit} onChange={(e) => setM({ ...m, unit: e.target.value })} />
            <select className={inputCls} value={m.source} onChange={(e) => setM({ ...m, source: e.target.value as 'technician' | 'device' })}><option value="technician">Technician</option><option value="device">Instrument</option></select>
            <input className={inputCls} placeholder="Expected min" inputMode="decimal" value={m.expectedMin} onChange={(e) => setM({ ...m, expectedMin: e.target.value })} />
            <input className={inputCls} placeholder="Expected max" inputMode="decimal" value={m.expectedMax} onChange={(e) => setM({ ...m, expectedMax: e.target.value })} />
            {m.source === 'device' && <input className={`${inputCls} sm:col-span-2`} placeholder="Instrument model / serial" value={m.deviceRef} onChange={(e) => setM({ ...m, deviceRef: e.target.value })} />}
            <div className="flex items-center gap-3 sm:col-span-6">
              <button className={btnPrimary} disabled={busy} onClick={submitMeasurement}>Record reading</button>
              {specPreview !== null && <span className={`text-xs ${specPreview ? 'text-success-500' : 'text-danger'}`}>{specPreview ? 'Within expected range' : 'Outside expected range - this will block verification'}</span>}
            </div>
            <p className="text-[11px] text-text-secondary sm:col-span-6">Readings are permanent. To correct one, record a new reading - the latest "after" reading per metric decides.</p>
          </div>
        )}
      </div>

      {/* Disputes */}
      <div className={card}>
        <p className="mb-3 text-sm font-semibold text-text-primary">Disputes</p>
        {d.disputes.length === 0 && <p className="mb-3 text-sm text-text-secondary">No disputes.</p>}
        <ul className="mb-3 space-y-2">
          {d.disputes.map((x) => (
            <li key={x.id} className="rounded-xl bg-bg-tertiary p-3 text-xs">
              <p className="font-medium text-text-primary">{DISPUTE_REASONS.find((r) => r.value === x.reason_code)?.label} · {x.opened_by_type} · {x.status.replace('_', ' ')}</p>
              <p className="mt-1 text-text-secondary">{x.description}</p>
              {x.resolution_note && <p className="mt-1 text-text-secondary">Resolution: {x.resolution_note}</p>}
              <p className="mt-1 text-[10px] text-text-secondary">Opened {fmtDate(x.opened_at)}{x.resolved_at ? ` · resolved ${fmtDate(x.resolved_at)}` : ''}</p>
            </li>
          ))}
        </ul>
        {open && d.is_manager && (
          <div className="space-y-2">
            <textarea className={`${inputCls} w-full`} rows={2} placeholder="Resolution note (at least 10 characters)" value={resNote} onChange={(e) => setResNote(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              {([['upheld', 'Uphold (outcome failed)'], ['rejected', 'Reject (outcome stands)'], ['withdrawn', 'Withdrawn']] as Array<[DisputeResolution, string]>).map(([k, label]) => (
                <button key={k} className={k === 'upheld' ? btnPrimary : btnGhost} disabled={busy} onClick={() => void run(() => resolveDispute(open.id, k, resNote), 'Dispute resolved.', () => setResNote(''))}>{label}</button>
              ))}
            </div>
          </div>
        )}
        {open && !d.is_manager && <p className="text-xs text-text-secondary">A manager must resolve the open dispute.</p>}
        {!open && rec.status !== 'voided' && (
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">Record a dispute reported by the customer or an insurer. Opening one immediately holds every un-executed settlement leg.</p>
            <select className={inputCls} value={dReason} onChange={(e) => setDReason(e.target.value as DisputeReason)}>{DISPUTE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
            <textarea className={`${inputCls} w-full`} rows={2} placeholder="What was reported? (5-2000 characters)" value={dText} onChange={(e) => setDText(e.target.value)} />
            <button className={btnGhost} disabled={busy || dText.trim().length < 5} onClick={() => void run(() => openDispute(id, dReason, dText), 'Dispute recorded - settlement legs held.', () => setDText(''))}><ShieldAlert size={12} className="mr-1 inline" />Open dispute</button>
          </div>
        )}
      </div>

      {/* Settlement (managers) */}
      {d.is_manager && (
        <div className={card}>
          <p className="mb-1 text-sm font-semibold text-text-primary">Settlement</p>
          <p className="mb-3 text-xs text-text-secondary">The Clearinghouse clears legs and records the decision; it does not move money. After clearing, execute each leg in the system that owns it and enter the reference.</p>
          {d.settlements.length > 0 && (
            <ul className="mb-4 space-y-2">
              {d.settlements.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-bg-tertiary p-3 text-xs">
                  <span className="font-medium capitalize text-text-primary">{l.kind}</span>
                  <span className="text-text-secondary">{formatCents(l.amount_cents)}</span>
                  <span className={`rounded-full px-2 py-0.5 ${l.status === 'cleared' ? TONE_CLASS.good : l.status === 'held' ? TONE_CLASS.bad : l.status === 'executed' ? TONE_CLASS.info : TONE_CLASS.neutral}`}>{l.status}</span>
                  {l.hold_reason && <span className="text-text-secondary">{l.hold_reason}</span>}
                  {l.executed_ref && <span className="text-text-secondary">Ref: {l.executed_ref}</span>}
                  {l.status === 'cleared' && rec.status === 'settled' && (
                    <span className="ml-auto flex gap-2">
                      <input className={`${inputCls} py-1 text-xs`} placeholder="Reference (invoice / claim no.)" value={legRef[l.id] ?? ''} onChange={(e) => setLegRef({ ...legRef, [l.id]: e.target.value })} />
                      <button className={btnPrimary} disabled={busy} onClick={() => void run(() => executeLeg(l.id, legRef[l.id] ?? ''), 'Leg marked executed.')}>Mark executed</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {rec.status === 'settled' ? (
            <p className="text-xs text-text-secondary">Settled {fmtDate(rec.settled_at)}{rec.settle_override_note ? ` with manager override: ${rec.settle_override_note}` : ''}.</p>
          ) : rec.status !== 'voided' && (
            <div className="space-y-2">
              {gate.reason && <p className="text-xs text-text-secondary">{gate.reason}</p>}
              {gate.needsOverride && <textarea className={`${inputCls} w-full`} rows={2} placeholder="Override reason (at least 10 characters) - recorded permanently" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} />}
              <button className={btnPrimary} disabled={busy || (!gate.allowed && !(gate.needsOverride && overrideNote.trim().length >= 10))} onClick={() => void run(() => settleRecord(id, gate.allowed ? undefined : overrideNote), 'Settlement legs cleared.', () => setOverrideNote(''))}>{gate.allowed ? 'Clear settlement' : 'Clear with override'}</button>
            </div>
          )}
          {rec.status !== 'voided' && rec.status !== 'settled' && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
              <input className={`${inputCls} flex-1`} placeholder="Reason to void this outcome (at least 10 characters)" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
              <button className={btnGhost} disabled={busy || voidReason.trim().length < 10} onClick={() => void run(() => voidRecord(id, voidReason), 'Outcome voided.', () => setVoidReason(''))}>Void outcome</button>
            </div>
          )}
        </div>
      )}

      {/* Sharing (managers) */}
      {d.is_manager && rec.status !== 'voided' && (
        <div className={card}>
          <p className="mb-1 text-sm font-semibold text-text-primary">Verification links</p>
          <p className="mb-3 text-xs text-text-secondary">Anyone with a link sees the outcome, readings and proof - never names, addresses or amounts. The verifier link is read-only (insurers, buyers); the customer link also lets the customer confirm or dispute.</p>
          <div className="flex flex-wrap gap-2">
            <button className={btnGhost} disabled={busy} onClick={() => void run(() => setPublic(id, !rec.public_enabled), rec.public_enabled ? 'Sharing turned off.' : 'Sharing turned on.')}>{rec.public_enabled ? 'Turn sharing off' : 'Turn sharing on'}</button>
            <button className={btnGhost} onClick={() => void showLinks()}>Show links</button>
            {links && <button className={btnGhost} disabled={busy} onClick={() => void run(async () => setLinks(await rotateTokens(id)), 'Links replaced - old links no longer work.')}>Rotate links</button>}
          </div>
          {links && (
            <div className="mt-3 space-y-2 text-xs">
              {([['Verifier link', links.verify_token], ['Customer link', links.customer_token]] as const).map(([label, tok]) => (
                <div key={label} className="flex items-center gap-2"><span className="w-24 text-text-secondary">{label}</span><input readOnly className={`${inputCls} flex-1 py-1 text-xs`} value={verifyUrl(window.location.origin, tok)} onFocus={(e) => e.currentTarget.select()} /><button className={btnGhost} onClick={() => void copy(verifyUrl(window.location.origin, tok))}>Copy</button></div>
              ))}
              {!links.public_enabled && <p className="text-warning-500">Sharing is off - these links show "not available" until you turn it on.</p>}
            </div>
          )}
        </div>
      )}

      {/* Ledger */}
      <div className={card}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-text-primary">Audit ledger</p>
          <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${chain?.valid ? TONE_CLASS.good : TONE_CLASS.bad}`}>{chain?.valid ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}{chain?.valid ? `Intact · ${chain.entries} entries` : `Broken at #${chain?.broken_seq ?? '?'}`}</span>
          <button className={`${btnGhost} ml-auto`} disabled={busy} onClick={async () => { try { setChain(await verifyLedger(id)); toast('Ledger re-verified from the database.', 'success'); } catch (e) { toast(clearingErrorMessage(e), 'error'); } }}>Re-verify</button>
        </div>
        <p className="mb-3 text-xs text-text-secondary">Append-only and SHA-256 hash-chained. Free text is stored only as a hash. Head: {shortHash(chain?.head_hash, 16)}</p>
        <ol className="space-y-1.5">
          {[...d.events].reverse().map((ev) => (
            <li key={ev.id} className="grid grid-cols-[28px_1fr_auto] items-start gap-2 text-xs">
              <span className="text-text-secondary">#{ev.seq}</span>
              <span><span className="font-medium text-text-primary">{ev.event_type.replace(/_/g, ' ')}</span> <span className="text-text-secondary">· {ev.actor_name ?? ev.actor_type}{typeof ev.payload.confidence === 'number' ? ` · confidence ${ev.payload.confidence}` : ''}{typeof ev.payload.status === 'string' ? ` · ${ev.payload.status}` : ''}</span></span>
              <span className="text-right text-[10px] text-text-secondary">{fmtDate(ev.recorded_at)}<br />{shortHash(ev.entry_hash, 8)}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function OutcomeClearinghousePage() {
  const { recordId } = useParams();
  return (
    <DashboardLayout activeLabel="Outcome Clearinghouse">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <Scale className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Outcome Clearinghouse</p>
        </div>
        <p className="-mt-4 text-sm text-text-secondary">
          Evidence → measurements → confidence → verified outcome → dispute window → settlement → reputation, with an immutable audit trail.
        </p>
        {recordId ? <DetailView id={recordId} /> : <OverviewView />}
      </div>
    </DashboardLayout>
  );
}
