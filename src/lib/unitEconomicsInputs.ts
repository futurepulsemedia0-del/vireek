/** Validation for staff-entered unit-economics inputs (rates, limits, invoices). Pure; mirrors the DB CHECK constraints. */

export const RATE_COMPONENTS = [
  'carrier_inbound', 'carrier_outbound', 'carrier_unclassified', 'asr', 'llm', 'tts', 'voice_platform',
  'sms_segment', 'recording_storage', 'transcription', 'embeddings', 'vision', 'provider_other', 'provider_total_unbroken', 'phone_number', 'platform_fixed',
] as const;
export const RATE_UNITS = [
  'per_minute', 'per_1m_input_tokens', 'per_1m_output_tokens', 'per_segment', 'per_1k_characters', 'per_gb_month', 'per_image', 'per_event', 'per_month',
] as const;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export interface RateInput {
  component: string; provider: string; unit: string; rateUsd: number; source: string;
  sourceUrl: string | null; effectiveFrom: string; effectiveTo: string | null;
}

export function validateRateInput(raw: { component: string; provider: string; unit: string; rateUsd: string; source: string; sourceUrl: string; effectiveFrom: string; effectiveTo: string }): Validation<RateInput> {
  const errors: string[] = [];
  const provider = raw.provider.trim();
  const source = raw.source.trim();
  const rate = raw.rateUsd.trim() === '' ? NaN : Number(raw.rateUsd);
  const url = raw.sourceUrl.trim();
  const to = raw.effectiveTo.trim();
  if (!(RATE_COMPONENTS as readonly string[]).includes(raw.component)) errors.push('Choose a component.');
  if (!(RATE_UNITS as readonly string[]).includes(raw.unit)) errors.push('Choose a unit.');
  if (!provider || provider.length > 80) errors.push('Provider is required (max 80 characters).');
  if (!Number.isFinite(rate) || rate < 0 || rate > 1000) errors.push('Rate must be a number between 0 and 1000 USD.');
  if (!source || source.length > 300) errors.push('Source is required (where this price comes from, max 300 characters).');
  if (url && !/^https?:\/\/\S+$/i.test(url)) errors.push('Source URL must start with http:// or https://.');
  if (!isIsoDate(raw.effectiveFrom)) errors.push('Effective-from must be a valid date.');
  if (to && !isIsoDate(to)) errors.push('Effective-to must be a valid date.');
  else if (to && isIsoDate(raw.effectiveFrom) && to <= raw.effectiveFrom) errors.push('Effective-to must be after effective-from.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { component: raw.component, provider, unit: raw.unit, rateUsd: rate, source, sourceUrl: url || null, effectiveFrom: raw.effectiveFrom, effectiveTo: to || null } };
}

export interface LimitInput { plan: string; softCostUsd: number | null; hardCostUsd: number | null; maxCallSeconds: number | null }

export function validateLimitInput(raw: { plan: string; softCostUsd: string; hardCostUsd: string; maxCallSeconds: string }): Validation<LimitInput> {
  const errors: string[] = [];
  const parse = (s: string, label: string, integer = false): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) { errors.push(`${label} must be a ${integer ? 'whole ' : ''}number ≥ 0 (or empty for no limit).`); return null; }
    return n;
  };
  const plan = raw.plan.trim();
  if (!plan) errors.push('Plan is required.');
  const soft = parse(raw.softCostUsd, 'Soft limit');
  const hard = parse(raw.hardCostUsd, 'Hard limit');
  const secs = parse(raw.maxCallSeconds, 'Max call seconds', true);
  if (secs !== null && secs === 0) errors.push('Max call seconds must be greater than 0 (or empty).');
  if (soft !== null && hard !== null && hard < soft) errors.push('Hard limit must be ≥ soft limit.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { plan, softCostUsd: soft, hardCostUsd: hard, maxCallSeconds: secs } };
}

export interface InvoiceInput { provider: string; periodMonth: string; invoicedUsd: number; invoiceRef: string | null }

export function validateInvoiceInput(raw: { provider: string; month: string; invoicedUsd: string; invoiceRef: string }): Validation<InvoiceInput> {
  const errors: string[] = [];
  const provider = raw.provider.trim();
  const amount = raw.invoicedUsd.trim() === '' ? NaN : Number(raw.invoicedUsd);
  if (!provider || provider.length > 80) errors.push('Provider is required (max 80 characters).');
  if (!/^\d{4}-\d{2}$/.test(raw.month) || !isIsoDate(`${raw.month}-01`)) errors.push('Month must look like 2026-10.');
  if (!Number.isFinite(amount) || amount < 0) errors.push('Invoice amount must be a number ≥ 0.');
  if (raw.invoiceRef.length > 200) errors.push('Invoice reference is too long (max 200).');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { provider, periodMonth: `${raw.month}-01`, invoicedUsd: amount, invoiceRef: raw.invoiceRef.trim() || null } };
}
