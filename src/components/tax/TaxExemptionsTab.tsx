import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, FileText, Loader2, Search, Trash2, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { EXEMPTION_TYPE_LABELS, US_STATES, evaluateExemption, type ExemptionType } from '@/lib/salesTax';
import {
  CERTIFICATE_ACCEPT, createExemption, deleteExemption, fetchAllExemptions, fetchCustomerOption, fetchTaxClasses,
  getCertificateUrl, searchCustomers, setExemptionStatus, validateCertificateFile,
  type CustomerOption, type ExemptionRecord, type TaxClassDetail,
} from '@/lib/salesTaxApi';

const inputClass = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const STATES = Object.entries(US_STATES).sort(([a], [b]) => a.localeCompare(b));
const today = () => new Date().toISOString().slice(0, 10);

const STATUS_STYLE: Record<string, string> = {
  verified: 'bg-success-500/10 text-success-500',
  pending: 'bg-warning-500/10 text-warning-500',
  rejected: 'bg-danger/10 text-danger',
  revoked: 'bg-bg-tertiary text-text-secondary',
};

function CustomerSearch({ onPick }: { onPick: (c: CustomerOption) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => { searchCustomers(q).then((r) => !cancelled && setResults(r)).catch(() => !cancelled && setResults([])); }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);
  return (
    <div>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
        <input aria-label="Search customers" className={`${inputClass} pl-8`} placeholder="Search customer by name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mt-1 max-h-40 overflow-auto rounded-lg border border-border">
        {results.map((c) => (
          <button key={c.id} type="button" onClick={() => onPick(c)} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-bg-tertiary">
            {c.name} <span className="text-xs text-text-secondary">{c.email ?? c.phone ?? ''}</span>
          </button>
        ))}
        {results.length === 0 && <p className="px-3 py-2 text-xs text-text-secondary">No customers found.</p>}
      </div>
    </div>
  );
}

function NewExemptionForm({ customer, classes, onDone, onCancel }: { customer: CustomerOption; classes: TaxClassDetail[]; onDone: () => void; onCancel: () => void }) {
  const { toast } = useToast();
  const [type, setType] = useState<ExemptionType>('resale');
  const [number, setNumber] = useState('');
  const [issuingState, setIssuingState] = useState('');
  const [states, setStates] = useState<string[]>([]);
  const [classCodes, setClassCodes] = useState<string[]>([]);
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const pickFile = (f: File | undefined) => {
    if (!f) return setFile(null);
    const problem = validateCertificateFile(f);
    if (problem) { toast(problem, 'error'); return; }
    setFile(f);
  };

  const submit = async () => {
    setSaving(true);
    try {
      await createExemption({ customerId: customer.id, exemptionType: type, certificateNumber: number, issuingState, appliesToStates: states, appliesToClasses: classCodes, issuedOn, expiresOn, notes, file });
      toast('Certificate saved — verify it to start exempting this customer.', 'success');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the certificate.', 'error');
    } finally { setSaving(false); }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">New certificate — {customer.name}</p>
        <button type="button" aria-label="Close" onClick={onCancel} className="focus-ring rounded p-1 text-text-secondary"><X size={14} /></button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-text-secondary">Type
          <select className={`${inputClass} mt-1`} value={type} onChange={(e) => setType(e.target.value as ExemptionType)}>
            {Object.entries(EXEMPTION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-secondary">Certificate number
          <input className={`${inputClass} mt-1`} value={number} onChange={(e) => setNumber(e.target.value)} />
        </label>
        <label className="text-xs text-text-secondary">Issuing state
          <select className={`${inputClass} mt-1`} value={issuingState} onChange={(e) => setIssuingState(e.target.value)}>
            <option value="">—</option>{STATES.map(([c]) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-secondary">Issued on
          <input type="date" className={`${inputClass} mt-1`} value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
        </label>
        <label className="text-xs text-text-secondary">Expires on (blank = no expiry)
          <input type="date" className={`${inputClass} mt-1`} value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
        <label className="text-xs text-text-secondary">Certificate file (PDF or image, max 10 MB)
          <input type="file" accept={CERTIFICATE_ACCEPT} className={`${inputClass} mt-1`} onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>
      </div>

      <p className="mt-4 text-xs text-text-secondary">Applies to states (none selected = every state)</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {STATES.map(([c]) => (
          <button key={c} type="button" aria-pressed={states.includes(c)} onClick={() => toggle(states, setStates, c)} className={`rounded px-1.5 py-0.5 text-[11px] ${states.includes(c) ? 'bg-accent text-white' : 'border border-border text-text-secondary'}`}>{c}</button>
        ))}
      </div>
      <p className="mt-3 text-xs text-text-secondary">Applies to tax classes (none selected = all)</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {classes.map((c) => (
          <button key={c.id} type="button" aria-pressed={classCodes.includes(c.code)} onClick={() => toggle(classCodes, setClassCodes, c.code)} className={`rounded px-2 py-0.5 text-[11px] ${classCodes.includes(c.code) ? 'bg-accent text-white' : 'border border-border text-text-secondary'}`}>{c.name}</button>
        ))}
      </div>
      <label className="mt-3 block text-xs text-text-secondary">Notes
        <textarea rows={2} className={`${inputClass} mt-1`} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <button type="button" disabled={saving} onClick={submit} className="focus-ring mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {saving && <Loader2 size={12} className="animate-spin" />} Save certificate
      </button>
    </div>
  );
}

export function TaxExemptionsTab({ initialCustomerId }: { initialCustomerId?: string | null }) {
  const { toast } = useToast();
  const [items, setItems] = useState<ExemptionRecord[]>([]);
  const [classes, setClasses] = useState<TaxClassDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([fetchAllExemptions(), fetchTaxClasses()]);
      setItems(a);
      setClasses(c);
    } catch { toast('Could not load certificates.', 'error'); } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!initialCustomerId) return;
    fetchCustomerOption(initialCustomerId).then((c) => { if (c) { setCustomer(c); setAdding(true); } }).catch(() => undefined);
  }, [initialCustomerId]);

  const act = async (fn: () => Promise<void>, ok: string) => {
    try { await fn(); toast(ok, 'success'); await load(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
  };

  const view = async (path: string) => {
    try { window.open(await getCertificateUrl(path), '_blank', 'noopener,noreferrer'); } catch { toast('Could not open the certificate.', 'error'); }
  };

  if (loading) return <div className="flex h-24 items-center justify-center"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-secondary">
        A customer is only treated as exempt when a certificate is <strong>verified</strong> and not expired. Pending, rejected, revoked and expired certificates are ignored and tax is charged. Files are stored privately.
      </p>

      {!adding && (
        <div className="max-w-md">
          <p className="mb-1 text-xs font-medium text-text-secondary">Add a certificate for…</p>
          <CustomerSearch onPick={(c) => { setCustomer(c); setAdding(true); }} />
        </div>
      )}
      {adding && customer && <NewExemptionForm customer={customer} classes={classes} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); void load(); }} />}

      <div className="space-y-2">
        {items.length === 0 && <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">No certificates yet.</div>}
        {items.map((e) => {
          const usable = evaluateExemption(e, { state: e.appliesToStates[0] ?? e.issuingState ?? '', classCode: e.appliesToClasses[0] ?? 'general', onDate: today() });
          const expired = Boolean(e.expiresOn && e.expiresOn < today());
          return (
            <div key={e.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{e.customerName ?? 'Customer'} · {EXEMPTION_TYPE_LABELS[e.exemptionType]}{e.certificateNumber ? ` #${e.certificateNumber}` : ''}</p>
                  <p className="text-xs text-text-secondary">
                    {e.appliesToStates.length ? e.appliesToStates.join(', ') : 'All states'} · {e.appliesToClasses.length ? e.appliesToClasses.join(', ') : 'all classes'}
                    {e.expiresOn ? ` · expires ${e.expiresOn}` : ' · no expiry'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${expired ? 'bg-danger/10 text-danger' : STATUS_STYLE[e.status]}`}>{expired ? 'expired' : e.status}</span>
                  {e.certificatePath && <button type="button" onClick={() => void view(e.certificatePath as string)} className="focus-ring inline-flex items-center gap-1 text-xs text-accent hover:underline"><FileText size={12} /> View <ExternalLink size={10} /></button>}
                  {e.status !== 'verified' && <button type="button" onClick={() => void act(() => setExemptionStatus(e.id, 'verified'), 'Certificate verified.')} className="focus-ring rounded-lg bg-success-500/15 px-2.5 py-1 text-xs font-medium text-success-500">Verify</button>}
                  {e.status === 'pending' && <button type="button" onClick={() => void act(() => setExemptionStatus(e.id, 'rejected'), 'Certificate rejected.')} className="focus-ring rounded-lg bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">Reject</button>}
                  {e.status === 'verified' && <button type="button" onClick={() => void act(() => setExemptionStatus(e.id, 'revoked'), 'Certificate revoked.')} className="focus-ring rounded-lg bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary">Revoke</button>}
                  <button type="button" aria-label="Delete certificate" onClick={() => { if (window.confirm('Delete this certificate and its file? Past invoices keep the certificate reference.')) void act(() => deleteExemption(e), 'Certificate deleted.'); }} className="focus-ring rounded p-1 text-text-secondary hover:text-danger"><Trash2 size={14} /></button>
                </div>
              </div>
              {e.status === 'verified' && !usable.applies && !expired && <p className="mt-1 text-[11px] text-text-secondary">{usable.reason}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
