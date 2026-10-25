import { supabase } from '@/lib/supabase';
import { isValidPortalToken } from '@/lib/portalHistory';

/**
 * Customer Portal — Home Inventory (/portal/:token/inventory) — client library.
 *
 * Same security model as `lib/portalHistory.ts`: the durable portal token is the credential. Data and writes go
 * through narrow SECURITY DEFINER RPCs (see supabase/migrations/20271102000000_customer_home_inventory.sql);
 * uploads, OCR, file viewing and deletion go through the `portal-home-inventory` edge function. RLS is never
 * opened to anon and storage paths never reach the browser.
 */

export { isValidPortalToken };

// ============================================================
// TYPES
// ============================================================

export type InventoryCategory = 'hvac' | 'water_heating' | 'plumbing' | 'electrical' | 'kitchen' | 'laundry' | 'smart_home' | 'outdoor' | 'other';
export type InventoryFileKind = 'appliance_photo' | 'receipt' | 'manual' | 'warranty_card' | 'label' | 'other';
export type ReminderKind = 'maintenance' | 'warranty_expiry' | 'custom';
export type ReminderAction = 'done' | 'snooze' | 'dismiss' | 'reopen';

export interface InventoryFile {
  id: string;
  kind: InventoryFileKind;
  mime_type: string;
  byte_size: number;
  original_name: string | null;
  ocr_status: 'done' | 'skipped' | 'failed';
  created_at: string;
}

export interface LinkedEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  last_service_date: string | null;
  service_interval_months: number | null;
  next_service_due: string | null;
  /** Only present for a VERIFIED equipment passport link. */
  passport_code: string | null;
}

export interface InventoryItem {
  id: string;
  category: InventoryCategory;
  name: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  location: string | null;
  retailer: string | null;
  purchase_date: string | null;
  purchase_price_cents: number | null;
  currency: string;
  warranty_months: number | null;
  warranty_expires_at: string | null;
  notes: string | null;
  equipment_id: string | null;
  source: 'customer' | 'ocr';
  created_at: string;
  equipment: LinkedEquipment | null;
  files: InventoryFile[];
}

export interface InventoryReminder {
  id: string;
  item_id: string;
  item_name: string;
  kind: ReminderKind;
  title: string;
  due_date: string;
  interval_months: number | null;
  status: 'active' | 'done' | 'dismissed';
  last_completed_at: string | null;
}

export interface EquipmentOption {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
}

export interface InventorySummary {
  item_count: number;
  file_count: number;
  active_warranties: number;
  expiring_warranties: number;
  reminders_due: number;
}

export interface PortalInventory {
  customer: { name: string };
  business_name: string | null;
  summary: InventorySummary;
  items: InventoryItem[];
  unattached_files: InventoryFile[];
  reminders: InventoryReminder[];
  equipment_options: EquipmentOption[];
}

export interface ItemSuggestion {
  name: string | null;
  category: InventoryCategory;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  retailer: string | null;
  purchase_date: string | null;
  purchase_price_cents: number | null;
  currency: string | null;
  warranty_months: number | null;
  warranty_expires_at: string | null;
}

export interface StoredRead {
  source: 'label' | 'document';
  confidence: number;
  low_confidence: boolean;
  issues: string[];
  manufacture_date: string | null;
  suggestion: ItemSuggestion;
}

export interface RegisterResult {
  file: InventoryFile & { item_id: string | null };
  duplicate: boolean;
  read: StoredRead | null;
  warning: 'ocr_unavailable' | 'ocr_failed' | 'ocr_rate_limited' | null;
}

/** Three distinct outcomes on purpose (same as the history page): `unavailable` retrying cannot fix. */
export type InventoryResult = { status: 'ok'; data: PortalInventory } | { status: 'unavailable' } | { status: 'error' };

export class InventoryError extends Error {
  constructor(message: string, public status = 0, public code?: string) {
    super(message);
    this.name = 'InventoryError';
  }
}

// ============================================================
// LABELS / LIMITS
// ============================================================

export const CATEGORY_LABELS: Record<InventoryCategory, string> = {
  hvac: 'Heating & cooling',
  water_heating: 'Water heating',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  kitchen: 'Kitchen',
  laundry: 'Laundry',
  smart_home: 'Smart home',
  outdoor: 'Outdoor',
  other: 'Other',
};
export const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS) as InventoryCategory[];

export const FILE_KIND_LABELS: Record<InventoryFileKind, string> = {
  appliance_photo: 'Photo',
  label: 'Label / data plate',
  receipt: 'Receipt',
  warranty_card: 'Warranty card',
  manual: 'Manual',
  other: 'Other document',
};
export const FILE_KIND_KEYS = Object.keys(FILE_KIND_LABELS) as InventoryFileKind[];

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'] as const;
const EXT_TO_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heic', pdf: 'application/pdf' };

const RPC_MESSAGES: Record<string, string> = {
  HI_INVALID_NAME: 'Please give it a name.',
  HI_INVALID_DATE: 'One of the dates is not valid. A purchase date cannot be in the future.',
  HI_INVALID_FIELD: 'Some details look invalid. Please check them and try again.',
  HI_NOT_FOUND: 'That item no longer exists. Refresh the page and try again.',
  HI_EQUIPMENT_NOT_FOUND: 'That equipment could not be linked. Refresh the page and try again.',
  HI_LIMIT: 'You have reached the limit for your home inventory.',
};
const GENERIC_ERROR = 'Something went wrong. Please try again.';

export function friendlyRpcError(message: string | null | undefined): string {
  const code = Object.keys(RPC_MESSAGES).find((k) => (message ?? '').includes(k));
  return code ? RPC_MESSAGES[code] : GENERIC_ERROR;
}

// ============================================================
// PURE HELPERS (unit-tested)
// ============================================================

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local calendar day as YYYY-MM-DD (what a person means by "today"). */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function dayNumber(iso: string | null | undefined): number | null {
  const m = ISO_DAY.exec(iso ?? '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  // Reject 2024-02-31 style dates that Date.UTC silently rolls over.
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? Math.round(t / DAY_MS) : null;
}

export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = dayNumber(fromIso);
  const b = dayNumber(toIso);
  return a === null || b === null ? null : b - a;
}

export function formatDay(iso: string | null | undefined, locale?: string): string {
  const n = dayNumber(iso);
  if (n === null) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(n * DAY_MS));
}

export const EXPIRING_SOON_DAYS = 60;
export const REMINDER_SOON_DAYS = 30;

export type WarrantyState = 'none' | 'active' | 'expiring' | 'expired';

export function warrantyStatus(expiresAt: string | null | undefined, today: string = todayIso()): { state: WarrantyState; daysLeft: number | null } {
  const left = expiresAt ? daysBetween(today, expiresAt) : null;
  if (left === null) return { state: 'none', daysLeft: null };
  if (left < 0) return { state: 'expired', daysLeft: left };
  return { state: left <= EXPIRING_SOON_DAYS ? 'expiring' : 'active', daysLeft: left };
}

export type ReminderState = 'overdue' | 'due_soon' | 'upcoming';

export function reminderStatus(dueDate: string, today: string = todayIso()): { state: ReminderState; days: number | null } {
  const days = daysBetween(today, dueDate);
  if (days === null) return { state: 'upcoming', days: null };
  if (days < 0) return { state: 'overdue', days };
  return { state: days <= REMINDER_SOON_DAYS ? 'due_soon' : 'upcoming', days };
}

export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatMoney(cents: number | null | undefined, currency: string, locale?: string): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const exp = currencyExponent(currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 10 ** exp);
  } catch {
    return `${(cents / 10 ** exp).toFixed(exp)} ${currency}`;
  }
}

/** "1,299.99" / "1.299,99" / "1299,99" / "$ 12" -> minor units. null when it is not a clear, non-negative amount. */
export function priceToCents(input: string, currency: string): number | null {
  const raw = input.replace(/[^\d.,-]/g, '');
  if (!raw || raw.includes('-')) return null;
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    normalized = raw.replace(decimal === '.' ? /,/g : /\./g, '').replace(decimal, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = raw.split(sep);
    const tail = parts[parts.length - 1];
    // "12,50" is a decimal; "1,299" / "1.299.000" are thousands separators.
    normalized = parts.length === 2 && tail.length <= currencyExponent(currency) && tail.length > 0 ? `${parts[0]}.${tail}` : parts.join('');
  } else {
    normalized = raw;
  }
  const n = Number(normalized);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return null;
  return Math.round(n * 10 ** currencyExponent(currency));
}

export function centsToInput(cents: number | null | undefined, currency: string): string {
  if (cents === null || cents === undefined) return '';
  const exp = currencyExponent(currency);
  return (cents / 10 ** exp).toFixed(exp);
}

// ---------- Form <-> payload ----------

export interface ItemForm {
  name: string;
  category: InventoryCategory;
  brand: string;
  model: string;
  serial_number: string;
  location: string;
  retailer: string;
  purchase_date: string;
  price: string;
  currency: string;
  warranty_months: string;
  warranty_expires_at: string;
  notes: string;
  equipment_id: string;
  maintenance_months: string;
  next_maintenance_due: string;
}

export const EMPTY_FORM: ItemForm = {
  name: '', category: 'other', brand: '', model: '', serial_number: '', location: '', retailer: '', purchase_date: '',
  price: '', currency: 'USD', warranty_months: '', warranty_expires_at: '', notes: '', equipment_id: '',
  maintenance_months: '', next_maintenance_due: '',
};

export function formFromItem(item: InventoryItem, reminders: InventoryReminder[]): ItemForm {
  const maint = reminders.find((r) => r.item_id === item.id && r.kind === 'maintenance' && r.status === 'active');
  return {
    name: item.name,
    category: item.category,
    brand: item.brand ?? '',
    model: item.model ?? '',
    serial_number: item.serial_number ?? '',
    location: item.location ?? '',
    retailer: item.retailer ?? '',
    purchase_date: item.purchase_date ?? '',
    price: centsToInput(item.purchase_price_cents, item.currency),
    currency: item.currency,
    warranty_months: item.warranty_months?.toString() ?? '',
    warranty_expires_at: item.warranty_expires_at ?? '',
    notes: item.notes ?? '',
    equipment_id: item.equipment_id ?? '',
    maintenance_months: maint?.interval_months?.toString() ?? '',
    next_maintenance_due: maint?.due_date ?? '',
  };
}

export type FormField = keyof ItemForm;

/**
 * Copies a document read into the form WITHOUT overwriting anything the customer already typed.
 * Returns which fields were filled so the UI can mark them "read from your document — please check".
 */
export function applySuggestion(form: ItemForm, s: ItemSuggestion): { form: ItemForm; filled: FormField[] } {
  const next = { ...form };
  const filled: FormField[] = [];
  const put = (field: FormField, value: string | null | undefined) => {
    if (value && !form[field].trim()) {
      (next as Record<FormField, string>)[field] = value;
      filled.push(field);
    }
  };
  put('name', s.name);
  put('brand', s.brand);
  put('model', s.model);
  put('serial_number', s.serial_number);
  put('retailer', s.retailer);
  put('purchase_date', s.purchase_date);
  put('warranty_expires_at', s.warranty_expires_at);
  if (s.warranty_months) put('warranty_months', String(s.warranty_months));
  if (form.category === 'other' && s.category !== 'other') {
    next.category = s.category;
    filled.push('category');
  }
  if (!form.price.trim() && s.purchase_price_cents !== null && s.currency) {
    next.currency = s.currency;
    next.price = centsToInput(s.purchase_price_cents, s.currency);
    filled.push('price');
  }
  return { form: next, filled };
}

export interface FormIssue { field: FormField; message: string }

export function validateForm(form: ItemForm, today: string = todayIso()): FormIssue[] {
  const issues: FormIssue[] = [];
  if (!form.name.trim()) issues.push({ field: 'name', message: 'Give the item a name.' });
  if (form.purchase_date) {
    const d = daysBetween(today, form.purchase_date);
    if (d === null) issues.push({ field: 'purchase_date', message: 'Enter a valid purchase date.' });
    else if (d > 1) issues.push({ field: 'purchase_date', message: 'The purchase date cannot be in the future.' });
  }
  if (form.warranty_expires_at && dayNumber(form.warranty_expires_at) === null) issues.push({ field: 'warranty_expires_at', message: 'Enter a valid date.' });
  if (form.price.trim() && priceToCents(form.price, form.currency) === null) issues.push({ field: 'price', message: 'Enter a valid price.' });
  const wm = form.warranty_months.trim();
  if (wm && !(/^\d+$/.test(wm) && +wm >= 1 && +wm <= 600)) issues.push({ field: 'warranty_months', message: 'Enter a whole number of months (1–600).' });
  const mm = form.maintenance_months.trim();
  if (mm && !(/^\d+$/.test(mm) && +mm >= 1 && +mm <= 120)) issues.push({ field: 'maintenance_months', message: 'Enter a whole number of months (1–120).' });
  if (form.next_maintenance_due && dayNumber(form.next_maintenance_due) === null) issues.push({ field: 'next_maintenance_due', message: 'Enter a valid date.' });
  if (form.next_maintenance_due && !mm) issues.push({ field: 'maintenance_months', message: 'Choose how often it needs maintenance.' });
  return issues;
}

/** The exact JSON the save RPC expects. Empty strings become null; maintenance is always sent (null removes it). */
export function buildFields(form: ItemForm, source: 'customer' | 'ocr' = 'customer'): Record<string, unknown> {
  const t = (v: string) => (v.trim() ? v.trim() : null);
  const price = form.price.trim() ? priceToCents(form.price, form.currency) : null;
  return {
    name: form.name.trim(),
    category: form.category,
    brand: t(form.brand),
    model: t(form.model),
    serial_number: t(form.serial_number),
    location: t(form.location),
    retailer: t(form.retailer),
    purchase_date: t(form.purchase_date),
    purchase_price_cents: price,
    currency: form.currency,
    warranty_months: form.warranty_months.trim() ? Number(form.warranty_months) : null,
    warranty_expires_at: t(form.warranty_expires_at),
    notes: t(form.notes),
    equipment_id: t(form.equipment_id),
    maintenance_interval_months: form.maintenance_months.trim() ? Number(form.maintenance_months) : null,
    next_maintenance_due: form.maintenance_months.trim() ? t(form.next_maintenance_due) : null,
    source,
  };
}

export function filterItems(items: InventoryItem[], query: string, category: InventoryCategory | 'all'): InventoryItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((i) => {
    if (category !== 'all' && i.category !== category) return false;
    if (!q) return true;
    return [i.name, i.brand, i.model, i.serial_number, i.location, i.retailer].some((v) => (v ?? '').toLowerCase().includes(q));
  });
}

export function equipmentLabel(e: { equipment_type: string; make: string | null; model: string | null }): string {
  const type = e.equipment_type.replace(/_/g, ' ');
  return [e.make, e.model].filter(Boolean).join(' ') || type.charAt(0).toUpperCase() + type.slice(1);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- File validation ----------

/** Returns the mime type to upload with, or an error message. Phones sometimes send an empty type for HEIC. */
export function checkUpload(file: { name: string; type: string; size: number }): { ok: true; mime: string } | { ok: false; error: string } {
  if (file.size <= 0) return { ok: false, error: 'That file is empty.' };
  if (file.size > MAX_FILE_BYTES * 3) return { ok: false, error: 'That file is too large. Each file must be under 10 MB.' };
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = (ALLOWED_MIME as readonly string[]).includes(file.type) ? file.type : EXT_TO_MIME[ext];
  if (!mime) return { ok: false, error: 'Use a JPEG, PNG, WebP or HEIC photo, or a PDF.' };
  return { ok: true, mime };
}

/** Downscales big phone photos (long edge 2000px, JPEG) before upload. Any failure falls back to the original. */
export async function fitImage(file: File, mime: string): Promise<{ blob: Blob; mime: string }> {
  const original = { blob: file as Blob, mime };
  if (!mime.startsWith('image/') || mime === 'image/heic' || typeof document === 'undefined' || typeof createImageBitmap !== 'function') return original;
  if (file.size <= 1.5 * 1024 * 1024) return original;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return original;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return out && out.size > 0 && out.size < file.size ? { blob: out, mime: 'image/jpeg' } : original;
  } catch {
    return original;
  }
}

// ---------- Calendar export (.ics, RFC 5545) ----------

const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds a content line at 75 octets (continuation lines start with a space). */
function icsFold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // leading space of a continuation line counts
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(reminders: InventoryReminder[], businessName: string | null, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vireek//Home Inventory//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const r of reminders) {
    const n = dayNumber(r.due_date);
    if (n === null) continue;
    const start = r.due_date.replace(/-/g, '');
    const end = new Date((n + 1) * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:reminder-${r.id}@vireek`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${icsEscape(r.title)}`,
      `DESCRIPTION:${icsEscape(`${r.item_name}${businessName ? ` — ${businessName}` : ''}`)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(r.title)}`, 'TRIGGER:-P1D', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

export function downloadIcs(reminders: InventoryReminder[], businessName: string | null): void {
  const blob = new Blob([buildIcs(reminders, businessName)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'home-maintenance-reminders.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================
// API
// ============================================================

export async function fetchPortalInventory(token: string): Promise<InventoryResult> {
  try {
    const { data, error } = await supabase.rpc('get_portal_home_inventory', { p_token: token });
    if (error) return { status: 'error' };
    if (!data || typeof data !== 'object') return { status: 'unavailable' };
    const d = data as Partial<PortalInventory>;
    return {
      status: 'ok',
      data: {
        customer: d.customer ?? { name: '' },
        business_name: d.business_name ?? null,
        summary: d.summary ?? { item_count: 0, file_count: 0, active_warranties: 0, expiring_warranties: 0, reminders_due: 0 },
        items: Array.isArray(d.items) ? d.items : [],
        unattached_files: Array.isArray(d.unattached_files) ? d.unattached_files : [],
        reminders: Array.isArray(d.reminders) ? d.reminders : [],
        equipment_options: Array.isArray(d.equipment_options) ? d.equipment_options : [],
      },
    };
  } catch {
    return { status: 'error' };
  }
}

async function rpcOrThrow<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new InventoryError(friendlyRpcError(error.message));
  if (data === null || data === undefined) throw new InventoryError('This link is no longer valid.', 404, 'unavailable');
  return data as T;
}

export function saveInventoryItem(
  token: string,
  itemId: string | null,
  fields: Record<string, unknown>,
  fileIds: string[] = [],
): Promise<{ id: string; equipment_id: string | null; linked_by_serial: boolean }> {
  return rpcOrThrow('portal_inventory_save_item', { p_token: token, p_item_id: itemId, p_fields: fields, p_file_ids: fileIds.length ? fileIds : null });
}

export function addInventoryReminder(token: string, itemId: string, title: string, dueDate: string, intervalMonths: number | null): Promise<{ id: string }> {
  return rpcOrThrow('portal_inventory_add_reminder', { p_token: token, p_item_id: itemId, p_title: title, p_due_date: dueDate, p_interval_months: intervalMonths });
}

export function reminderAction(token: string, reminderId: string, action: ReminderAction, days?: number): Promise<{ id: string; status: string; due_date: string }> {
  return rpcOrThrow('portal_inventory_reminder_action', { p_token: token, p_reminder_id: reminderId, p_action: action, p_days: days ?? null });
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function readFunctionError(error: unknown): Promise<InventoryError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string; code?: string };
      if (body?.error) return new InventoryError(body.error, ctx.status, body.code);
    } catch {
      /* body was not JSON */
    }
    return new InventoryError(GENERIC_ERROR, ctx.status);
  }
  return new InventoryError('Could not reach the server. Check your connection and try again.');
}

async function callInventoryFn<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('portal-home-inventory', { body });
  if (error) throw await readFunctionError(error);
  return data as T;
}

export interface UploadOptions {
  kind: InventoryFileKind;
  itemId?: string | null;
  /** Read the document with OCR. Defaults to true except for plain appliance photos. */
  ocr?: boolean;
}

export async function uploadInventoryFile(token: string, file: File, opts: UploadOptions): Promise<RegisterResult> {
  const check = checkUpload(file);
  if (!check.ok) throw new InventoryError(check.error);
  const prepared = await fitImage(file, check.mime);
  if (prepared.blob.size > MAX_FILE_BYTES) throw new InventoryError('That file is too large. Each file must be under 10 MB.');

  const signed = await callInventoryFn<{ path: string; upload_token: string }>({
    token, action: 'sign_upload', kind: opts.kind, mime: prepared.mime, bytes: prepared.blob.size,
  });
  const { error: upErr } = await supabase.storage.from('home-inventory').uploadToSignedUrl(signed.path, signed.upload_token, prepared.blob, { contentType: prepared.mime });
  if (upErr) throw new InventoryError('The upload did not finish. Please try again.');

  return callInventoryFn<RegisterResult>({
    token, action: 'register', kind: opts.kind, path: signed.path, name: file.name, itemId: opts.itemId ?? undefined, ocr: opts.ocr,
  });
}

export async function getInventoryFileUrl(token: string, fileId: string): Promise<string> {
  const r = await callInventoryFn<{ url: string }>({ token, action: 'file_url', fileId });
  return r.url;
}

export async function deleteInventoryFile(token: string, fileId: string): Promise<void> {
  await callInventoryFn({ token, action: 'delete_file', fileId });
}

export async function deleteInventoryItem(token: string, itemId: string): Promise<void> {
  await callInventoryFn({ token, action: 'delete_item', itemId });
}
