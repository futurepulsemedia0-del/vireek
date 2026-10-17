import { useState } from 'react';
import { Languages } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  LANGUAGE_OPTIONS,
  normalizeLanguage,
  sourceLabel,
  updateCustomerLanguage,
  type LanguageCode,
  type LanguageSource,
} from '@/lib/customerLanguage';

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-2.5 text-sm text-text-primary';

/** Controlled picker. Empty value = "not set" (assistant adapts / auto-detect may fill it). */
export function CustomerLanguageSelect({
  value,
  onChange,
  id = 'customer-language',
}: {
  value: LanguageCode | null;
  onChange: (next: LanguageCode | null) => void;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(normalizeLanguage(e.target.value))}
      className={SELECT_CLASS}
    >
      <option value="">Not set — detect automatically</option>
      {LANGUAGE_OPTIONS.map((o) => (
        <option key={o.code} value={o.code}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Self-saving control for the customer detail page. */
export function CustomerLanguageControl({
  customerId,
  language,
  source,
  onChanged,
}: {
  customerId: string;
  language: string | null | undefined;
  source: LanguageSource | null | undefined;
  onChanged: (language: LanguageCode | null) => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const current = normalizeLanguage(language);

  const handleChange = async (next: LanguageCode | null) => {
    if (next === current) return;
    setSaving(true);
    const ok = await updateCustomerLanguage(customerId, next);
    setSaving(false);
    if (!ok) {
      toast('Could not update the language.', 'error');
      return;
    }
    onChanged(next);
    toast(next ? 'Language updated.' : 'Language cleared.', 'success');
  };

  return (
    <div className="mt-3 max-w-xs">
      <label
        htmlFor="customer-language-control"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text-secondary"
      >
        <Languages size={13} aria-hidden="true" /> Preferred language
      </label>
      <div className={saving ? 'pointer-events-none opacity-60' : undefined}>
        <CustomerLanguageSelect
          id="customer-language-control"
          value={current}
          onChange={handleChange}
        />
      </div>
      <p className="mt-1 text-[11px] text-text-secondary">{sourceLabel(current ? source : null)}</p>
    </div>
  );
}
