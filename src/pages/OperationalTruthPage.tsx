import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, BadgeCheck, Ban, Clock, GitMerge, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  PREDICATE_SUGGESTIONS,
  STATE_META,
  SUBJECT_TYPES,
  USER_SOURCES,
  VERDICT_META,
  assertClaim,
  confirmClaim,
  deleteTruthPolicy,
  describeExpiry,
  fetchTechnicianOptions,
  fetchTruthOverview,
  fetchTruthPolicies,
  formatClaimValue,
  formatConfidence,
  formatDate,
  prettyPredicate,
  rejectClaim,
  resolveTruthConflict,
  saveTruthPolicy,
} from '@/lib/operationalTruth';
import type { TruthClaimView, TruthItem, TruthOverview, TruthPolicyRow } from '@/lib/operationalTruth';

const sectionClass = 'mb-8 rounded-2xl border border-border bg-bg-secondary p-5';
const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className={`text-2xl font-bold ${tone ?? 'text-text-primary'}`}>{value}</p>
      <p className="mt-1 text-xs text-text-secondary">{label}</p>
    </div>
  );
}

interface ItemCardProps {
  item: TruthItem;
  nowIso: string;
  canManage: boolean;
  conflictId: string | null;
  busyId: string | null;
  onConfirm: (claim: TruthClaimView, expiresAt: string | null) => void;
  onReject: (claim: TruthClaimView) => void;
  onPick: (conflictId: string, claim: TruthClaimView) => void;
}

function ItemCard({ item, nowIso, canManage, conflictId, busyId, onConfirm, onReject, onPick }: ItemCardProps) {
  const meta = VERDICT_META[item.verdict];
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<'confirm' | 'reject' | null>(null);
  const [expiry, setExpiry] = useState('');

  const close = () => {
    setOpenId(null);
    setMode(null);
    setExpiry('');
  };

  return (
    <li className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{item.subject_label}</p>
          <p className="text-xs capitalize text-text-secondary">
            {item.subject_type} · {prettyPredicate(item.predicate)}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${meta.tone}`}>
          {meta.label}
          {item.confidence > 0 ? ` · ${formatConfidence(item.confidence)}` : ''}
        </span>
      </div>

      <p className="mt-2 text-sm text-text-secondary">{item.reason}</p>
      {item.required_action && <p className="mt-1 text-sm font-medium text-text-primary">Next step: {item.required_action}</p>}
      {item.warnings.map((w) => (
        <p key={w} className="mt-1 flex items-center gap-1.5 text-xs text-warning-500">
          <AlertTriangle size={12} aria-hidden="true" /> {w}
        </p>
      ))}

      <ul className="mt-3 space-y-2">
        {item.claims.map((c) => {
          const state = STATE_META[c.state];
          const busy = busyId === c.id;
          const isOpen = openId === c.id;
          return (
            <li key={c.id} className="rounded-lg border border-border/60 bg-bg-secondary px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-semibold text-text-primary">{c.source_label}</span>
                  {c.authoritative && <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">Authority</span>}
                  <span className="ml-2 text-text-secondary">says {formatClaimValue(c.value)}</span>
                </div>
                <span className={`font-semibold ${state.tone}`}>
                  {state.label} · {formatConfidence(c.effective_confidence)}
                </span>
              </div>
              <p className="mt-1 text-text-secondary">
                Verified {formatDate(c.verified_at)} · {describeExpiry(c.expires_at, nowIso)} · {c.evidence_count} evidence item{c.evidence_count === 1 ? '' : 's'}
              </p>

              {canManage && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {conflictId && item.verdict === 'conflict' && (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => onPick(conflictId, c)}>
                      <GitMerge size={14} aria-hidden="true" /> This one is correct
                    </Button>
                  )}
                  {!c.authoritative && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setOpenId(c.id); setMode('confirm'); }}>
                      <BadgeCheck size={14} aria-hidden="true" /> Re-verify
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setOpenId(c.id); setMode('reject'); }}>
                    <Ban size={14} aria-hidden="true" /> Reject
                  </Button>
                </div>
              )}

              {isOpen && mode === 'confirm' && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-[180px] flex-1">
                    <Input label="New expiry (optional)" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} helperText="Required if the current expiry has passed." />
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => { onConfirm(c, expiry ? new Date(`${expiry}T23:59:59`).toISOString() : null); close(); }}>
                    Confirm I verified this today
                  </Button>
                  <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
                </div>
              )}
              {isOpen && mode === 'reject' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="text-text-secondary">Reject this record? It will no longer count as evidence.</p>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => { onReject(c); close(); }}>Yes, reject</Button>
                  <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function OperationalTruthPage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const formId = useId();
  const canManage = isOwner || permissions.can_manage_team === true;

  const [data, setData] = useState<TruthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [techs, setTechs] = useState<Array<{ id: string; name: string }>>([]);
  const [policies, setPolicies] = useState<TruthPolicyRow[]>([]);

  // Record-a-claim form
  const [showForm, setShowForm] = useState(false);
  const [subjectType, setSubjectType] = useState('technician');
  const [subjectId, setSubjectId] = useState('');
  const [predicate, setPredicate] = useState('');
  const [claimValue, setClaimValue] = useState<'true' | 'false'>('true');
  const [sourceKey, setSourceKey] = useState('document_upload');
  const [expiresAt, setExpiresAt] = useState('');
  const [evidenceUri, setEvidenceUri] = useState('');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Policy form
  const [polPredicate, setPolPredicate] = useState('');
  const [polConfidence, setPolConfidence] = useState('80');
  const [polAge, setPolAge] = useState('90');
  const [polSources, setPolSources] = useState('1');
  const [polWarn, setPolWarn] = useState('14');

  const load = useCallback(async () => {
    try {
      const overview = await fetchTruthOverview();
      setData(overview);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the Truth Engine.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPolicies = useCallback(async () => {
    try {
      setPolicies(await fetchTruthPolicies());
    } catch {
      /* policies are optional; built-in defaults still apply */
    }
  }, []);

  useEffect(() => {
    load();
    loadPolicies();
    fetchTechnicianOptions().then(setTechs).catch(() => undefined);
  }, [load, loadPolicies]);

  const conflictFor = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.conflicts ?? []) m.set(`${c.subject_type}|${c.subject_id}|${c.predicate}`, c.id);
    return m;
  }, [data]);

  const run = async (id: string, fn: () => Promise<void>, success: string) => {
    setBusyId(id);
    try {
      await fn();
      toast(success, 'success');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const submitClaim = async (e: FormEvent) => {
    e.preventDefault();
    if (!subjectId.trim() || !predicate.trim()) {
      toast('Choose a subject and enter what you are verifying.', 'error');
      return;
    }
    const evidence: Array<{ kind: 'document' | 'note'; uri?: string; excerpt?: string }> = [];
    if (evidenceUri.trim()) evidence.push({ kind: 'document', uri: evidenceUri.trim() });
    if (evidenceNote.trim()) evidence.push({ kind: 'note', excerpt: evidenceNote.trim() });
    setSaving(true);
    try {
      await assertClaim({
        subject_type: subjectType,
        subject_id: subjectId.trim(),
        predicate: predicate.trim().toLowerCase(),
        value: claimValue === 'true',
        source_key: sourceKey,
        expires_at: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
        evidence,
      });
      toast('Claim recorded. Agents see the updated verdict immediately.', 'success');
      setSubjectId('');
      setPredicate('');
      setExpiresAt('');
      setEvidenceUri('');
      setEvidenceNote('');
      setShowForm(false);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record this claim.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const submitPolicy = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !polPredicate.trim()) return;
    try {
      await saveTruthPolicy(
        {
          predicate: polPredicate.trim().toLowerCase(),
          min_confidence: Math.min(99.9, Math.max(30, Number(polConfidence) || 80)) / 100,
          max_age_days: Math.min(3650, Math.max(1, Math.round(Number(polAge) || 90))),
          min_independent_sources: Math.min(5, Math.max(1, Math.round(Number(polSources) || 1))),
          expiring_warning_days: Math.min(365, Math.max(0, Math.round(Number(polWarn) || 0))),
        },
        user.id,
      );
      toast('Policy saved.', 'success');
      setPolPredicate('');
      await Promise.all([loadPolicies(), load()]);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this policy.', 'error');
    }
  };

  const s = data?.summary;

  return (
    <DashboardLayout activeLabel="Operational Truth">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <ShieldCheck size={24} aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Operational Truth Engine</h1>
            <p className="text-sm text-text-secondary">
              Every fact an AI agent acts on carries its source, evidence, freshness, confidence and conflict status. Agents cannot decide on stale or disputed data.
            </p>
          </div>
        </div>

        {loadError && (
          <p role="alert" className="mb-6 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{loadError}</p>
        )}

        {loading ? (
          <SkeletonCard rows={3} withIcon={false} />
        ) : data && s ? (
          <>
            <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <StatCard label="Facts verified" value={s.verified} tone="text-success-500" />
              <StatCard label="Need attention" value={s.needs_attention} tone={s.needs_attention > 0 ? 'text-warning-500' : undefined} />
              <StatCard label="Expiring soon" value={s.expiring_soon} />
              <StatCard label="Open conflicts" value={s.open_conflicts} tone={s.open_conflicts > 0 ? 'text-danger' : undefined} />
              <StatCard label="Agent actions blocked (7d)" value={s.blocked_7d} />
            </div>

            {/* ---------------- Attention ---------------- */}
            <section className={sectionClass} aria-labelledby={`${formId}-attn`}>
              <h2 id={`${formId}-attn`} className="mb-3 text-sm font-semibold text-text-primary">Needs attention</h2>
              {data.items.length === 0 ? (
                <EmptyState
                  icon={BadgeCheck}
                  title={s.facts_tracked === 0 ? 'No operational facts tracked yet' : 'Everything agents rely on is verified'}
                  description={
                    s.facts_tracked === 0
                      ? 'Technician credentials you add in Compliance appear here automatically. You can also record a fact below.'
                      : 'No stale, expiring, low-confidence or conflicting facts right now.'
                  }
                />
              ) : (
                <ul className="space-y-3">
                  {data.items.map((item) => (
                    <ItemCard
                      key={`${item.subject_type}|${item.subject_id}|${item.predicate}`}
                      item={item}
                      nowIso={data.now}
                      canManage={canManage}
                      conflictId={conflictFor.get(`${item.subject_type}|${item.subject_id}|${item.predicate}`) ?? null}
                      busyId={busyId}
                      onConfirm={(c, exp) => run(c.id, () => confirmClaim(c.id, exp), 'Re-verified.')}
                      onReject={(c) => run(c.id, () => rejectClaim(c.id), 'Record rejected.')}
                      onPick={(cid, c) => run(c.id, () => resolveTruthConflict(cid, c.id), 'Conflict resolved.')}
                    />
                  ))}
                </ul>
              )}
              {data.truncated && <p className="mt-3 text-xs text-text-secondary">Showing the most recent records; older ones are still enforced.</p>}
            </section>

            {/* ---------------- Record a claim ---------------- */}
            {canManage && (
              <section className={sectionClass} aria-labelledby={`${formId}-rec`}>
                <div className="flex items-center justify-between gap-3">
                  <h2 id={`${formId}-rec`} className="text-sm font-semibold text-text-primary">Record a verified fact</h2>
                  <Button size="sm" variant={showForm ? 'ghost' : 'secondary'} onClick={() => setShowForm((v) => !v)}>
                    <Plus size={14} aria-hidden="true" /> {showForm ? 'Close' : 'New fact'}
                  </Button>
                </div>
                {showForm && (
                  <form onSubmit={submitClaim} className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`${formId}-st`} className="mb-1.5 block text-sm font-medium text-text-primary">Subject type</label>
                      <select id={`${formId}-st`} className={selectClass} value={subjectType} onChange={(e) => { setSubjectType(e.target.value); setSubjectId(''); }}>
                        {SUBJECT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>
                    <div>
                      {subjectType === 'technician' && techs.length > 0 ? (
                        <>
                          <label htmlFor={`${formId}-sid`} className="mb-1.5 block text-sm font-medium text-text-primary">Technician</label>
                          <select id={`${formId}-sid`} className={selectClass} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                            <option value="">Select…</option>
                            {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </>
                      ) : (
                        <Input label="Subject ID" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="e.g. unit-4821" helperText="Letters, numbers, dashes and underscores." />
                      )}
                    </div>
                    <div className="sm:col-span-2">
                      <Input label="What is being verified?" value={predicate} onChange={(e) => setPredicate(e.target.value)} list={`${formId}-preds`} placeholder="credential.hvac_license" helperText="Dotted name. The first word sets the default policy (credential, insurance, pricing, equipment…)." />
                      <datalist id={`${formId}-preds`}>
                        {PREDICATE_SUGGESTIONS.map((p) => <option key={p} value={p} />)}
                      </datalist>
                    </div>
                    <div>
                      <label htmlFor={`${formId}-val`} className="mb-1.5 block text-sm font-medium text-text-primary">The fact is</label>
                      <select id={`${formId}-val`} className={selectClass} value={claimValue} onChange={(e) => setClaimValue(e.target.value as 'true' | 'false')}>
                        <option value="true">True (valid / qualified / active)</option>
                        <option value="false">False (not valid / not qualified)</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`${formId}-src`} className="mb-1.5 block text-sm font-medium text-text-primary">Source</label>
                      <select id={`${formId}-src`} className={selectClass} value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
                        {USER_SOURCES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <Input label="Expires on (optional)" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                    <Input label="Evidence link (optional)" value={evidenceUri} onChange={(e) => setEvidenceUri(e.target.value)} placeholder="https://… or storage path" helperText="Claims with evidence are trusted more than bare statements." />
                    <div className="sm:col-span-2">
                      <Input label="Evidence note (optional)" value={evidenceNote} onChange={(e) => setEvidenceNote(e.target.value)} placeholder="e.g. Checked license card on site, 2026-10-02" />
                    </div>
                    <div className="sm:col-span-2">
                      <Button type="submit" disabled={saving}>{saving ? 'Recording…' : 'Record fact'}</Button>
                      <p className="mt-2 text-xs text-text-secondary">Authority sources (State License DB, manufacturer portals, carriers) can only be written by verified integrations, never typed in.</p>
                    </div>
                  </form>
                )}
              </section>
            )}

            {/* ---------------- Blocked decisions ---------------- */}
            <section className={sectionClass} aria-labelledby={`${formId}-blk`}>
              <h2 id={`${formId}-blk`} className="mb-3 text-sm font-semibold text-text-primary">Recently blocked agent actions</h2>
              {data.recent_blocked.length === 0 ? (
                <p className="text-sm text-text-secondary">No agent has been blocked yet. When an agent asks the gate and the fact is not verified, it appears here with the reason.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.recent_blocked.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="text-text-primary">
                        <span className="font-semibold">{d.agent}</span> · {d.subject_label} · {prettyPredicate(d.predicate)}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-text-secondary">
                        <span className={`rounded-full px-2 py-0.5 font-semibold ${VERDICT_META[d.verdict].tone}`}>{VERDICT_META[d.verdict].label}</span>
                        <Clock size={12} aria-hidden="true" /> {formatDate(d.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ---------------- Policies ---------------- */}
            <section className={sectionClass} aria-labelledby={`${formId}-pol`}>
              <h2 id={`${formId}-pol`} className="mb-1 text-sm font-semibold text-text-primary">Freshness &amp; confidence policies</h2>
              <p className="mb-3 text-xs text-text-secondary">
                Defaults apply by family: credentials 90 days / 80%, insurance 30 days / 85%, pricing 30 days / 80%. Override a whole family (end with a dot, e.g. <code>credential.</code>) or one exact fact.
              </p>
              {policies.length > 0 && (
                <ul className="mb-4 divide-y divide-border">
                  {policies.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="font-mono text-xs text-text-primary">{p.predicate}</span>
                      <span className="flex items-center gap-3 text-xs text-text-secondary">
                        ≥{formatConfidence(p.min_confidence)} · {p.max_age_days}d · {p.min_independent_sources} source{p.min_independent_sources === 1 ? '' : 's'}
                        {isOwner && (
                          <button
                            type="button"
                            aria-label={`Delete policy ${p.predicate}`}
                            className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger"
                            onClick={async () => {
                              try {
                                await deleteTruthPolicy(p.id);
                                await Promise.all([loadPolicies(), load()]);
                              } catch (err) {
                                toast(err instanceof Error ? err.message : 'Could not delete this policy.', 'error');
                              }
                            }}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {isOwner ? (
                <form onSubmit={submitPolicy} className="grid gap-3 sm:grid-cols-5">
                  <div className="sm:col-span-2">
                    <Input label="Fact or family" value={polPredicate} onChange={(e) => setPolPredicate(e.target.value)} placeholder="credential." />
                  </div>
                  <Input label="Min confidence %" type="number" min={30} max={99.9} value={polConfidence} onChange={(e) => setPolConfidence(e.target.value)} />
                  <Input label="Max age (days)" type="number" min={1} max={3650} value={polAge} onChange={(e) => setPolAge(e.target.value)} />
                  <Input label="Independent sources" type="number" min={1} max={5} value={polSources} onChange={(e) => setPolSources(e.target.value)} />
                  <Input label="Warn before expiry (days)" type="number" min={0} max={365} value={polWarn} onChange={(e) => setPolWarn(e.target.value)} />
                  <div className="flex items-end">
                    <Button type="submit" variant="secondary">Save policy</Button>
                  </div>
                </form>
              ) : (
                <p className="text-xs text-text-secondary">Only the account owner can change policies.</p>
              )}
            </section>

            {/* ---------------- Source trust ---------------- */}
            <section className={sectionClass} aria-labelledby={`${formId}-src2`}>
              <h2 id={`${formId}-src2`} className="mb-3 text-sm font-semibold text-text-primary">How sources are trusted</h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.sources.map((src) => (
                  <li key={src.key} className="rounded-lg border border-border/60 bg-bg-primary px-3 py-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-text-primary">{src.label}</span>
                      <span className="text-text-secondary">{formatConfidence(src.reliability)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
                      <div className={`h-full ${src.authoritative ? 'bg-accent' : 'bg-success-500'}`} style={{ width: `${Math.round(src.reliability * 100)}%` }} />
                    </div>
                    <p className="mt-1 text-text-secondary">{src.authoritative ? 'Authority — cannot be out-voted' : src.user_assertable ? 'You can record claims from this source' : 'Written by Vireek systems only'}</p>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
