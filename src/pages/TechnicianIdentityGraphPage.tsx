/**
 * Technician Identity Graph (Passport 2.0) — /dashboard/technician-identity
 *
 * Managers see every technician; a technician sees only their own passport.
 * Access is enforced by the database (RLS + SECURITY DEFINER checks), not by this UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Copy,
  Fingerprint,
  FlaskConical,
  Globe2,
  Languages,
  Link2,
  MapPin,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import {
  CertificationList,
  ConfidenceList,
  IndexRing,
  InsuranceList,
  MetricTile,
  TierBadge,
} from '@/components/passport/PassportParts';
import { formatRate, rateColor } from '@/lib/trustPassport';
import {
  addInsurancePolicy,
  fetchIdentityPassports,
  formatCoverage,
  formatDate,
  INSURANCE_LABELS,
  INSURANCE_TYPES,
  issuePassportShare,
  listInsurancePolicies,
  listPassportShares,
  passportUrl,
  removeInsurancePolicy,
  revokePassportShare,
  setInsuranceVerified,
  shareState,
  skillLabel,
  TIER_META,
  type InsurancePolicyRow,
  type InsuranceType,
  type IssuedShare,
  type PassportShare,
  type TechnicianIdentityPassport,
} from '@/lib/technicianIdentity';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

function errMsg(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return fallback;
}

function SectionTitle({ icon: Icon, children }: { icon: typeof Fingerprint; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <Icon size={14} />
      </span>
      {children}
    </h3>
  );
}

// ---------------------------------------------------------------- Insurance manager
function InsuranceManager({
  technicianId,
  canManage,
  onChanged,
}: {
  technicianId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [rows, setRows] = useState<InsurancePolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState<InsuranceType>('general_liability');
  const [carrier, setCarrier] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [coverage, setCoverage] = useState('');
  const [expires, setExpires] = useState('');
  const [verified, setVerified] = useState(true);

  const reload = useCallback(async () => {
    try {
      setRows(await listInsurancePolicies(technicianId));
    } catch {
      toastRef.current('Could not load insurance policies', 'error');
    } finally {
      setLoading(false);
    }
  }, [technicianId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  const add = async () => {
    if (!carrier.trim()) return toastRef.current('Carrier is required', 'error');
    if (!expires) return toastRef.current('Expiry date is required', 'error');
    const dollars = coverage.trim() === '' ? null : Number(coverage);
    if (dollars !== null && (!Number.isFinite(dollars) || dollars < 0)) {
      return toastRef.current('Coverage must be a positive number', 'error');
    }
    setSaving(true);
    try {
      await addInsurancePolicy({
        technicianId,
        policyType: type,
        carrier,
        policyNumber: policyNumber || null,
        coverageCents: dollars === null ? null : Math.round(dollars * 100),
        expiresAt: expires,
        verified,
      });
      setCarrier('');
      setPolicyNumber('');
      setCoverage('');
      setExpires('');
      await reload();
      onChanged();
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not save policy'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleVerified = async (row: InsurancePolicyRow) => {
    try {
      await setInsuranceVerified(row.id, !row.verified_at);
      await reload();
      onChanged();
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not update policy'), 'error');
    }
  };

  const remove = async (row: InsurancePolicyRow) => {
    if (!window.confirm(`Remove ${INSURANCE_LABELS[row.policy_type]} policy from ${row.carrier}?`)) return;
    try {
      await removeInsurancePolicy(row.id);
      await reload();
      onChanged();
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not remove policy'), 'error');
    }
  };

  if (!canManage) return null;

  return (
    <div className="mt-4 border-t border-border/60 pt-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">Manage policies</p>
      {loading ? (
        <p className="mt-2 text-xs text-text-secondary">Loading…</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((r) => {
            const expired = new Date(r.expires_at).getTime() < Date.now() - 86_400_000;
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2">
                <div className="min-w-0 text-xs text-text-secondary">
                  <p className="text-sm font-medium text-text-primary">
                    {INSURANCE_LABELS[r.policy_type]} · {r.carrier}
                  </p>
                  {formatCoverage(r.coverage_amount_cents)} · {expired ? 'expired' : 'expires'} {formatDate(r.expires_at)}
                  {r.policy_number ? ` · …${r.policy_number.slice(-4)}` : ''}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void toggleVerified(r)}
                    className={`focus-ring rounded-lg px-2.5 py-1 text-xs font-medium ${
                      r.verified_at ? 'bg-success-500/10 text-success-500' : 'bg-warning-500/10 text-warning-500'
                    }`}
                  >
                    {r.verified_at ? 'Verified' : 'Mark verified'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(r)}
                    className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger"
                    aria-label="Remove policy"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
          {rows.length === 0 && <li className="text-xs text-text-secondary">No active policies yet.</li>}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <select value={type} onChange={(e) => setType(e.target.value as InsuranceType)} className={inputClass} aria-label="Policy type">
          {INSURANCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {INSURANCE_LABELS[t]}
            </option>
          ))}
        </select>
        <input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Carrier" maxLength={120} className={inputClass} aria-label="Carrier" />
        <input value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} placeholder="Policy number (private)" maxLength={60} className={inputClass} aria-label="Policy number" />
        <input value={coverage} onChange={(e) => setCoverage(e.target.value)} placeholder="Coverage (USD)" inputMode="decimal" className={inputClass} aria-label="Coverage amount" />
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className={inputClass} aria-label="Expiry date" />
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
          I reviewed the certificate of insurance
        </label>
      </div>
      <button
        type="button"
        onClick={() => void add()}
        disabled={saving}
        className="focus-ring mt-3 inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        <Plus size={14} /> {saving ? 'Saving…' : 'Add policy'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Share panel
function SharePanel({ technicianId, windowDays }: { technicianId: string; windowDays: number }) {
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [shares, setShares] = useState<PassportShare[]>([]);
  const [label, setLabel] = useState('');
  const [validDays, setValidDays] = useState(30);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedShare | null>(null);

  const reload = useCallback(async () => {
    try {
      setShares(await listPassportShares(technicianId));
    } catch {
      toastRef.current('Could not load passport links', 'error');
    }
  }, [technicianId]);

  useEffect(() => {
    setIssued(null);
    void reload();
  }, [reload]);

  const issue = async () => {
    setIssuing(true);
    try {
      const res = await issuePassportShare({ technicianId, label, validDays, windowDays });
      setIssued(res);
      setLabel('');
      await reload();
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not issue passport link'), 'error');
    } finally {
      setIssuing(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastRef.current('Link copied', 'success');
    } catch {
      toastRef.current('Copy failed — select the link and copy it manually', 'error');
    }
  };

  const revoke = async (s: PassportShare) => {
    if (!window.confirm('Revoke this link? Anyone holding it will immediately lose access.')) return;
    try {
      await revokePassportShare(s.id);
      await reload();
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not revoke link'), 'error');
    }
  };

  return (
    <div>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        Issues a sealed, read-only snapshot anyone can verify — without a Vireek account. It contains outcomes, skill
        confidence, credentials and verified insurance. It never contains customer data, pricing, margins or policy numbers.
        The snapshot is frozen at issue time and cannot be edited.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Label (e.g. “For Acme HVAC application”)" className={inputClass} aria-label="Link label" />
        <select value={validDays} onChange={(e) => setValidDays(Number(e.target.value))} className={inputClass} aria-label="Validity">
          <option value={7}>Valid 7 days</option>
          <option value={30}>Valid 30 days</option>
          <option value={90}>Valid 90 days</option>
          <option value={365}>Valid 1 year</option>
        </select>
        <button
          type="button"
          onClick={() => void issue()}
          disabled={issuing}
          className="focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          <Link2 size={14} /> {issuing ? 'Issuing…' : 'Issue link'}
        </button>
      </div>

      {issued && (
        <div className="mt-3 rounded-xl border border-success-500/30 bg-success-500/5 p-3">
          <p className="text-xs font-medium text-success-500">Link created — copy it now. For security it cannot be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <input readOnly value={passportUrl(issued.token)} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.currentTarget.select()} aria-label="Passport link" />
            <button type="button" onClick={() => void copy(passportUrl(issued.token))} className="focus-ring rounded-xl border border-border p-2 text-text-secondary hover:text-text-primary" aria-label="Copy link">
              <Copy size={14} />
            </button>
          </div>
          <p className="mt-1.5 break-all font-mono text-[10px] text-text-secondary">SHA-256 {issued.snapshot_hash}</p>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {shares.map((s) => {
          const state = shareState(s);
          return (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2">
              <div className="min-w-0 text-xs text-text-secondary">
                <p className="text-sm font-medium text-text-primary">{s.label || 'Untitled link'}</p>
                Issued {formatDate(s.issued_at)} by {s.issued_by_role} · {state === 'revoked' ? 'revoked' : `expires ${formatDate(s.expires_at)}`} · {s.view_count} {s.view_count === 1 ? 'view' : 'views'}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    state === 'active' ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'
                  }`}
                >
                  {state}
                </span>
                {state === 'active' && (
                  <button type="button" onClick={() => void revoke(s)} className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10">
                    Revoke
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {shares.length === 0 && <li className="text-xs text-text-secondary">No passport links issued yet.</li>}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Detail
function PassportDetail({
  p,
  windowDays,
  canManage,
  onChanged,
}: {
  p: TechnicianIdentityPassport;
  windowDays: number;
  canManage: boolean;
  onChanged: () => void;
}) {
  const d = p.payload;
  const m = d.metrics;
  const tier = TIER_META[d.tier];
  const provisional = m.jobs_completed < 10;

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          <IndexRing score={d.index} tier={d.tier} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-text-primary">{p.technician_name}</h2>
              <TierBadge tier={d.tier} />
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              {d.company_name ? `${d.company_name} · ` : ''}
              {m.jobs_completed} jobs in the last {d.window_days} days · {m.lifetime_jobs} lifetime
            </p>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              The index blends first-time fix, customer satisfaction, safety, response reliability, diagnosis accuracy, skill
              confidence, valid certifications and verified insurance. It is built from {Math.round(d.index_coverage)}% of the
              possible evidence
              {d.index === null ? ' — at least 3 completed jobs are needed before an index is shown.' : '.'}
            </p>
            {provisional && d.index !== null && (
              <p className="mt-1.5 text-xs font-medium text-warning-500">
                Provisional: fewer than 10 jobs in this window, so {tier.label} is a soft rating.
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <SectionTitle icon={Fingerprint}>Verified performance</SectionTitle>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          <MetricTile label="First-time fix" value={formatRate(m.first_time_fix_rate)} valueClass={rateColor(m.first_time_fix_rate, 90)} />
          <MetricTile
            label="Reservice rate"
            value={formatRate(m.callback_rate)}
            valueClass={m.callback_rate === null ? 'text-text-secondary' : m.callback_rate <= 5 ? 'text-success-500' : m.callback_rate <= 15 ? 'text-warning-500' : 'text-danger'}
          />
          <MetricTile
            label="Customer satisfaction"
            value={m.customer_rating_avg === null ? '—' : `${m.customer_rating_avg.toFixed(1)}/5`}
            hint={`${m.rated_jobs} rated ${m.rated_jobs === 1 ? 'job' : 'jobs'}`}
            valueClass={rateColor(m.customer_rating_avg === null ? null : m.customer_rating_avg * 20, 90)}
          />
          <MetricTile
            label="Diagnosis accuracy"
            value={formatRate(m.diagnosis_accuracy)}
            hint={`${m.diagnosed_jobs} diagnosed · held without callback`}
            valueClass={rateColor(m.diagnosis_accuracy, 90)}
          />
          <MetricTile
            label="Response reliability"
            value={formatRate(m.response_reliability)}
            hint={`${m.timed_jobs} timed arrivals · ±15 min`}
            valueClass={rateColor(m.response_reliability, 90)}
          />
          <MetricTile
            label="Safety record"
            value={formatRate(m.safety_compliance_rate)}
            hint={`${m.safety_required_jobs} jobs required evidence`}
            valueClass={rateColor(m.safety_compliance_rate, 95)}
          />
          <MetricTile label="Verified jobs" value={String(m.verified_jobs)} hint={`${m.lifetime_verified_jobs} lifetime`} />
          <MetricTile
            label="Open complaints"
            value={String(d.internal.unresolved_complaints)}
            valueClass={d.internal.unresolved_complaints > 0 ? 'text-danger' : 'text-success-500'}
            hint="Internal only — never shared"
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-6">
          <SectionTitle icon={ShieldCheck}>Skill confidence</SectionTitle>
          <p className="mb-4 mt-1 text-xs text-text-secondary">
            Recency-weighted results, discounted for small samples — high scores must be earned with volume.
          </p>
          <ConfidenceList items={d.skills} emptyText="No completed jobs with a service type yet." />
        </Card>
        <Card className="p-6">
          <SectionTitle icon={ShieldCheck}>Equipment expertise</SectionTitle>
          <p className="mb-4 mt-1 text-xs text-text-secondary">Same model, grouped by equipment make and type.</p>
          <ConfidenceList items={d.equipment_expertise} emptyText="No jobs linked to equipment with a known make yet." />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="p-6">
          <SectionTitle icon={ShieldCheck}>Certifications</SectionTitle>
          <div className="mt-4">
            <CertificationList items={d.certifications} />
          </div>
        </Card>
        <Card className="p-6">
          <SectionTitle icon={ShieldCheck}>Insurance</SectionTitle>
          <div className="mt-4">
            <InsuranceList items={d.insurance.filter((i) => i.valid && i.verified)} />
          </div>
          <InsuranceManager technicianId={p.technician_id} canManage={canManage} onChanged={onChanged} />
        </Card>
      </div>

      <Card className="p-6">
        <SectionTitle icon={FlaskConical}>Training &amp; profile</SectionTitle>
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">Training (not real jobs)</p>
            <p className="mt-1.5 text-sm text-text-primary">
              {d.training.lessons_completed} lessons completed
              {d.training.apprenticeship_target_level ? ` · targeting level ${d.training.apprenticeship_target_level}` : ''}
            </p>
            <p className="mt-0.5 text-sm text-text-primary">
              Simulator: {d.training.simulator_passed}/{d.training.simulator_attempts} passed
              {d.training.simulator_avg_score !== null ? ` · avg ${d.training.simulator_avg_score}` : ''}
            </p>
          </div>
          <div className="space-y-3">
            <div>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">
                <Languages size={12} /> Languages
              </p>
              <p className="mt-1 text-sm text-text-primary">{d.languages.length ? d.languages.join(', ') : '—'}</p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">
                <MapPin size={12} /> Regions
              </p>
              <p className="mt-1 text-sm text-text-primary">{d.regions.length ? d.regions.join(', ') : '—'}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">Declared skills (self-reported, unverified)</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {d.declared_skills.length === 0 && <span className="text-sm text-text-secondary">—</span>}
                {d.declared_skills.map((s) => (
                  <span key={s} className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary">
                    {skillLabel(s)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <SectionTitle icon={Globe2}>Portable passport</SectionTitle>
        <SharePanel technicianId={p.technician_id} windowDays={windowDays} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Page
export function TechnicianIdentityGraphPage() {
  const { isOwner, permissions } = useAuth();
  const navigate = useNavigate();
  const canManage = isOwner || permissions.can_view_billing;

  const [passports, setPassports] = useState<TechnicianIdentityPassport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(365);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPassports(await fetchIdentityPassports(windowDays));
    } catch (e) {
      setError(errMsg(e, 'Could not load technician passports'));
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => passports.find((p) => p.technician_id === selectedId) ?? passports[0] ?? null,
    [passports, selectedId],
  );

  return (
    <DashboardLayout activeLabel="Technician Identity Graph">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Fingerprint size={16} />
              </span>
              <h1 className="text-2xl font-bold text-text-primary">Technician Identity Graph</h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              Passport 2.0 — a portable, verifiable technician identity built from real job outcomes, with per-skill confidence.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
            aria-label="Time window"
          >
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 6 months</option>
            <option value={365}>Last 12 months</option>
            <option value={730}>Last 24 months</option>
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={4} />
      ) : error ? (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-6 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : passports.length === 0 || !selected ? (
        <EmptyState
          icon={Fingerprint}
          title="No passports available"
          description="Add a team member with the Technician role to start building identity passports from real job outcomes."
        />
      ) : (
        <FadeIn className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
          <nav aria-label="Technicians" className="space-y-2 lg:sticky lg:top-4 lg:self-start">
            {passports.map((p) => {
              const active = p.technician_id === selected.technician_id;
              return (
                <button
                  key={p.technician_id}
                  type="button"
                  onClick={() => setSelectedId(p.technician_id)}
                  aria-pressed={active}
                  className={`focus-ring w-full rounded-xl border p-3.5 text-left transition-colors ${
                    active ? 'border-accent/50 bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">{p.technician_name}</p>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {p.payload.metrics.jobs_completed} jobs · {p.payload.certifications.filter((c) => c.valid).length} certs
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-text-primary">{p.payload.index === null ? '—' : Math.round(p.payload.index)}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TIER_META[p.payload.tier].badgeClass}`}>
                        {TIER_META[p.payload.tier].label}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </nav>
          <PassportDetail key={selected.technician_id} p={selected} windowDays={windowDays} canManage={canManage} onChanged={() => void load()} />
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
