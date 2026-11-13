import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useFairSaleT } from '@/i18n/fairSaleNamespace';
import { CONFIG_BOUNDS, errorMessage, saveSettings, type FairSaleConfig } from '@/lib/fairSale';

type NumKey = keyof typeof CONFIG_BOUNDS;
const FIELDS: { key: NumKey; cents: boolean }[] = [
  { key: 'largeJobCents', cents: true },
  { key: 'largeDepositCents', cents: true },
  { key: 'largeDepositPercent', cents: false },
  { key: 'scopeEscalationPercent', cents: false },
  { key: 'pauseThresholdCents', cents: true },
  { key: 'pauseHours', cents: false },
  { key: 'managerApprovalDepositCents', cents: true },
  { key: 'confusionRepeatThreshold', cents: false },
];

type Form = Record<NumKey, string>;
const toForm = (c: FairSaleConfig): Form =>
  Object.fromEntries(FIELDS.map((f) => [f.key, String(f.cents ? c[f.key] / 100 : c[f.key])])) as Form;

function parse(value: string, cents: boolean, key: NumKey): number | null {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) return null;
  const raw = cents ? Math.round(n * 100) : n;
  if (!cents && !Number.isInteger(n)) return null;
  const [min, max] = CONFIG_BOUNDS[key];
  return raw >= min && raw <= max ? raw : null;
}

export function SettingsTab({ initial, canEdit, onSaved }: { initial: FairSaleConfig; canEdit: boolean; onSaved: (c: FairSaleConfig) => void }) {
  const { t } = useFairSaleT();
  const [form, setForm] = useState<Form>(() => toForm(initial));
  const [financing, setFinancing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const errors: Partial<Record<NumKey, string>> = {};
  for (const f of FIELDS) {
    if (parse(form[f.key], f.cents, f.key) === null) {
      const [min, max] = CONFIG_BOUNDS[f.key];
      errors[f.key] = t('settings.range', { min: f.cents ? min / 100 : min, max: f.cents ? max / 100 : max });
    }
  }
  const invalid = Object.keys(errors).length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || !canEdit) return;
    const next = { managerApprovalFinancing: true } as FairSaleConfig;
    for (const f of FIELDS) (next as unknown as Record<string, number>)[f.key] = parse(form[f.key], f.cents, f.key) as number;
    setBusy(true);
    setMsg(null);
    try {
      const saved = await saveSettings(next);
      onSaved(saved);
      setForm(toForm(saved));
      setMsg({ ok: true, text: t('settings.saved') });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err, t('dash.errors.generic')) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-5 rounded-2xl border border-border bg-bg-secondary p-5" noValidate>
      <p className="text-sm text-text-secondary">{t('settings.intro')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Input
            key={f.key}
            type="number"
            inputMode="decimal"
            label={t(`settings.fields.${f.key}`)}
            value={form[f.key]}
            error={errors[f.key]}
            disabled={!canEdit || busy}
            onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
          />
        ))}
      </div>
      <Switch
        checked={financing}
        onChange={setFinancing}
        label={t('settings.financingLabel')}
        hint={t('settings.financingHint')}
        disabled
        disabledReason={t('settings.financingLocked')}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={busy} disabled={!canEdit || invalid} disabledReason={!canEdit ? t('settings.readOnly') : undefined}>
          {t('settings.save')}
        </Button>
        <span role="status" aria-live="polite" className={`text-sm ${msg?.ok ? 'text-success-500' : 'text-danger-500'}`}>{msg?.text ?? ''}</span>
      </div>
    </form>
  );
}
