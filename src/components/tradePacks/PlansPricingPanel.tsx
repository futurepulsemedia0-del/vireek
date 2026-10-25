import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { fetchCustomerOptions, localTimeZone, saveAgreement, todayISO, type CustomerOption } from '@/lib/recurringJobs';
import { fetchTeam, friendlyTradePackError, ratesFor, updatePack, type PackInstall, type TeamOption } from '@/lib/tradePacksApi';
import {
  applyRateOverrides,
  applySeason,
  quote,
  visitsPerYear,
  type PlanTemplate,
  type PricingModelDef,
  type RateOverrides,
  type TradePack,
} from '@/lib/tradePacks';
import { SelectField, money } from './shared';

interface Props {
  pack: TradePack;
  ownerId: string;
  install: PackInstall;
  canManage: boolean;
  onSaved: () => void;
}

/** Editable scalar rates (flat / per-unit / markup). Tier tables are edited in code defaults. */
function editableLines(model: PricingModelDef) {
  return model.lines.filter((l) => l.kind !== 'tier');
}

function lineValue(l: PricingModelDef['lines'][number]): number {
  return l.kind === 'flat' ? l.amount : l.kind === 'per_unit' ? l.unitPrice : l.kind === 'cost_plus' ? l.markupPct : 0;
}

export function PlansPricingPanel({ pack, ownerId, install, canManage, onSaved }: Props) {
  const { toast } = useToast();
  const [modelKey, setModelKey] = useState(pack.pricingModels[0].key);
  const baseModel = pack.pricingModels.find((m) => m.key === modelKey) ?? pack.pricingModels[0];
  const [overrides, setOverrides] = useState<RateOverrides>(ratesFor(install, modelKey) ?? {});
  const [inputs, setInputs] = useState<Record<string, number>>({});
  const [visits, setVisits] = useState(4);
  const [savingRates, setSavingRates] = useState(false);

  const [planKey, setPlanKey] = useState<string | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [team, setTeam] = useState<TeamOption[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [address, setAddress] = useState('');
  const [startDate, setStartDate] = useState(todayISO());
  const [techId, setTechId] = useState('');
  const [price, setPrice] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setOverrides(ratesFor(install, modelKey) ?? {});
    setInputs(Object.fromEntries(baseModel.inputs.map((i) => [i.key, i.defaultValue])));
    const plan = pack.plans.find((p) => p.pricingModel === modelKey);
    if (plan) setVisits(Math.round(visitsPerYear(plan.intervalUnit, plan.intervalCount)) || 1);
  }, [modelKey, install, baseModel, pack.plans]);

  const model = useMemo(() => applyRateOverrides(baseModel, overrides), [baseModel, overrides]);
  const q = useMemo(() => quote(model, inputs, visits), [model, inputs, visits]);
  const plan: PlanTemplate | undefined = pack.plans.find((p) => p.key === planKey);

  const saveRates = async () => {
    setSavingRates(true);
    try {
      const next = { ...install.config, rates: { ...(install.config.rates ?? {}), [modelKey]: overrides } };
      await updatePack(pack.key, { config: next });
      toast('Rates saved for this pack.', 'success');
      onSaved();
    } catch (e) {
      toast(friendlyTradePackError(e), 'error');
    } finally {
      setSavingRates(false);
    }
  };

  const openPlan = async (p: PlanTemplate) => {
    setPlanKey(p.key);
    setModelKey(p.pricingModel);
    if (!customers.length) {
      try {
        const [c, t] = await Promise.all([fetchCustomerOptions(ownerId), fetchTeam(ownerId)]);
        setCustomers(c);
        setTeam(t);
      } catch (e) {
        toast(friendlyTradePackError(e, 'Could not load customers.'), 'error');
      }
    }
  };

  useEffect(() => {
    if (plan) setPrice(q.perVisit ? String(q.perVisit) : '');
  }, [plan, q.perVisit]);

  const customer = customers.find((c) => c.id === customerId);

  const createPlan = async () => {
    if (!plan || !customer) return;
    const season = applySeason(startDate, plan.season);
    setCreating(true);
    try {
      await saveAgreement(ownerId, {
        customerId: customer.id,
        customerName: customer.name,
        customerPhone: customer.phone ?? '',
        customerEmail: customer.email ?? '',
        address: (address || customer.address || '').trim(),
        title: plan.title,
        serviceType: pack.name,
        notes: plan.description,
        intervalUnit: plan.intervalUnit,
        intervalCount: plan.intervalCount,
        startDate: season.start,
        endDate: season.end,
        preferredTime: '09:00',
        timezone: localTimeZone(),
        durationMinutes: plan.durationMinutes,
        preferredTechnicianId: techId || null,
        priceAmount: price.trim() ? Number(price) : null,
        autoInvoice: false,
        leadTimeDays: 14,
      });
      toast('Recurring plan created. Visits appear on the schedule automatically.', 'success');
      setPlanKey(null);
      setCustomerId('');
      setAddress('');
    } catch (e) {
      toast(friendlyTradePackError(e, e instanceof Error ? e.message : 'Could not create the plan.'), 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-text-primary">Plan templates</h3>
        <ul className="grid gap-3 sm:grid-cols-2">
          {pack.plans.map((p) => (
            <li key={p.key} className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-4 text-sm">
              <div>
                <p className="font-semibold text-text-primary">{p.title}</p>
                <p className="text-text-secondary">{p.description}</p>
                {p.season && <p className="mt-1 text-xs text-text-secondary">Seasonal: months {p.season.fromMonth}–{p.season.toMonth}</p>}
              </div>
              <Button variant="secondary" size="sm" onClick={() => openPlan(p)}>
                <CalendarPlus size={14} /> Create plan for a customer
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {plan && (
        <Card className="space-y-4 p-6">
          <h3 className="text-base font-semibold text-text-primary">{plan.title}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label="Customer" required value={customerId} onChange={(v) => { setCustomerId(v); setAddress(customers.find((c) => c.id === v)?.address ?? ''); }}>
              <option value="">Select…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </SelectField>
            <Input label="Service address" required value={address} onChange={(e) => setAddress(e.target.value)} />
            <Input label="First visit" type="date" min={todayISO()} value={startDate} onChange={(e) => setStartDate(e.target.value)} helperText={plan.season ? 'Moved into the season automatically.' : undefined} />
            <SelectField label="Preferred technician" value={techId} onChange={setTechId}>
              <option value="">Any</option>
              {team.map((t) => (
                <option key={t.id} value={t.id}>{t.member_name ?? 'Unnamed'}</option>
              ))}
            </SelectField>
            <Input label="Price per visit ($)" type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} helperText="Prefilled from the calculator below." />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPlanKey(null)}>Cancel</Button>
            <Button onClick={createPlan} disabled={creating || !customer || !address.trim()}>Create plan</Button>
          </div>
        </Card>
      )}

      <section className="space-y-3">
        <h3 className="text-base font-semibold text-text-primary">Pricing calculator</h3>
        <Card className="space-y-4 p-6">
          <SelectField label="Pricing model" value={modelKey} onChange={setModelKey} helperText={baseModel.description}>
            {pack.pricingModels.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </SelectField>
          <div className="grid gap-3 sm:grid-cols-3">
            {baseModel.inputs.map((i) => (
              <Input key={i.key} label={`${i.label} (${i.unit})`} type="number" min={i.min} max={i.max} step="any" value={String(inputs[i.key] ?? '')} onChange={(e) => setInputs((s) => ({ ...s, [i.key]: Number(e.target.value) }))} />
            ))}
            <Input label="Visits per year" type="number" min={0} max={365} value={String(visits)} onChange={(e) => setVisits(Number(e.target.value))} />
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {q.lines.map((l) => (
              <div key={l.key} className="flex justify-between rounded-lg bg-bg-primary px-3 py-2">
                <dt className="text-text-secondary">{l.label} <span className="text-xs">({l.billing === 'one_time' ? 'one-time' : 'per visit'})</span></dt>
                <dd className="font-medium text-text-primary">{money(l.amount)}</dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-2 rounded-xl border border-border p-3 text-sm sm:grid-cols-3">
            <p><span className="text-text-secondary">Monthly value</span><br /><span className="text-lg font-semibold text-text-primary">{money(q.monthlyRecurring)}</span></p>
            <p><span className="text-text-secondary">Annual recurring</span><br /><span className="text-lg font-semibold text-text-primary">{money(q.annualRecurring)}</span></p>
            <p><span className="text-text-secondary">First-year total</span><br /><span className="text-lg font-semibold text-text-primary">{money(q.firstYearTotal)}</span></p>
          </div>

          {canManage && editableLines(baseModel).length > 0 && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-sm font-medium text-text-primary">Your rates</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {editableLines(baseModel).map((l) => (
                  <Input
                    key={l.key}
                    label={`${l.label}${l.kind === 'cost_plus' ? ' (markup %)' : l.kind === 'per_unit' ? ' (per unit $)' : ' ($)'}`}
                    type="number"
                    min="0"
                    step="any"
                    value={String(overrides[l.key] !== undefined && typeof overrides[l.key] === 'number' ? overrides[l.key] : lineValue(l))}
                    onChange={(e) => setOverrides((s) => ({ ...s, [l.key]: Number(e.target.value) }))}
                  />
                ))}
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={saveRates} disabled={savingRates}>Save rates</Button>
              </div>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
