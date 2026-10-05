/**
 * Verification Network - /dashboard/verification-network
 *
 * Managers see every technician; a technician sees only their own record.
 * Results are produced by the verification-network edge function (primary sources + rules engine)
 * and stored immutably. This page can only ASK for a check or record a documented manual result;
 * access control is enforced by the database (RLS + SECURITY DEFINER checks), not by this UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  BadgeCheck,
  FileCheck2,
  Landmark,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList } from '@/components/Skeleton';
import {
  KIND_LABELS,
  STATUS_META,
  TIER_LABELS,
  US_JURISDICTIONS,
  blockerText,
  fetchTechnicianChecks,
  fetchTechnicianSubjects,
  fetchVerificationProfiles,
  fetchVerificationSources,
  formatDate,
  hasBackgroundConsent,
  pickCheck,
  reasonText,
  recordBackgroundConsent,
  requestVerification,
  resolveVerification,
  type CredentialSubject,
  type PolicySubject,
  type VerificationCheck,
  type VerificationKind,
  type VerificationProfile,
  type VerificationSource,
} from '@/lib/verificationNetwork';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

function errMsg(e: unknown, fallback: string): string {
  if (
    e &&
    typeof e === 'object' &&
    'message' in e &&
    typeof (e as { message: unknown }).message === 'string'
  ) {
    return (e as { message: string }).message;
  }
  return fallback;
}

// ---------------------------------------------------------------- one verifiable subject
interface SubjectProps {
  technicianId: string;
  kind: VerificationKind;
  title: string;
  subtitle: string;
  credentialId?: string;
  policyId?: string;
  check: VerificationCheck | null;
  canManage: boolean;
  canRequest: boolean;
  onChanged: () => void;
}

function SubjectRow({
  technicianId,
  kind,
  title,
  subtitle,
  credentialId,
  policyId,
  check,
  canManage,
  canRequest,
  onChanged,
}: SubjectProps) {
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [jurisdiction, setJurisdiction] = useState('');
  const [outcome, setOutcome] = useState<'verified' | 'adverse'>('verified');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [expiresOn, setExpiresOn] = useState('');

  const meta = check ? STATUS_META[check.status] : null;
  const needsJurisdiction = kind === 'license' && check?.reason === 'jurisdiction_unknown';
  const canResolve =
    canManage &&
    check !== null &&
    check.status !== 'pending' &&
    check.status !== 'verified_primary';

  const run = async () => {
    if (needsJurisdiction && !jurisdiction)
      return toastRef.current('Choose the issuing state first', 'error');
    setBusy(true);
    try {
      const res = await requestVerification({
        technicianId,
        kind,
        credentialId,
        policyId,
        jurisdiction: jurisdiction || undefined,
      });
      toastRef.current(
        res.processing ? 'Verification is already running' : 'Verification complete',
        'success',
      );
      onChanged();
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not run verification'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const resolve = async () => {
    if (!check) return;
    if (note.trim().length < 5)
      return toastRef.current('Describe the evidence you checked (at least 5 characters)', 'error');
    setBusy(true);
    try {
      await resolveVerification({
        checkId: check.id,
        outcome,
        note: note.trim(),
        reference: reference.trim() || undefined,
        expiresOn: expiresOn || undefined,
      });
      toastRef.current('Manual result recorded', 'success');
      setManualOpen(false);
      setNote('');
      setReference('');
      setExpiresOn('');
      onChanged();
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not record the result'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-xl border border-border/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">
            <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">
              {KIND_LABELS[kind]}
            </span>
            {title}
          </p>
          <p className="text-xs text-text-secondary">{subtitle}</p>
        </div>
        <span
          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${meta?.className ?? 'bg-bg-tertiary text-text-secondary'}`}
        >
          {meta?.label ?? 'Not checked'}
        </span>
      </div>

      {check && (
        <p className="mt-2 text-xs text-text-secondary">
          {reasonText(check.reason)}
          {check.checked_at ? ` · checked ${formatDate(check.checked_at)}` : ''}
          {check.next_check_at ? ` · next ${formatDate(check.next_check_at)}` : ''}
          {check.disciplinary_flag ? ' · disciplinary action on record' : ''}
          {check.evidence_sha256 ? ` · seal ${check.evidence_sha256.slice(0, 10)}…` : ''}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {needsJurisdiction && (
          <select
            value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value)}
            className={`${selectClass} !w-auto`}
            aria-label="Issuing state"
          >
            <option value="">Issuing state…</option>
            {US_JURISDICTIONS.map((j) => (
              <option key={j} value={j}>
                {j.slice(3)}
              </option>
            ))}
          </select>
        )}
        {canRequest && kind !== 'background' && (
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || check?.status === 'pending'}
            className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
            {check ? 'Re-verify now' : 'Verify now'}
          </button>
        )}
        {canResolve && (
          <button
            type="button"
            onClick={() => setManualOpen((o) => !o)}
            className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            {manualOpen ? 'Cancel' : 'Record result manually'}
          </button>
        )}
      </div>

      {manualOpen && (
        <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as 'verified' | 'adverse')}
            className={selectClass}
            aria-label="Outcome"
          >
            <option value="verified">Verified / clear</option>
            <option value="adverse">Adverse finding</option>
          </select>
          <Input
            type="date"
            label="Evidence expiry date (optional)"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
          <Input
            label="Reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Report / portal URL / certificate no."
            maxLength={200}
            className="sm:col-span-2"
          />
          <Textarea
            label="Evidence checked (required)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did you check, and where?"
            maxLength={1000}
            rows={2}
            className="sm:col-span-2"
          />
          <button
            type="button"
            onClick={() => void resolve()}
            disabled={busy}
            className="focus-ring justify-self-start rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            Save result
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- technician detail
function TechnicianDetail({
  profile,
  canManage,
  isSelf,
  onChanged,
}: {
  profile: VerificationProfile;
  canManage: boolean;
  isSelf: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState<VerificationCheck[]>([]);
  const [creds, setCreds] = useState<CredentialSubject[]>([]);
  const [policies, setPolicies] = useState<PolicySubject[]>([]);
  const [consent, setConsent] = useState(false);

  const id = profile.technician_id;
  const reload = useCallback(async () => {
    try {
      const [c, s, k] = await Promise.all([
        fetchTechnicianChecks(id),
        fetchTechnicianSubjects(id),
        hasBackgroundConsent(id),
      ]);
      setChecks(c);
      setCreds(s.credentials);
      setPolicies(s.policies);
      setConsent(k);
    } catch {
      toastRef.current('Could not load verification details', 'error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  const changed = () => {
    void reload();
    onChanged();
  };

  const licenseCreds = useMemo(
    () =>
      creds.filter(
        (c) =>
          /licen[sc]e/i.test(c.credential_type) || checks.some((k) => k.credential_id === c.id),
      ),
    [creds, checks],
  );
  const otherCreds = creds.filter((c) => !licenseCreds.includes(c));
  const background = pickCheck(checks, { kind: 'background' });

  const giveConsent = async () => {
    try {
      await recordBackgroundConsent();
      toastRef.current('Consent recorded', 'success');
      changed();
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not record consent'), 'error');
    }
  };

  if (loading) return <SkeletonCardList count={2} rows={2} />;

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {licenseCreds.map((c) => (
          <SubjectRow
            key={c.id}
            technicianId={id}
            kind="license"
            credentialId={c.id}
            title={c.credential_name || c.credential_type}
            subtitle={`${c.issuing_authority ?? 'Issuer not set'} · expires ${formatDate(c.expires_at)}`}
            check={pickCheck(checks, { credentialId: c.id })}
            canManage={canManage}
            canRequest={canManage || isSelf}
            onChanged={changed}
          />
        ))}
        {policies.map((p) => (
          <SubjectRow
            key={p.id}
            technicianId={id}
            kind="insurance"
            policyId={p.id}
            title={`${p.policy_type.replace(/_/g, ' ')} · ${p.carrier}`}
            subtitle={`expires ${formatDate(p.expires_at)}`}
            check={pickCheck(checks, { policyId: p.id })}
            canManage={canManage}
            canRequest={canManage || isSelf}
            onChanged={changed}
          />
        ))}
        {licenseCreds.length === 0 && policies.length === 0 && (
          <li className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">
            No licence or insurance is on file. Add a licence under Compliance Center and a policy
            under Technician Identity Graph — Vireek verifies them automatically.
          </li>
        )}
      </ul>

      <div className="rounded-xl border border-border/60 p-3">
        <p className="text-sm font-medium text-text-primary">
          <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">
            {KIND_LABELS.background}
          </span>
          Background check
        </p>
        <p className="mt-1 text-xs text-text-secondary">
          {consent
            ? 'Technician consent recorded.'
            : 'Requires the technician’s own consent before any result can be recorded.'}
          {background ? ` ${reasonText(background.reason)}` : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {isSelf && !consent && (
            <button
              type="button"
              onClick={() => void giveConsent()}
              className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110"
            >
              I consent to a background check
            </button>
          )}
          {canManage && consent && !background && (
            <BackgroundStart technicianId={id} onChanged={changed} />
          )}
        </div>
        {background && (
          <ul className="mt-2">
            <SubjectRow
              technicianId={id}
              kind="background"
              title="Vendor result"
              subtitle="Recorded by a manager from your background-check vendor"
              check={background}
              canManage={canManage}
              canRequest={false}
              onChanged={changed}
            />
          </ul>
        )}
      </div>

      {otherCreds.length > 0 && (
        <p className="text-xs text-text-secondary">
          {otherCreds.length} other credential{otherCreds.length === 1 ? '' : 's'} (certifications,
          training) are tracked in the Compliance Center and are not part of state-board
          verification.
        </p>
      )}
    </div>
  );
}

function BackgroundStart({
  technicianId,
  onChanged,
}: {
  technicianId: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await requestVerification({ technicianId, kind: 'background' });
          onChanged();
        } catch (e) {
          toast(errMsg(e, 'Could not start the background check'), 'error');
        } finally {
          setBusy(false);
        }
      }}
      className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
    >
      Start background-check record
    </button>
  );
}

// ---------------------------------------------------------------- page
export function VerificationNetworkPage() {
  const navigate = useNavigate();
  const { isOwner, permissions, teamMember } = useAuth();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const canManage = isOwner || permissions.can_view_billing;

  const [profiles, setProfiles] = useState<VerificationProfile[]>([]);
  const [sources, setSources] = useState<VerificationSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([fetchVerificationProfiles(), fetchVerificationSources()]);
      setProfiles(p);
      setSources(s);
    } catch (e) {
      toastRef.current(errMsg(e, 'Could not load the verification network'), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => profiles.find((p) => p.technician_id === selectedId) ?? profiles[0] ?? null,
    [profiles, selectedId],
  );
  const counts = useMemo(
    () => ({
      verified: profiles.filter((p) => p.tier === 'verified').length,
      attention: profiles.filter((p) => p.tier === 'attention').length,
      open: profiles.filter((p) => p.tier === 'partially_verified' || p.tier === 'unverified')
        .length,
    }),
    [profiles],
  );
  const licenseStates = useMemo(
    () =>
      [
        ...new Set(sources.filter((s) => s.kind === 'license').map((s) => s.jurisdiction.slice(3))),
      ].sort(),
    [sources],
  );

  return (
    <DashboardLayout activeLabel="Verification Network">
      <div className="mb-8 flex items-center gap-3">
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
              <BadgeCheck size={16} />
            </span>
            <h1 className="text-2xl font-bold text-text-primary">Verification Network</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Licences are checked against the issuing board, insurance against policy rules, and
            every result is sealed and re-checked automatically.
          </p>
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={2} />
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title="No technicians to verify yet"
          description="Add technicians to your team, then add their licences and insurance. Vireek verifies them automatically."
        />
      ) : (
        <FadeIn>
          <div className="mb-6 grid gap-4 sm:grid-cols-4">
            <Card className="!p-5">
              <ShieldCheck size={16} className="text-success-500" />
              <p className="mt-2 text-2xl font-bold text-text-primary">{counts.verified}</p>
              <p className="text-xs text-text-secondary">Fully verified</p>
            </Card>
            <Card className="!p-5">
              <FileCheck2 size={16} className="text-warning-500" />
              <p className="mt-2 text-2xl font-bold text-text-primary">{counts.open}</p>
              <p className="text-xs text-text-secondary">Verification incomplete</p>
            </Card>
            <Card className="!p-5">
              <ShieldAlert size={16} className="text-danger" />
              <p className="mt-2 text-2xl font-bold text-text-primary">{counts.attention}</p>
              <p className="text-xs text-text-secondary">Need attention</p>
            </Card>
            <Card className="!p-5">
              <Landmark size={16} className="text-accent" />
              <p className="mt-2 text-2xl font-bold text-text-primary">{licenseStates.length}</p>
              <p className="text-xs text-text-secondary">
                States connected live{licenseStates.length ? ` (${licenseStates.join(', ')})` : ''}
              </p>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
            <ul className="space-y-2" aria-label="Technicians">
              {profiles.map((p) => {
                const tier = TIER_LABELS[p.tier];
                const active = selected?.technician_id === p.technician_id;
                return (
                  <li key={p.technician_id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.technician_id)}
                      aria-current={active}
                      className={`focus-ring w-full rounded-xl border p-3 text-left transition-colors ${active ? 'border-accent/50 bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/30'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-text-primary">
                          {p.technician_name ?? 'Technician'}
                        </span>
                        <span className="text-sm font-bold text-text-primary">
                          {p.verification_score}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${tier.className}`}
                        >
                          {tier.label}
                        </span>
                        {p.pending_count > 0 && (
                          <span className="text-[11px] text-accent">
                            {p.pending_count} checking…
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>

            {selected && (
              <Card className="!p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">
                      {selected.technician_name ?? 'Technician'}
                    </h2>
                    <p className="text-xs text-text-secondary">
                      Last verified {formatDate(selected.last_verified_at)}
                    </p>
                  </div>
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${TIER_LABELS[selected.tier].className}`}
                  >
                    {TIER_LABELS[selected.tier].label} · {selected.verification_score}/100
                  </span>
                </div>

                {selected.blockers.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Blockers">
                    {selected.blockers.map((b, i) => (
                      <li
                        key={`${b.code}-${i}`}
                        className="rounded-full bg-warning-500/10 px-2.5 py-1 text-xs text-warning-500"
                      >
                        {blockerText(b)}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-5">
                  <TechnicianDetail
                    key={selected.technician_id}
                    profile={selected}
                    canManage={canManage}
                    isSelf={teamMember?.id === selected.technician_id}
                    onChanged={() => void load()}
                  />
                </div>
              </Card>
            )}
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
