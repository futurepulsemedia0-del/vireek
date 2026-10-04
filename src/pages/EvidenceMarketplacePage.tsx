/**
 * Evidence Marketplace — /dashboard/evidence-marketplace
 *
 * Vireek turns validated, anonymized job evidence into industry intelligence for
 * the ecosystem (OEMs, parts suppliers, insurers, contractors, training
 * providers): "this failure pattern was observed in 14,000 jobs". Never a
 * person, a customer or a business. Opt-in, owner-controlled, revocable.
 * See src/lib/evidenceMarketplace.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lock, Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  GRADE_META,
  NEVER_SHARED,
  PARTNER_TYPE_LABELS,
  SAFEGUARDS,
  SHARED_FIELDS,
  fetchConsent,
  fetchContribution,
  fetchEcosystem,
  fetchPatterns,
  fetchProducts,
  filterPatterns,
  formatCount,
  formatPct,
  humanizeKey,
  observedHeadline,
  patternTitle,
  setEvidenceSharing,
  type ConsentRow,
  type Contribution,
  type EcosystemRow,
  type Grade,
  type PatternRow,
  type PatternScope,
  type ProductRow,
  type ReleaseRow,
} from '@/lib/evidenceMarketplace';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

// ============================================================
// CONSENT PANEL
// ============================================================

function ConsentPanel({ consent, contribution, isOwner, onSaved }: { consent: ConsentRow | null; contribution: Contribution; isOwner: boolean; onSaved: () => void }) {
  const { toast } = useToast();
  const enabled = consent?.enabled ?? false;
  const [parts, setParts] = useState(consent?.share_part_usage ?? false);
  const [equip, setEquip] = useState(consent?.share_equipment_signals ?? false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setParts(consent?.share_part_usage ?? false);
    setEquip(consent?.share_equipment_signals ?? false);
  }, [consent]);

  const save = async (next: boolean) => {
    setBusy(true);
    try {
      await setEvidenceSharing({ enabled: next, sharePartUsage: parts, shareEquipmentSignals: equip, consentVersion: contribution.consent_version });
      toast(next ? (enabled ? 'Sharing preferences updated' : 'You are now contributing to industry intelligence') : 'Sharing turned off. You are excluded from all future releases.');
      setAgree(false);
      onSaved();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  const dirty = enabled && (parts !== (consent?.share_part_usage ?? false) || equip !== (consent?.share_equipment_signals ?? false));
  const check = 'focus-ring mt-0.5 h-4 w-4 shrink-0 rounded border-border';

  return (
    <div className="mb-5 rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Lock size={15} /> Your contribution
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {enabled
              ? `You are contributing anonymized job evidence${consent?.consented_at ? ` since ${new Date(consent.consented_at).toLocaleDateString()}` : ''}.`
              : 'Off by default. Nothing leaves your account until the account owner opts in.'}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${enabled ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>{enabled ? 'Contributing' : 'Not contributing'}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-bg-primary p-3">
          <p className="mb-1 text-xs font-semibold text-text-primary">What is shared (as anonymous patterns)</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-text-secondary">
            {SHARED_FIELDS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl bg-bg-primary p-3">
          <p className="mb-1 text-xs font-semibold text-text-primary">What never leaves your account</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-text-secondary">
            {NEVER_SHARED.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <label className="flex items-start gap-2 text-xs text-text-secondary">
          <input type="checkbox" className={check} checked={parts} disabled={!isOwner || busy} onChange={(e) => setParts(e.target.checked)} />
          <span>
            <span className="font-medium text-text-primary">Include part usage.</span> Part names are released only if at least 5 businesses used the same part.
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs text-text-secondary">
          <input type="checkbox" className={check} checked={equip} disabled={!isOwner || busy} onChange={(e) => setEquip(e.target.checked)} />
          <span>
            <span className="font-medium text-text-primary">Include equipment signals.</span> Manufacturer (from the OEM catalog) and age band only, never serial numbers.
          </span>
        </label>
      </div>

      {isOwner ? (
        <div className="mt-4 space-y-3">
          {!enabled && (
            <label className="flex items-start gap-2 text-xs text-text-secondary">
              <input type="checkbox" className={check} checked={agree} disabled={busy} onChange={(e) => setAgree(e.target.checked)} />
              <span>I am authorized to share anonymized job statistics for my business. I understand that opting out stops all future releases, but statistics already released inside aggregates cannot be taken back out.</span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {!enabled ? (
              <Button size="sm" onClick={() => void save(true)} disabled={!agree || busy}>
                Opt in and contribute
              </Button>
            ) : (
              <>
                {dirty && (
                  <Button size="sm" onClick={() => void save(true)} disabled={busy}>
                    Save preferences
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => void save(false)} disabled={busy}>
                  Stop contributing
                </Button>
              </>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-text-secondary">Only the account owner can change sharing.</p>
      )}
    </div>
  );
}

// ============================================================
// PATTERN CARD
// ============================================================

function PatternCard({ p }: { p: PatternRow }) {
  const grade = GRADE_META[p.grade];
  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{patternTitle(p)}</p>
          <p className="mt-0.5 text-xs font-medium text-accent">{observedHeadline(p)}</p>
        </div>
        <span title={grade.description} className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${grade.className}`}>
          {grade.label}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Fixed first visit', formatPct(p.ftf_rate)],
          ['Callback rate', formatPct(p.callback_rate)],
          ['Typical duration', p.median_minutes === null ? '—' : `${p.median_minutes} min`],
          ['Evidence-backed', `${p.evidence_backed_pct}%`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-bg-primary px-3 py-2">
            <p className="text-[11px] text-text-secondary">{label}</p>
            <p className="text-sm font-semibold text-text-primary">{value}</p>
          </div>
        ))}
      </div>
      {p.top_parts.length > 0 && (
        <p className="mt-3 text-[11px] text-text-secondary">
          Parts most used:{' '}
          {p.top_parts.map((t, i) => (
            <span key={t.part}>
              {i > 0 && ', '}
              <span className="text-text-primary">{humanizeKey(t.part)}</span> ({formatPct(t.share)})
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

// ============================================================
// PAGE
// ============================================================

export function EvidenceMarketplacePage() {
  const { isOwner } = useAuth();
  const [consent, setConsent] = useState<ConsentRow | null>(null);
  const [contribution, setContribution] = useState<Contribution | null>(null);
  const [ecosystem, setEcosystem] = useState<EcosystemRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [release, setRelease] = useState<ReleaseRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [grade, setGrade] = useState<Grade | 'all'>('all');
  const [scope, setScope] = useState<PatternScope>('cause');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [c, contrib, prods] = await Promise.all([fetchConsent(), fetchContribution(), fetchProducts()]);
      const [eco, pats] = c?.enabled ? await Promise.all([fetchEcosystem(), fetchPatterns()]) : [[] as EcosystemRow[], { patterns: [] as PatternRow[], release: null as ReleaseRow | null }];
      if (!mounted.current) return;
      setConsent(c);
      setContribution(contrib);
      setProducts(prods);
      setEcosystem(eco);
      setPatterns(pats.patterns);
      setRelease(pats.release);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
    if (mounted.current) setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => filterPatterns(patterns, { query, grade, scope }), [patterns, query, grade, scope]);
  const enabled = consent?.enabled ?? false;
  const hasEquipment = patterns.some((p) => p.scope === 'equipment');

  return (
    <DashboardLayout activeLabel="Evidence Marketplace">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Network size={18} /> Evidence Marketplace
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Anonymized, validated industry intelligence for OEMs, parts suppliers, insurers, contractors and training providers. Not personal data. Patterns like "observed in 14,000 jobs", and you get the same intelligence back when you contribute.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => { setLoading(true); void load(); }} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : failed || !contribution ? (
          <EmptyState
            icon={Network}
            title="Evidence Marketplace unavailable"
            description="Sharing status could not be loaded. Check your connection and try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Eligible jobs (12 mo)" value={formatCount(contribution.eligible_outcomes)} hint="completed, not rework, root cause recorded" />
              <StatCard label="Patterns you contribute to" value={enabled ? formatCount(contribution.patterns_contributed_to) : '—'} />
              <StatCard label="Partner requests (30d)" value={enabled ? formatCount(contribution.partner_requests_30d) : '—'} hint="network-wide, aggregate" />
              <StatCard label="Latest release" value={release ? new Date(release.created_at).toLocaleDateString() : '—'} hint={release ? `${formatCount(release.pattern_count)} patterns` : 'none yet'} />
            </div>

            <ConsentPanel consent={consent} contribution={contribution} isOwner={isOwner} onSaved={() => void load()} />

            <div className="mb-5 grid gap-2 sm:grid-cols-3">
              {SAFEGUARDS.map((s) => (
                <div key={s.title} className="rounded-2xl border border-border bg-bg-secondary p-3">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                    <ShieldCheck size={13} className="text-success-500" /> {s.title}
                  </p>
                  <p className="text-[11px] text-text-secondary">{s.body}</p>
                </div>
              ))}
            </div>

            <div className="mb-5 rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="mb-2 text-sm font-semibold text-text-primary">What the ecosystem receives</p>
              <ul className="space-y-2">
                {products.map((p) => (
                  <li key={p.slug} className="rounded-xl bg-bg-primary p-3">
                    <p className="text-xs font-semibold text-text-primary">{p.name}</p>
                    <p className="mt-0.5 text-[11px] text-text-secondary">{p.description}</p>
                    <p className="mt-1 text-[11px] text-text-secondary">For: {p.partner_types.map((t) => PARTNER_TYPE_LABELS[t]).join(', ')}</p>
                  </li>
                ))}
              </ul>
              {enabled && ecosystem.length > 0 && (
                <p className="mt-3 text-[11px] text-text-secondary">
                  Active partners right now: {ecosystem.map((e) => `${e.active_partners} ${PARTNER_TYPE_LABELS[e.partner_type].toLowerCase()}${e.active_partners === 1 ? '' : 's'}`).join(' · ')}. Partner names are never shown.
                </p>
              )}
            </div>

            {!enabled ? (
              <EmptyState icon={Lock} title="Contribute to unlock the network" description="Opted-in businesses can explore every industry failure pattern: first-visit-fix rates, typical durations and the parts used. Opt in above to see them." />
            ) : patterns.length === 0 ? (
              <EmptyState
                icon={Network}
                title="No patterns released yet"
                description="A pattern appears only when at least 5 businesses and 30 jobs contribute and no single business dominates. Releases run weekly. Keep recording job outcomes with a root cause."
              />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search trade, job type, cause or make"
                    aria-label="Search patterns"
                    className="focus-ring min-w-[200px] flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  />
                  <div className="flex gap-1.5" role="tablist" aria-label="Pattern view">
                    {(['cause', 'equipment'] as PatternScope[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="tab"
                        aria-selected={scope === s}
                        disabled={s === 'equipment' && !hasEquipment}
                        onClick={() => setScope(s)}
                        className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${scope === s ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                      >
                        {s === 'cause' ? 'By cause' : 'By equipment'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by grade">
                  {(['all', 'A', 'B', 'C'] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      aria-pressed={grade === g}
                      onClick={() => setGrade(g)}
                      className={`focus-ring rounded-full px-3 py-1 text-xs font-medium ${grade === g ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                    >
                      {g === 'all' ? 'All grades' : GRADE_META[g].label}
                    </button>
                  ))}
                </div>
                <ul className="space-y-3">
                  {visible.map((p) => (
                    <PatternCard key={p.id} p={p} />
                  ))}
                </ul>
                {visible.length === 0 && <p className="py-6 text-center text-sm text-text-secondary">No patterns match this view.</p>}
                {release && (
                  <p className="mt-4 break-all text-[11px] text-text-secondary">
                    Release {release.period_start} to {release.period_end} · integrity hash {release.content_hash.slice(0, 16)}…
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
