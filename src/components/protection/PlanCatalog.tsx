import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, Pencil, Plus, Power, ShieldCheck, Tag } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  EMPTY_TEMPLATE,
  TEMPLATE_PRESETS,
  fetchOpenQuotes,
  formatMoney,
  isOfferedOnQuote,
  offerOnQuote,
  parseList,
  parseMoney,
  protectionErrorMessage,
  removeFromQuote,
  saveTemplate,
  setTemplateActive,
  termLabel,
  validateTemplate,
  type OpenQuote,
  type PlanTemplate,
  type TemplateInput,
} from '@/lib/protectionPlans';
import { ErrorText, Field, Modal, Pill, cardClass, inputClass } from './ui';

interface FormState {
  name: string;
  description: string;
  term_months: string;
  price: string;
  renewal_price: string;
  deductible: string;
  per_claim_limit: string;
  aggregate_limit: string;
  waiting_period_days: string;
  free_look_days: string;
  cancellation_fee: string;
  reserve_percent: string;
  max_equipment: string;
  eligible_types: string;
  max_age: string;
  covered_items: string;
  exclusions: string;
  terms: string;
  renewable: boolean;
  active: boolean;
}

const centsToText = (c: number | null) => (c === null ? '' : (c / 100).toFixed(c % 100 === 0 ? 0 : 2));

function toForm(t: Partial<PlanTemplate> | null): FormState {
  const base = { ...EMPTY_TEMPLATE, ...(t ?? {}) };
  return {
    name: base.name,
    description: base.description,
    term_months: String(base.term_months),
    price: centsToText(base.price_cents || null),
    renewal_price: centsToText(base.renewal_price_cents),
    deductible: centsToText(base.deductible_cents),
    per_claim_limit: centsToText(base.per_claim_limit_cents),
    aggregate_limit: centsToText(base.aggregate_limit_cents),
    waiting_period_days: String(base.waiting_period_days),
    free_look_days: String(base.free_look_days),
    cancellation_fee: centsToText(base.cancellation_fee_cents),
    reserve_percent: String(base.reserve_percent),
    max_equipment: String(base.max_equipment),
    eligible_types: base.eligible_equipment_types.join(', '),
    max_age: base.max_equipment_age_years === null ? '' : String(base.max_equipment_age_years),
    covered_items: base.covered_items.join('\n'),
    exclusions: base.exclusions.join('\n'),
    terms: base.terms,
    renewable: base.renewable,
    active: base.active,
  };
}

type Built = { ok: true; value: TemplateInput } | { ok: false; error: string };

function buildInput(f: FormState): Built {
  const money = (label: string, text: string, opts: { optional?: boolean; allowZero?: boolean } = {}): number | null | string => {
    if (opts.optional && text.trim() === '') return null;
    const r = parseMoney(text, { allowZero: opts.allowZero });
    return r.ok ? r.cents : `${label}: ${r.error}`;
  };
  const price = money('Price', f.price);
  const renewal = money('Renewal price', f.renewal_price, { optional: true });
  const deductible = money('Deductible', f.deductible, { allowZero: true });
  const perClaim = money('Per-claim limit', f.per_claim_limit, { optional: true });
  const aggregate = money('Total coverage limit', f.aggregate_limit, { optional: true });
  const fee = money('Cancellation fee', f.cancellation_fee, { allowZero: true });
  for (const v of [price, renewal, deductible, perClaim, aggregate, fee]) if (typeof v === 'string') return { ok: false, error: v };

  const int = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));
  const value: TemplateInput = {
    name: f.name,
    description: f.description,
    term_months: int(f.term_months),
    price_cents: price as number,
    renewal_price_cents: renewal as number | null,
    deductible_cents: deductible as number,
    per_claim_limit_cents: perClaim as number | null,
    aggregate_limit_cents: aggregate as number | null,
    waiting_period_days: int(f.waiting_period_days),
    free_look_days: int(f.free_look_days),
    cancellation_fee_cents: fee as number,
    reserve_percent: int(f.reserve_percent),
    max_equipment: int(f.max_equipment),
    eligible_equipment_types: parseList(f.eligible_types),
    max_equipment_age_years: f.max_age.trim() === '' ? null : Number(f.max_age),
    covered_items: parseList(f.covered_items),
    exclusions: parseList(f.exclusions),
    terms: f.terms,
    renewable: f.renewable,
    active: f.active,
  };
  const errors = validateTemplate(value);
  return errors.length ? { ok: false, error: errors[0] } : { ok: true, value };
}

function TemplateDialog({
  initial,
  editingId,
  ownerId,
  onClose,
  onSaved,
}: {
  initial: Partial<PlanTemplate> | null;
  editingId: string | null;
  ownerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<FormState>(() => toForm(initial));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = buildInput(f);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await saveTemplate(ownerId, built.value, editingId ?? undefined);
      onSaved();
    } catch (err) {
      setError(protectionErrorMessage(err, 'Could not save the plan.'));
      setSaving(false);
    }
  };

  return (
    <Modal
      wide
      title={editingId ? 'Edit plan' : 'New protection plan'}
      description="Changes apply to future sales only. Plans already sold keep the terms they were sold with."
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan name" htmlFor="pp-name">
            <input id="pp-name" className={inputClass} value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} placeholder="Complete Protection" />
          </Field>
          <Field label="Term (months)" htmlFor="pp-term">
            <input id="pp-term" className={inputClass} inputMode="numeric" value={f.term_months} onChange={(e) => set('term_months', e.target.value)} />
          </Field>
          <Field label="Price ($)" htmlFor="pp-price" hint="Before tax. Tax follows the invoice.">
            <input id="pp-price" className={inputClass} inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="249" />
          </Field>
          <Field label="Renewal price ($)" htmlFor="pp-renewal" hint="Blank = renew at the sold price.">
            <input id="pp-renewal" className={inputClass} inputMode="decimal" value={f.renewal_price} onChange={(e) => set('renewal_price', e.target.value)} />
          </Field>
        </div>

        <Field label="Short description (shown to the customer)" htmlFor="pp-desc">
          <textarea id="pp-desc" rows={2} className={inputClass} maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>

        <fieldset className="space-y-3 rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-semibold text-text-secondary">Coverage</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Deductible ($)" htmlFor="pp-ded">
              <input id="pp-ded" className={inputClass} inputMode="decimal" value={f.deductible} onChange={(e) => set('deductible', e.target.value)} />
            </Field>
            <Field label="Per-claim limit ($)" htmlFor="pp-pcl" hint="Blank = none">
              <input id="pp-pcl" className={inputClass} inputMode="decimal" value={f.per_claim_limit} onChange={(e) => set('per_claim_limit', e.target.value)} />
            </Field>
            <Field label="Total limit ($)" htmlFor="pp-agg" hint="Blank = none (not recommended)">
              <input id="pp-agg" className={inputClass} inputMode="decimal" value={f.aggregate_limit} onChange={(e) => set('aggregate_limit', e.target.value)} />
            </Field>
            <Field label="Waiting period (days)" htmlFor="pp-wait">
              <input id="pp-wait" className={inputClass} inputMode="numeric" value={f.waiting_period_days} onChange={(e) => set('waiting_period_days', e.target.value)} />
            </Field>
            <Field label="Units per plan" htmlFor="pp-units">
              <input id="pp-units" className={inputClass} inputMode="numeric" value={f.max_equipment} onChange={(e) => set('max_equipment', e.target.value)} />
            </Field>
            <Field label="Max unit age (years)" htmlFor="pp-age" hint="Blank = any age">
              <input id="pp-age" className={inputClass} inputMode="numeric" value={f.max_age} onChange={(e) => set('max_age', e.target.value)} />
            </Field>
          </div>
          <Field label="Eligible equipment types" htmlFor="pp-types" hint="Comma separated, e.g. Furnace, AC. Blank = any type.">
            <input id="pp-types" className={inputClass} value={f.eligible_types} onChange={(e) => set('eligible_types', e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What is covered (one per line)" htmlFor="pp-cov">
              <textarea id="pp-cov" rows={4} className={inputClass} value={f.covered_items} onChange={(e) => set('covered_items', e.target.value)} />
            </Field>
            <Field label="Exclusions (one per line)" htmlFor="pp-exc">
              <textarea id="pp-exc" rows={4} className={inputClass} value={f.exclusions} onChange={(e) => set('exclusions', e.target.value)} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-3 rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-semibold text-text-secondary">Cancellation &amp; accounting</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Free-look (days)" htmlFor="pp-free" hint="Full refund if no claims">
              <input id="pp-free" className={inputClass} inputMode="numeric" value={f.free_look_days} onChange={(e) => set('free_look_days', e.target.value)} />
            </Field>
            <Field label="Cancellation fee ($)" htmlFor="pp-fee">
              <input id="pp-fee" className={inputClass} inputMode="decimal" value={f.cancellation_fee} onChange={(e) => set('cancellation_fee', e.target.value)} />
            </Field>
            <Field label="Claims reserve (%)" htmlFor="pp-res" hint="Premium set aside for claims">
              <input id="pp-res" className={inputClass} inputMode="decimal" value={f.reserve_percent} onChange={(e) => set('reserve_percent', e.target.value)} />
            </Field>
          </div>
        </fieldset>

        <Field label="Full terms &amp; conditions (shown on the customer’s certificate)" htmlFor="pp-terms">
          <textarea id="pp-terms" rows={5} className={inputClass} maxLength={20000} value={f.terms} onChange={(e) => set('terms', e.target.value)} />
        </Field>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-text-primary">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.renewable} onChange={(e) => set('renewable', e.target.checked)} /> Renewable
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Available to sell
          </label>
        </div>

        <ErrorText message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save plan'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function OfferOnQuoteDialog({ template, onClose }: { template: PlanTemplate; onClose: () => void }) {
  const { toast } = useToast();
  const [quotes, setQuotes] = useState<OpenQuote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setQuotes(await fetchOpenQuotes());
      setError(null);
    } catch (e) {
      setError(protectionErrorMessage(e, 'Could not load quotes.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (q: OpenQuote) => {
    setBusy(q.id);
    try {
      if (isOfferedOnQuote(q, template.id)) {
        await removeFromQuote(q.id, template.id);
        toast('Removed from the quote', 'success');
      } else {
        await offerOnQuote(q.id, template.id);
        toast('Offered at checkout — the customer will see it as an add-on', 'success');
      }
      await load();
    } catch (e) {
      toast(protectionErrorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title={`Offer “${template.name}” at checkout`}
      description="It appears as an optional add-on on the quote the customer accepts. If they choose it, a plan is created and waits for payment."
      onClose={onClose}
    >
      <ErrorText message={error} />
      {!quotes && !error && <p className="text-sm text-text-secondary">Loading quotes…</p>}
      {quotes && quotes.length === 0 && <p className="text-sm text-text-secondary">No draft or sent quotes right now.</p>}
      <ul className="space-y-2">
        {quotes?.map((q) => {
          const offered = isOfferedOnQuote(q, template.id);
          return (
            <li key={q.id} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{q.customer_name}</p>
                <p className="text-xs capitalize text-text-secondary">{q.status}</p>
              </div>
              <Button size="sm" variant={offered ? 'secondary' : 'primary'} disabled={busy === q.id} onClick={() => void toggle(q)}>
                {offered ? 'Remove' : 'Offer'}
              </Button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

export function PlanCatalog({
  templates,
  ownerId,
  canManage,
  onChanged,
}: {
  templates: PlanTemplate[];
  ownerId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [editor, setEditor] = useState<{ initial: Partial<PlanTemplate> | null; id: string | null } | null>(null);
  const [offerFor, setOfferFor] = useState<PlanTemplate | null>(null);

  const toggleActive = async (t: PlanTemplate) => {
    try {
      await setTemplateActive(t.id, !t.active);
      onChanged();
    } catch (e) {
      toast(protectionErrorMessage(e), 'error');
    }
  };

  if (templates.length === 0) {
    return (
      <>
        <EmptyState
          icon={ShieldCheck}
          title="Create your first protection plan"
          description="Set the price, term, deductible and limits once, then sell it on quotes and invoices."
          action={canManage ? { label: 'Create a plan', onClick: () => setEditor({ initial: null, id: null }) } : undefined}
        />
        {canManage && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {TEMPLATE_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => setEditor({ initial: p, id: null })}
                className={`${cardClass} focus-ring text-left transition-colors hover:border-accent/40`}
              >
                <p className="text-sm font-semibold text-text-primary">Start from “{p.name}”</p>
                <p className="mt-1 text-xs text-text-secondary">
                  {termLabel(p.term_months)} · {formatMoney(p.price_cents)} · {formatMoney(p.deductible_cents)} deductible
                </p>
              </button>
            ))}
          </div>
        )}
        {editor && (
          <TemplateDialog
            initial={editor.initial}
            editingId={editor.id}
            ownerId={ownerId}
            onClose={() => setEditor(null)}
            onSaved={() => {
              setEditor(null);
              onChanged();
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditor({ initial: null, id: null })}>
            <Plus size={16} /> New plan
          </Button>
        </div>
      )}
      <ul className="grid gap-4 lg:grid-cols-2">
        {templates.map((t) => (
          <li key={t.id} className={`${cardClass} ${t.active ? '' : 'opacity-70'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-text-primary">{t.name}</h3>
                <p className="mt-0.5 text-sm text-text-secondary">
                  {termLabel(t.term_months)} · {formatMoney(t.price_cents)}
                  {t.renewal_price_cents !== null && ` · renews at ${formatMoney(t.renewal_price_cents)}`}
                </p>
              </div>
              <Pill className={t.active ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}>{t.active ? 'On sale' : 'Off'}</Pill>
            </div>
            {t.description && <p className="mt-2 text-sm text-text-secondary">{t.description}</p>}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary">
              <dt>Deductible</dt>
              <dd className="text-right text-text-primary">{formatMoney(t.deductible_cents)}</dd>
              <dt>Per-claim limit</dt>
              <dd className="text-right text-text-primary">{t.per_claim_limit_cents === null ? 'None' : formatMoney(t.per_claim_limit_cents)}</dd>
              <dt>Total limit</dt>
              <dd className="text-right text-text-primary">{t.aggregate_limit_cents === null ? 'None' : formatMoney(t.aggregate_limit_cents)}</dd>
              <dt>Waiting period</dt>
              <dd className="text-right text-text-primary">{t.waiting_period_days} days</dd>
              <dt>Claims reserve</dt>
              <dd className="text-right text-text-primary">{t.reserve_percent}%</dd>
            </dl>
            {canManage && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditor({ initial: t, id: t.id })}>
                  <Pencil size={14} /> Edit
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditor({ initial: { ...t, name: `${t.name} (copy)` }, id: null })}>
                  <Copy size={14} /> Duplicate
                </Button>
                <Button size="sm" variant="secondary" disabled={!t.active} onClick={() => setOfferFor(t)}>
                  <Tag size={14} /> Offer on a quote
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void toggleActive(t)}>
                  <Power size={14} /> {t.active ? 'Turn off' : 'Turn on'}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editor && (
        <TemplateDialog
          initial={editor.initial}
          editingId={editor.id}
          ownerId={ownerId}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            onChanged();
          }}
        />
      )}
      {offerFor && <OfferOnQuoteDialog template={offerFor} onClose={() => setOfferFor(null)} />}
    </div>
  );
}
