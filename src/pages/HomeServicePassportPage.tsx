/**
 * Home Service Passport — dashboard (/dashboard/home-passport)
 *
 * Managers pick a customer's property, preview the passport exactly as a
 * recipient would see it, log permits, and issue sealed, revocable links
 * for a buyer, agent, inspector, insurer or lender.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, Link2, Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { HomePassportView } from '@/components/passport/HomePassportView';
import { supabase } from '@/lib/supabase';
import {
  PERMIT_STATUS_LABELS,
  RECIPIENT_LABELS,
  computePassportProjections,
  createHomePermit,
  deleteHomePermit,
  fetchHomePassport,
  formatPassportDate,
  issuePassportTransfer,
  listHomePermits,
  listPassportTransfers,
  passportUrl,
  revokePassportTransfer,
  type HomePassportPayload,
  type HomePermit,
  type PassportProjections,
  type PassportTransfer,
  type PermitStatus,
  type RecipientType,
} from '@/lib/homeServicePassport';

interface CustomerOption {
  id: string;
  name: string;
  customer_type: 'residential' | 'commercial';
}

const SELECT_CLASS = 'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary';
const VALID_DAY_OPTIONS = [30, 90, 180, 365] as const;

const EMPTY_PERMIT = {
  permit_type: '',
  permit_number: '',
  jurisdiction: '',
  status: 'issued' as PermitStatus,
  issued_on: '',
  expires_on: '',
  finalized_on: '',
};

function transferState(t: PassportTransfer): { label: string; className: string } {
  if (t.revoked_at) return { label: 'Revoked', className: 'bg-danger/10 text-danger' };
  if (new Date(t.expires_at).getTime() <= Date.now()) return { label: 'Expired', className: 'bg-bg-primary text-text-secondary' };
  return { label: 'Active', className: 'bg-success-500/10 text-success-500' };
}

export function HomeServicePassportPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const canAccess = isOwner || permissions.can_view_billing;

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);
  const [search, setSearch] = useState('');
  const customerId = params.get('customer') ?? '';

  const [passport, setPassport] = useState<HomePassportPayload | null>(null);
  const [projections, setProjections] = useState<Omit<PassportProjections, 'model'> | null>(null);
  const [permits, setPermits] = useState<HomePermit[]>([]);
  const [transfers, setTransfers] = useState<PassportTransfer[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const [recipient, setRecipient] = useState<RecipientType>('buyer');
  const [label, setLabel] = useState('');
  const [validDays, setValidDays] = useState<number>(90);
  const [consent, setConsent] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const [permitDraft, setPermitDraft] = useState(EMPTY_PERMIT);
  const [savingPermit, setSavingPermit] = useState(false);

  // Customers ------------------------------------------------------------------------
  useEffect(() => {
    if (!canAccess) return;
    let cancelled = false;
    supabase
      .from('customers')
      .select('id, name, customer_type')
      .order('name', { ascending: true })
      .limit(1000)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) toast('Could not load customers', 'error');
        setCustomers((data ?? []) as CustomerOption[]);
        setCustomersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canAccess, toast]);

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? customers.filter((c) => c.name.toLowerCase().includes(q)) : customers;
    return list.slice(0, 200);
  }, [customers, search]);

  // Passport data --------------------------------------------------------------------
  const loadAll = useCallback(
    async (id: string, isCancelled: () => boolean = () => false) => {
      setLoading(true);
      setLoadFailed(false);
      try {
        const [pp, proj, pm, tr] = await Promise.all([
          fetchHomePassport(id),
          computePassportProjections(id).catch(() => null),
          listHomePermits(id),
          listPassportTransfers(id),
        ]);
        if (isCancelled()) return;
        setPassport(pp);
        setProjections(proj);
        setPermits(pm);
        setTransfers(tr);
      } catch {
        if (isCancelled()) return;
        setLoadFailed(true);
        setPassport(null);
        toast('Could not load this home passport', 'error');
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    setIssuedUrl(null);
    setConsent(false);
    setPassport(null);
    if (!canAccess || !customerId) return;
    let cancelled = false;
    void loadAll(customerId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [canAccess, customerId, loadAll]);

  const preview = useMemo<HomePassportPayload | null>(
    () => (passport ? { ...passport, projections: projections ? { model: 'vireek.home_budget.v1', ...projections } : null } : null),
    [passport, projections],
  );

  // Actions --------------------------------------------------------------------------
  const handleIssue = async () => {
    if (!customerId || !consent || issuing) return;
    setIssuing(true);
    try {
      const issued = await issuePassportTransfer({
        customerId,
        recipientType: recipient,
        label,
        validDays,
        customerConsent: consent,
        projections,
      });
      setIssuedUrl(passportUrl(issued.token));
      setCopied(false);
      setLabel('');
      setConsent(false);
      setTransfers(await listPassportTransfers(customerId));
      toast('Sealed passport link created', 'success');
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : 'Could not issue the passport';
      toast(msg, 'error');
    } finally {
      setIssuing(false);
    }
  };

  const handleCopy = async () => {
    if (!issuedUrl) return;
    try {
      await navigator.clipboard.writeText(issuedUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Copy failed — select the link and copy it manually', 'error');
    }
  };

  const handleRevoke = async () => {
    if (!revokeId) return;
    try {
      await revokePassportTransfer(revokeId);
      setTransfers(await listPassportTransfers(customerId));
      toast('Passport link revoked', 'success');
    } catch {
      toast('Could not revoke this link', 'error');
    } finally {
      setRevokeId(null);
    }
  };

  const handleAddPermit = async () => {
    if (!customerId || !permitDraft.permit_type.trim() || savingPermit) return;
    setSavingPermit(true);
    try {
      await createHomePermit(customerId, {
        job_id: null,
        permit_type: permitDraft.permit_type.trim(),
        permit_number: permitDraft.permit_number.trim() || null,
        jurisdiction: permitDraft.jurisdiction.trim() || null,
        status: permitDraft.status,
        issued_on: permitDraft.issued_on || null,
        expires_on: permitDraft.expires_on || null,
        finalized_on: permitDraft.finalized_on || null,
        notes: null,
      });
      setPermitDraft(EMPTY_PERMIT);
      await loadAll(customerId);
      toast('Permit added', 'success');
    } catch {
      toast('Could not save the permit — check the dates and try again', 'error');
    } finally {
      setSavingPermit(false);
    }
  };

  const handleDeletePermit = async (id: string) => {
    try {
      await deleteHomePermit(id);
      await loadAll(customerId);
    } catch {
      toast('Could not delete the permit', 'error');
    }
  };

  // Render ---------------------------------------------------------------------------
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Home Service Passport">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don&apos;t have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Home Service Passports are restricted. Ask your account owner to grant you the &quot;View Billing&quot; permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const selectedName = customers.find((c) => c.id === customerId)?.name;

  return (
    <DashboardLayout activeLabel="Home Service Passport">
      <div className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <ShieldCheck size={24} className="text-accent" aria-hidden="true" /> Home Service Passport
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          A sealed, buyer-ready record of every system in the home: age, warranty, service history, permits, known problems,
          predicted maintenance and expected future costs. Facts come from your job data — nothing is typed in.
        </p>
      </div>

      <Card className="mb-6 !p-5 hover:!translate-y-0">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Find a customer"
            placeholder="Start typing a name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div>
            <label htmlFor="hp-customer" className="mb-1.5 block text-sm font-medium text-text-primary">
              Property / customer
            </label>
            <select
              id="hp-customer"
              className={SELECT_CLASS}
              value={customerId}
              disabled={customersLoading}
              onChange={(e) => setParams(e.target.value ? { customer: e.target.value } : {})}
            >
              <option value="">{customersLoading ? 'Loading…' : 'Select a customer'}</option>
              {customerId && !filteredCustomers.some((c) => c.id === customerId) && selectedName && (
                <option value={customerId}>{selectedName}</option>
              )}
              {filteredCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.customer_type === 'commercial' ? ' (commercial)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {!customerId && (
        <EmptyState
          icon={ShieldCheck}
          title="Choose a property"
          description="Select a customer to preview their Home Service Passport and prepare it for a sale, inspection, insurance or lending."
        />
      )}

      {customerId && loading && !passport && <SkeletonCardList count={3} rows={3} />}

      {customerId && loadFailed && !loading && (
        <EmptyState
          icon={Lock}
          title="Could not load this passport"
          description="Check your connection and permissions, then try again."
          action={{ label: 'Retry', onClick: () => void loadAll(customerId) }}
        />
      )}

      {customerId && preview && (
        <FadeIn>
          <div className="space-y-6">
            {preview.summary.record_completeness_pct < 60 && preview.summary.active_equipment > 0 && (
              <div className="rounded-xl border border-warning-500/30 bg-warning-500/5 p-4 text-sm text-text-secondary" role="status">
                Only {preview.summary.record_completeness_pct}% of this home&apos;s equipment has make, install date and last service
                recorded. Complete those on the customer&apos;s equipment list to make the passport — and its cost estimates — more
                trustworthy.
              </div>
            )}

            <Card className="!p-6 hover:!translate-y-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Link2 size={16} className="text-accent" aria-hidden="true" /> Issue a sealed passport
              </h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="hp-recipient" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Recipient
                  </label>
                  <select
                    id="hp-recipient"
                    className={SELECT_CLASS}
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value as RecipientType)}
                  >
                    {(Object.keys(RECIPIENT_LABELS) as RecipientType[]).map((k) => (
                      <option key={k} value={k}>
                        {RECIPIENT_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <Input
                  label="Label (optional)"
                  placeholder="e.g. 14 Oak St sale"
                  maxLength={80}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <div>
                  <label htmlFor="hp-valid" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Link valid for
                  </label>
                  <select id="hp-valid" className={SELECT_CLASS} value={validDays} onChange={(e) => setValidDays(Number(e.target.value))}>
                    {VALID_DAY_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d} days
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="mt-4 flex items-start gap-2.5 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  The homeowner has agreed to share this record. It will include the property address, equipment, service
                  history, permits and known problems — never contact details, technician names, prices or internal notes.
                </span>
              </label>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={() => void handleIssue()} disabled={!consent || issuing}>
                  {issuing ? 'Sealing…' : 'Issue sealed link'}
                </Button>
                <p className="text-xs text-text-secondary">The snapshot is frozen at issue time and can only be revoked, never edited.</p>
              </div>

              {issuedUrl && (
                <div className="mt-4 rounded-xl border border-success-500/30 bg-success-500/5 p-4" role="status">
                  <p className="text-sm font-medium text-success-500">Link created — copy it now</p>
                  <p className="mt-0.5 text-xs text-text-secondary">For security, the full link is shown only once.</p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <code className="min-w-0 flex-1 break-all rounded-lg bg-bg-primary px-3 py-2 text-xs text-text-primary">{issuedUrl}</code>
                    <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
                      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </div>
              )}

              {transfers.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Issued links</h3>
                  <ul className="mt-2 divide-y divide-border">
                    {transfers.map((t) => {
                      const st = transferState(t);
                      const active = st.label === 'Active';
                      return (
                        <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                          <div className="min-w-0">
                            <p className="font-medium text-text-primary">
                              {RECIPIENT_LABELS[t.recipient_type]}
                              {t.label ? ` · ${t.label}` : ''}
                            </p>
                            <p className="text-xs text-text-secondary">
                              Issued {formatPassportDate(t.issued_at)} · expires {formatPassportDate(t.expires_at)} · {t.view_count} view
                              {t.view_count === 1 ? '' : 's'}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${st.className}`}>{st.label}</span>
                            {active && (
                              <Button variant="ghost" size="sm" onClick={() => setRevokeId(t.id)}>
                                Revoke
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </Card>

            <Card className="!p-6 hover:!translate-y-0">
              <h2 className="text-sm font-semibold text-text-primary">Permits on file</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Only permits you log here appear on the passport. Completed jobs that likely needed a permit but have none logged are
                listed as known problems.
              </p>
              {permits.length > 0 && (
                <ul className="mt-3 divide-y divide-border">
                  {permits.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary">{p.permit_type}</p>
                        <p className="text-xs text-text-secondary">
                          {[p.permit_number ? `#${p.permit_number}` : null, p.jurisdiction, PERMIT_STATUS_LABELS[p.status]]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => void handleDeletePermit(p.id)} aria-label={`Delete permit ${p.permit_type}`}>
                        <Trash2 size={15} aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Input
                  label="Permit type"
                  placeholder="e.g. Water heater replacement"
                  maxLength={80}
                  value={permitDraft.permit_type}
                  onChange={(e) => setPermitDraft((d) => ({ ...d, permit_type: e.target.value }))}
                />
                <Input
                  label="Permit number"
                  maxLength={60}
                  value={permitDraft.permit_number}
                  onChange={(e) => setPermitDraft((d) => ({ ...d, permit_number: e.target.value }))}
                />
                <Input
                  label="Jurisdiction"
                  placeholder="City / county"
                  maxLength={120}
                  value={permitDraft.jurisdiction}
                  onChange={(e) => setPermitDraft((d) => ({ ...d, jurisdiction: e.target.value }))}
                />
                <div>
                  <label htmlFor="hp-permit-status" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Status
                  </label>
                  <select
                    id="hp-permit-status"
                    className={SELECT_CLASS}
                    value={permitDraft.status}
                    onChange={(e) => setPermitDraft((d) => ({ ...d, status: e.target.value as PermitStatus }))}
                  >
                    {(Object.keys(PERMIT_STATUS_LABELS) as PermitStatus[]).map((k) => (
                      <option key={k} value={k}>
                        {PERMIT_STATUS_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <Input
                  label="Issued on"
                  type="date"
                  value={permitDraft.issued_on}
                  onChange={(e) => setPermitDraft((d) => ({ ...d, issued_on: e.target.value }))}
                />
                <Input
                  label="Finalized on"
                  type="date"
                  value={permitDraft.finalized_on}
                  onChange={(e) => setPermitDraft((d) => ({ ...d, finalized_on: e.target.value }))}
                />
              </div>
              <div className="mt-4">
                <Button variant="secondary" size="sm" onClick={() => void handleAddPermit()} disabled={!permitDraft.permit_type.trim() || savingPermit}>
                  <Plus size={15} aria-hidden="true" /> {savingPermit ? 'Saving…' : 'Add permit'}
                </Button>
              </div>
            </Card>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Preview — exactly what the recipient will see
              </p>
              <HomePassportView data={preview} />
            </div>
          </div>
        </FadeIn>
      )}

      <ConfirmDialog
        open={revokeId !== null}
        title="Revoke this passport link?"
        description="Anyone holding the link will immediately lose access. This cannot be undone — issue a new link if needed."
        confirmLabel="Revoke link"
        onConfirm={handleRevoke}
        onCancel={() => setRevokeId(null)}
      />
    </DashboardLayout>
  );
}
