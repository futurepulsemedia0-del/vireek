/**
 * Modal forms for Vendor Management. Every submit goes through the validated
 * helpers in src/lib/vendorManagement.ts (same rules the unit tests cover).
 * Vendor evaluations reuse submitVendorEvaluation from the procurement module.
 */

import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { PO_STATUS_LABELS, submitVendorEvaluation } from '@/lib/procurement';
import type { PurchaseOrder } from '@/lib/procurement';
import type { InventoryVendor } from '@/lib/inventory';
import {
  CONTRACT_STATUS_OPTIONS,
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPE_OPTIONS,
  DOC_TYPE_LABELS,
  DOC_TYPE_OPTIONS,
  INCIDENT_TYPE_LABELS,
  INCIDENT_TYPE_OPTIONS,
  SEVERITY_LABELS,
  TIER_LABELS,
  TIER_OPTIONS,
  centsToInput,
  createVendorProfile,
  fetchLinkableInventoryVendors,
  linkInventoryVendor,
  parseMoneyToCents,
  saveVendorContract,
  saveVendorDocument,
  saveVendorIncident,
  setVendorIncidentStatus,
  suggestInventoryVendor,
  updateVendorProfile,
} from '@/lib/vendorManagement';
import type {
  VendorContract,
  VendorContractInput,
  VendorDocType,
  VendorDocument,
  VendorIncident,
  VendorIncidentSeverity,
  VendorIncidentType,
  VendorOverviewRow,
  VendorTier,
} from '@/lib/vendorManagement';

// ============================================================
// SHARED PIECES
// ============================================================

const selectCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary disabled:opacity-50';

const nz = (s: string): string | null => s.trim() || null;

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Turns DB / network errors into something a person can act on. */
function friendlyError(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : '';
  if (/idx_vendors_inventory_vendor_link|duplicate key/i.test(msg)) return 'That inventory vendor is already linked to another vendor.';
  if (/vendors_blocked_not_active/i.test(msg)) return 'A blocked vendor has to stay inactive.';
  if (/row-level security|violates row-level/i.test(msg)) return 'You do not have permission to change this vendor.';
  if (e instanceof Error && !/^(\{|PGRST|new row|insert|update|violates|null value|invalid input)/i.test(msg) && msg.length < 160) return msg;
  return fallback;
}

function useSubmit(onDone: () => void, successMessage: string, fallbackError: string) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await fn();
      toast(successMessage, 'success');
      onDone();
    } catch (e) {
      setError(friendlyError(e, fallbackError));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, setError, run };
}

export function ModalShell({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`max-h-[88vh] w-full overflow-y-auto rounded-2xl border border-border bg-bg-primary p-5 shadow-xl ${
          wide ? 'max-w-2xl' : 'max-w-md'
        }`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = `sel-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={selectCls}>
        {children}
      </select>
    </div>
  );
}

const Grid2 = ({ children }: { children: ReactNode }) => <div className="grid gap-3 sm:grid-cols-2">{children}</div>;

function FormFooter({
  saving,
  error,
  onClose,
  submitLabel,
}: {
  saving: boolean;
  error: string | null;
  onClose: () => void;
  submitLabel: string;
}) {
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
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// ADD / EDIT VENDOR
// ============================================================

interface ProfileFormState {
  name: string;
  category: string;
  contact_name: string;
  email: string;
  phone: string;
  website: string;
  payment_terms: string;
  address: string;
  notes: string;
}

const emptyProfile: ProfileFormState = {
  name: '',
  category: '',
  contact_name: '',
  email: '',
  phone: '',
  website: '',
  payment_terms: '',
  address: '',
  notes: '',
};

function ProfileFields({
  f,
  set,
}: {
  f: ProfileFormState;
  set: <K extends keyof ProfileFormState>(k: K, v: string) => void;
}) {
  return (
    <>
      <Input label="Vendor name" required value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
      <Grid2>
        <Input label="Category" placeholder="HVAC parts, electrical…" value={f.category} onChange={(e) => set('category', e.target.value)} />
        <Input label="Payment terms" placeholder="Net 30" value={f.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} />
      </Grid2>
      <Grid2>
        <Input label="Contact name" value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} />
        <Input label="Phone" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
      </Grid2>
      <Grid2>
        <Input label="Email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        <Input label="Website" placeholder="acme.com" value={f.website} onChange={(e) => set('website', e.target.value)} />
      </Grid2>
      <Input label="Address" value={f.address} onChange={(e) => set('address', e.target.value)} />
      <Textarea label="Notes" rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
    </>
  );
}

export function AddVendorModal({ onClose, onCreated }: { onClose: () => void; onCreated: (vendorId: string) => void }) {
  const [f, setF] = useState<ProfileFormState>(emptyProfile);
  const [tier, setTier] = useState<VendorTier>('approved');
  const [required, setRequired] = useState<string[]>(['w9', 'coi']);
  const { saving, error, run } = useSubmit(onClose, 'Vendor added', 'Could not add this vendor.');
  const set = <K extends keyof ProfileFormState>(k: K, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const id = await createVendorProfile({
        name: f.name,
        category: nz(f.category),
        contact_name: nz(f.contact_name),
        email: nz(f.email),
        phone: nz(f.phone),
        website: nz(f.website),
        payment_terms: nz(f.payment_terms),
        address: nz(f.address),
        notes: nz(f.notes),
        tier,
        required_documents: required,
      });
      onCreated(id);
    });
  };

  return (
    <ModalShell title="Add vendor" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <ProfileFields f={f} set={set} />
        <Select label="Tier" value={tier} onChange={(v) => setTier(v as VendorTier)}>
          {TIER_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {TIER_LABELS[t]}
            </option>
          ))}
        </Select>
        <RequiredDocsField value={required} onChange={setRequired} />
        <FormFooter saving={saving} error={error} onClose={onClose} submitLabel="Add vendor" />
      </form>
    </ModalShell>
  );
}

const REQUIRED_DOC_CHOICES = DOC_TYPE_OPTIONS.filter((t) => t !== 'other');

function RequiredDocsField({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-text-primary">Required compliance documents</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {REQUIRED_DOC_CHOICES.map((t) => (
          <label key={t} className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={value.includes(t)}
              onChange={(e) => onChange(e.target.checked ? [...value, t] : value.filter((x) => x !== t))}
            />
            {DOC_TYPE_LABELS[t]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function EditVendorModal({
  vendor,
  onClose,
  onSaved,
}: {
  vendor: VendorOverviewRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<ProfileFormState>({
    name: vendor.name,
    category: vendor.category ?? '',
    contact_name: vendor.contact_name ?? '',
    email: vendor.email ?? '',
    phone: vendor.phone ?? '',
    website: vendor.website ?? '',
    payment_terms: vendor.payment_terms ?? '',
    address: vendor.address ?? '',
    notes: vendor.notes ?? '',
  });
  const [cadence, setCadence] = useState(String(vendor.review_cadence_days));
  const [required, setRequired] = useState<string[]>(vendor.required_documents);
  const { saving, error, setError, run } = useSubmit(
    () => {
      onSaved();
      onClose();
    },
    'Vendor updated',
    'Could not save the vendor.',
  );
  const set = <K extends keyof ProfileFormState>(k: K, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const days = Number(cadence);
    if (!Number.isInteger(days) || days < 30 || days > 730) {
      setError('Review cadence must be a whole number of days between 30 and 730.');
      return;
    }
    void run(() =>
      updateVendorProfile(vendor.vendor_id, {
        name: f.name,
        category: nz(f.category),
        contact_name: nz(f.contact_name),
        email: nz(f.email),
        phone: nz(f.phone),
        website: nz(f.website),
        payment_terms: nz(f.payment_terms),
        address: nz(f.address),
        notes: nz(f.notes),
        review_cadence_days: days,
        required_documents: required,
      }),
    );
  };

  return (
    <ModalShell title={`Edit ${vendor.name}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <ProfileFields f={f} set={set} />
        <Input
          label="Review cadence (days)"
          type="number"
          min={30}
          max={730}
          value={cadence}
          helperText="How often this vendor should be formally reviewed."
          onChange={(e) => setCadence(e.target.value)}
        />
        <RequiredDocsField value={required} onChange={setRequired} />
        <FormFooter saving={saving} error={error} onClose={onClose} submitLabel="Save changes" />
      </form>
    </ModalShell>
  );
}

// ============================================================
// CONTRACT
// ============================================================

export function ContractModal({
  vendorId,
  contract,
  onClose,
  onSaved,
}: {
  vendorId: string;
  contract: VendorContract | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    title: contract?.title ?? '',
    contract_type: (contract?.contract_type ?? 'master_supply') as VendorContractInput['contract_type'],
    status: (contract?.status ?? 'active') as VendorContractInput['status'],
    start_date: contract?.start_date ?? '',
    end_date: contract?.end_date ?? '',
    renewal_notice_days: String(contract?.renewal_notice_days ?? 60),
    auto_renew: contract?.auto_renew ?? false,
    value: centsToInput(contract?.value_cents),
    discount: contract?.discount_percent === null || contract?.discount_percent === undefined ? '' : String(contract.discount_percent),
    payment_terms: contract?.payment_terms ?? '',
    document_url: contract?.document_url ?? '',
    notes: contract?.notes ?? '',
  });
  const { saving, error, setError, run } = useSubmit(
    () => {
      onSaved();
      onClose();
    },
    contract ? 'Contract updated' : 'Contract added',
    'Could not save the contract.',
  );
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = parseMoneyToCents(f.value);
    if (value !== null && Number.isNaN(value)) {
      setError('Enter the contract value as a dollar amount, e.g. 12500.00');
      return;
    }
    const discount = f.discount.trim() === '' ? null : Number(f.discount);
    if (discount !== null && Number.isNaN(discount)) {
      setError('Enter the discount as a number, e.g. 7.5');
      return;
    }
    const input: VendorContractInput = {
      title: f.title,
      contract_type: f.contract_type,
      status: f.status,
      start_date: nz(f.start_date),
      end_date: nz(f.end_date),
      auto_renew: f.auto_renew,
      renewal_notice_days: Number(f.renewal_notice_days),
      value_cents: value,
      discount_percent: discount,
      payment_terms: nz(f.payment_terms),
      document_url: nz(f.document_url),
      notes: nz(f.notes),
    };
    void run(() => saveVendorContract(vendorId, input, contract?.id));
  };

  return (
    <ModalShell title={contract ? 'Edit contract' : 'Add contract'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <Input label="Title" required value={f.title} onChange={(e) => set('title', e.target.value)} />
        <Grid2>
          <Select label="Type" value={f.contract_type} onChange={(v) => set('contract_type', v as VendorContractInput['contract_type'])}>
            {CONTRACT_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {CONTRACT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Select label="Status" value={f.status} onChange={(v) => set('status', v as VendorContractInput['status'])}>
            {CONTRACT_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </Grid2>
        <Grid2>
          <Input label="Start date" type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} />
          <Input label="End date" type="date" value={f.end_date} onChange={(e) => set('end_date', e.target.value)} />
        </Grid2>
        <Grid2>
          <Input
            label="Renewal notice (days)"
            type="number"
            min={0}
            max={365}
            value={f.renewal_notice_days}
            helperText="You are alerted this many days before the end date."
            onChange={(e) => set('renewal_notice_days', e.target.value)}
          />
          <label className="flex items-center gap-2 self-end pb-3 text-sm text-text-primary">
            <input type="checkbox" checked={f.auto_renew} onChange={(e) => set('auto_renew', e.target.checked)} />
            Auto-renews
          </label>
        </Grid2>
        <Grid2>
          <Input label="Contract value (USD)" inputMode="decimal" placeholder="12500.00" value={f.value} onChange={(e) => set('value', e.target.value)} />
          <Input label="Negotiated discount (%)" inputMode="decimal" placeholder="7.5" value={f.discount} onChange={(e) => set('discount', e.target.value)} />
        </Grid2>
        <Input label="Payment terms" placeholder="Net 45" value={f.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} />
        <Input label="Document link" placeholder="https://…" value={f.document_url} onChange={(e) => set('document_url', e.target.value)} />
        <Textarea label="Notes" rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <FormFooter saving={saving} error={error} onClose={onClose} submitLabel={contract ? 'Save contract' : 'Add contract'} />
      </form>
    </ModalShell>
  );
}

// ============================================================
// COMPLIANCE DOCUMENT
// ============================================================

export function DocumentModal({
  vendorId,
  document: doc,
  defaultType,
  onClose,
  onSaved,
}: {
  vendorId: string;
  document: VendorDocument | null;
  defaultType?: VendorDocType;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    doc_type: (doc?.doc_type ?? defaultType ?? 'w9') as VendorDocType,
    title: doc?.title ?? '',
    issued_on: doc?.issued_on ?? '',
    expires_on: doc?.expires_on ?? '',
    document_url: doc?.document_url ?? '',
    notes: doc?.notes ?? '',
  });
  const { saving, error, run } = useSubmit(
    () => {
      onSaved();
      onClose();
    },
    doc ? 'Document updated' : 'Document added',
    'Could not save the document.',
  );
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() =>
      saveVendorDocument(
        vendorId,
        {
          doc_type: f.doc_type,
          title: nz(f.title),
          issued_on: nz(f.issued_on),
          expires_on: nz(f.expires_on),
          document_url: nz(f.document_url),
          notes: nz(f.notes),
        },
        doc?.id,
      ),
    );
  };

  return (
    <ModalShell title={doc ? 'Edit document' : 'Add compliance document'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Select label="Document type" value={f.doc_type} onChange={(v) => set('doc_type', v as VendorDocType)}>
          {DOC_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {DOC_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <Input label="Title (optional)" value={f.title} onChange={(e) => set('title', e.target.value)} />
        <Grid2>
          <Input label="Issued" type="date" value={f.issued_on} onChange={(e) => set('issued_on', e.target.value)} />
          <Input label="Expires" type="date" value={f.expires_on} onChange={(e) => set('expires_on', e.target.value)} />
        </Grid2>
        <Input label="Document link" placeholder="https://…" value={f.document_url} onChange={(e) => set('document_url', e.target.value)} />
        <Textarea label="Notes" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <FormFooter saving={saving} error={error} onClose={onClose} submitLabel={doc ? 'Save document' : 'Add document'} />
      </form>
    </ModalShell>
  );
}

// ============================================================
// INCIDENTS
// ============================================================

export function IncidentModal({
  vendorId,
  orders,
  onClose,
  onSaved,
}: {
  vendorId: string;
  orders: PurchaseOrder[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    incident_type: 'late_delivery' as VendorIncidentType,
    severity: '1',
    summary: '',
    occurred_on: todayInput(),
    cost: '',
    po_id: '',
  });
  const { saving, error, setError, run } = useSubmit(
    () => {
      onSaved();
      onClose();
    },
    'Incident logged',
    'Could not log the incident.',
  );
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cost = parseMoneyToCents(f.cost);
    if (cost !== null && Number.isNaN(cost)) {
      setError('Enter the cost impact as a dollar amount, e.g. 250.00');
      return;
    }
    void run(() =>
      saveVendorIncident(vendorId, {
        incident_type: f.incident_type,
        severity: Number(f.severity) as VendorIncidentSeverity,
        summary: f.summary,
        occurred_on: f.occurred_on,
        cost_impact_cents: cost ?? 0,
        po_id: f.po_id || null,
      }),
    );
  };

  return (
    <ModalShell title="Log vendor incident" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Grid2>
          <Select label="Type" value={f.incident_type} onChange={(v) => set('incident_type', v as VendorIncidentType)}>
            {INCIDENT_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {INCIDENT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Select label="Severity" value={f.severity} onChange={(v) => set('severity', v)}>
            {([1, 2, 3] as VendorIncidentSeverity[]).map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </Select>
        </Grid2>
        <Textarea label="What happened?" required rows={3} value={f.summary} onChange={(e) => set('summary', e.target.value)} />
        <Grid2>
          <Input label="Date" type="date" required value={f.occurred_on} onChange={(e) => set('occurred_on', e.target.value)} />
          <Input label="Cost impact (USD)" inputMode="decimal" placeholder="0.00" value={f.cost} onChange={(e) => set('cost', e.target.value)} />
        </Grid2>
        {orders.length > 0 && (
          <Select label="Related purchase order (optional)" value={f.po_id} onChange={(v) => set('po_id', v)}>
            <option value="">None</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.po_number} · {PO_STATUS_LABELS[o.status]}
              </option>
            ))}
          </Select>
        )}
        <p className="text-xs text-text-secondary">Open incidents raise this vendor&apos;s risk score until they are resolved.</p>
        <FormFooter saving={saving} error={error} onClose={onClose} submitLabel="Log incident" />
      </form>
    </ModalShell>
  );
}

export function ResolveIncidentModal({
  incident,
  onClose,
  onSaved,
}: {
  incident: VendorIncident;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState('');
  const { saving, error, run } = useSubmit(
    () => {
      onSaved();
      onClose();
    },
    'Incident resolved',
    'Could not resolve the incident.',
  );
  return (
    <ModalShell title="Resolve incident" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => setVendorIncidentStatus(incident.id, 'resolved', notes));
        }}
        className="space-y-3"
      >
        <p className="text-sm text-text-secondary">{incident.summary}</p>
        <Textarea label="Resolution notes (optional)" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <FormFooter saving={saving} error={error} onClose={onClose} submitLabel="Mark resolved" />
      </form>
    </ModalShell>
  );
}

// ============================================================
// EVALUATION  (writes to procurement's vendor_evaluations)
// ============================================================

export function EvaluationModal({
  vendorId,
  vendorName,
  orders,
  onClose,
  onSaved,
}: {
  vendorId: string;
  vendorName: string;
  orders: PurchaseOrder[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({ po_id: '', on_time: '', quality: '', price: '', communication: '', notes: '' });
  const { saving, error, setError, run } = useSubmit(
    () => {
      onSaved();
      onClose();
    },
    'Evaluation saved',
    'Could not save the evaluation.',
  );
  const set = <K extends keyof typeof f>(k: K, v: string) => setF((p) => ({ ...p, [k]: v }));
  const score = (v: string) => (v === '' ? null : Number(v));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.on_time === '' && f.quality === '' && f.price === '' && f.communication === '') {
      setError('Rate at least one area (or whether the delivery was on time).');
      return;
    }
    void run(() =>
      submitVendorEvaluation({
        vendor_id: vendorId,
        po_id: f.po_id || null,
        on_time: f.on_time === '' ? null : f.on_time === 'yes',
        quality_score: score(f.quality),
        price_score: score(f.price),
        communication_score: score(f.communication),
        notes: nz(f.notes),
      }),
    );
  };

  const ratingOptions = (
    <>
      <option value="">Not rated</option>
      {[5, 4, 3, 2, 1].map((n) => (
        <option key={n} value={n}>
          {n} / 5
        </option>
      ))}
    </>
  );

  return (
    <ModalShell title={`Evaluate ${vendorName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {orders.length > 0 && (
          <Select label="Purchase order (optional)" value={f.po_id} onChange={(v) => set('po_id', v)}>
            <option value="">General evaluation</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.po_number} · {PO_STATUS_LABELS[o.status]}
              </option>
            ))}
          </Select>
        )}
        <Select label="Delivered on time?" value={f.on_time} onChange={(v) => set('on_time', v)}>
          <option value="">Not sure</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
        <Grid2>
          <Select label="Quality" value={f.quality} onChange={(v) => set('quality', v)}>
            {ratingOptions}
          </Select>
          <Select label="Price" value={f.price} onChange={(v) => set('price', v)}>
            {ratingOptions}
          </Select>
        </Grid2>
        <Select label="Communication" value={f.communication} onChange={(v) => set('communication', v)}>
          {ratingOptions}
        </Select>
        <Textarea label="Notes (optional)" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        <FormFooter saving={saving} error={error} onClose={onClose} submitLabel="Save evaluation" />
      </form>
    </ModalShell>
  );
}

// ============================================================
// INVENTORY LINK
// ============================================================

export function LinkInventoryModal({
  vendor,
  linkedIds,
  onClose,
  onSaved,
}: {
  vendor: VendorOverviewRow;
  linkedIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [candidates, setCandidates] = useState<InventoryVendor[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState(vendor.inventory_vendor_id ?? '');
  const { saving, error, run } = useSubmit(
    () => {
      onSaved();
      onClose();
    },
    'Inventory link updated',
    'Could not update the inventory link.',
  );

  useEffect(() => {
    let alive = true;
    fetchLinkableInventoryVendors(linkedIds, vendor.inventory_vendor_id)
      .then((list) => {
        if (!alive) return;
        setCandidates(list);
        if (!vendor.inventory_vendor_id) {
          const hit = suggestInventoryVendor(vendor, list);
          if (hit) setSelected(hit.id);
        }
      })
      .catch(() => {
        if (alive) setLoadFailed(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ModalShell title="Link inventory vendor" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => linkInventoryVendor(vendor.vendor_id, selected || null));
        }}
        className="space-y-3"
      >
        <p className="text-sm text-text-secondary">
          Linking connects <strong className="text-text-primary">{vendor.name}</strong> to its entry in Parts &amp; Inventory, so the
          catalog (SKUs, costs, lead times) shows up under Pricing &amp; catalog.
        </p>
        {loadFailed ? (
          <p role="alert" className="text-sm text-danger">
            Could not load your inventory vendors. Close this dialog and try again.
          </p>
        ) : candidates === null ? (
          <p className="text-sm text-text-secondary">Loading inventory vendors…</p>
        ) : (
          <Select label="Inventory vendor" value={selected} onChange={setSelected}>
            <option value="">Not linked</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <FormFooter saving={saving || candidates === null} error={error} onClose={onClose} submitLabel="Save link" />
      </form>
    </ModalShell>
  );
}
