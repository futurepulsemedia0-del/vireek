import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Banknote, BadgePercent, CreditCard, Info, Lock, ShieldCheck, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { PricingBreakdown } from '@/components/payments/PricingBreakdown';
import {
  MAX_DISCLOSURE_LENGTH,
  MAX_LABEL_LENGTH,
  NETWORK_SURCHARGE_CAP_BPS,
  bpsToPercent,
  buildPricingDisclosure,
  buildReceiptLines,
  checkoutPricing,
  defaultLabel,
  normalizeState,
  percentToBps,
  stateRule,
  validatePricingSettings,
  type PricingMode,
  type PricingSettings,
  type SettingsErrors,
} from '@/lib/paymentPricing';
import { dollarsToCents, formatUsd } from '@/lib/tipping';
import { loadPricingSettings, savePricingSettings } from '@/lib/paymentPricingApi';

const PAGE = 'Payment Pricing';
const SAMPLE_INVOICE_CENTS = 25_000;

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO',
  'MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','PR','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

const MODES: { value: PricingMode; title: string; description: string; icon: ReactNode }[] = [
  { value: 'off', title: 'Off', description: 'Customers pay the listed price. No fee, no discount.', icon: <ShieldCheck size={18} /> },
  { value: 'surcharge', title: 'Credit card surcharge', description: 'Add a percentage to credit card payments. Capped at 3% by the card networks.', icon: <CreditCard size={18} /> },
  { value: 'convenience_fee', title: 'Convenience fee', description: 'Add a flat fee to online payments.', icon: <BadgePercent size={18} /> },
  { value: 'cash_discount', title: 'Cash discount', description: 'Listed prices include card costs; cash and check payers save a percentage. Allowed in every state.', icon: <Banknote size={18} /> },
];

interface Form {
  mode: PricingMode;
  surcharge: string;
  flat: string;
  cash: string;
  excludeDebit: boolean;
  state: string;
  label: string;
  disclosure: string;
  ack: boolean;
}

function toForm(s: PricingSettings, ack: boolean): Form {
  return {
    mode: s.mode,
    surcharge: s.surchargeBps > 0 ? bpsToPercent(s.surchargeBps) : '',
    flat: s.flatFeeCents > 0 ? (s.flatFeeCents / 100).toFixed(2) : '',
    cash: s.cashDiscountBps > 0 ? bpsToPercent(s.cashDiscountBps) : '',
    excludeDebit: s.excludeDebit,
    state: s.businessState ?? '',
    label: s.label,
    disclosure: s.disclosure,
    ack,
  };
}

/** NaN marks "typed but not a valid number" so validation can flag it. Empty means 0. */
function toSettings(f: Form): PricingSettings {
  const bps = (t: string) => (t.trim() === '' ? 0 : percentToBps(t) ?? Number.NaN);
  const flat = f.flat.trim() === '' ? 0 : dollarsToCents(f.flat) ?? Number.NaN;
  return {
    mode: f.mode,
    surchargeBps: bps(f.surcharge),
    flatFeeCents: flat,
    cashDiscountBps: bps(f.cash),
    excludeDebit: f.excludeDebit,
    businessState: normalizeState(f.state),
    label: f.label,
    disclosure: f.disclosure,
  };
}

/** Values for rates that are not the active mode are kept only if the database would accept them. */
function toPayload(s: PricingSettings): PricingSettings {
  const sane = (n: number, max: number) => (Number.isInteger(n) && n >= 0 && n <= max ? n : 0);
  return {
    ...s,
    surchargeBps: sane(s.surchargeBps, NETWORK_SURCHARGE_CAP_BPS),
    flatFeeCents: sane(s.flatFeeCents, 5000),
    cashDiscountBps: sane(s.cashDiscountBps, 500),
  };
}

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <p className="text-xs text-text-secondary">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

function Callout({ tone, children }: { tone: 'danger' | 'warning' | 'info'; children: ReactNode }) {
  const styles = {
    danger: 'border-danger/40 bg-danger/10 text-danger',
    warning: 'border-warning-500/40 bg-warning-500/10 text-warning-500',
    info: 'border-border bg-bg-primary text-text-secondary',
  }[tone];
  return (
    <p role={tone === 'danger' ? 'alert' : 'note'} className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed ${styles}`}>
      {tone === 'info' ? <Info size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

function NoAccess() {
  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Payment pricing is restricted. Ask your account owner to grant you the "Edit Business Profile" permission.
        </p>
      </div>
    </DashboardLayout>
  );
}

export function PaymentPricingSettingsPage() {
  const auth = useAuth();
  const { permissions, profileLoading } = auth;
  const { toast } = useToast();
  // Team members read and write the OWNER's row (RLS enforces the same in Postgres).
  const ownerId =
    (auth as unknown as { accountOwnerId?: string }).accountOwnerId ?? auth.teamMember?.account_owner_id ?? auth.user?.id ?? null;

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [saved, setSaved] = useState<Form | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(async () => {
    if (!ownerId) return;
    setStatus('loading');
    try {
      const result = await loadPricingSettings(ownerId);
      const next = toForm(result.settings, result.acknowledgedAt !== null);
      setSaved(next);
      setForm(next);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [ownerId]);

  useEffect(() => { void load(); }, [load]);

  const dirty = useMemo(() => Boolean(form && saved && JSON.stringify(form) !== JSON.stringify(saved)), [form, saved]);
  const settings = useMemo(() => (form ? toSettings(form) : null), [form]);
  const validation = useMemo<{ ok: boolean; errors: SettingsErrors }>(
    () => (settings && settings.mode !== 'off' ? validatePricingSettings(settings) : { ok: true, errors: {} }),
    [settings],
  );
  const errors: Record<string, string | undefined> = { ...validation.errors };
  if (form && form.mode !== 'off' && !form.ack) errors.ack = 'Confirm that you have read this before turning pricing on.';
  const shown: Record<string, string | undefined> = showErrors ? errors : {};

  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const rule = form && (form.mode === 'surcharge' || form.mode === 'convenience_fee') ? stateRule(normalizeState(form.state)) : null;

  const preview = useMemo(() => {
    if (!settings || settings.mode === 'off' || !validation.ok) return null;
    const p = checkoutPricing(SAMPLE_INVOICE_CENTS, 0, settings);
    const receipt = buildReceiptLines({ baseCents: p.baseCents, tipCents: 0, feeCents: p.feeCents, feeRefundedCents: 0, feeLabel: p.feeLabel });
    return { p, receipt, disclosure: buildPricingDisclosure(settings) };
  }, [settings, validation.ok]);

  if (profileLoading) return <DashboardLayout activeLabel={PAGE}><SkeletonCardList count={3} rows={3} /></DashboardLayout>;
  if (!permissions.can_edit_business_profile) return <NoAccess />;

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const handleSave = async () => {
    if (!form || !settings || !ownerId) return;
    setShowErrors(true);
    if (Object.keys(errors).filter((k) => errors[k]).length > 0) { toast('Fix the highlighted fields to save.', 'error'); return; }
    setSaving(true);
    const result = await savePricingSettings(ownerId, toPayload(settings), form.mode !== 'off' && form.ack);
    setSaving(false);
    if (!result.ok) {
      toast(
        result.reason === 'forbidden' ? 'Only account owners and admins can change payment pricing.'
          : result.reason === 'invalid' ? 'These settings aren’t allowed for your state. Review the highlighted fields.'
          : 'Could not save payment pricing. Please try again.',
        'error',
      );
      return;
    }
    const next = { ...form, ack: form.mode !== 'off' ? form.ack : saved?.ack ?? false };
    setSaved(next);
    setForm(next);
    setShowErrors(false);
    toast('Payment pricing saved.', 'success');
  };

  const handleDiscard = () => {
    if (!saved) return;
    setForm(saved);
    setShowErrors(false);
  };

  const feeMode = form?.mode === 'surcharge' || form?.mode === 'convenience_fee';

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><BadgePercent size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Payment Pricing</h1>
          <p className="text-sm text-text-secondary">Card surcharge, convenience fee or cash discount — shown to customers before they pay and itemised on every receipt.</p>
        </div>
      </div>

      {status === 'loading' && <SkeletonCardList count={3} rows={3} />}

      {status === 'error' && (
        <EmptyState icon={AlertTriangle} title="Couldn't load payment pricing" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      )}

      {status === 'ready' && form && settings && (
        <div className="space-y-5 pb-28">
          <Section icon={<BadgePercent size={18} />} title="Pricing model" description="Pick one. They can't be combined, so customers never pay a fee and get a discount on the same bill.">
            <div role="radiogroup" aria-label="Pricing model" className="grid gap-3 sm:grid-cols-2">
              {MODES.map((m) => {
                const active = form.mode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => set({ mode: m.value })}
                    className={`focus-ring flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${active ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:border-accent/50'}`}
                  >
                    <span className={`mt-0.5 ${active ? 'text-accent' : 'text-text-secondary'}`}>{m.icon}</span>
                    <span>
                      <span className="block text-sm font-medium text-text-primary">{m.title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">{m.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {shown.mode && <p role="alert" className="mt-3 text-xs text-danger">{shown.mode}</p>}
          </Section>

          {form.mode !== 'off' && (
            <Section icon={<CreditCard size={18} />} title="Rates and wording" description="What customers are charged and what they read.">
              <div className="grid gap-4 sm:grid-cols-2">
                {form.mode === 'surcharge' && (
                  <Input label="Surcharge (%)" inputMode="decimal" placeholder="3" value={form.surcharge} error={shown.surcharge}
                    helperText={`Percent of the invoice, added to credit cards only. Never more than ${bpsToPercent(rule?.capBps ?? NETWORK_SURCHARGE_CAP_BPS)}%.`}
                    onChange={(e) => set({ surcharge: e.target.value })} />
                )}
                {form.mode === 'convenience_fee' && (
                  <Input label="Convenience fee (USD)" inputMode="decimal" placeholder="4.95" value={form.flat} error={shown.flat}
                    helperText="Flat amount added to each online payment (max $50.00)." onChange={(e) => set({ flat: e.target.value })} />
                )}
                {form.mode === 'cash_discount' && (
                  <Input label="Cash discount (%)" inputMode="decimal" placeholder="3" value={form.cash} error={shown.cash}
                    helperText="Taken off the listed price when the customer pays cash or check (max 5%)." onChange={(e) => set({ cash: e.target.value })} />
                )}

                {feeMode && (
                  <div>
                    <label htmlFor="pricing-state" className="mb-1.5 block text-sm font-medium text-text-primary">Business state</label>
                    <select id="pricing-state" value={form.state} onChange={(e) => set({ state: e.target.value })}
                      className="focus-ring h-12 w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary">
                      <option value="">Choose a state…</option>
                      {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {shown.state && <p role="alert" className="mt-1 text-xs text-danger">{shown.state}</p>}
                  </div>
                )}

                <Input label="Label on receipts (optional)" maxLength={MAX_LABEL_LENGTH + 10} placeholder={defaultLabel(form.mode)} value={form.label} error={shown.label}
                  onChange={(e) => set({ label: e.target.value })} />

                {form.mode === 'surcharge' && (
                  <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-primary px-4 py-3 sm:col-span-2">
                    <div>
                      <p className="text-sm font-medium text-text-primary">Don't charge on debit, prepaid or bank payments</p>
                      <p className="text-xs text-text-secondary">Recommended and required by the card networks. The fee is refunded automatically if the customer pays that way.</p>
                    </div>
                    <Switch checked={form.excludeDebit} label="Don't surcharge debit, prepaid or bank payments" onChange={(v) => set({ excludeDebit: v })} />
                  </div>
                )}

                <div className="sm:col-span-2">
                  <Textarea label="Extra notice for customers (optional)" rows={2} maxLength={MAX_DISCLOSURE_LENGTH + 20} value={form.disclosure} error={shown.disclosure}
                    placeholder="Added after the standard notice shown on the payment page." onChange={(e) => set({ disclosure: e.target.value })} />
                </div>
              </div>

              {rule?.kind === 'banned' && <Callout tone="danger">Card surcharges and fees are prohibited by law in this state. Choose the cash discount model instead; it is allowed everywhere.</Callout>}
              {rule?.kind === 'restricted' && <Callout tone="warning">Rules for surcharging in this state are restrictive or disputed. Check with your attorney or payment processor before turning this on.</Callout>}
              {rule?.kind === 'capped' && <Callout tone="info">This state caps surcharges at {bpsToPercent(rule.capBps)}%, lower than the card networks' 3%.</Callout>}
              {form.mode === 'surcharge' && <Callout tone="info">Visa and Mastercard require 30 days' written notice before you start surcharging, and the surcharge can never exceed your actual cost of accepting the card.</Callout>}
              {form.mode === 'convenience_fee' && <Callout tone="info">Convenience fees are kept on every online payment method. Card-brand rules for convenience fees differ from surcharges, so confirm yours with your processor.</Callout>}
              {form.mode === 'cash_discount' && <Callout tone="info">Technicians see the cash price when recording cash or check. The discount is recorded on the job and shown on the receipt. Online card payments pay the listed price.</Callout>}
            </Section>
          )}

          {preview && (
            <Section icon={<Info size={18} />} title="What customers will see" description={`Example with a ${formatUsd(SAMPLE_INVOICE_CENTS)} invoice.`}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-bg-primary p-4">
                  <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-text-secondary">Card payment</p>
                  <PricingBreakdown lines={preview.receipt.lines} totalCents={preview.p.totalCents} />
                </div>
                {preview.p.cashPriceCents !== null && (
                  <div className="rounded-xl border border-border bg-bg-primary p-4">
                    <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-text-secondary">Cash or check</p>
                    <PricingBreakdown
                      lines={[{ key: 'invoice', label: 'Listed price', cents: preview.p.baseCents }, { key: 'fee_refund', label: 'Cash discount', cents: -preview.p.cashDiscountCents }]}
                      totalCents={preview.p.cashPriceCents}
                      totalLabel="You pay"
                    />
                  </div>
                )}
              </div>
              <p className="mt-4 rounded-xl bg-bg-primary px-3 py-2 text-xs leading-relaxed text-text-secondary">{preview.disclosure}</p>
            </Section>
          )}

          {form.mode !== 'off' && (
            <Section icon={<ShieldCheck size={18} />} title="Your responsibility" description="Laws and card-network rules change. Vireek enforces the limits below, but compliance is yours.">
              <label className="flex cursor-pointer items-start gap-3 text-sm text-text-secondary">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={form.ack} onChange={(e) => set({ ack: e.target.checked })} />
                <span>
                  I understand this is not legal advice. I have checked that this pricing is allowed in my state and under my merchant agreement,
                  and I will give my card processor any required notice.
                </span>
              </label>
              {shown.ack && <p role="alert" className="mt-2 text-xs text-danger">{shown.ack}</p>}
            </Section>
          )}
        </div>
      )}

      {status === 'ready' && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg-secondary/95 px-4 py-3 backdrop-blur" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">You have unsaved changes</p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={saving}>Discard</Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
