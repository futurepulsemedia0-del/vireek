import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  CONTRACT_STATUS_COLORS,
  CONTRACT_STATUS_LABELS,
  effectiveStatus,
  fetchTemplates,
  formatMoney,
  protectionErrorMessage,
  fetchContractsForInvoice,
  type PlanTemplate,
  type ProtectionContract,
} from '@/lib/protectionPlans';
import { SellDialog } from './ContractDialogs';
import { Pill, cardClass } from './ui';

/**
 * Drop-in card for the invoice detail page: shows the protection plans billed on this invoice and lets
 * a billing user add one. Renders nothing for users without billing access or when the feature's
 * tables are not installed yet, so it can never break the invoice page.
 */
export function InvoiceProtectionCard({
  invoiceId,
  invoiceLabel,
  customerName,
  invoiceOpen,
  canManage,
}: {
  invoiceId: string;
  invoiceLabel: string;
  customerName: string;
  /** true for draft / sent / viewed invoices */
  invoiceOpen: boolean;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const [contracts, setContracts] = useState<ProtectionContract[]>([]);
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [available, setAvailable] = useState(false);
  const [selling, setSelling] = useState(false);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      const [c, t] = await Promise.all([fetchContractsForInvoice(invoiceId), fetchTemplates()]);
      setContracts(c);
      setTemplates(t);
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, [canManage, invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canManage || !available) return null;
  if (contracts.length === 0 && (!invoiceOpen || templates.filter((t) => t.active).length === 0)) return null;

  return (
    <section className={cardClass} aria-label="Protection plans on this invoice">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ShieldCheck size={16} className="text-accent" /> Protection plans
        </h2>
        {invoiceOpen && templates.some((t) => t.active) && (
          <Button size="sm" variant="secondary" onClick={() => setSelling(true)}>
            <ShieldPlus size={14} /> Add protection plan
          </Button>
        )}
      </div>

      {contracts.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">Offer extended coverage on this job. The plan is added as a line item and starts when the invoice is paid.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {contracts.map((c) => {
            const status = effectiveStatus(c);
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    {c.plan_name} · {formatMoney(c.price_cents)}
                  </p>
                  <p className="text-xs text-text-secondary">{c.contract_number}</p>
                </div>
                <Pill className={CONTRACT_STATUS_COLORS[status]}>{CONTRACT_STATUS_LABELS[status]}</Pill>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-text-secondary">
        Manage claims and renewals in <Link to="/dashboard/protection-plans" className="focus-ring rounded text-accent">Protection Plans</Link>.
      </p>

      {selling && (
        <SellDialog
          templates={templates}
          presetInvoice={{ id: invoiceId, label: invoiceLabel }}
          presetCustomerName={customerName}
          onClose={() => setSelling(false)}
          onDone={(n) => {
            setSelling(false);
            toast(`Plan ${n} added to the invoice`, 'success');
            void load().catch((e: unknown) => toast(protectionErrorMessage(e), 'error'));
          }}
        />
      )}
    </section>
  );
}
