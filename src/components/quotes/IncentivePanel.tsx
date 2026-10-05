import { useId, useState } from 'react';
import { AlertTriangle, BadgePercent, ChevronDown, ExternalLink, Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  DELIVERY_LABEL,
  EMPTY_PROJECT_FORM,
  STATUS_META,
  assessQuoteIncentives,
  formatMonths,
  formatUsd,
  projectToForm,
} from '@/lib/incentives';
import type { IncentiveAssessmentResult, ProgramEvaluation, ProjectForm } from '@/lib/incentives';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const SEVERITY_TONE = {
  critical: 'text-danger',
  warning: 'text-warning-500',
  info: 'text-text-secondary',
} as const;

interface TextField {
  key: keyof ProjectForm;
  label: string;
  type?: 'text' | 'number' | 'date';
  placeholder?: string;
  helper?: string;
}

const LOCATION_FIELDS: TextField[] = [
  { key: 'effective_date', label: 'Project date', type: 'date', helper: 'Programs are checked against this date.' },
  { key: 'country', label: 'Country', placeholder: 'US' },
  { key: 'state', label: 'State / region', placeholder: 'CA' },
  { key: 'postal_code', label: 'Postal code', placeholder: '94105' },
  { key: 'utility_name', label: 'Utility provider', placeholder: 'Your electric / gas utility' },
  { key: 'building_year_built', label: 'Year built', type: 'number', placeholder: '1998' },
];

const EQUIPMENT_FIELDS: TextField[] = [
  { key: 'equipment_type', label: 'Equipment being installed', placeholder: 'Heat pump, water heater…' },
  { key: 'equipment_units', label: 'Units', type: 'number', placeholder: '1' },
  { key: 'efficiency_metric', label: 'Efficiency rating type', placeholder: 'SEER2, AFUE, UEF…' },
  { key: 'efficiency_value', label: 'Efficiency rating', type: 'number', placeholder: '17' },
  { key: 'equipment_cost_dollars', label: 'Equipment cost ($)', type: 'number', helper: 'Only needed for programs that pay on equipment cost.' },
];

const SAVINGS_FIELDS: TextField[] = [
  { key: 'annual_kwh_saved', label: 'Electricity saved per year (kWh)', type: 'number' },
  { key: 'electric_rate_cents_per_kwh', label: 'Electric rate (¢ per kWh)', type: 'number' },
  { key: 'annual_therms_saved', label: 'Gas saved per year (therms)', type: 'number' },
  { key: 'gas_rate_cents_per_therm', label: 'Gas rate (¢ per therm)', type: 'number' },
  { key: 'annual_savings_dollars', label: 'Or total saved per year ($)', type: 'number', helper: 'Overrides the kWh / therm figures.' },
];

function Stat({ label, value, sub, emphasis = false }: { label: string; value: string; sub?: string; emphasis?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${emphasis ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-primary'}`}>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-0.5 text-lg font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

function BreakdownRow({ label, value, strong = false, muted = false }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 text-sm ${strong ? 'border-t border-border pt-2.5 font-bold text-text-primary' : muted ? 'text-text-secondary' : 'text-text-primary'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function EvaluationCard({ e }: { e: ProgramEvaluation }) {
  const meta = STATUS_META[e.status];
  const hasDetail = e.met.length + e.failed.length + e.verify.length + e.warnings.length > 0 || e.stacking_note;
  return (
    <li className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{e.name}</p>
          <p className="text-xs text-text-secondary">
            {e.administrator ? `${e.administrator} · ` : ''}
            {DELIVERY_LABEL[e.delivery]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {e.status !== 'ineligible' && <span className="text-sm font-bold tabular-nums text-text-primary">{formatUsd(e.amount_cents)}</span>}
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.tone}`}>{meta.label}</span>
        </div>
      </div>
      {e.stacking_note && <p className="mt-2 text-xs text-text-secondary">{e.stacking_note}</p>}
      {hasDetail && (
        <details className="mt-2 group">
          <summary className="focus-ring inline-flex cursor-pointer items-center gap-1 rounded text-xs font-medium text-accent">
            Why <ChevronDown size={12} aria-hidden="true" className="transition-transform group-open:rotate-180" />
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {e.failed.map((t) => (
              <li key={`f-${t}`} className="text-danger">✕ {t}</li>
            ))}
            {e.verify.map((t) => (
              <li key={`v-${t}`} className="text-warning-500">? {t}</li>
            ))}
            {e.warnings.map((t) => (
              <li key={`w-${t}`} className="text-warning-500">! {t}</li>
            ))}
            {e.met.map((t) => (
              <li key={`m-${t}`} className="text-success-500">✓ {t}</li>
            ))}
          </ul>
          {e.source_url && (
            <a href={e.source_url} target="_blank" rel="noopener noreferrer" className="focus-ring mt-2 inline-flex items-center gap-1 rounded text-xs text-accent">
              Program source <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </details>
      )}
    </li>
  );
}

export function IncentivePanel({ quoteId, onAssessed }: { quoteId: string; onAssessed?: () => void }) {
  const { toast } = useToast();
  const uid = useId();
  const [form, setForm] = useState<ProjectForm>(EMPTY_PROJECT_FORM);
  const [formOpen, setFormOpen] = useState(true);
  const [saveDefaults, setSaveDefaults] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IncentiveAssessmentResult | null>(null);

  const setField = (key: keyof ProjectForm, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await assessQuoteIncentives(quoteId, form, saveDefaults);
      setResult(r);
      setForm((prev) => projectToForm(r.project, prev));
      setFormOpen(false);
      if (saveDefaults) toast(r.profileSaved ? 'Saved as this customer’s defaults.' : 'Could not save customer defaults.', r.profileSaved ? 'success' : 'error');
      onAssessed?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not assess incentives.';
      setError(message);
      toast(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const renderFields = (fields: TextField[]) =>
    fields.map((f) => (
      <Input
        key={f.key}
        label={f.label}
        type={f.type ?? 'text'}
        inputMode={f.type === 'number' ? 'decimal' : undefined}
        min={f.type === 'number' ? 0 : undefined}
        placeholder={f.placeholder}
        helperText={f.helper}
        value={form[f.key]}
        onChange={(e) => setField(f.key, e.target.value)}
      />
    ));

  const triSelect = (key: 'owner_occupied' | 'income_qualified', label: string) => (
    <div>
      <label htmlFor={`${uid}-${key}`} className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      <select id={`${uid}-${key}`} value={form[key]} onChange={(e) => setField(key, e.target.value)} className={selectClass}>
        <option value="">Not sure</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </div>
  );

  const report = result?.report ?? null;
  const econ = report?.economics ?? null;
  const energy = report?.energy ?? null;

  return (
    <div>
      <div className="rounded-xl border border-border bg-bg-primary">
        <button
          type="button"
          onClick={() => setFormOpen((o) => !o)}
          aria-expanded={formOpen}
          aria-controls={`${uid}-form`}
          className="focus-ring flex w-full items-center justify-between rounded-xl px-4 py-3 text-left text-sm font-semibold text-text-primary"
        >
          Project details
          <ChevronDown size={16} aria-hidden="true" className={`transition-transform ${formOpen ? 'rotate-180' : ''}`} />
        </button>
        {formOpen && (
          <div id={`${uid}-form`} className="space-y-5 border-t border-border p-4">
            <p className="text-xs text-text-secondary">
              Fill in what you know. Anything left blank is never guessed: programs that depend on it are marked “Verify first”.
            </p>
            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Property and customer</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {renderFields(LOCATION_FIELDS)}
                {triSelect('owner_occupied', 'Owner-occupied?')}
                {triSelect('income_qualified', 'Income-qualified household?')}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Equipment</legend>
              <div className="grid gap-3 sm:grid-cols-2">{renderFields(EQUIPMENT_FIELDS)}</div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Expected energy savings (optional)</legend>
              <div className="grid gap-3 sm:grid-cols-2">{renderFields(SAVINGS_FIELDS)}</div>
            </fieldset>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input type="checkbox" checked={saveDefaults} onChange={(e) => setSaveDefaults(e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
              Remember the location, utility and ownership details for this customer
            </label>
          </div>
        )}
      </div>

      <Button type="button" className="mt-4 w-full sm:w-auto" onClick={run} disabled={loading}>
        <BadgePercent size={18} aria-hidden="true" />
        {loading ? 'Checking incentives…' : result ? 'Re-run incentive check' : 'Run incentive check'}
      </Button>

      {error && !loading && (
        <p role="alert" className="mt-3 text-sm text-danger">{error}</p>
      )}

      {loading && !result && <div className="mt-4"><SkeletonCard rows={4} withIcon={false} /></div>}

      {report && econ && energy && (
        <div className="mt-5 space-y-5" aria-live="polite">
          {/* Net project economics */}
          <section aria-label="Net project economics">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Project total" value={formatUsd(econ.total_cents)} sub={econ.tax_cents > 0 ? `incl. ${formatUsd(econ.tax_cents)} tax` : undefined} />
              <Stat
                label="Incentives"
                value={econ.conditional_cents > 0 ? `${formatUsd(econ.confirmed_cents)}–${formatUsd(econ.potential_cents)}` : formatUsd(econ.confirmed_cents)}
                sub={econ.conditional_cents > 0 ? `${formatUsd(econ.confirmed_cents)} confirmed` : 'all confirmed'}
              />
              <Stat
                label="Estimated net cost"
                emphasis
                value={econ.conditional_cents > 0 ? `${formatUsd(econ.net_cost_best_cents)}–${formatUsd(econ.net_cost_confirmed_cents)}` : formatUsd(econ.net_cost_confirmed_cents)}
                sub={econ.conditional_cents > 0 ? 'best case – confirmed only' : undefined}
              />
              <Stat
                label="Payback"
                value={energy.known ? formatMonths(energy.payback_months_best) : 'n/a'}
                sub={energy.known ? `${formatMonths(energy.payback_months_without_incentives)} without incentives` : 'add expected savings'}
              />
            </div>

            <div className="mt-4 rounded-xl border border-border bg-bg-primary px-4 py-3">
              <BreakdownRow label="Project price" value={formatUsd(econ.total_cents)} />
              <BreakdownRow label="Confirmed incentives" value={`-${formatUsd(econ.confirmed_cents)}`} />
              {econ.conditional_cents > 0 && <BreakdownRow label="Pending verification" value={`-${formatUsd(econ.conditional_cents)}`} muted />}
              <BreakdownRow label="Estimated net cost" value={econ.conditional_cents > 0 ? `${formatUsd(econ.net_cost_best_cents)}–${formatUsd(econ.net_cost_confirmed_cents)}` : formatUsd(econ.net_cost_confirmed_cents)} strong />
              <BreakdownRow label="Due at signing" value={formatUsd(econ.due_at_signing_cents)} muted />
              {econ.delayed_cents > 0 && <BreakdownRow label="Returned after the sale" value={formatUsd(econ.delayed_cents)} muted />}
              {energy.known && energy.annual_savings_cents !== null && (
                <BreakdownRow label="Expected energy savings" value={`${formatUsd(energy.annual_savings_cents)} / year`} muted />
              )}
              {energy.known && energy.months_saved_by_incentives !== null && energy.months_saved_by_incentives > 0 && (
                <BreakdownRow label="Payback shortened by" value={formatMonths(energy.months_saved_by_incentives)} muted />
              )}
              {energy.known && energy.ten_year_net_benefit_cents !== null && (
                <BreakdownRow label="10-year net benefit (simple)" value={formatUsd(energy.ten_year_net_benefit_cents)} muted />
              )}
            </div>
            {energy.notes.length > 0 && (
              <p className="mt-2 text-xs text-text-secondary">{energy.notes.join(' ')}</p>
            )}
          </section>

          {/* Action items */}
          {report.action_items.length > 0 && (
            <section aria-label="What to do next">
              <h3 className="mb-2 text-sm font-semibold text-text-primary">What to do next</h3>
              <ul className="space-y-2">
                {report.action_items.map((a) => (
                  <li key={`${a.severity}-${a.title}`} className="flex gap-2 rounded-xl border border-border bg-bg-primary p-3 text-sm">
                    {a.severity === 'info' ? (
                      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" />
                    ) : (
                      <AlertTriangle size={16} aria-hidden="true" className={`mt-0.5 shrink-0 ${SEVERITY_TONE[a.severity]}`} />
                    )}
                    <div>
                      <p className="font-medium text-text-primary">{a.title}</p>
                      <p className="text-xs text-text-secondary">{a.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Programs */}
          {report.evaluations.length > 0 && (
            <section aria-label="Programs evaluated">
              <h3 className="mb-2 text-sm font-semibold text-text-primary">Programs evaluated ({report.evaluations.length})</h3>
              <ul className="space-y-2">
                {report.evaluations.map((e) => (
                  <EvaluationCard key={e.program_id} e={e} />
                ))}
              </ul>
            </section>
          )}

          <p className="text-xs text-text-secondary">{report.disclaimer}</p>
        </div>
      )}
    </div>
  );
}
