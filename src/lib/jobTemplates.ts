import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/priceBook';

// ============================================================
// Types
// ============================================================

export interface JobTemplate {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  service_type: string | null;
  expected_duration_minutes: number | null;
  price_cents: number;
  active: boolean;
  times_used: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobTemplateSummary extends JobTemplate {
  service_count: number;
  part_count: number;
  checklist_count: number;
}

export interface JobTemplateServiceLine {
  service_name: string;
  price_book_item_id: string | null;
  quantity: number;
  unit_price_cents: number;
}

export interface JobTemplatePartLine {
  part_id: string;
  part_name: string;
  part_number: string | null;
  quantity: number;
}

export interface JobTemplateDetail extends JobTemplate {
  services: JobTemplateServiceLine[];
  parts: JobTemplatePartLine[];
  checklist: string[];
}

export interface JobChecklistItem {
  id: string;
  job_id: string;
  label: string;
  sort_order: number;
  completed_at: string | null;
  completed_by: string | null;
}

export interface JobTemplateSnapshot {
  template_id: string;
  name: string;
  description: string | null;
  duration_minutes: number | null;
  price_cents: number;
  services: JobTemplateServiceLine[];
  applied_at: string;
}

export interface ApplyTemplateResult {
  template_id: string;
  checklist_items: number;
  parts: number;
  services: number;
}

// ============================================================
// Limits (mirrored by CHECK constraints / RPC guards in the migration)
// ============================================================

export const TEMPLATE_LIMITS = {
  name: 120,
  description: 1000,
  serviceType: 120,
  serviceName: 120,
  checklistLabel: 200,
  maxServices: 50,
  maxParts: 50,
  maxChecklist: 100,
  minDurationMinutes: 5,
  maxDurationMinutes: 10080,
} as const;

// ============================================================
// Form state
// ============================================================

export interface ServiceLineForm {
  key: string;
  service_name: string;
  price_book_item_id: string;
  quantity: string;
  unit_price: string;
}

export interface PartLineForm {
  key: string;
  part_id: string;
  part_name: string;
  part_number: string;
  quantity: string;
}

export interface ChecklistLineForm {
  key: string;
  label: string;
}

export interface JobTemplateFormState {
  name: string;
  description: string;
  service_type: string;
  duration_minutes: string;
  price: string;
  services: ServiceLineForm[];
  parts: PartLineForm[];
  checklist: ChecklistLineForm[];
}

let keyCounter = 0;
export function newLineKey(): string {
  keyCounter += 1;
  return `l${Date.now().toString(36)}${keyCounter}`;
}

export function emptyTemplateForm(): JobTemplateFormState {
  return {
    name: '',
    description: '',
    service_type: '',
    duration_minutes: '',
    price: '',
    services: [],
    parts: [],
    checklist: [],
  };
}

export function templateToForm(t: JobTemplateDetail): JobTemplateFormState {
  return {
    name: t.name,
    description: t.description ?? '',
    service_type: t.service_type ?? '',
    duration_minutes: t.expected_duration_minutes != null ? String(t.expected_duration_minutes) : '',
    price: centsToInput(t.price_cents),
    services: t.services.map((s) => ({
      key: newLineKey(),
      service_name: s.service_name,
      price_book_item_id: s.price_book_item_id ?? '',
      quantity: String(s.quantity),
      unit_price: centsToInput(s.unit_price_cents),
    })),
    parts: t.parts.map((p) => ({
      key: newLineKey(),
      part_id: p.part_id,
      part_name: p.part_name,
      part_number: p.part_number ?? '',
      quantity: String(p.quantity),
    })),
    checklist: t.checklist.map((label) => ({ key: newLineKey(), label })),
  };
}

// ============================================================
// Money / number helpers
// ============================================================

export function centsToInput(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** Parses a dollar string ("12", "12.5", "$1,200.00") into integer cents, or null if invalid. */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isFinite(cents) && cents >= 0 && cents <= 2_000_000_000 ? cents : null;
}

export function parseQuantity(input: string): number | null {
  const n = Number(input.trim());
  if (!Number.isFinite(n) || n <= 0 || n > 999999) return null;
  return Math.round(n * 100) / 100;
}

export function parsePositiveInt(input: string): number | null {
  const t = input.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 1_000_000 ? n : null;
}

export function servicesTotalCents(lines: Array<Pick<JobTemplateServiceLine, 'quantity' | 'unit_price_cents'>>): number {
  return lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unit_price_cents), 0);
}

/** Sum of the service lines in the form, ignoring rows that are not valid yet. */
export function formServicesTotalCents(services: ServiceLineForm[]): number {
  return services.reduce((sum, s) => {
    const qty = parseQuantity(s.quantity);
    const unit = parseDollarsToCents(s.unit_price);
    return qty != null && unit != null ? sum + Math.round(qty * unit) : sum;
  }, 0);
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || minutes <= 0) return 'Not set';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export function formatTemplatePrice(cents: number): string {
  return cents > 0 ? formatCents(cents) : 'No price set';
}

// ============================================================
// Validation
// ============================================================

export type TemplateFormErrors = Partial<Record<'name' | 'description' | 'service_type' | 'duration_minutes' | 'price' | 'services' | 'parts' | 'checklist', string>>;

export function validateTemplateForm(form: JobTemplateFormState): TemplateFormErrors {
  const errors: TemplateFormErrors = {};
  const name = form.name.trim();

  if (!name) errors.name = 'Give the template a name.';
  else if (name.length > TEMPLATE_LIMITS.name) errors.name = `Keep the name under ${TEMPLATE_LIMITS.name} characters.`;

  if (form.description.length > TEMPLATE_LIMITS.description) {
    errors.description = `Keep the description under ${TEMPLATE_LIMITS.description} characters.`;
  }
  if (form.service_type.trim().length > TEMPLATE_LIMITS.serviceType) {
    errors.service_type = `Keep the service type under ${TEMPLATE_LIMITS.serviceType} characters.`;
  }

  if (form.duration_minutes.trim()) {
    const d = parsePositiveInt(form.duration_minutes);
    if (d == null || d < TEMPLATE_LIMITS.minDurationMinutes || d > TEMPLATE_LIMITS.maxDurationMinutes) {
      errors.duration_minutes = `Enter whole minutes between ${TEMPLATE_LIMITS.minDurationMinutes} and ${TEMPLATE_LIMITS.maxDurationMinutes}.`;
    }
  }

  if (form.price.trim() && parseDollarsToCents(form.price) == null) {
    errors.price = 'Enter a valid price, like 149 or 149.50.';
  }

  if (form.services.length > TEMPLATE_LIMITS.maxServices) {
    errors.services = `A template can have at most ${TEMPLATE_LIMITS.maxServices} services.`;
  } else {
    for (const s of form.services) {
      if (!s.service_name.trim()) {
        errors.services = 'Every service line needs a name — fill it in or remove the line.';
        break;
      }
      if (s.service_name.trim().length > TEMPLATE_LIMITS.serviceName) {
        errors.services = `Service names must be under ${TEMPLATE_LIMITS.serviceName} characters.`;
        break;
      }
      if (parseQuantity(s.quantity) == null) {
        errors.services = `"${s.service_name.trim()}" needs a quantity greater than zero.`;
        break;
      }
      if (parseDollarsToCents(s.unit_price || '0') == null) {
        errors.services = `"${s.service_name.trim()}" has an invalid price.`;
        break;
      }
    }
  }

  if (form.parts.length > TEMPLATE_LIMITS.maxParts) {
    errors.parts = `A template can have at most ${TEMPLATE_LIMITS.maxParts} parts.`;
  } else if (form.parts.some((p) => parsePositiveInt(p.quantity) == null)) {
    errors.parts = 'Every part needs a whole-number quantity of at least 1.';
  }

  if (form.checklist.length > TEMPLATE_LIMITS.maxChecklist) {
    errors.checklist = `A checklist can have at most ${TEMPLATE_LIMITS.maxChecklist} items.`;
  } else if (form.checklist.some((c) => !c.label.trim())) {
    errors.checklist = 'Checklist items cannot be blank — fill them in or remove them.';
  } else if (form.checklist.some((c) => c.label.trim().length > TEMPLATE_LIMITS.checklistLabel)) {
    errors.checklist = `Checklist items must be under ${TEMPLATE_LIMITS.checklistLabel} characters.`;
  }

  return errors;
}

export function hasErrors(errors: TemplateFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Builds the save_job_template RPC payload. Throws if the form is invalid. */
export function formToPayload(form: JobTemplateFormState) {
  const errors = validateTemplateForm(form);
  if (hasErrors(errors)) throw new Error(Object.values(errors)[0]);

  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    service_type: form.service_type.trim() || null,
    expected_duration_minutes: form.duration_minutes.trim() ? parsePositiveInt(form.duration_minutes) : null,
    price_cents: form.price.trim() ? (parseDollarsToCents(form.price) as number) : 0,
    services: form.services.map((s) => ({
      service_name: s.service_name.trim(),
      price_book_item_id: s.price_book_item_id || null,
      quantity: parseQuantity(s.quantity) as number,
      unit_price_cents: parseDollarsToCents(s.unit_price || '0') as number,
    })),
    parts: mergeDuplicateParts(form.parts),
    checklist: form.checklist.map((c) => c.label.trim()),
  };
}

function mergeDuplicateParts(parts: PartLineForm[]) {
  const merged = new Map<string, number>();
  for (const p of parts) {
    merged.set(p.part_id, (merged.get(p.part_id) ?? 0) + (parsePositiveInt(p.quantity) as number));
  }
  return [...merged.entries()].map(([part_id, quantity]) => ({ part_id, quantity }));
}

// ============================================================
// List helpers
// ============================================================

export type TemplateStatusFilter = 'active' | 'archived' | 'all';

export function filterTemplates(
  templates: JobTemplateSummary[],
  search: string,
  status: TemplateStatusFilter
): JobTemplateSummary[] {
  const q = search.trim().toLowerCase();
  return templates
    .filter((t) => (status === 'all' ? true : status === 'active' ? t.active : !t.active))
    .filter(
      (t) =>
        !q ||
        t.name.toLowerCase().includes(q) ||
        (t.service_type?.toLowerCase().includes(q) ?? false) ||
        (t.description?.toLowerCase().includes(q) ?? false)
    )
    .sort((a, b) => b.times_used - a.times_used || a.name.localeCompare(b.name));
}

export function checklistProgress(items: Array<Pick<JobChecklistItem, 'completed_at'>>) {
  const total = items.length;
  const done = items.filter((i) => i.completed_at).length;
  return { total, done, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

// ============================================================
// Error mapping (RPC raises short codes; PostgREST adds its own)
// ============================================================

interface PgLikeError {
  message?: string;
  code?: string;
}

export function describeTemplateError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof Error && !('code' in err)) return err.message || fallback;
  const e = (err ?? {}) as PgLikeError;
  const msg = e.message ?? '';
  if (e.code === '23505') return 'A template with this name already exists. Choose a different name.';
  if (e.code === '42501' || msg.includes('not_permitted') || msg.includes('row-level security')) {
    return 'You do not have permission to manage job templates. Ask your account owner for the "View Billing" permission.';
  }
  if (msg.includes('name_required')) return 'Give the template a name.';
  if (msg.includes('too_many_lines')) return 'This template has too many lines. Remove a few and try again.';
  if (msg.includes('invalid_part')) return 'One of the parts is no longer in your inventory. Remove it and try again.';
  if (msg.includes('template_not_found')) return 'That template no longer exists or is archived.';
  if (msg.includes('template_already_applied')) return 'A template was already applied to this job.';
  if (msg.includes('job_not_found')) return 'That job could not be found.';
  if (msg.includes('not_authenticated')) return 'Your session expired. Sign in again to continue.';
  return msg || fallback;
}

// ============================================================
// Supabase API
// ============================================================

type CountEmbed = Array<{ count: number }> | null;

interface SummaryRow extends JobTemplate {
  job_template_services: CountEmbed;
  job_template_parts: CountEmbed;
  job_template_checklist_items: CountEmbed;
}

const embedCount = (c: CountEmbed) => c?.[0]?.count ?? 0;

/** All templates for the caller's account (RLS scopes to the account owner). */
export async function fetchJobTemplates(accountOwnerId: string): Promise<JobTemplateSummary[]> {
  const { data, error } = await supabase
    .from('job_templates')
    .select('*, job_template_services(count), job_template_parts(count), job_template_checklist_items(count)')
    .eq('user_id', accountOwnerId)
    .order('name');
  if (error) throw error;
  return ((data ?? []) as unknown as SummaryRow[]).map((row) => {
    const { job_template_services, job_template_parts, job_template_checklist_items, ...template } = row;
    return {
      ...template,
      service_count: embedCount(job_template_services),
      part_count: embedCount(job_template_parts),
      checklist_count: embedCount(job_template_checklist_items),
    };
  });
}

/** Active templates only — the picker in the New Job flow. */
export async function fetchActiveJobTemplates(accountOwnerId: string): Promise<JobTemplateSummary[]> {
  const all = await fetchJobTemplates(accountOwnerId);
  return all.filter((t) => t.active).sort((a, b) => b.times_used - a.times_used || a.name.localeCompare(b.name));
}

interface DetailRow extends JobTemplate {
  job_template_services: Array<JobTemplateServiceLine & { sort_order: number }> | null;
  job_template_parts: Array<{
    part_id: string;
    quantity: number;
    part: { name: string; part_number: string | null } | null;
  }> | null;
  job_template_checklist_items: Array<{ label: string; sort_order: number }> | null;
}

export async function fetchJobTemplateDetail(accountOwnerId: string, templateId: string): Promise<JobTemplateDetail> {
  const { data, error } = await supabase
    .from('job_templates')
    .select(
      '*, job_template_services(service_name, price_book_item_id, quantity, unit_price_cents, sort_order), job_template_parts(part_id, quantity, part:inventory_parts(name, part_number)), job_template_checklist_items(label, sort_order)'
    )
    .eq('id', templateId)
    .eq('user_id', accountOwnerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('That template no longer exists.');

  const row = data as unknown as DetailRow;
  const { job_template_services, job_template_parts, job_template_checklist_items, ...template } = row;
  return {
    ...template,
    services: [...(job_template_services ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({
        service_name: s.service_name,
        price_book_item_id: s.price_book_item_id,
        quantity: Number(s.quantity),
        unit_price_cents: s.unit_price_cents,
      })),
    parts: (job_template_parts ?? []).map((p) => ({
      part_id: p.part_id,
      part_name: p.part?.name ?? 'Unknown part',
      part_number: p.part?.part_number ?? null,
      quantity: p.quantity,
    })),
    checklist: [...(job_template_checklist_items ?? [])].sort((a, b) => a.sort_order - b.sort_order).map((c) => c.label),
  };
}

export async function saveJobTemplate(templateId: string | null, form: JobTemplateFormState): Promise<string> {
  const payload = formToPayload(form);
  const { data, error } = await supabase.rpc('save_job_template', { p_template_id: templateId, p_payload: payload });
  if (error) throw error;
  return data as string;
}

export async function duplicateJobTemplate(templateId: string): Promise<string> {
  const { data, error } = await supabase.rpc('duplicate_job_template', { p_template_id: templateId });
  if (error) throw error;
  return data as string;
}

export async function setJobTemplateActive(accountOwnerId: string, templateId: string, active: boolean): Promise<void> {
  const { error } = await supabase
    .from('job_templates')
    .update({ active })
    .eq('id', templateId)
    .eq('user_id', accountOwnerId);
  if (error) throw error;
}

export async function deleteJobTemplate(accountOwnerId: string, templateId: string): Promise<void> {
  const { error } = await supabase.from('job_templates').delete().eq('id', templateId).eq('user_id', accountOwnerId);
  if (error) throw error;
}

export async function applyJobTemplate(jobId: string, templateId: string): Promise<ApplyTemplateResult> {
  const { data, error } = await supabase.rpc('apply_job_template', { p_job_id: jobId, p_template_id: templateId });
  if (error) throw error;
  return data as ApplyTemplateResult;
}

export async function fetchJobChecklist(jobId: string): Promise<JobChecklistItem[]> {
  const { data, error } = await supabase
    .from('job_checklist_items')
    .select('id, job_id, label, sort_order, completed_at, completed_by')
    .eq('job_id', jobId)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []) as JobChecklistItem[];
}

export async function setChecklistItemDone(itemId: string, done: boolean): Promise<JobChecklistItem> {
  const { data, error } = await supabase.rpc('set_job_checklist_item_done', { p_item_id: itemId, p_done: done });
  if (error) throw error;
  return data as JobChecklistItem;
}
