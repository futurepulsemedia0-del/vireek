import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { BadgePercent, CheckCircle2, FileText, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { IncentivePanel } from '@/components/quotes/IncentivePanel';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { calculateQuoteTotals } from '@/lib/quotes';
import type { QuoteLineItem } from '@/lib/quotes';
import {
  BASIS_OPTIONS,
  BENEFIT_KIND_OPTIONS,
  CUSTOMER_KIND_OPTIONS,
  DELIVERY_LABEL,
  DELIVERY_OPTIONS,
  EMPTY_PROGRAM_FORM,
  FUNDING_OPTIONS,
  PROGRAM_TYPE_OPTIONS,
  addProgram,
  deleteProgram,
  describeBenefit,
  fetchPrograms,
  fetchRecentAssessments,
  formatMonths,
  formatUsd,
  markProgramVerified,
  programFreshness,
  setProgramActive,
} from '@/lib/incentives';
import type { IncentiveAssessmentRow, IncentiveProgramRow, ProgramForm } from '@/lib/incentives';

interface PickerQuote {
  id: string;
  customer_name: string;
  status: string;
  line_items: QuoteLineItem[];
  tax_percent: number;
  created_at: string;
  incentive_potential_cents: number | null;
}

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';
const sectionClass = 'mb-8 rounded-2xl border border-border bg-bg-secondary p-5';

type TextKey = {
  [K in keyof ProgramForm]: ProgramForm[K] extends string ? K : never;
}[keyof ProgramForm];

interface FormField {
  key: TextKey;
  label: string;
  type?: 'text' | 'number' | 'date';
  placeholder?: string;
  helper?: string;
}

const REGION_FIELDS: FormField[] = [
  { key: 'country', label: 'Country code', placeholder: 'US' },
  { key: 'states', label: 'States / regions', placeholder: 'CA, OR (blank = anywhere)' },
  { key: 'postal_prefixes', label: 'Postal code prefixes', placeholder: '941, 945 (blank = anywhere)' },
  { key: 'utility_names', label: 'Utilities', placeholder: 'Utility names (blank = any)' },
];

const RULE_FIELDS: FormField[] = [
  { key: 'equipment_types', label: 'Qualifying equipment', placeholder: 'heat pump, water heater (blank = any)' },
  { key: 'efficiency_metric', label: 'Efficiency rating type', placeholder: 'SEER2, UEF…' },
  { key: 'min_efficiency_value', label: 'Minimum rating', type: 'number' },
  { key: 'min_project_dollars', label: 'Minimum project size ($)', type: 'number' },
  { key: 'min_building_age_years', label: 'Minimum building age (years)', type: 'number' },
  { key: 'max_building_age_years', label: 'Maximum building age (years)', type: 'number' },
];

const TIMING_FIELDS: FormField[] = [
  { key: 'effective_start', label: 'Starts', type: 'date' },
  { key: 'effective_end', label: 'Ends', type: 'date', helper: 'Last day the program applies.' },
  { key: 'stack_group', label: 'Exclusive group', placeholder: 'e.g. hp-rebates', helper: 'Programs with the same group name cannot be combined.' },
  { key: 'source_url', label: 'Official source link', placeholder: 'https://…' },
];

export function IncentiveEnginePage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();
  const pickerId = useId();
  const formId = useId();

  const [quotes, setQuotes] = useState<PickerQuote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');

  const [programs, setPrograms] = useState<IncentiveProgramRow[]>([]);
  const [programsLoading, setProgramsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ProgramForm>(EMPTY_PROGRAM_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [history, setHistory] = useState<IncentiveAssessmentRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadQuotes = useCallback(async () => {
    setQuotesLoading(true);
    const { data, error } = await supabase
      .from('quotes')
      .select('id, customer_name, status, line_items, tax_percent, created_at, incentive_potential_cents')
      .in('status', ['draft', 'sent'])
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) toast('Could not load your quotes.', 'error');
    setQuotes((data as unknown as PickerQuote[]) ?? []);
    setQuotesLoading(false);
  }, [toast]);

  const loadPrograms = useCallback(async () => {
    setProgramsLoading(true);
    try {
      setPrograms(await fetchPrograms());
    } catch {
      toast('Could not load your incentive programs.', 'error');
    }
    setProgramsLoading(false);
  }, [toast]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistory(await fetchRecentAssessments(50));
    } catch {
      // Team members without billing access get an empty list from RLS; a hard error is rare and non-fatal here.
      setHistory([]);
    }
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    loadQuotes();
    loadPrograms();
    loadHistory();
  }, [loadQuotes, loadPrograms, loadHistory]);

  const selected = useMemo(() => quotes.find((q) => q.id === selectedId) ?? null, [quotes, selectedId]);
  const activeCount = programs.filter((p) => p.is_active).length;

  const setField = (key: keyof ProgramForm, value: string | boolean) => setForm((f) => ({ ...f, [key]: value }));

  const handleAdd = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await addProgram(user.id, form);
      toast('Program added to your catalog.', 'success');
      setForm(EMPTY_PROGRAM_FORM);
      setShowForm(false);
      await loadPrograms();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the program.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (fn: () => Promise<void>, ok: string, fail: string) => {
    try {
      await fn();
      toast(ok, 'success');
      await loadPrograms();
    } catch {
      toast(fail, 'error');
    }
  };

  const handleDelete = async () => {
    const id = deletingId;
    setDeletingId(null);
    if (id) await runAction(() => deleteProgram(id), 'Program deleted.', 'Could not delete the program.');
  };

  const textFields = (fields: FormField[]) =>
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

  const selectField = <T extends string>(key: keyof ProgramForm, label: string, value: T, options: { value: T; label: string }[]) => (
    <div>
      <label htmlFor={`${formId}-${key}`} className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      <select id={`${formId}-${key}`} value={value} onChange={(e) => setField(key, e.target.value)} className={selectClass}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );

  const benefitLabel =
    form.benefit_kind === 'percent' ? 'Benefit (% of cost)' : form.benefit_kind === 'per_unit' ? 'Benefit ($ per unit)' : 'Benefit ($)';

  return (
    <DashboardLayout activeLabel="Incentive Engine">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <BadgePercent size={24} aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Incentive Engine</h1>
            <p className="text-sm text-text-secondary">
              See which rebates and credits apply to a project, what the customer really pays after them, and how fast the upgrade pays for itself.
            </p>
          </div>
        </div>

        {/* ---------------- Assess ---------------- */}
        <section className={sectionClass} aria-labelledby={`${pickerId}-h`}>
          <h2 id={`${pickerId}-h`} className="mb-3 text-sm font-semibold text-text-primary">Check a quote</h2>
          {quotesLoading ? (
            <SkeletonCard rows={2} withIcon={false} />
          ) : quotes.length === 0 ? (
            <EmptyState icon={FileText} title="No draft or sent quotes to check" description="Build a quote on the Quotes page, then come back to see its incentives and net cost." />
          ) : (
            <>
              <label htmlFor={pickerId} className="mb-1.5 block text-sm font-medium text-text-primary">Quote</label>
              <select id={pickerId} value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className={`${selectClass} mb-4`}>
                <option value="">Select a quote…</option>
                {quotes.map((q) => {
                  const total = calculateQuoteTotals(q.line_items ?? [], Number(q.tax_percent) || 0).totalCents;
                  return (
                    <option key={q.id} value={q.id}>
                      {q.customer_name} · {formatUsd(total)} · {q.status}
                      {q.incentive_potential_cents ? ` · up to ${formatUsd(q.incentive_potential_cents)} in incentives` : ''}
                    </option>
                  );
                })}
              </select>
              {selected ? (
                <IncentivePanel key={selected.id} quoteId={selected.id} onAssessed={() => { loadHistory(); loadQuotes(); }} />
              ) : (
                <p className="text-xs text-text-secondary">Pick a quote to run the check. The result is advisory and never changes the quote.</p>
              )}
            </>
          )}
        </section>

        {/* ---------------- Catalog ---------------- */}
        <section className={sectionClass} aria-labelledby={`${formId}-h`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id={`${formId}-h`} className="text-sm font-semibold text-text-primary">Your program catalog</h2>
              <p className="text-xs text-text-secondary">
                The engine only evaluates programs you add here, and never invents amounts. Re-verify each one against its official source at least every 6 months.
              </p>
            </div>
            {isOwner && (
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
                <Plus size={16} aria-hidden="true" /> {showForm ? 'Close' : 'Add program'}
              </Button>
            )}
          </div>

          {isOwner && showForm && (
            <div className="mb-5 space-y-5 rounded-xl border border-border bg-bg-primary p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Program name" required value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="Utility heat pump rebate" />
                <Input label="Administrator" value={form.administrator} onChange={(e) => setField('administrator', e.target.value)} placeholder="Utility, agency or manufacturer" />
                {selectField('program_type', 'Program type', form.program_type, PROGRAM_TYPE_OPTIONS)}
                {selectField('funding_status', 'Funding', form.funding_status, FUNDING_OPTIONS)}
              </div>

              <fieldset>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Where it applies</legend>
                <div className="grid gap-3 sm:grid-cols-2">{textFields(REGION_FIELDS)}</div>
              </fieldset>

              <fieldset>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Who and what qualifies</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {selectField('customer_kind', 'Customer type', form.customer_kind, CUSTOMER_KIND_OPTIONS)}
                  <div className="flex flex-col justify-end gap-2 pb-1">
                    <label className="flex items-center gap-2 text-sm text-text-primary">
                      <input type="checkbox" checked={form.requires_owner_occupied} onChange={(e) => setField('requires_owner_occupied', e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
                      Owner-occupied homes only
                    </label>
                    <label className="flex items-center gap-2 text-sm text-text-primary">
                      <input type="checkbox" checked={form.requires_income_qualified} onChange={(e) => setField('requires_income_qualified', e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
                      Income-qualified households only
                    </label>
                  </div>
                  {textFields(RULE_FIELDS)}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">What it pays</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {selectField('benefit_kind', 'Benefit type', form.benefit_kind, BENEFIT_KIND_OPTIONS)}
                  <Input label={benefitLabel} type="number" inputMode="decimal" min={0} required value={form.benefit_value} onChange={(e) => setField('benefit_value', e.target.value)} />
                  <Input label="Maximum payout ($)" type="number" inputMode="decimal" min={0} value={form.cap_dollars} onChange={(e) => setField('cap_dollars', e.target.value)} helperText="Leave blank for no cap." />
                  {form.benefit_kind === 'percent' && selectField('percent_basis', 'Percentage applies to', form.percent_basis, BASIS_OPTIONS)}
                  {selectField('delivery', 'How the customer receives it', form.delivery, DELIVERY_OPTIONS)}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Timing and source</legend>
                <div className="grid gap-3 sm:grid-cols-2">{textFields(TIMING_FIELDS)}</div>
              </fieldset>

              <Textarea label="Notes" rows={2} value={form.notes} onChange={(e) => setField('notes', e.target.value)} placeholder="Application steps, paperwork, quirks…" />

              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input type="checkbox" checked={form.verified_now} onChange={(e) => setField('verified_now', e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
                I checked these details against the official source today
              </label>

              <Button type="button" size="sm" className="w-full sm:w-auto" onClick={handleAdd} disabled={saving}>
                {saving ? 'Adding…' : 'Add to catalog'}
              </Button>
            </div>
          )}

          {programsLoading ? (
            <SkeletonCard rows={3} withIcon={false} />
          ) : programs.length === 0 ? (
            <EmptyState
              icon={BadgePercent}
              title="No programs in your catalog yet"
              description={isOwner ? 'Add the rebates and credits available in your service area, then check any quote against them.' : 'Ask the account owner to add the incentive programs available in your service area.'}
            />
          ) : (
            <>
              <p className="mb-2 text-xs text-text-secondary">{activeCount} active of {programs.length}</p>
              <ul className="space-y-2">
                {programs.map((p) => {
                  const fresh = programFreshness(p.verified_at);
                  const region = [p.states.join(', '), p.utility_names.join(', ')].filter(Boolean).join(' · ') || 'Anywhere';
                  return (
                    <li key={p.id} className={`rounded-xl border border-border bg-bg-primary p-3 ${p.is_active ? '' : 'opacity-60'}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text-primary">{p.name}</p>
                          <p className="text-xs text-text-secondary">
                            {describeBenefit(p)} · {DELIVERY_LABEL[p.delivery]} · {p.country} · {region}
                          </p>
                          <p className="text-xs text-text-secondary">
                            {p.effective_start || p.effective_end ? `${p.effective_start ?? 'any time'} → ${p.effective_end ?? 'open-ended'} · ` : ''}
                            <span className={fresh.stale ? 'font-medium text-warning-500' : ''}>{fresh.label}</span>
                            {p.is_active ? '' : ' · Paused'}
                          </p>
                        </div>
                        {isOwner && (
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => runAction(() => markProgramVerified(p.id), 'Marked as verified today.', 'Could not update the program.')} aria-label={`Mark ${p.name} as verified today`} title="Mark verified today" className="focus-ring rounded-lg p-2 text-text-secondary hover:text-success-500">
                              <CheckCircle2 size={16} aria-hidden="true" />
                            </button>
                            <button type="button" onClick={() => runAction(() => setProgramActive(p.id, !p.is_active), p.is_active ? 'Program paused.' : 'Program resumed.', 'Could not update the program.')} aria-label={p.is_active ? `Pause ${p.name}` : `Resume ${p.name}`} title={p.is_active ? 'Pause' : 'Resume'} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-text-primary">
                              {p.is_active ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                            </button>
                            <button type="button" onClick={() => setDeletingId(p.id)} aria-label={`Delete ${p.name}`} title="Delete" className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger">
                              <Trash2 size={16} aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        {/* ---------------- History ---------------- */}
        <section className={sectionClass} aria-labelledby={`${pickerId}-hist`}>
          <h2 id={`${pickerId}-hist`} className="mb-3 text-sm font-semibold text-text-primary">Recent checks</h2>
          {historyLoading ? (
            <SkeletonCard rows={3} withIcon={false} />
          ) : history.length === 0 ? (
            <EmptyState icon={BadgePercent} title="No incentive checks yet" description="Every check you run is saved here so you can see how much value your quotes are unlocking." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs text-text-secondary">
                  <tr>
                    <th className="px-3 py-2 font-medium">Quote</th>
                    <th className="px-3 py-2 font-medium">Total</th>
                    <th className="px-3 py-2 font-medium">Confirmed</th>
                    <th className="px-3 py-2 font-medium">Up to</th>
                    <th className="px-3 py-2 font-medium">Best net cost</th>
                    <th className="px-3 py-2 font-medium">Payback</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-text-primary">{a.quotes?.customer_name ?? 'Quote'}</td>
                      <td className="px-3 py-2 text-text-secondary">{formatUsd(a.total_cents)}</td>
                      <td className="px-3 py-2 text-text-secondary">{formatUsd(a.confirmed_cents)}</td>
                      <td className="px-3 py-2 text-text-secondary">{formatUsd(a.potential_cents)}</td>
                      <td className="px-3 py-2 text-text-secondary">{formatUsd(a.net_cost_best_cents)}</td>
                      <td className="px-3 py-2 text-text-secondary">{formatMonths(a.payback_months_best === null ? null : Number(a.payback_months_best))}</td>
                      <td className="px-3 py-2 text-text-secondary">{new Date(a.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="Delete this program?"
        description="It will no longer be considered in incentive checks. Past results are kept."
        confirmLabel="Yes, delete it"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
      />
    </DashboardLayout>
  );
}
