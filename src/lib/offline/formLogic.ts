// src/lib/offline/formLogic.ts
// Pure runtime for field forms (schema v2): conditional visibility, validation, and packaging a
// submission for the offline outbox. No network, no IndexedDB — everything here works the same
// with zero signal, and the builder's live preview runs this exact code.

import type { FieldCondition, FormField, FormTemplate } from './formSchema';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/** Text/number/select/yes_no/pass_fail/checkbox values. Pass-fail notes live at `${id}__note`. */
export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;

export interface PhotoAttachment {
  /** local-only id, stable for React keys and removal */
  id: string;
  blob: Blob;
}

export interface SignatureAttachment {
  method: 'drawn' | 'typed';
  /** PNG data URL for drawn signatures, the typed name for typed ones */
  data: string;
  typedFont?: string;
  signerName: string;
}

export interface FormAttachments {
  photos: Record<string, PhotoAttachment[]>;
  signatures: Record<string, SignatureAttachment | undefined>;
}

export type SubmissionAnswer = string | number | boolean | string[];
export type SubmissionAnswers = Record<string, SubmissionAnswer>;

export interface SubmissionSummary {
  visible_fields: number;
  answered: number;
  passed: number;
  failed: number;
  na: number;
  out_of_range: number;
  photos: number;
}

export interface ValidationResult {
  /** blocking */
  errors: Record<string, string>;
  /** informational only (e.g. a reading outside the expected range) */
  warnings: Record<string, string>;
}

export interface BuiltSubmission {
  /** payload for enqueue('artifact', jobId, { kind: 'form', data, ... }) */
  data: {
    template_id: string;
    slug: string;
    version: number;
    title: string;
    schema_version: 2;
    submission_ref: string;
    answers: SubmissionAnswers;
    summary: SubmissionSummary;
  };
  photos: Array<{ fieldId: string; ref: string; blob: Blob }>;
  signatures: Array<{ fieldId: string; ref: string; signature: SignatureAttachment }>;
}

export const EMPTY_ATTACHMENTS: FormAttachments = { photos: {}, signatures: {} };

export function noteKey(fieldId: string): string {
  return `${fieldId}__note`;
}

// ------------------------------------------------------------
// Conditional logic
// ------------------------------------------------------------

function comparable(v: FormValue | undefined): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return (v ?? '').trim();
}

function isFilled(v: FormValue | undefined): boolean {
  if (typeof v === 'boolean') return v;
  return (v ?? '').trim() !== '';
}

export function evaluateCondition(cond: FieldCondition, values: FormValues): boolean {
  const actual = values[cond.field];
  switch (cond.op) {
    case 'is_filled':
      return isFilled(actual);
    case 'is_empty':
      return !isFilled(actual);
    case 'equals':
    case 'not_equals': {
      const a = comparable(actual);
      const b = String(cond.value ?? '').trim();
      const an = Number(a);
      const bn = Number(b);
      // Compare numerically when both sides are numbers ("10" equals "10.0"), else as text.
      const same = a !== '' && b !== '' && Number.isFinite(an) && Number.isFinite(bn) ? an === bn : a === b;
      return cond.op === 'equals' ? same : !same;
    }
    case 'greater_than':
    case 'less_than': {
      const a = comparable(actual);
      const an = Number(a);
      const bn = Number(cond.value);
      if (a === '' || !Number.isFinite(an) || !Number.isFinite(bn)) return false;
      return cond.op === 'greater_than' ? an > bn : an < bn;
    }
    default:
      return false;
  }
}

/**
 * Fields currently visible, in order. A hidden field's value is ignored when evaluating later
 * conditions, so hiding a parent also hides everything that depended on it.
 */
export function visibleFields(template: Pick<FormTemplate, 'fields'>, values: FormValues): FormField[] {
  const effective: FormValues = {};
  const out: FormField[] = [];
  for (const field of template.fields) {
    const logic = field.show_if;
    let show = true;
    if (logic && logic.conditions.length > 0) {
      const results = logic.conditions.map((c) => evaluateCondition(c, effective));
      show = logic.match === 'any' ? results.some(Boolean) : results.every(Boolean);
    }
    if (!show) continue;
    out.push(field);
    if (field.id in values) effective[field.id] = values[field.id];
    const nk = noteKey(field.id);
    if (nk in values) effective[nk] = values[nk];
  }
  return out;
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

function numberOf(v: FormValue | undefined): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function photoBounds(field: FormField): { min: number; max: number } {
  const max = field.max_photos ?? 10;
  const min = Math.min(field.min_photos ?? (field.required ? 1 : 0), max);
  return { min, max };
}

export function outOfRange(field: FormField, value: number): boolean {
  return (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max);
}

export function validateSubmission(
  template: Pick<FormTemplate, 'fields'>,
  values: FormValues,
  attachments: FormAttachments = EMPTY_ATTACHMENTS
): ValidationResult {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};

  for (const field of visibleFields(template, values)) {
    const v = values[field.id];
    switch (field.type) {
      case 'checkbox':
        if (field.required && v !== true) errors[field.id] = 'Required';
        break;
      case 'yes_no':
        if (v !== undefined && v !== '' && v !== 'yes' && v !== 'no') errors[field.id] = 'Choose yes or no';
        else if (field.required && v !== 'yes' && v !== 'no') errors[field.id] = 'Choose yes or no';
        break;
      case 'pass_fail': {
        const allowed = field.allow_na ? ['pass', 'fail', 'na'] : ['pass', 'fail'];
        if (typeof v !== 'string' || v === '') {
          if (field.required) errors[field.id] = 'Choose pass or fail';
        } else if (!allowed.includes(v)) {
          errors[field.id] = 'Choose pass or fail';
        } else if (v === 'fail' && field.note_on_fail && comparable(values[noteKey(field.id)]) === '') {
          errors[field.id] = 'Add a note explaining the failure';
        }
        break;
      }
      case 'number': {
        const raw = typeof v === 'string' ? v.trim() : '';
        if (raw === '') {
          if (field.required) errors[field.id] = 'Enter a number';
        } else {
          const n = numberOf(v);
          if (n === null) errors[field.id] = 'Enter a number';
          else if (outOfRange(field, n)) {
            const lo = field.min !== undefined ? field.min : '…';
            const hi = field.max !== undefined ? field.max : '…';
            warnings[field.id] = `Outside the expected range (${lo} to ${hi}${field.unit ? ` ${field.unit}` : ''})`;
          }
        }
        break;
      }
      case 'select': {
        const raw = typeof v === 'string' ? v : '';
        if (raw === '') {
          if (field.required) errors[field.id] = 'Required';
        } else if (!(field.options ?? []).includes(raw)) {
          errors[field.id] = 'Choose one of the options';
        }
        break;
      }
      case 'photo': {
        const count = attachments.photos[field.id]?.length ?? 0;
        const { min, max } = photoBounds(field);
        if (count < min) errors[field.id] = min === 1 ? 'Add a photo' : `Add at least ${min} photos`;
        else if (count > max) errors[field.id] = `Add at most ${max} photo${max === 1 ? '' : 's'}`;
        break;
      }
      case 'signature': {
        const sig = attachments.signatures[field.id];
        if (!sig) {
          if (field.required) errors[field.id] = 'Signature required';
        } else if (sig.signerName.trim() === '') {
          errors[field.id] = "Enter the signer's name";
        }
        break;
      }
      default: {
        // text, textarea
        if (field.required && (typeof v !== 'string' || v.trim() === '')) errors[field.id] = 'Required';
      }
    }
  }
  return { errors, warnings };
}

export function hasBlockingErrors(result: ValidationResult): boolean {
  return Object.keys(result.errors).length > 0;
}

// ------------------------------------------------------------
// Packaging
// ------------------------------------------------------------

export function newSubmissionRef(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Packages a validated form. Only VISIBLE fields are included (answers to fields hidden by
 * conditional logic are dropped). Photo and signature answers are deterministic refs derived
 * from the submission ref, so a retry after a partial failure produces identical refs and the
 * server can de-duplicate instead of storing the same photo twice.
 */
export function buildSubmission(
  template: FormTemplate,
  values: FormValues,
  attachments: FormAttachments,
  submissionRef: string
): BuiltSubmission {
  const answers: SubmissionAnswers = {};
  const photos: BuiltSubmission['photos'] = [];
  const signatures: BuiltSubmission['signatures'] = [];
  const summary: SubmissionSummary = {
    visible_fields: 0,
    answered: 0,
    passed: 0,
    failed: 0,
    na: 0,
    out_of_range: 0,
    photos: 0,
  };

  for (const field of visibleFields(template, values)) {
    summary.visible_fields += 1;
    const v = values[field.id];

    switch (field.type) {
      case 'checkbox':
        answers[field.id] = v === true;
        if (v === true) summary.answered += 1;
        break;
      case 'number': {
        const n = numberOf(v);
        if (n !== null) {
          answers[field.id] = n;
          summary.answered += 1;
          if (outOfRange(field, n)) summary.out_of_range += 1;
        }
        break;
      }
      case 'pass_fail': {
        if (v === 'pass' || v === 'fail' || (v === 'na' && field.allow_na)) {
          answers[field.id] = v;
          summary.answered += 1;
          if (v === 'pass') summary.passed += 1;
          else if (v === 'fail') {
            summary.failed += 1;
            const note = comparable(values[noteKey(field.id)]);
            if (note) answers[noteKey(field.id)] = note.slice(0, 4000);
          } else summary.na += 1;
        }
        break;
      }
      case 'photo': {
        const list = attachments.photos[field.id] ?? [];
        if (list.length > 0) {
          const refs = list.map((p, i) => {
            const ref = `${submissionRef}:${field.id}:${i + 1}`;
            photos.push({ fieldId: field.id, ref, blob: p.blob });
            return ref;
          });
          answers[field.id] = refs;
          summary.answered += 1;
          summary.photos += list.length;
        }
        break;
      }
      case 'signature': {
        const sig = attachments.signatures[field.id];
        if (sig) {
          const ref = `${submissionRef}:${field.id}`;
          signatures.push({ fieldId: field.id, ref, signature: sig });
          answers[field.id] = ref;
          answers[`${field.id}__signer`] = sig.signerName.trim();
          summary.answered += 1;
        }
        break;
      }
      case 'yes_no':
        if (v === 'yes' || v === 'no') {
          answers[field.id] = v;
          summary.answered += 1;
        }
        break;
      default: {
        if (typeof v === 'string' && v.trim() !== '') {
          answers[field.id] = v.trim().slice(0, 4000);
          summary.answered += 1;
        }
      }
    }
  }

  return {
    data: {
      template_id: template.id,
      slug: template.slug,
      version: template.version,
      title: template.title,
      schema_version: 2,
      submission_ref: submissionRef,
      answers,
      summary,
    },
    photos,
    signatures,
  };
}

// ------------------------------------------------------------
// Drafts (values only — blobs are never written to localStorage)
// ------------------------------------------------------------

const DRAFT_PREFIX = 'vireek:form-draft:v1:';

export function draftKey(jobId: string, templateId: string, version: number): string {
  return `${DRAFT_PREFIX}${jobId}:${templateId}:${version}`;
}

export function saveDraft(key: string, values: FormValues): void {
  try {
    if (Object.keys(values).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // storage full / unavailable — a draft is a convenience, never an error
  }
}

export function loadDraft(key: string): FormValues {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: FormValues = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
