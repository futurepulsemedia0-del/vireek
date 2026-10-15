import { useMemo, useState } from 'react';
import { Layers, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/payroll';
import {
  MAX_TIERS,
  calculateTieredCommission,
  dollarsToCents,
  parseRatePercent,
  validateTiers,
  type CommissionTier,
  type TierMode,
  type TierPeriod,
} from '@/lib/commissionEngine';
import { assignEmployeePlan, errorMessage, saveCommissionPlan, type CommissionEmployee, type CommissionPlan } from '@/lib/commissions';
import { Dialog, LoadError, SelectField, StatusPill, formatPct } from './shared';

interface TierDraft { id: number; min: string; rate: string }
interface PlanDraft {
  id: string | null;
  name: string;
  description: string;
  tierMode: TierMode;
  tierPeriod: TierPeriod;
  isDefault: boolean;
  active: boolean;
  tiers: TierDraft[];
}

const MODE_HELP: Record<TierMode, string> = {
  marginal: 'Each dollar earns the rate of the tier it falls in (like tax brackets). A job that crosses a threshold is split across tiers.',
  tier_reached: 'The whole job earns the rate of the tier the employee reaches after it. Earlier jobs are not re-paid.',
};
const PERIOD_LABEL: Record<TierPeriod, string> = { monthly: 'Resets monthly', quarterly: 'Resets quarterly', yearly: 'Resets yearly' };

let draftSeq = 0;
const newTier = (min = '', rate = ''): TierDraft => ({ id: (draftSeq += 1), min, rate });

function emptyDraft(isFirst: boolean): PlanDraft {
  return { id: null, name: '', description: '', tierMode: 'marginal', tierPeriod: 'monthly', isDefault: isFirst, active: true, tiers: [newTier('0', '')] };
}

function toDraft(p: CommissionPlan): PlanDraft {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    tierMode: p.tier_mode,
    tierPeriod: p.tier_period,
    isDefault: p.is_default,
    active: p.active,
    tiers: p.tiers.map((t) => newTier(String(t.min_cents / 100), String(t.rate_percent))),
  };
}

function parseTiers(drafts: TierDraft[]): { tiers: CommissionTier[]; error: string | null } {
  const tiers: CommissionTier[] = [];
  for (const d of drafts) {
    const min = dollarsToCents(d.min || '0');
    const rate = parseRatePercent(d.rate);
    if (min === null) return { tiers: [], error: 'Each threshold must be a dollar amount like 25000 or 25,000.50.' };
    if (rate === null) return { tiers: [], error: 'Each rate must be 0-100% with at most 2 decimals.' };
    tiers.push({ min_cents: min, rate_percent: rate });
  }
  return { tiers, error: validateTiers(tiers) };
}

function PlanDialog({ draft, onChange, onClose, onSaved }: { draft: PlanDraft | null; onChange: (d: PlanDraft) => void; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [previewJob, setPreviewJob] = useState('1500');

  const parsed = useMemo(() => (draft ? parseTiers(draft.tiers) : { tiers: [], error: null }), [draft]);
  const previewCents = dollarsToCents(previewJob);
  const preview = useMemo(() => {
    if (!draft || parsed.error || previewCents === null || previewCents <= 0) return null;
    return calculateTieredCommission({ basisCents: previewCents, cumulativeBeforeCents: 0, tiers: parsed.tiers, mode: draft.tierMode });
  }, [draft, parsed, previewCents]);

  if (!draft) return null;
  const nameOk = draft.name.trim().length > 0;
  const valid = nameOk && !parsed.error;
  const setTier = (id: number, patch: Partial<TierDraft>) => onChange({ ...draft, tiers: draft.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await saveCommissionPlan({
        id: draft.id,
        name: draft.name.trim(),
        description: draft.description.trim(),
        tierMode: draft.tierMode,
        tierPeriod: draft.tierPeriod,
        isDefault: draft.isDefault && draft.active,
        active: draft.active,
        tiers: parsed.tiers,
      });
      toast('Commission plan saved. It applies to commissions generated from now on.', 'success');
      onSaved();
      onClose();
    } catch (e) {
      toast(errorMessage(e, 'Could not save plan.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      title={draft.id ? 'Edit commission plan' : 'New commission plan'}
      description="A plan is a ladder of thresholds and rates applied to the commissionable (pre-tax, collected) amount of each job."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={!valid || saving}>{saving ? 'Saving…' : 'Save plan'}</Button>
        </>
      }
    >
      <Input label="Plan name" value={draft.name} maxLength={80} onChange={(e) => onChange({ ...draft, name: e.target.value })} required />
      <Input label="Description (optional)" value={draft.description} maxLength={500} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Tier method" value={draft.tierMode} onChange={(v) => onChange({ ...draft, tierMode: v as TierMode })} helperText={MODE_HELP[draft.tierMode]}>
          <option value="marginal">Marginal (brackets)</option>
          <option value="tier_reached">Tier reached</option>
        </SelectField>
        <SelectField label="Volume period" value={draft.tierPeriod} onChange={(v) => onChange({ ...draft, tierPeriod: v as TierPeriod })} helperText="Tier thresholds use the employee's volume within this period.">
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
          <option value="yearly">Yearly</option>
        </SelectField>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-text-primary">Tiers</p>
        <div className="space-y-2">
          {draft.tiers.map((t, i) => (
            <div key={t.id} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <Input label={i === 0 ? 'From (USD volume)' : undefined} aria-label="Tier starts at (USD)" inputMode="decimal" value={t.min} disabled={i === 0 && draft.tiers.length > 0 && t.min === '0'} onChange={(e) => setTier(t.id, { min: e.target.value })} />
              <Input label={i === 0 ? 'Rate (%)' : undefined} aria-label="Tier rate (%)" inputMode="decimal" value={t.rate} placeholder="5" onChange={(e) => setTier(t.id, { rate: e.target.value })} />
              <button
                type="button"
                aria-label="Remove tier"
                disabled={draft.tiers.length === 1}
                onClick={() => onChange({ ...draft, tiers: draft.tiers.filter((x) => x.id !== t.id) })}
                className="focus-ring mb-1 rounded-lg p-2.5 text-text-secondary hover:text-danger disabled:opacity-40"
              ><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-2" disabled={draft.tiers.length >= MAX_TIERS} onClick={() => onChange({ ...draft, tiers: [...draft.tiers, newTier('', '')] })}><Plus size={14} /> Add tier</Button>
        {parsed.error && <p role="alert" className="mt-1 text-xs text-danger">{parsed.error}</p>}
      </div>

      <div className="rounded-xl border border-border bg-bg-primary p-3">
        <Input label="Preview: a single $ job at the start of a period" inputMode="decimal" value={previewJob} onChange={(e) => setPreviewJob(e.target.value)} />
        <p className="mt-2 text-sm text-text-secondary">
          {preview ? <>Commission <span className="font-semibold text-text-primary">{formatCents(preview.commissionCents)}</span> ({formatPct(preview.effectiveRatePercent)} effective)</> : 'Enter a valid job amount and tiers to preview.'}
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={draft.isDefault && draft.active} disabled={!draft.active} onChange={(e) => onChange({ ...draft, isDefault: e.target.checked })} />
        Use as the account default (applies to employees without their own plan)
      </label>
      {draft.id && (
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={draft.active} onChange={(e) => onChange({ ...draft, active: e.target.checked, isDefault: e.target.checked ? draft.isDefault : false })} />
          Plan is active
        </label>
      )}
    </Dialog>
  );
}

export function RulesTab({ plans, employees, loading, error, onReload }: { plans: CommissionPlan[]; employees: CommissionEmployee[]; loading: boolean; error: string | null; onReload: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);

  const activePlans = plans.filter((p) => p.active);
  const defaultPlan = plans.find((p) => p.is_default && p.active);

  const assign = async (employeeId: string, planId: string) => {
    setAssigning(employeeId);
    try {
      await assignEmployeePlan(employeeId, planId || null);
      toast('Plan assignment updated.', 'success');
      onReload();
    } catch (e) {
      toast(errorMessage(e, 'Could not assign plan.'), 'error');
    } finally {
      setAssigning(null);
    }
  };

  if (error) return <LoadError message={error} onRetry={onReload} />;
  if (loading) return <SkeletonCardList count={3} rows={2} />;

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Commission plans</h2>
            <p className="text-xs text-text-secondary">Order of precedence: job override, then the employee's plan, then the account default, then the employee's flat rate.</p>
          </div>
          <Button size="sm" onClick={() => setDraft(emptyDraft(plans.length === 0))}><Plus size={14} /> New plan</Button>
        </div>

        {plans.length === 0 ? (
          <EmptyState icon={Layers} title="No commission plans yet" description="Create a tiered plan (for example 5% up to $10,000, then 8%) and make it the default so every technician earns commission automatically." action={{ label: 'Create first plan', onClick: () => setDraft(emptyDraft(true)) }} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {plans.map((p) => (
              <Card key={p.id} className="p-5 hover:translate-y-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-text-primary">{p.name}</h3>
                    {p.description && <p className="mt-0.5 text-xs text-text-secondary">{p.description}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {p.is_default && <StatusPill tone="info">Default</StatusPill>}
                    {!p.active && <StatusPill tone="neutral">Inactive</StatusPill>}
                  </div>
                </div>
                <p className="mt-2 text-xs text-text-secondary">{p.tier_mode === 'marginal' ? 'Marginal brackets' : 'Tier reached'} · {PERIOD_LABEL[p.tier_period]}</p>
                <ul className="mt-3 space-y-1 text-sm">
                  {p.tiers.map((t, i) => {
                    const next = p.tiers[i + 1];
                    return (
                      <li key={t.min_cents} className="flex justify-between gap-3">
                        <span className="text-text-secondary">{next ? `${formatCents(t.min_cents)} – ${formatCents(next.min_cents)}` : `${formatCents(t.min_cents)}+`}</span>
                        <span className="font-semibold text-text-primary">{formatPct(t.rate_percent)}</span>
                      </li>
                    );
                  })}
                </ul>
                <Button variant="secondary" size="sm" className="mt-4" onClick={() => setDraft(toDraft(p))}>Edit</Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Who earns what</h2>
        <p className="mb-3 text-xs text-text-secondary">
          Technicians must be linked to an employee in Payroll to earn commission.{' '}
          {defaultPlan ? `Employees without a plan use "${defaultPlan.name}".` : 'No default plan: employees without a plan fall back to their flat commission rate.'}
        </p>
        {employees.length === 0 ? (
          <EmptyState icon={Layers} title="No employees yet" description="Add employees in Payroll and link them to your technicians to start earning commission." />
        ) : (
          <Card className="p-0 hover:translate-y-0">
            {employees.map((e) => (
              <div key={e.id} className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{e.full_name} {!e.active && <span className="text-xs font-normal text-text-secondary">(inactive)</span>}</p>
                  <p className="text-xs text-text-secondary">
                    {e.team_member_id ? 'Linked to a technician' : 'Not linked to a technician: cannot earn job commission'}
                    {e.commission_rate_percent > 0 ? ` · flat fallback ${formatPct(Number(e.commission_rate_percent))}` : ''}
                  </p>
                </div>
                <select
                  aria-label={`Commission plan for ${e.full_name}`}
                  value={e.commission_plan_id ?? ''}
                  disabled={assigning === e.id}
                  onChange={(ev) => void assign(e.id, ev.target.value)}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-50 sm:w-56"
                >
                  <option value="">{defaultPlan ? `Account default (${defaultPlan.name})` : 'No plan'}</option>
                  {activePlans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            ))}
          </Card>
        )}
      </section>

      <PlanDialog draft={draft} onChange={setDraft} onClose={() => setDraft(null)} onSaved={onReload} />
    </div>
  );
}
