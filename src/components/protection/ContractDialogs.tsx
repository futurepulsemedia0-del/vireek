import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import {
  COLLECTION_METHOD_LABELS,
  activateContract,
  attachToInvoice,
  cancelContract,
  createRenewal,
  fetchCustomerEquipment,
  fetchOpenInvoices,
  formatMoney,
  linkEquipment,
  protectionErrorMessage,
  refundCents,
  searchCustomers,
  sellPlan,
  termLabel,
  todayString,
  addDays,
  isOpenClaim,
  type CollectionMethod,
  type CustomerOption,
  type EquipmentOption,
  type OpenInvoice,
  type PlanClaim,
  type PlanTemplate,
  type ProtectionContract,
} from '@/lib/protectionPlans';
import { ErrorText, Field, Modal, fmtDate, inputClass, unitLabel } from './ui';

function useSubmit() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(protectionErrorMessage(e));
      setBusy(false);
    }
  };
  return { error, busy, run, setError };
}

function Actions({ onClose, busy, label }: { onClose: () => void; busy: boolean; label: string }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button type="button" variant="secondary" size="sm" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? 'Working…' : label}
      </Button>
    </div>
  );
}

// ─── Equipment picker (checkboxes) ─────────────────────────────────────────

function EquipmentPicker({
  customerId,
  selected,
  onChange,
  max,
  disabledIds = [],
}: {
  customerId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  max: number;
  disabledIds?: string[];
}) {
  const [items, setItems] = useState<EquipmentOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setItems(null);
    fetchCustomerEquipment(customerId)
      .then((r) => live && setItems(r))
      .catch((e) => live && setError(protectionErrorMessage(e, 'Could not load equipment.')));
    return () => {
      live = false;
    };
  }, [customerId]);

  if (error) return <ErrorText message={error} />;
  if (!items) return <p className="text-sm text-text-secondary">Loading equipment…</p>;
  if (items.length === 0) return <p className="text-sm text-text-secondary">This customer has no active equipment on file. Add it from the customer page first.</p>;

  return (
    <ul className="space-y-1.5">
      {items.map((u) => {
        const checked = selected.includes(u.id);
        const disabled = disabledIds.includes(u.id) || (!checked && selected.length >= max);
        return (
          <li key={u.id}>
            <label className={`flex items-start gap-2.5 rounded-xl border border-border p-2.5 text-sm ${disabled ? 'opacity-50' : 'cursor-pointer hover:border-accent/40'}`}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...selected, u.id] : selected.filter((x) => x !== u.id))}
              />
              <span className="min-w-0">
                <span className="block font-medium text-text-primary">{unitLabel(u)}</span>
                <span className="block text-xs text-text-secondary">
                  {u.serial_number ? `Serial ${u.serial_number}` : 'No serial'}
                  {u.install_date ? ` · installed ${fmtDate(u.install_date)}` : ' · install date unknown'}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Sell a plan (manual or straight onto an invoice) ──────────────────────

export function SellDialog({
  templates,
  presetInvoice,
  presetCustomerName,
  onClose,
  onDone,
}: {
  templates: PlanTemplate[];
  presetInvoice?: { id: string; label: string } | null;
  presetCustomerName?: string;
  onClose: () => void;
  onDone: (contractNumber: string) => void;
}) {
  const sellable = useMemo(() => templates.filter((t) => t.active), [templates]);
  const [templateId, setTemplateId] = useState(sellable[0]?.id ?? '');
  const [term, setTerm] = useState(presetCustomerName ?? '');
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [units, setUnits] = useState<string[]>([]);
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [invoiceId, setInvoiceId] = useState(presetInvoice?.id ?? '');
  const { error, busy, run } = useSubmit();
  const template = sellable.find((t) => t.id === templateId) ?? null;

  useEffect(() => {
    let live = true;
    const id = window.setTimeout(() => {
      searchCustomers(term)
        .then((r) => live && setCustomers(r))
        .catch(() => live && setCustomers([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [term]);

  useEffect(() => {
    if (presetInvoice) return;
    fetchOpenInvoices()
      .then(setInvoices)
      .catch(() => setInvoices([]));
  }, [presetInvoice]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!template || !customer) return;
    void run(async () => {
      const r = await sellPlan({ templateId: template.id, customerId: customer.id, equipmentIds: units, invoiceId: invoiceId || null });
      onDone(r.contract_number);
    });
  };

  return (
    <Modal
      wide
      title="Sell a protection plan"
      description={invoiceId ? 'The plan is added to the invoice as a line item and starts when the invoice is paid.' : 'The plan starts once you confirm payment.'}
      onClose={onClose}
    >
      {sellable.length === 0 ? (
        <p className="text-sm text-text-secondary">Turn on at least one plan in the Plans tab first.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Plan" htmlFor="sell-plan">
            <select id="sell-plan" className={inputClass} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setUnits([]); }}>
              {sellable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} — {termLabel(t.term_months)} — {formatMoney(t.price_cents)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Customer" htmlFor="sell-customer">
            {customer ? (
              <div className="flex items-center justify-between rounded-xl border border-border px-3.5 py-2.5 text-sm">
                <span className="font-medium text-text-primary">{customer.name}</span>
                <button type="button" className="focus-ring rounded text-xs text-accent" onClick={() => { setCustomer(null); setUnits([]); }}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <input id="sell-customer" className={inputClass} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search customers by name…" autoComplete="off" />
                <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                  {customers.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setCustomer(c)} className="focus-ring w-full rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary">
                        {c.name}
                      </button>
                    </li>
                  ))}
                  {customers.length === 0 && <li className="px-3 py-2 text-xs text-text-secondary">No matching customers.</li>}
                </ul>
              </>
            )}
          </Field>

          {customer && template && (
            <Field label={`Covered equipment (up to ${template.max_equipment})`}>
              <EquipmentPicker customerId={customer.id} selected={units} onChange={setUnits} max={template.max_equipment} />
              {template.eligible_equipment_types.length > 0 && (
                <p className="mt-1 text-xs text-text-secondary">Eligible types: {template.eligible_equipment_types.join(', ')}.</p>
              )}
              {template.max_equipment_age_years !== null && (
                <p className="mt-1 text-xs text-text-secondary">Units must be {template.max_equipment_age_years} years old or newer.</p>
              )}
            </Field>
          )}

          {presetInvoice ? (
            <p className="rounded-xl bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">Adding to invoice {presetInvoice.label}.</p>
          ) : (
            <Field label="Bill on an invoice (optional)" htmlFor="sell-invoice" hint="Leave empty to collect payment separately.">
              <select id="sell-invoice" className={inputClass} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                <option value="">No invoice — collect separately</option>
                {invoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.invoice_number ?? 'Invoice'} · {i.customer_name} · {i.status}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <ErrorText message={error} />
          <Actions onClose={onClose} busy={busy || !customer || units.length === 0 || !template} label="Create plan" />
        </form>
      )}
    </Modal>
  );
}

// ─── Add a pending plan to an invoice ──────────────────────────────────────

export function AttachInvoiceDialog({ contract, onClose, onDone }: { contract: ProtectionContract; onClose: () => void; onDone: () => void }) {
  const [invoices, setInvoices] = useState<OpenInvoice[] | null>(null);
  const [invoiceId, setInvoiceId] = useState(contract.invoice_id ?? '');
  const { error, busy, run } = useSubmit();

  useEffect(() => {
    fetchOpenInvoices()
      .then((r) => {
        setInvoices(r);
        setInvoiceId((cur) => cur || r.find((i) => i.customer_name.toLowerCase() === contract.customer_name.toLowerCase())?.id || '');
      })
      .catch(() => setInvoices([]));
  }, [contract.customer_name]);

  return (
    <Modal title="Add to an invoice" description={`${contract.plan_name} · ${formatMoney(contract.price_cents)} is added as a line item. The plan activates when the invoice is paid.`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!invoiceId) return;
          void run(async () => {
            await attachToInvoice(contract.id, invoiceId);
            onDone();
          });
        }}
        className="space-y-4"
      >
        {!invoices && <p className="text-sm text-text-secondary">Loading invoices…</p>}
        {invoices && invoices.length === 0 && <p className="text-sm text-text-secondary">There are no open invoices. Create one first, or use “Paid separately”.</p>}
        {invoices && invoices.length > 0 && (
          <Field label="Invoice" htmlFor="att-inv">
            <select id="att-inv" className={inputClass} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">Choose an invoice…</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoice_number ?? 'Invoice'} · {i.customer_name} · {i.status}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ErrorText message={error} />
        <Actions onClose={onClose} busy={busy || !invoiceId} label="Add to invoice" />
      </form>
    </Modal>
  );
}

// ─── Paid separately → activate ────────────────────────────────────────────

export function ActivateDialog({ contract, onClose, onDone }: { contract: ProtectionContract; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<CollectionMethod>('card');
  const [start, setStart] = useState('');
  const { error, busy, run } = useSubmit();
  const today = todayString();

  return (
    <Modal title="Confirm payment received" description={`${formatMoney(contract.price_cents)} for ${contract.plan_name}. Coverage starts on the date below.`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await activateContract(contract.id, method, start || null);
            onDone();
          });
        }}
        className="space-y-4"
      >
        <Field label="How was it paid?" htmlFor="act-method">
          <select id="act-method" className={inputClass} value={method} onChange={(e) => setMethod(e.target.value as CollectionMethod)}>
            {(Object.keys(COLLECTION_METHOD_LABELS) as CollectionMethod[]).map((m) => (
              <option key={m} value={m}>
                {COLLECTION_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Coverage starts" htmlFor="act-start" hint="Blank = today.">
          <input id="act-start" type="date" className={inputClass} value={start} min={addDays(today, -30)} max={addDays(today, 90)} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <ErrorText message={error} />
        <Actions onClose={onClose} busy={busy} label="Activate plan" />
      </form>
    </Modal>
  );
}

// ─── Link more units ───────────────────────────────────────────────────────

export function LinkUnitsDialog({ contract, onClose, onDone }: { contract: ProtectionContract; onClose: () => void; onDone: () => void }) {
  const [customerId, setCustomerId] = useState(contract.customer_id ?? '');
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [term, setTerm] = useState(contract.customer_name);
  const [units, setUnits] = useState<string[]>([]);
  const { error, busy, run } = useSubmit();
  const linked = contract.protection_contract_equipment.map((u) => u.equipment_id);
  const room = Math.max(0, contract.max_equipment - linked.length);

  useEffect(() => {
    if (contract.customer_id) return;
    let live = true;
    const id = window.setTimeout(() => {
      searchCustomers(term)
        .then((r) => live && setCustomers(r))
        .catch(() => live && setCustomers([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [term, contract.customer_id]);

  return (
    <Modal wide title="Cover equipment" description={`${linked.length} of ${contract.max_equipment} units covered. New units are covered after the plan’s ${contract.waiting_period_days}-day waiting period.`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (units.length === 0) return;
          void run(async () => {
            await linkEquipment(contract.id, units);
            onDone();
          });
        }}
        className="space-y-4"
      >
        {!contract.customer_id && (
          <Field label="Customer" htmlFor="lk-customer">
            <input id="lk-customer" className={inputClass} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search customers…" />
            <select className={`${inputClass} mt-1.5`} aria-label="Customer" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setUnits([]); }}>
              <option value="">Choose a customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {customerId ? (
          room === 0 ? (
            <p className="text-sm text-text-secondary">All {contract.max_equipment} units this plan covers are already linked.</p>
          ) : (
            <EquipmentPicker customerId={customerId} selected={units} onChange={setUnits} max={room} disabledIds={linked} />
          )
        ) : (
          <p className="text-sm text-text-secondary">Choose the customer to see their equipment.</p>
        )}
        <ErrorText message={error} />
        <Actions onClose={onClose} busy={busy || units.length === 0} label="Cover selected units" />
      </form>
    </Modal>
  );
}

// ─── Cancel ────────────────────────────────────────────────────────────────

export function CancelDialog({ contract, claims, onClose, onDone }: { contract: ProtectionContract; claims: PlanClaim[]; onClose: () => void; onDone: (refundCents: number) => void }) {
  const [reason, setReason] = useState('');
  const [effective, setEffective] = useState('');
  const { error, busy, run } = useSubmit();
  const today = todayString();
  const mine = claims.filter((c) => c.protection_contract_id === contract.id);
  const open = mine.filter((c) => isOpenClaim(c.status)).length;
  const filed = mine.filter((c) => c.status !== 'denied').length;
  const active = contract.status === 'active';

  const refund = active
    ? refundCents({
        priceCents: contract.price_cents,
        start: contract.coverage_start,
        end: contract.coverage_end,
        effective: effective || today,
        freeLookDays: contract.free_look_days,
        feeCents: contract.cancellation_fee_cents,
        paidOutCents: contract.paid_out_cents,
        claimsFiled: filed,
      })
    : 0;

  return (
    <Modal title="Cancel this plan" description={`${contract.contract_number} · ${contract.customer_name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await cancelContract(contract.id, reason, effective || null);
            onDone(r.refund_cents);
          });
        }}
        className="space-y-4"
      >
        {open > 0 && <ErrorText message={`${open} open claim${open === 1 ? '' : 's'} must be resolved or paid first.`} />}
        {active && (
          <Field label="Cancellation takes effect" htmlFor="cx-eff" hint="Blank = today. This is the first day the customer is no longer covered.">
            <input id="cx-eff" type="date" className={inputClass} value={effective} min={contract.coverage_start ?? undefined} max={addDays(today, 30)} onChange={(e) => setEffective(e.target.value)} />
          </Field>
        )}
        <Field label="Reason" htmlFor="cx-reason">
          <textarea id="cx-reason" rows={2} className={inputClass} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {active && (
          <div className="rounded-xl bg-bg-tertiary p-3 text-sm">
            <p className="font-medium text-text-primary">Refund due to customer: {formatMoney(refund)}</p>
            <p className="mt-1 text-xs text-text-secondary">
              Full refund inside the {contract.free_look_days}-day free-look period with no claims; otherwise unused time minus the {formatMoney(contract.cancellation_fee_cents)} fee and
              {' '}
              {formatMoney(contract.paid_out_cents)} already paid out. Issue the refund from the linked invoice.
            </p>
          </div>
        )}
        <ErrorText message={error} />
        <Actions onClose={onClose} busy={busy || reason.trim().length === 0 || open > 0} label="Cancel plan" />
      </form>
    </Modal>
  );
}

// ─── Renew ─────────────────────────────────────────────────────────────────

export function RenewDialog({ contract, onClose, onDone }: { contract: ProtectionContract; onClose: () => void; onDone: (number: string) => void }) {
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const { error, busy, run } = useSubmit();

  useEffect(() => {
    fetchOpenInvoices()
      .then(setInvoices)
      .catch(() => setInvoices([]));
  }, []);

  return (
    <Modal
      title="Renew this plan"
      description={`A renewal continues coverage from ${fmtDate(contract.coverage_end ? addDays(contract.coverage_end, 1) : null)} with the same terms and no new waiting period.`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await createRenewal(contract.id, invoiceId || null);
            onDone(r.contract_number);
          });
        }}
        className="space-y-4"
      >
        <Field label="Bill on an invoice (optional)" htmlFor="rn-inv">
          <select id="rn-inv" className={inputClass} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            <option value="">No invoice — collect separately</option>
            {invoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.invoice_number ?? 'Invoice'} · {i.customer_name} · {i.status}
              </option>
            ))}
          </select>
        </Field>
        <ErrorText message={error} />
        <Actions onClose={onClose} busy={busy} label="Create renewal" />
      </form>
    </Modal>
  );
}
