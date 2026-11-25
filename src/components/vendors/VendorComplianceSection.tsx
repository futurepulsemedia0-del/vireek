/**
 * Subcontractor compliance — insurance certificates (COI) and licence verification.
 * Rendered inside the vendor's Compliance tab. Everything is manager-only: the data layer
 * (RLS + RPCs) enforces it, this component only explains it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Check, ExternalLink, FileText, Pencil, Plus, Settings2, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ModalShell } from '@/components/vendors/VendorForms';
import { Pill } from '@/components/vendors/VendorBadges';
import {
  COI_BLOCK_MESSAGE,
  COI_STATE_LABELS,
  COVERAGE_LABELS,
  COVERAGE_OPTIONS,
  LICENSE_STATUS_LABELS,
  LICENSE_STATUS_OPTIONS,
  US_STATE_CODES,
  complianceErrorMessage,
  daysLeft,
  deleteCoverage,
  expiryState,
  fetchComplianceSettings,
  fetchLicenseChecks,
  fetchVendorCoiStatus,
  fetchVendorCoverages,
  parseMoneyToCents,
  recordLicenseCheck,
  saveComplianceSettings,
  saveVendorCoverage,
  setCoiRequirement,
  setCoverageStatus,
  signedCoiUrl,
  uploadCoiFile,
  type CoiState,
  type ComplianceSettings,
  type CoverageInput,
  type CoverageType,
  type ExpiryState,
  type LicenseInput,
  type LicenseStatus,
  type VendorCoverage,
  type VendorLicenseCheck,
} from '@/lib/vendorCompliance';

const panelCls = 'rounded-2xl border border-border bg-bg-secondary p-4';
const rowCls = 'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3';
const grid2 = 'grid gap-3 sm:grid-cols-2';

const COI_STATE_CLS: Record<CoiState, string> = {
  ok: 'bg-success-subtle text-success',
  pending: 'bg-warning-subtle text-warning',
  expired: 'bg-danger/10 text-danger',
  missing: 'bg-danger/10 text-danger',
  below_minimum: 'bg-danger/10 text-danger',
};
const EXPIRY_CLS: Record<ExpiryState, string> = {
  expired: 'bg-danger/10 text-danger',
  expiring: 'bg-warning-subtle text-warning',
  valid: 'bg-success-subtle text-success',
  none: 'bg-bg-tertiary text-text-secondary',
};
const EXPIRY_LABEL = (s: ExpiryState, d: number | null) =>
  s === 'expired' ? 'Expired' : s === 'expiring' ? (d === 0 ? 'Expires today' : `Expires in ${d} day${d === 1 ? '' : 's'}`) : s === 'valid' ? 'Valid' : 'No expiry';
const LICENSE_CLS: Record<LicenseStatus, string> = {
  active: 'bg-success-subtle text-success',
  inactive: 'bg-warning-subtle text-warning',
  expired: 'bg-danger/10 text-danger',
  suspended: 'bg-danger/10 text-danger',
  revoked: 'bg-danger/10 text-danger',
  unknown: 'bg-bg-tertiary text-text-secondary',
};

function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return '—';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(undefined, {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric',
  });
}

function money(cents: number | null): string {
  return cents == null ? '—' : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/** Small loader: ignores stale responses, exposes reload and the error message. */
function useLoad<T>(load: () => Promise<T>, key: string) {
  const ref = useRef(load);
  ref.current = load;
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    ref.current().then(
      (data) => alive && setState({ data, loading: false, error: null }),
      (e: unknown) => alive && setState({ data: null, loading: false, error: e instanceof Error ? e.message : 'error' }),
    );
    return () => {
      alive = false;
    };
  }, [key, nonce]);
  return { ...state, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

function Block({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={panelCls}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Skel() {
  return (
    <div className="space-y-2" aria-busy="true">
      <Skeleton className="h-14 w-full rounded-xl" />
      <Skeleton className="h-14 w-full rounded-xl" />
    </div>
  );
}

function LoadProblem({ message, onRetry }: { message: string; onRetry: () => void }) {
  const forbidden = /FORBIDDEN/.test(message);
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
      <span>{forbidden ? 'Only an owner, admin or billing manager can view insurance and licence records.' : 'Could not load this section.'}</span>
      {!forbidden && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function useSave(onDone: () => void, ok: string, fallback: string) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await fn();
      toast(ok, 'success');
      onDone();
    } catch (e) {
      setError(e instanceof Error && !/^[A-Z_]+(:|$)/.test(e.message) && e.message.length < 140 && !/violates|constraint|PGRST/.test(e.message)
        ? e.message
        : complianceErrorMessage(e, fallback));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, run };
}

function Footer({ saving, error, onClose, label }: { saving: boolean; error: string | null; onClose: () => void; label: string }) {
  return (
    <div className="space-y-3 pt-1">
      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : label}
        </Button>
      </div>
    </div>
  );
}

// ============================================================ main

export function VendorComplianceSection({ vendorId, onChanged }: { vendorId: string; onChanged?: () => void }) {
  const status = useLoad(() => fetchVendorCoiStatus(vendorId), `status:${vendorId}`);
  const covs = useLoad(() => fetchVendorCoverages(vendorId), `cov:${vendorId}`);
  const lic = useLoad(() => fetchLicenseChecks(vendorId), `lic:${vendorId}`);
  const [coverageModal, setCoverageModal] = useState<{ row: VendorCoverage | null; type?: CoverageType } | null>(null);
  const [licenseModal, setLicenseModal] = useState<VendorLicenseCheck | null | 'new'>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [exemptOpen, setExemptOpen] = useState(false);
  const [deleting, setDeleting] = useState<VendorCoverage | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const { toast } = useToast();
  const now = new Date();

  const refreshAll = () => {
    status.reload();
    covs.reload();
    lic.reload();
    onChanged?.();
  };

  const act = async (fn: () => Promise<void>, ok: string, fallback: string) => {
    try {
      await fn();
      toast(ok, 'success');
      refreshAll();
    } catch (e) {
      toast(complianceErrorMessage(e, fallback), 'error');
    }
  };

  const openFile = async (path: string) => {
    try {
      window.open(await signedCoiUrl(path), '_blank', 'noopener,noreferrer');
    } catch {
      toast('Could not open the file', 'error');
    }
  };

  const st = status.data;
  const rows = covs.data ?? [];

  return (
    <div className="space-y-4">
      <Block
        title="Insurance certificate (COI)"
        action={
          <span className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRulesOpen(true)}>
              <Settings2 size={14} /> Rules
            </Button>
            <Button size="sm" onClick={() => setCoverageModal({ row: null })}>
              <Plus size={14} /> Add coverage
            </Button>
          </span>
        }
      >
        {status.loading && !st ? (
          <Skel />
        ) : status.error ? (
          <LoadProblem message={status.error} onRetry={status.reload} />
        ) : st ? (
          <div className="space-y-3">
            {st.blocked && (
              <p role="status" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>Blocked from new assignments. {COI_BLOCK_MESSAGE}</span>
              </p>
            )}
            {st.enforcement === 'off' && (
              <p className="text-xs text-text-secondary">Assignment blocking is off for this account. Expiry alerts still run.</p>
            )}
            {st.exempt ? (
              <div className={rowCls}>
                <span className="text-sm text-text-primary">
                  <Pill className="bg-bg-tertiary text-text-secondary">Exempt</Pill> {st.exempt_reason}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void act(() => setCoiRequirement(vendorId, false, null), 'Exemption removed', 'Could not remove the exemption')}>
                  Remove exemption
                </Button>
              </div>
            ) : (
              <ul className="space-y-2">
                {st.coverages.length === 0 && <li className="text-sm text-text-secondary">No coverage is required for this account (see Rules).</li>}
                {st.coverages.map((c) => (
                  <li key={c.coverage_type} className={rowCls}>
                    <span className="text-sm font-medium text-text-primary">
                      {COVERAGE_LABELS[c.coverage_type]} <Pill className={COI_STATE_CLS[c.state]}>{COI_STATE_LABELS[c.state]}</Pill>
                      {c.expires_on && <span className="ms-2 text-xs font-normal text-text-secondary">to {formatDay(c.expires_on)}</span>}
                    </span>
                    {(c.state === 'missing' || c.state === 'expired') && (
                      <Button variant="secondary" size="sm" onClick={() => setCoverageModal({ row: null, type: c.coverage_type })}>
                        <Plus size={14} /> Add
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!st.exempt && (
              <Button variant="ghost" size="sm" onClick={() => setExemptOpen(true)}>
                Mark this vendor exempt…
              </Button>
            )}
          </div>
        ) : null}

        <h4 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-text-secondary">Coverage on file</h4>
        {covs.loading && !covs.data ? (
          <Skel />
        ) : covs.error ? (
          <LoadProblem message={covs.error} onRetry={covs.reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No coverage on file"
            description="Upload the certificate, key in the policy details, then verify them."
            action={{ label: 'Add coverage', onClick: () => setCoverageModal({ row: null }) }}
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => {
              const es = expiryState(r.expires_on, now);
              return (
                <li key={r.id} className={rowCls}>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-text-primary">
                      {COVERAGE_LABELS[r.coverage_type]} <Pill className={EXPIRY_CLS[es]}>{EXPIRY_LABEL(es, daysLeft(r.expires_on, now))}</Pill>
                      {r.status === 'verified' && <Pill className="ms-1 bg-success-subtle text-success">Verified</Pill>}
                      {r.status === 'pending' && <Pill className="ms-1 bg-warning-subtle text-warning">Unverified</Pill>}
                      {r.status === 'rejected' && <Pill className="ms-1 bg-danger/10 text-danger">Rejected</Pill>}
                    </span>
                    <span className="block text-xs text-text-secondary">
                      {[r.carrier, r.policy_number, `Expires ${formatDay(r.expires_on)}`, r.each_occurrence_cents != null ? `${money(r.each_occurrence_cents)} per occurrence` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1">
                    {r.file_path && (
                      <Button variant="ghost" size="sm" aria-label="Open certificate file" onClick={() => void openFile(r.file_path!)}>
                        <FileText size={14} />
                      </Button>
                    )}
                    {r.status !== 'verified' && (
                      <Button variant="ghost" size="sm" aria-label="Verify coverage" onClick={() => void act(() => setCoverageStatus(r.id, 'verified'), 'Coverage verified', 'Could not verify the coverage')}>
                        <Check size={14} />
                      </Button>
                    )}
                    {r.status !== 'rejected' && (
                      <Button variant="ghost" size="sm" aria-label="Reject coverage" onClick={() => void act(() => setCoverageStatus(r.id, 'rejected'), 'Coverage rejected', 'Could not reject the coverage')}>
                        <X size={14} />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" aria-label="Edit coverage" onClick={() => setCoverageModal({ row: r })}>
                      <Pencil size={14} />
                    </Button>
                    <Button variant="ghost" size="sm" aria-label="Delete coverage" onClick={() => setDeleting(r)}>
                      <Trash2 size={14} />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Block>

      <Block
        title="Contractor licence"
        action={
          <Button size="sm" onClick={() => setLicenseModal('new')}>
            <Plus size={14} /> Record check
          </Button>
        }
      >
        {lic.loading && !lic.data ? (
          <Skel />
        ) : lic.error ? (
          <LoadProblem message={lic.error} onRetry={lic.reload} />
        ) : (lic.data?.current.length ?? 0) === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No licence check recorded"
            description="Look the licence up on the state board, then record the result with the link as evidence."
            action={{ label: 'Record check', onClick: () => setLicenseModal('new') }}
          />
        ) : (
          <>
            <ul className="space-y-2">
              {lic.data!.current.map((c) => {
                const es = expiryState(c.expires_on, now);
                return (
                  <li key={c.id} className={rowCls}>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-text-primary">
                        {c.license_number} · {c.jurisdiction.slice(3)} <Pill className={LICENSE_CLS[c.effective_status]}>{LICENSE_STATUS_LABELS[c.effective_status]}</Pill>
                        {c.expires_on && c.effective_status === 'active' && es === 'expiring' && (
                          <Pill className="ms-1 bg-warning-subtle text-warning">{EXPIRY_LABEL(es, daysLeft(c.expires_on, now))}</Pill>
                        )}
                      </span>
                      <span className="block text-xs text-text-secondary">
                        {[c.trade, c.holder_name, c.expires_on ? `Expires ${formatDay(c.expires_on)}` : 'No expiry date', `Checked ${formatDay(c.checked_at)}`,
                          c.next_check_at ? `Re-check ${formatDay(c.next_check_at)}` : null].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="flex items-center gap-1">
                      {c.source_url && (
                        <a href={c.source_url} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-accent hover:underline">
                          Source <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      )}
                      <Button variant="secondary" size="sm" onClick={() => setLicenseModal(c)}>
                        Re-check
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
              {showHistory ? 'Hide history' : `Show history (${lic.data!.history.length})`}
            </Button>
            {showHistory && (
              <ul className="mt-2 space-y-1 text-xs text-text-secondary">
                {lic.data!.history.map((h) => (
                  <li key={h.id}>
                    {formatDay(h.checked_at)} · {h.license_number} ({h.jurisdiction.slice(3)}) · {LICENSE_STATUS_LABELS[h.license_status]}
                    {h.expires_on ? ` · exp. ${formatDay(h.expires_on)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Block>

      {coverageModal && (
        <CoverageModal
          vendorId={vendorId}
          row={coverageModal.row}
          defaultType={coverageModal.type}
          onClose={() => setCoverageModal(null)}
          onSaved={refreshAll}
        />
      )}
      {licenseModal && (
        <LicenseModal
          vendorId={vendorId}
          previous={licenseModal === 'new' ? null : licenseModal}
          onClose={() => setLicenseModal(null)}
          onSaved={refreshAll}
        />
      )}
      {rulesOpen && <RulesModal onClose={() => setRulesOpen(false)} onSaved={refreshAll} />}
      {exemptOpen && <ExemptModal vendorId={vendorId} onClose={() => setExemptOpen(false)} onSaved={refreshAll} />}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this coverage?"
        description="The record is removed permanently. The uploaded certificate file stays in storage."
        confirmLabel="Delete coverage"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting;
          setDeleting(null);
          if (target) await act(() => deleteCoverage(target.id), 'Coverage deleted', 'Could not delete the coverage');
        }}
      />
    </div>
  );
}

// ============================================================ modals

function CoverageModal({ vendorId, row, defaultType, onClose, onSaved }: {
  vendorId: string; row: VendorCoverage | null; defaultType?: CoverageType; onClose: () => void; onSaved: () => void;
}) {
  const { profile, teamMember, isOwner } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const [f, setF] = useState<CoverageInput>({
    coverage_type: row?.coverage_type ?? defaultType ?? 'general_liability',
    carrier: row?.carrier ?? '',
    policy_number: row?.policy_number ?? '',
    effective_on: row?.effective_on ?? '',
    expires_on: row?.expires_on ?? '',
    each_occurrence: row?.each_occurrence_cents != null ? String(row.each_occurrence_cents / 100) : '',
    aggregate: row?.aggregate_cents != null ? String(row.aggregate_cents / 100) : '',
    notes: row?.notes ?? '',
  });
  const [file, setFile] = useState<File | null>(null);
  const { saving, error, run } = useSave(() => { onSaved(); onClose(); }, row ? 'Coverage updated' : 'Coverage added', 'Could not save the coverage.');
  const set = <K extends keyof CoverageInput>(k: K, v: CoverageInput[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      let path: string | null = null;
      if (file) {
        if (!ownerId) throw new Error('Your account is still loading. Try again in a moment.');
        path = await uploadCoiFile(ownerId, vendorId, file);
      }
      await saveVendorCoverage(vendorId, f, path, row?.id);
    });
  };

  return (
    <ModalShell title={row ? 'Edit coverage' : 'Add coverage'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Select label="Coverage" value={f.coverage_type} onChange={(e) => set('coverage_type', e.target.value as CoverageType)}>
          {COVERAGE_OPTIONS.map((t) => (<option key={t} value={t}>{COVERAGE_LABELS[t]}</option>))}
        </Select>
        <div className={grid2}>
          <Input label="Insurance carrier" value={f.carrier} onChange={(e) => set('carrier', e.target.value)} />
          <Input label="Policy number" value={f.policy_number} onChange={(e) => set('policy_number', e.target.value)} />
          <Input label="Effective" type="date" value={f.effective_on} onChange={(e) => set('effective_on', e.target.value)} />
          <Input label="Expires" type="date" required value={f.expires_on} onChange={(e) => set('expires_on', e.target.value)} />
          <Input label="Each occurrence (USD)" inputMode="decimal" value={f.each_occurrence} onChange={(e) => set('each_occurrence', e.target.value)}
            error={parseMoneyToCents(f.each_occurrence) === undefined ? 'Enter a number' : undefined} />
          <Input label="Aggregate (USD)" inputMode="decimal" value={f.aggregate} onChange={(e) => set('aggregate', e.target.value)}
            error={parseMoneyToCents(f.aggregate) === undefined ? 'Enter a number' : undefined} />
        </div>
        <div>
          <label htmlFor="coi-file" className="mb-1 block text-sm font-medium text-text-primary">Certificate file (PDF or photo, max 10 MB)</label>
          <input id="coi-file" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="focus-ring block w-full text-sm text-text-secondary file:me-3 file:rounded-lg file:border file:border-border file:bg-bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-text-primary" />
          {row?.file_path && !file && <p className="mt-1 text-xs text-text-secondary">A file is already attached. Choose another only to replace it.</p>}
        </div>
        <Textarea label="Notes" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <p className="text-xs text-text-secondary">Saved as unverified. A manager checks the numbers against the certificate, then verifies.</p>
        <Footer saving={saving} error={error} onClose={onClose} label={row ? 'Save coverage' : 'Add coverage'} />
      </form>
    </ModalShell>
  );
}

function LicenseModal({ vendorId, previous, onClose, onSaved }: {
  vendorId: string; previous: VendorLicenseCheck | null; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState<LicenseInput>({
    license_number: previous?.license_number ?? '',
    jurisdiction: previous?.jurisdiction ?? '',
    status: 'active',
    expires_on: previous?.expires_on ?? '',
    source_url: '',
    holder_name: previous?.holder_name ?? '',
    trade: previous?.trade ?? '',
    notes: '',
  });
  const { saving, error, run } = useSave(() => { onSaved(); onClose(); }, 'Licence check recorded', 'Could not record the check.');
  const set = <K extends keyof LicenseInput>(k: K, v: LicenseInput[K]) => setF((p) => ({ ...p, [k]: v }));
  return (
    <ModalShell title={previous ? 'Re-check licence' : 'Record licence check'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await recordLicenseCheck(vendorId, f); }); }} className="space-y-3">
        <div className={grid2}>
          <Input label="Licence number" required value={f.license_number} readOnly={previous !== null} onChange={(e) => set('license_number', e.target.value)} />
          <Select label="Issuing state" required value={f.jurisdiction} disabled={previous !== null} onChange={(e) => set('jurisdiction', e.target.value)}>
            <option value="">Choose…</option>
            {US_STATE_CODES.map((s) => (<option key={s} value={`US-${s}`}>{s}</option>))}
          </Select>
          <Select label="Status on the state board" value={f.status} onChange={(e) => set('status', e.target.value as LicenseStatus)}>
            {LICENSE_STATUS_OPTIONS.map((s) => (<option key={s} value={s}>{LICENSE_STATUS_LABELS[s]}</option>))}
          </Select>
          <Input label="Expires" type="date" value={f.expires_on} onChange={(e) => set('expires_on', e.target.value)} />
        </div>
        <Input label="Link to the board record (https://…)" required={f.status === 'active'} value={f.source_url} onChange={(e) => set('source_url', e.target.value)}
          helperText="The page you checked. Required when you record the licence as active." />
        <div className={grid2}>
          <Input label="Name on the licence" value={f.holder_name} onChange={(e) => set('holder_name', e.target.value)} />
          <Input label="Trade / classification" value={f.trade} onChange={(e) => set('trade', e.target.value)} />
        </div>
        <Textarea label="Notes" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <p className="text-xs text-text-secondary">The record is stamped with your name and today’s date, and can’t be edited afterwards. Record a new check instead.</p>
        <Footer saving={saving} error={error} onClose={onClose} label="Record check" />
      </form>
    </ModalShell>
  );
}

function ExemptModal({ vendorId, onClose, onSaved }: { vendorId: string; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const { saving, error, run } = useSave(() => { onSaved(); onClose(); }, 'Vendor marked exempt', 'Could not save the exemption.');
  return (
    <ModalShell title="Exempt from insurance requirements" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => setCoiRequirement(vendorId, true, reason.trim())); }} className="space-y-3">
        <Textarea label="Reason (required)" rows={3} required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)}
          helperText="For example: sole proprietor with no employees, so workers’ compensation does not apply. Keep the proof on file." />
        <Footer saving={saving} error={error} onClose={onClose} label="Mark exempt" />
      </form>
    </ModalShell>
  );
}

function RulesModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const cfg = useLoad(fetchComplianceSettings, 'settings');
  return (
    <ModalShell title="Compliance rules" onClose={onClose}>
      {cfg.loading && !cfg.data ? <Skel /> : cfg.error ? <LoadProblem message={cfg.error} onRetry={cfg.reload} /> : cfg.data ? (
        <RulesForm initial={cfg.data} onClose={onClose} onSaved={onSaved} />
      ) : null}
    </ModalShell>
  );
}

function RulesForm({ initial, onClose, onSaved }: { initial: ComplianceSettings; onClose: () => void; onSaved: () => void }) {
  const [block, setBlock] = useState(initial.coi_enforcement === 'block');
  const [req, setReq] = useState<CoverageType[]>(initial.coi_required_coverages);
  const [grace, setGrace] = useState(String(initial.coi_grace_days));
  const [minGl, setMinGl] = useState(initial.coi_min_general_liability_cents != null ? String(initial.coi_min_general_liability_cents / 100) : '');
  const [recheck, setRecheck] = useState(initial.license_recheck_days != null ? String(initial.license_recheck_days) : '');
  const { saving, error, run } = useSave(() => { onSaved(); onClose(); }, 'Rules saved', 'Could not save the rules.');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const g = Number(grace);
      const m = parseMoneyToCents(minGl);
      const r = recheck.trim() === '' ? null : Number(recheck);
      if (!Number.isInteger(g) || g < 0 || g > 30) throw new Error('Grace days must be a whole number from 0 to 30.');
      if (m === undefined) throw new Error('The minimum limit must be a number.');
      if (r !== null && (!Number.isInteger(r) || r < 7 || r > 730)) throw new Error('Re-check interval must be 7 to 730 days, or empty.');
      await saveComplianceSettings({
        coi_enforcement: block ? 'block' : 'off',
        coi_required_coverages: req,
        coi_grace_days: g,
        coi_min_general_liability_cents: m,
        license_recheck_days: r,
      });
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="flex items-start gap-2 text-sm text-text-primary">
        <input type="checkbox" className="focus-ring mt-1" checked={block} onChange={(e) => setBlock(e.target.checked)} />
        <span>
          Block assignment when required insurance is missing, unverified or expired
          <span className="block text-xs text-text-secondary">Applies to the job board, including dispatcher overrides. Off by default.</span>
        </span>
      </label>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-text-primary">Required coverage</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {COVERAGE_OPTIONS.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" className="focus-ring" checked={req.includes(t)}
                onChange={(e) => setReq((p) => (e.target.checked ? [...p, t] : p.filter((x) => x !== t)))} />
              {COVERAGE_LABELS[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className={grid2}>
        <Input label="Grace days after expiry" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} helperText="0 = blocked the day after expiry." />
        <Input label="Minimum GL per occurrence (USD)" inputMode="decimal" value={minGl} onChange={(e) => setMinGl(e.target.value)} helperText="Empty = no minimum. Ask your broker." />
        <Input label="Licence re-check every (days)" inputMode="numeric" value={recheck} onChange={(e) => setRecheck(e.target.value)} helperText="Empty = no re-check reminders." />
      </div>
      <p className="text-xs text-text-secondary">Only an owner or admin can change these rules.</p>
      <Footer saving={saving} error={error} onClose={onClose} label="Save rules" />
    </form>
  );
}
