// src/lib/offline/forms.ts
// Offline form engine: templates (per trade, defined by the office) are cached on the device,
// rendered and validated locally, and submitted through the normal outbox as a 'form' capture.
// Built-in templates guarantee a technician always has forms, even on a fresh install with no signal.

import { supabase } from '@/lib/supabase';
import { getMeta, notifyData, setMeta } from './db';

export type FieldType = 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'yes_no';

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  required?: boolean;
  options?: string[];
  help?: string;
}

export interface FormTemplate {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  trade?: string | null;
  version: number;
  fields: FormField[];
}

export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;
export type FormAnswers = Record<string, string | number | boolean>;

const META_KEY = 'form_templates';
const FIELD_TYPES: FieldType[] = ['text', 'textarea', 'number', 'checkbox', 'select', 'yes_no'];

export const BUILTIN_TEMPLATES: FormTemplate[] = [
  {
    id: 'builtin:job_completion',
    slug: 'job_completion',
    title: 'Job completion',
    description: 'Standard sign-off checklist for any job.',
    trade: 'general',
    version: 1,
    fields: [
      { id: 'work_performed', type: 'textarea', label: 'Work performed', required: true },
      { id: 'parts_used', type: 'text', label: 'Parts used' },
      { id: 'system_tested', type: 'checkbox', label: 'System tested and running', required: true },
      { id: 'area_cleaned', type: 'checkbox', label: 'Work area cleaned' },
      { id: 'customer_walkthrough', type: 'checkbox', label: 'Walked the customer through the work' },
      { id: 'follow_up_needed', type: 'yes_no', label: 'Follow-up visit needed?', required: true },
      { id: 'follow_up_note', type: 'text', label: 'What is needed for the follow-up?' },
    ],
  },
  {
    id: 'builtin:site_safety',
    slug: 'site_safety',
    title: 'Site safety check',
    description: 'Quick hazard check before starting work.',
    trade: 'general',
    version: 1,
    fields: [
      { id: 'hazards_found', type: 'yes_no', label: 'Any hazards found on arrival?', required: true },
      { id: 'hazard_detail', type: 'textarea', label: 'Describe the hazard and what you did about it' },
      { id: 'ppe_worn', type: 'checkbox', label: 'Required PPE worn', required: true },
      { id: 'utilities_isolated', type: 'checkbox', label: 'Power / gas / water isolated where needed' },
    ],
  },
];

// ------------------------------------------------------------
// Parsing (server data is untrusted until normalized)
// ------------------------------------------------------------

function normalizeField(raw: unknown): FormField | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== 'string' || typeof f.label !== 'string' || !FIELD_TYPES.includes(f.type as FieldType)) return null;
  const options = Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string') : undefined;
  if (f.type === 'select' && (!options || options.length === 0)) return null;
  return {
    id: f.id,
    type: f.type as FieldType,
    label: f.label,
    required: f.required === true,
    options,
    help: typeof f.help === 'string' ? f.help : undefined,
  };
}

export function normalizeTemplates(raw: unknown): FormTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: FormTemplate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const schema = (t.schema ?? {}) as { fields?: unknown };
    const fields = (Array.isArray(schema.fields) ? schema.fields : []).map(normalizeField).filter((f): f is FormField => f !== null);
    if (typeof t.id !== 'string' || typeof t.slug !== 'string' || typeof t.title !== 'string' || fields.length === 0) continue;
    out.push({
      id: t.id,
      slug: t.slug,
      title: t.title,
      description: typeof t.description === 'string' ? t.description : null,
      trade: typeof t.trade === 'string' ? t.trade : null,
      version: typeof t.version === 'number' ? t.version : 1,
      fields,
    });
  }
  return out;
}

// ------------------------------------------------------------
// Storage
// ------------------------------------------------------------

/** Templates available on this device: the office's templates plus built-ins they did not override. */
export async function loadTemplates(): Promise<FormTemplate[]> {
  const cached = (await getMeta<FormTemplate[]>(META_KEY).catch(() => undefined)) ?? [];
  const bySlug = new Set(cached.map((t) => t.slug));
  return [...cached, ...BUILTIN_TEMPLATES.filter((t) => !bySlug.has(t.slug))];
}

/** Pulls the latest templates (called by the sync engine). Silently keeps the cache if the server lacks the RPC. */
export async function refreshFormTemplates(): Promise<void> {
  const { data, error } = await supabase.rpc('get_field_form_templates');
  if (error) throw error;
  await setMeta(META_KEY, normalizeTemplates(data));
  notifyData();
}

// ------------------------------------------------------------
// Ordering, validation, packaging (pure — unit tested)
// ------------------------------------------------------------

const TRADE_PATTERNS: Record<string, RegExp> = {
  hvac: /hvac|heat|cool|furnace|air ?cond|\bac\b|boiler|duct/i,
  plumbing: /plumb|drain|water|pipe|sewer|leak|toilet|faucet/i,
  electrical: /electric|wiring|panel|outlet|breaker|lighting/i,
};

/** Puts the templates that match the job's service type first (stable order otherwise). */
export function sortForService(templates: FormTemplate[], serviceType: string | null | undefined): FormTemplate[] {
  const rank = (t: FormTemplate) => (t.trade && serviceType && TRADE_PATTERNS[t.trade]?.test(serviceType) ? 0 : 1);
  return templates.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
}

export function validateValues(template: FormTemplate, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of template.fields) {
    if (!field.required) continue;
    const v = values[field.id];
    if (field.type === 'checkbox') {
      if (v !== true) errors[field.id] = 'Required';
    } else if (field.type === 'number') {
      if (typeof v !== 'string' || v.trim() === '' || !Number.isFinite(Number(v))) errors[field.id] = 'Enter a number';
    } else if (field.type === 'yes_no') {
      if (v !== 'yes' && v !== 'no') errors[field.id] = 'Choose yes or no';
    } else if (typeof v !== 'string' || v.trim() === '') {
      errors[field.id] = 'Required';
    }
  }
  return errors;
}

/** Keeps only fields that exist in the template, trims text and converts numbers. */
export function toAnswers(template: FormTemplate, values: FormValues): FormAnswers {
  const answers: FormAnswers = {};
  for (const field of template.fields) {
    const v = values[field.id];
    if (field.type === 'checkbox') {
      answers[field.id] = v === true;
    } else if (typeof v === 'string' && v.trim() !== '') {
      answers[field.id] = field.type === 'number' ? Number(v) : v.trim().slice(0, 4000);
    }
  }
  return answers;
}
