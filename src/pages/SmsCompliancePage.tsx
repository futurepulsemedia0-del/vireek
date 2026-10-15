import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquareText, ShieldCheck, ShieldAlert, Clock, CircleDashed, CheckCircle2, XCircle,
  Search, Plus, Download, RefreshCw, AlertTriangle, Lock, ExternalLink, X, BadgeCheck, Ban,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonTable } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  OPT_OUT_PAGE_SIZE, fetchRegistration, submitRegistration, fetchOptOuts, addManualOptOut,
  fetchOptInProof, recordOptIn, computeReadiness, canSendSms, canSubmit, overallState,
  currentConsent, maskEin, maskPhone, toCsv, isValidPhone,
  type A2pRegistration, type OptOutRow, type OptInRow, type OptInSource, type RegistrationStatus,
} from '@/lib/smsCompliance';

type Tab = 'registration' | 'opt-in' | 'opt-outs';

const STATUS_META: Record<RegistrationStatus, { label: string; cls: string; Icon: typeof Clock }> = {
  not_started: { label: 'Not started', cls: 'bg-bg-tertiary text-text-secondary', Icon: CircleDashed },
  pending: { label: 'In carrier review', cls: 'bg-warning-500/10 text-warning-500', Icon: Clock },
  approved: { label: 'Approved', cls: 'bg-success/10 text-success', Icon: CheckCircle2 },
  rejected: { label: 'Rejected', cls: 'bg-danger/10 text-danger', Icon: XCircle },
};

const REASON_LABEL: Record<OptOutRow['reason'], string> = {
  customer_opt_out: 'Replied STOP',
  manual: 'Added manually',
  national_registry: 'National registry',
};

const SOURCE_LABEL: Record<OptInSource, string> = {
  web_form: 'Web form',
  sms_reply: 'SMS reply',
  ivr_verbal: 'Verbal (call)',
  import: 'Import',
  manual: 'Manual entry',
};

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function StatusPill({ status }: { status: RegistrationStatus }) {
  const { label, cls, Icon } = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>
      <Icon size={13} aria-hidden="true" /> {label}
    </span>
  );
}

function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Modal({ title, id, onClose, children }: { title: string; id: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className="relative max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover dark:shadow-card-hover-dark sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={id} className="text-lg font-bold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -mr-1 -mt-1 flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorState({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title={`Couldn't load ${what}`}
      description="Check your connection and try again."
      action={{ label: 'Retry', onClick: onRetry }}
    />
  );
}

// ---------------------------------------------------------------------------
// Registration tab
// ---------------------------------------------------------------------------

function RegistrationTab({
  reg, onSubmit, onRefresh, refreshing,
}: { reg: A2pRegistration; onSubmit: () => void; onRefresh: () => void; refreshing: boolean }) {
  const navigate = useNavigate();
  const readiness = computeReadiness(reg);
  const state = overallState(reg);
  const rejected = reg.a2p_brand_status === 'rejected' || reg.a2p_campaign_status === 'rejected';
  const submitLabel = rejected ? 'Resubmit registration' : 'Submit for carrier registration';

  const rows: [string, string][] = [
    ['Legal business name', reg.legal_business_name || '—'],
    ['EIN', maskEin(reg.ein)],
    ['Registration type', reg.business_registration_type ? reg.business_registration_type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—'],
    ['Website', reg.business_website || '—'],
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {([
          ['Brand', reg.a2p_brand_status, reg.a2p_brand_sid],
          ['Campaign', reg.a2p_campaign_status, reg.a2p_campaign_sid],
        ] as const).map(([label, status, sid]) => (
          <Card key={label} className="!p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
            <div className="mt-2"><StatusPill status={status} /></div>
            <p className="mt-3 break-all text-xs text-text-secondary">
              SID: <code className="text-text-primary">{sid || 'Not assigned yet'}</code>
            </p>
          </Card>
        ))}
      </div>

      {rejected && (
        <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-4">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-semibold text-text-primary">Carrier registration was rejected</p>
            <p className="mt-1 text-text-secondary">{reg.a2p_rejection_reason || 'No reason was returned. Review your business details and resubmit.'}</p>
          </div>
        </div>
      )}

      {state === 'in_review' && (
        <div className="flex items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4">
          <Clock size={18} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
          <p className="text-sm text-text-secondary">
            Submitted {fmt(reg.a2p_requested_at)}. Carrier vetting usually takes 1–5 business days. Outbound SMS stays blocked until the campaign is approved.
          </p>
        </div>
      )}

      <Card className="!p-5">
        <h2 className="text-base font-semibold text-text-primary">Registration details</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-text-secondary">{k}</dt>
              <dd className="mt-0.5 break-words text-sm text-text-primary">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-xs text-text-secondary">Sample message</p>
            <p className="mt-1 rounded-xl bg-bg-primary p-3 text-sm text-text-primary">{reg.sms_sample_message || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-text-secondary">How customers opt in</p>
            <p className="mt-1 rounded-xl bg-bg-primary p-3 text-sm text-text-primary">{reg.sms_opt_in_description || '—'}</p>
          </div>
        </div>
      </Card>

      {!readiness.complete && state !== 'approved' && state !== 'in_review' && (
        <Card className="!p-5">
          <h2 className="text-base font-semibold text-text-primary">Before you can submit</h2>
          <ul className="mt-2 space-y-1.5">
            {readiness.missing.map((m) => (
              <li key={m.key} className="flex items-center gap-2 text-sm text-text-secondary">
                <XCircle size={14} className="shrink-0 text-danger" aria-hidden="true" /> {m.label}
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => navigate('/dashboard/business-profile')}>
            <ExternalLink size={14} /> Complete in Business Profile
          </Button>
        </Card>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {canSubmit(reg) && (
          <Button type="button" size="sm" onClick={onSubmit}>{submitLabel}</Button>
        )}
        <Button type="button" variant="secondary" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh status'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opt-in proof tab
// ---------------------------------------------------------------------------

function OptInModal({ saving, onSave, onClose }: { saving: boolean; onSave: (v: { phone: string; source: OptInSource; notes: string }) => void; onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState<OptInSource>('web_form');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const phoneErr = touched && !isValidPhone(phone) ? 'Enter a valid phone number, e.g. +15551234567.' : undefined;
  const notesErr = touched && notes.trim().length < 10 ? 'Describe how consent was obtained (10+ characters).' : undefined;

  return (
    <Modal title="Record opt-in proof" id="optin-title" onClose={onClose}>
      <p className="mt-1 text-xs text-text-secondary">Adds an entry to the consent ledger. Entries can't be edited or deleted afterwards.</p>
      <div className="mt-4 space-y-4">
        <Input label="Phone number" required inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 123 4567" error={phoneErr} />
        <div>
          <label htmlFor="optin-source" className="mb-1.5 block text-xs font-medium text-text-secondary">Source</label>
          <select
            id="optin-source"
            value={source}
            onChange={(e) => setSource(e.target.value as OptInSource)}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
          >
            {(['web_form', 'sms_reply', 'ivr_verbal', 'import', 'manual'] as OptInSource[]).map((s) => (
              <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
            ))}
          </select>
        </div>
        <Textarea label="Evidence" required rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Ticked the SMS box on the booking form at vireek.com/book on 2027-04-02" error={notesErr} />
      </div>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => {
            setTouched(true);
            if (isValidPhone(phone) && notes.trim().length >= 10) onSave({ phone, source, notes });
          }}
        >
          {saving ? 'Saving…' : 'Record consent'}
        </Button>
      </div>
    </Modal>
  );
}

function OptInTab({ accountOwnerId, reg }: { accountOwnerId: string; reg: A2pRegistration }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<OptInRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setRows(null);
    try { setRows(await fetchOptInProof(accountOwnerId)); } catch { setFailed(true); }
  }, [accountOwnerId]);
  useEffect(() => { load(); }, [load]);

  const save = async (v: { phone: string; source: OptInSource; notes: string }) => {
    setSaving(true);
    try {
      await recordOptIn(accountOwnerId, v);
      toast('Opt-in recorded.', 'success');
      setOpen(false);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record consent.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () =>
    rows && downloadCsv(
      `sms-opt-in-proof-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        ['Date', 'Phone', 'Email', 'Consent', 'Source', 'Evidence', 'IP'],
        rows.map((r) => [r.created_at, r.contact_phone, r.contact_email, r.granted ? 'granted' : 'revoked', r.source, r.notes, r.ip_address]),
      ),
    );

  const totals = rows ? currentConsent(rows) : null;

  return (
    <div className="space-y-4">
      <Card className="!p-5">
        <h2 className="text-base font-semibold text-text-primary">Opt-in disclosure on file</h2>
        <p className="mt-2 rounded-xl bg-bg-primary p-3 text-sm text-text-primary">
          {reg.sms_opt_in_description || 'Not provided yet. Add it in Business Profile — carriers require it for campaign approval.'}
        </p>
      </Card>

      {failed ? (
        <ErrorState what="opt-in proof" onRetry={load} />
      ) : rows === null ? (
        <SkeletonTable rows={5} columns={4} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Card className="!p-4"><p className="text-xs text-text-secondary">Contacts with consent</p><p className="mt-1 text-2xl font-bold text-text-primary">{totals?.granted ?? 0}</p></Card>
            <Card className="!p-4"><p className="text-xs text-text-secondary">Consent revoked</p><p className="mt-1 text-2xl font-bold text-text-primary">{totals?.revoked ?? 0}</p></Card>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={exportCsv} disabled={rows.length === 0}><Download size={14} /> Export CSV</Button>
            <Button type="button" size="sm" onClick={() => setOpen(true)}><Plus size={14} /> Record opt-in</Button>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon={BadgeCheck}
              title="No opt-in records yet"
              description="Every customer you text needs documented consent. Record it here so you can prove it to carriers or in a dispute."
              action={{ label: 'Record first opt-in', onClick: () => setOpen(true) }}
            />
          ) : (
            <Card className="!p-0 overflow-hidden">
              <ul className="divide-y divide-border/60">
                {rows.map((r) => (
                  <li key={r.id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-text-primary">{r.contact_phone ? maskPhone(r.contact_phone) : r.contact_email}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[0.65rem] font-medium ${r.granted ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
                        {r.granted ? 'Granted' : 'Revoked'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">{SOURCE_LABEL[r.source]} · {fmt(r.created_at)}</p>
                    {r.notes && <p className="mt-2 text-sm text-text-secondary">{r.notes}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {open && <OptInModal saving={saving} onSave={save} onClose={() => !saving && setOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opt-out log tab
// ---------------------------------------------------------------------------

function OptOutTab({ accountOwnerId }: { accountOwnerId: string }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<OptOutRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState('');
  const [phoneErr, setPhoneErr] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetchOptOuts(accountOwnerId, { search: query });
      setRows(res.rows);
      setTotal(res.total);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId, query]);
  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await fetchOptOuts(accountOwnerId, { search: query, offset: rows.length });
      setRows((prev) => [...prev, ...res.rows]);
      setTotal(res.total);
    } catch {
      toast('Could not load more.', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const add = async () => {
    if (!isValidPhone(phone)) { setPhoneErr('Enter a valid phone number, e.g. +15551234567.'); return; }
    setSaving(true);
    try {
      await addManualOptOut(accountOwnerId, phone);
      toast('Number added to the opt-out list.', 'success');
      setAdding(false);
      setPhone('');
      setPhoneErr(undefined);
      await load();
    } catch {
      toast('Could not add the number.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () =>
    downloadCsv(
      `sms-opt-outs-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(['Date', 'Phone', 'Reason'], rows.map((r) => [r.created_at, r.phone_number, REASON_LABEL[r.reason]])),
    );

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
        <Ban size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <p className="text-sm text-text-secondary">
          Anyone who replies STOP is added here automatically and is blocked from every text <em>and</em> outbound call. Numbers can't be removed from this screen — a customer who wants back in must opt in again.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex-1">
          <Input aria-label="Search opt-outs by phone number" icon={Search} inputMode="tel" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by phone number" />
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={exportCsv} disabled={rows.length === 0}><Download size={14} /> Export</Button>
        <Button type="button" size="sm" onClick={() => setAdding(true)}><Plus size={14} /> Add number</Button>
      </div>

      {loading ? (
        <SkeletonTable rows={6} columns={3} />
      ) : failed ? (
        <ErrorState what="the opt-out log" onRetry={load} />
      ) : rows.length === 0 ? (
        query ? (
          <EmptyState icon={Search} title="No matches" description="No opted-out number matches that search." />
        ) : (
          <EmptyState icon={ShieldCheck} title="No opt-outs yet" description="When a customer replies STOP, their number appears here with the time it happened." />
        )
      ) : (
        <>
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border/60">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-semibold text-text-primary">{r.phone_number}</p>
                  <p className="text-xs text-text-secondary">{REASON_LABEL[r.reason]} · {fmt(r.created_at)}</p>
                </li>
              ))}
            </ul>
          </Card>
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-text-secondary">Showing {rows.length} of {total}</p>
            {rows.length < total && (
              <Button type="button" variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : `Load ${Math.min(OPT_OUT_PAGE_SIZE, total - rows.length)} more`}
              </Button>
            )}
          </div>
        </>
      )}

      {adding && (
        <Modal title="Add to opt-out list" id="optout-title" onClose={() => !saving && setAdding(false)}>
          <p className="mt-1 text-xs text-text-secondary">This number will be blocked from all texts and outbound calls.</p>
          <div className="mt-4">
            <Input label="Phone number" required inputMode="tel" autoComplete="off" value={phone} onChange={(e) => { setPhone(e.target.value); setPhoneErr(undefined); }} placeholder="+1 555 123 4567" error={phoneErr} />
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(false)} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={add} disabled={saving}>{saving ? 'Adding…' : 'Add number'}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SmsCompliancePage() {
  const { isOwner, profile, refreshProfile } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id ?? null : null;

  const [tab, setTab] = useState<Tab>('registration');
  const [reg, setReg] = useState<A2pRegistration | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!accountOwnerId) return;
    if (silent) setRefreshing(true); else setLoading(true);
    setFailed(false);
    try {
      setReg(await fetchRegistration(accountOwnerId));
    } catch {
      if (silent) toast('Could not refresh status.', 'error'); else setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accountOwnerId, toast]);
  useEffect(() => { load(); }, [load]);

  if (!isOwner || !accountOwnerId) {
    return (
      <DashboardLayout activeLabel="Settings">
        <EmptyState
          icon={Lock}
          title="Owner access only"
          description="SMS compliance covers your legal business details and customer consent records — only the account owner can view or change them."
        />
      </DashboardLayout>
    );
  }

  const handleSubmit = async () => {
    setConfirmSubmit(false);
    try {
      await submitRegistration();
      toast('Registration submitted. Carrier review usually takes 1–5 business days.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Registration failed.', 'error');
    }
    await Promise.all([load(true), refreshProfile()]);
  };

  const sendable = reg ? canSendSms(reg) : false;
  const state = reg ? overallState(reg) : null;

  return (
    <DashboardLayout activeLabel="Settings">
      <div className="mb-6"><BackButton fallback="/dashboard/settings" /></div>

      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <MessageSquareText size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">SMS compliance</h1>
          <p className="mt-1 text-sm text-text-secondary">A2P 10DLC registration, opt-in proof, and the opt-out log.</p>
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={2} />
      ) : failed || !reg ? (
        <ErrorState what="SMS compliance" onRetry={() => load()} />
      ) : (
        <>
          <div
            role="status"
            className={`mb-5 flex items-start gap-3 rounded-2xl border p-4 ${sendable ? 'border-success/30 bg-success/5' : 'border-warning-500/30 bg-warning-500/5'}`}
          >
            {sendable ? <ShieldCheck size={20} className="mt-0.5 shrink-0 text-success" aria-hidden="true" /> : <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />}
            <div className="text-sm">
              <p className="font-semibold text-text-primary">{sendable ? 'Outbound SMS is enabled' : 'Outbound SMS is blocked'}</p>
              <p className="mt-0.5 text-text-secondary">
                {sendable
                  ? 'Your campaign is approved. Every message is still checked against the opt-out list before sending.'
                  : state === 'in_review'
                    ? 'Waiting on carrier approval. US carriers block unregistered texts, so nothing is sent until then.'
                    : 'US carriers block unregistered business texts. Complete registration to start sending.'}
              </p>
            </div>
          </div>

          <div role="tablist" aria-label="SMS compliance sections" className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {([['registration', 'Registration'], ['opt-in', 'Opt-in proof'], ['opt-outs', 'Opt-outs']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`focus-ring min-h-[40px] flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors ${tab === id ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'registration' && (
            <RegistrationTab reg={reg} refreshing={refreshing} onRefresh={() => load(true)} onSubmit={() => setConfirmSubmit(true)} />
          )}
          {tab === 'opt-in' && <OptInTab accountOwnerId={accountOwnerId} reg={reg} />}
          {tab === 'opt-outs' && <OptOutTab accountOwnerId={accountOwnerId} />}
        </>
      )}

      <ConfirmDialog
        open={confirmSubmit}
        title="Submit for carrier registration?"
        description="Your legal business details are sent to the carriers for vetting. Review takes 1–5 business days and you can't edit a pending registration."
        confirmLabel="Submit"
        onConfirm={handleSubmit}
        onCancel={() => setConfirmSubmit(false)}
      />
    </DashboardLayout>
  );
}
