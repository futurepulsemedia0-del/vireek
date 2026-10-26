import { useEffect, useState } from 'react';
import { Landmark, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import {
  ADDBACK_KIND_LABELS,
  GRADE_LABELS,
  INDUSTRY_PRESETS,
  fmtMoney,
  signedAmountCents,
  validateAddBack,
  validateMultiple,
  type AddBack,
  type AddBackDraft,
  type AddBackKind,
  type Evaluation,
  type ExitSettings,
  type IndustryKey,
  type MultipleRange,
  type ValuationMethod,
} from '@/lib/exitReadiness';
import { EstimateBanner, Stat, Toggle, selectClass } from './shared';

interface Props {
  evaluation: Evaluation;
  settings: ExitSettings;
  addBacks: AddBack[];
  saving: boolean;
  onSaveSettings: (s: ExitSettings) => Promise<void>;
  onCreateAddBack: (input: { kind: AddBackKind; label: string; amountCents: number; justification: string; evidenceRef: string }) => Promise<void>;
  onToggleAddBack: (id: string, active: boolean) => Promise<void>;
  onDeleteAddBack: (id: string) => void;
}

const num = (v: string): number => Number(v.trim());
const multDraft = (m: MultipleRange | null, fallback: MultipleRange) => {
  const x = m ?? fallback;
  return { low: String(x.low), mid: String(x.mid), high: String(x.high) };
};

function MultipleFields({ title, idPrefix, value, onChange, error }: {
  title: string; idPrefix: string; value: { low: string; mid: string; high: string };
  onChange: (v: { low: string; mid: string; high: string }) => void; error?: string | null;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-text-primary">{title}</legend>
      <div className="grid grid-cols-3 gap-2">
        {(['low', 'mid', 'high'] as const).map((k) => (
          <Input key={k} id={`${idPrefix}-${k}`} label={k === 'low' ? 'Low' : k === 'mid' ? 'Mid' : 'High'} type="number" inputMode="decimal" step="0.1" min={0.1} max={20}
            value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </fieldset>
  );
}

export function ValuationPanel({ evaluation, settings, addBacks, saving, onSaveSettings, onCreateAddBack, onToggleAddBack, onDeleteAddBack }: Props) {
  const { valuation: v, earnings: e, readiness, confidence } = evaluation;
  const preset = INDUSTRY_PRESETS[settings.industryKey];

  // ---- settings draft
  const [industry, setIndustry] = useState<IndustryKey>(settings.industryKey);
  const [method, setMethod] = useState<ValuationMethod>(settings.method);
  const [sde, setSde] = useState(multDraft(settings.sdeMultiple, preset.sde));
  const [ebitda, setEbitda] = useState(multDraft(settings.ebitdaMultiple, preset.ebitda));
  const [useCustom, setUseCustom] = useState(settings.sdeMultiple !== null || settings.ebitdaMultiple !== null);
  const [salary, setSalary] = useState(String(settings.ownerMarketSalaryCents / 100));
  const [hours, setHours] = useState(settings.ownerWeeklyHours === null ? '' : String(settings.ownerWeeklyHours));
  const [adjusts, setAdjusts] = useState(settings.readinessAdjusts);

  useEffect(() => {
    const p = INDUSTRY_PRESETS[settings.industryKey];
    setIndustry(settings.industryKey);
    setMethod(settings.method);
    setSde(multDraft(settings.sdeMultiple, p.sde));
    setEbitda(multDraft(settings.ebitdaMultiple, p.ebitda));
    setUseCustom(settings.sdeMultiple !== null || settings.ebitdaMultiple !== null);
    setSalary(String(settings.ownerMarketSalaryCents / 100));
    setHours(settings.ownerWeeklyHours === null ? '' : String(settings.ownerWeeklyHours));
    setAdjusts(settings.readinessAdjusts);
  }, [settings]);

  const toRange = (d: { low: string; mid: string; high: string }): MultipleRange => ({ low: num(d.low), mid: num(d.mid), high: num(d.high) });
  const sdeErr = useCustom ? validateMultiple(toRange(sde)) : null;
  const ebitdaErr = useCustom ? validateMultiple(toRange(ebitda)) : null;
  const salaryN = num(salary);
  const hoursN = hours.trim() === '' ? null : num(hours);
  const salaryErr = !Number.isFinite(salaryN) || salaryN < 0 || salaryN > 100_000_000 ? 'Enter a salary between $0 and $100,000,000.' : null;
  const hoursErr = hoursN !== null && (!Number.isFinite(hoursN) || hoursN < 0 || hoursN > 120) ? 'Hours must be between 0 and 120.' : null;
  const canSave = !sdeErr && !ebitdaErr && !salaryErr && !hoursErr && !saving;

  const save = () =>
    onSaveSettings({
      industryKey: industry,
      method,
      sdeMultiple: useCustom ? toRange(sde) : null,
      ebitdaMultiple: useCustom ? toRange(ebitda) : null,
      ownerMarketSalaryCents: Math.round(salaryN * 100),
      ownerWeeklyHours: hoursN,
      readinessAdjusts: adjusts,
    });

  // ---- add-back draft
  const emptyDraft: AddBackDraft = { kind: 'owner_compensation', label: '', amountDollars: '', justification: '', evidenceRef: '' };
  const [draft, setDraft] = useState<AddBackDraft>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const submitAddBack = async () => {
    const found = validateAddBack(draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    setAdding(true);
    try {
      await onCreateAddBack({ kind: draft.kind, label: draft.label, amountCents: signedAmountCents(draft.kind, draft.amountDollars), justification: draft.justification, evidenceRef: draft.evidenceRef });
      setDraft(emptyDraft);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <EstimateBanner />
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Estimated range (low)" value={v.reason ? '—' : fmtMoney(v.lowCents)} sub={`${v.multiple.low.toFixed(1)}× ${v.method.toUpperCase()}`} />
          <Stat label="Readiness-adjusted estimate" value={v.reason ? '—' : fmtMoney(v.pointCents)} sub={`${v.pointMultiple.toFixed(2)}× · ${GRADE_LABELS[readiness.grade]}`} />
          <Stat label="Estimated range (high)" value={v.reason ? '—' : fmtMoney(v.highCents)} sub={`${v.multiple.high.toFixed(1)}× ${v.method.toUpperCase()}`} />
          <Stat label="Data confidence" value={confidence.charAt(0).toUpperCase() + confidence.slice(1)} sub={`${Math.round(readiness.coverage * 100)}% of drivers have data`} />
        </div>
        {v.reason && <p className="mt-3 text-sm text-danger">{v.reason}</p>}
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">How earnings are built</h2>
        <p className="mb-4 text-xs text-text-secondary">Trailing 12 months of posted ledger entries plus the documented add-backs below. Nothing is hidden.</p>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          {([
            ['Net income (revenue − expenses)', e.netIncomeCents],
            ['+ Interest, taxes, D&A found in your ledger', e.autoAddBacksCents],
            ['+ Documented add-backs (net of deductions)', e.manualAddBacksCents],
            ['= Seller’s discretionary earnings (SDE)', e.sdeCents],
            ['− Market salary for an owner-replacement manager', -e.ownerSalaryCents],
            ['= Adjusted EBITDA', e.ebitdaCents],
          ] as const).map(([k, val]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-border/60 py-1.5">
              <dt className="text-text-secondary">{k}</dt>
              <dd className="font-medium text-text-primary">{fmtMoney(val)}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">Assumptions you control</h2>
        <p className="mb-4 text-xs text-text-secondary">Industry multiples are illustrative starting ranges, not market data. Replace them with figures from your broker or advisor.</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ex-industry" className="mb-1.5 block text-sm font-medium text-text-primary">Industry preset</label>
            <select id="ex-industry" className={selectClass} value={industry} onChange={(ev) => setIndustry(ev.target.value as IndustryKey)}>
              {Object.values(INDUSTRY_PRESETS).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ex-method" className="mb-1.5 block text-sm font-medium text-text-primary">Method</label>
            <select id="ex-method" className={selectClass} value={method} onChange={(ev) => setMethod(ev.target.value as ValuationMethod)}>
              <option value="auto">Automatic (SDE under $750K, EBITDA above)</option>
              <option value="sde">Seller’s discretionary earnings (SDE)</option>
              <option value="ebitda">Adjusted EBITDA</option>
            </select>
          </div>
          <Input id="ex-salary" label="Market salary to replace you (USD / year)" type="number" inputMode="decimal" min={0} value={salary} onChange={(ev) => setSalary(ev.target.value)} error={salaryErr ?? undefined} helperText="Used only for adjusted EBITDA." />
          <Input id="ex-hours" label="Your weekly hours in operations (optional)" type="number" inputMode="decimal" min={0} max={120} value={hours} onChange={(ev) => setHours(ev.target.value)} error={hoursErr ?? undefined} helperText="Feeds the owner-dependence score." />
          <div className="sm:col-span-2 space-y-3">
            <Toggle id="ex-adjusts" checked={adjusts} onChange={setAdjusts} label="Place the estimate inside the range using the sell-readiness score" hint="Off = always use the mid multiple." />
            <Toggle id="ex-custom" checked={useCustom} onChange={setUseCustom} label="Use my own multiples instead of the preset" />
          </div>
          {useCustom && (
            <>
              <MultipleFields title="SDE multiple" idPrefix="ex-sde" value={sde} onChange={setSde} error={sdeErr} />
              <MultipleFields title="EBITDA multiple" idPrefix="ex-ebitda" value={ebitda} onChange={setEbitda} error={ebitdaErr} />
            </>
          )}
        </div>
        <div className="mt-4">
          <Button variant="primary" size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />} Save assumptions
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">Add-backs & adjustments</h2>
        <p className="mb-4 text-xs text-text-secondary">Every adjustment needs a written justification; buyers will test each one. Interest, taxes and depreciation already in your ledger are picked up automatically — only add what the ledger does not show.</p>

        {addBacks.length === 0 ? (
          <EmptyState icon={Landmark} title="No add-backs yet" description="Start with your owner compensation, then any personal or one-time expenses that run through the business." />
        ) : (
          <ul className="divide-y divide-border/60">
            {addBacks.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium ${a.active ? 'text-text-primary' : 'text-text-secondary line-through'}`}>{a.label} · {fmtMoney(a.amountCents)}</p>
                  <p className="text-[11px] text-text-secondary">{ADDBACK_KIND_LABELS[a.kind]}</p>
                  <p className="mt-1 text-xs text-text-secondary">{a.justification}</p>
                  {a.evidenceRef && <p className="text-[11px] text-text-secondary">Evidence: {a.evidenceRef}</p>}
                </div>
                <Toggle id={`ab-${a.id}`} checked={a.active} onChange={(val) => void onToggleAddBack(a.id, val)} label="Included" />
                <button type="button" aria-label={`Delete ${a.label}`} onClick={() => onDeleteAddBack(a.id)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger">
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 grid grid-cols-1 gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ab-kind" className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
            <select id="ab-kind" className={selectClass} value={draft.kind} onChange={(ev) => setDraft({ ...draft, kind: ev.target.value as AddBackKind })}>
              {(Object.keys(ADDBACK_KIND_LABELS) as AddBackKind[]).map((k) => <option key={k} value={k}>{ADDBACK_KIND_LABELS[k]}</option>)}
            </select>
          </div>
          <Input id="ab-amount" label="Annual amount (USD)" type="number" inputMode="decimal" min={0} value={draft.amountDollars} onChange={(ev) => setDraft({ ...draft, amountDollars: ev.target.value })} error={errors.amountDollars} helperText={draft.kind === 'deduction' ? 'Enter a positive number; it is subtracted.' : undefined} />
          <div className="sm:col-span-2"><Input id="ab-label" label="Label" value={draft.label} onChange={(ev) => setDraft({ ...draft, label: ev.target.value })} error={errors.label} maxLength={120} /></div>
          <div className="sm:col-span-2"><Textarea id="ab-just" label="Justification" rows={3} value={draft.justification} onChange={(ev) => setDraft({ ...draft, justification: ev.target.value })} error={errors.justification} maxLength={1000} /></div>
          <div className="sm:col-span-2"><Input id="ab-evidence" label="Evidence (optional)" value={draft.evidenceRef} onChange={(ev) => setDraft({ ...draft, evidenceRef: ev.target.value })} error={errors.evidenceRef} maxLength={300} helperText="e.g. “2026 tax return, Schedule C line 12” or a document name." /></div>
          <div className="sm:col-span-2">
            <Button variant="secondary" size="sm" disabled={adding} onClick={() => void submitAddBack()}>
              {adding ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} Add adjustment
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
