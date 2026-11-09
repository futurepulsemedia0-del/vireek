/**
 * Config-driven Trade Pack framework — shared types.
 *
 * A pack is VERSIONED DATA (no code). It is validated by schema.ts, flattened into
 * addressable artifacts, and installed / upgraded / rolled back per account by engine.ts.
 * The database (supabase/migrations/20290301000000_pack_framework.sql) re-checks every
 * write with optimistic guards, so a stale or tampered plan can never overwrite anything.
 *
 * Not to be confused with src/lib/tradePacks/ (the older pest-control / pool-service
 * compliance packs), which this framework does not touch.
 */

export const PACK_SCHEMA_VERSION = 1 as const;

export const ARTIFACT_KINDS = [
  'job_type',
  'custom_field',
  'form',
  'status',
  'workflow_rule',
  'pricing_template',
  'term',
  'document_template',
  'recurring_rule',
  'report',
  'onboarding_preset',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface JobTypeDef {
  key: string;
  label: string;
  description?: string;
  defaultDurationMinutes: number;
  /** Must reference a `forms` key. */
  checklistFormKey?: string;
  /** Must reference a `pricingTemplates` key. */
  pricingTemplateKey?: string;
  ticketMinCents?: number;
  ticketMaxCents?: number;
}

export interface CustomFieldDef {
  key: string;
  label: string;
  entity: 'customer' | 'job' | 'equipment';
  fieldType: 'text' | 'number' | 'select' | 'date' | 'boolean';
  options?: string[];
  required?: boolean;
}

export interface FormItemDef {
  id: string;
  label: string;
  type?: 'check' | 'text' | 'number' | 'photo';
  required?: boolean;
  /** Skipping this is a known safety / callback risk. */
  critical?: boolean;
}

export interface FormDef {
  key: string;
  title: string;
  kind: 'form' | 'checklist';
  items: FormItemDef[];
}

export interface StatusDef {
  key: string;
  label: string;
  category: 'open' | 'active' | 'done' | 'cancelled';
  order: number;
}

export interface WorkflowRuleDef {
  key: string;
  label: string;
  /** Must reference `statuses` keys. */
  from: string;
  to: string;
  /** Must reference `forms` keys that have to be completed before the transition. */
  requiresFormKeys?: string[];
  requiresPhoto?: boolean;
}

export interface PricingLineDef {
  key: string;
  label: string;
  pricingModel: 'flat' | 'hourly' | 'starting_at' | 'range' | 'per_unit';
  /** Integer cents. */
  priceCents: number;
  /** Integer cents; only for `range` (must be >= priceCents). */
  priceMaxCents?: number;
  estimatedCostCents?: number;
}

export interface PricingTemplateDef {
  key: string;
  label: string;
  lines: PricingLineDef[];
}

export interface TermDef {
  /** The platform concept being relabelled, e.g. "job", "customer", "technician". */
  key: string;
  singular: string;
  plural: string;
}

export interface DocumentTemplateDef {
  key: string;
  label: string;
  docType: 'estimate' | 'invoice' | 'work_order' | 'agreement';
  /** Plain text with {{placeholder}} tokens (letters, digits, dot, underscore). No HTML. */
  body: string;
}

export interface RecurringRuleDef {
  key: string;
  label: string;
  intervalUnit: 'week' | 'month' | 'year';
  intervalCount: number;
  durationMinutes: number;
  /** Must reference a `jobTypes` key. */
  jobTypeKey?: string;
}

export interface ReportDef {
  key: string;
  label: string;
  metric: 'revenue' | 'callback_rate' | 'first_time_fix' | 'avg_ticket' | 'jobs_completed';
  groupBy: 'job_type' | 'technician' | 'month';
}

export interface OnboardingPresetDef {
  key: string;
  label: string;
  steps: Array<{ key: string; label: string; route?: string }>;
}

export interface PackManifest {
  schemaVersion: typeof PACK_SCHEMA_VERSION;
  /** Stable identifier; entitlement is `packs:<id>`. */
  id: string;
  /** Semver `MAJOR.MINOR.PATCH`. Published versions are immutable. */
  version: string;
  name: string;
  description?: string;
  jobTypes?: JobTypeDef[];
  customFields?: CustomFieldDef[];
  forms?: FormDef[];
  statuses?: StatusDef[];
  workflowRules?: WorkflowRuleDef[];
  pricingTemplates?: PricingTemplateDef[];
  terminology?: TermDef[];
  documentTemplates?: DocumentTemplateDef[];
  recurringRules?: RecurringRuleDef[];
  reports?: ReportDef[];
  onboardingPresets?: OnboardingPresetDef[];
}

/** One installable unit. `content` always carries its own `key` (or `id`-less singletons use `key`). */
export interface Artifact {
  kind: ArtifactKind;
  key: string;
  content: Record<string, unknown>;
}

export type ArtifactId = string; // `${kind}:${key}`

/* ---------------- install state + plans ---------------- */

/** What an account currently holds for one artifact. `base` = pack content last applied; null = account-owned. */
export interface TrackedArtifact {
  live: unknown;
  base: unknown | null;
}
export type AccountState = Record<ArtifactId, TrackedArtifact>;

export type OpKind = 'create' | 'update' | 'remove' | 'rebase' | 'detach';

/**
 * One atomic change. Every op carries the state it expects and the state it produces, so the
 * server can refuse it if the account changed in between (optimistic guard) and so a rollback
 * can be derived purely from the recorded event.
 */
export interface Op {
  op: OpKind;
  id: ArtifactId;
  liveBefore: unknown | null;
  liveAfter: unknown | null;
  baseBefore: unknown | null;
  baseAfter: unknown | null;
}

export type ConflictReason = 'customized_and_changed_by_pack';

export interface Conflict {
  id: ArtifactId;
  reason: ConflictReason;
  base: unknown;
  live: unknown;
  next: unknown;
}

export type Resolution = 'take_pack' | 'keep_mine';

export interface PlanSummary {
  created: number;
  updated: number;
  removed: number;
  rebased: number;
  detached: number;
  /** Artifacts left exactly as they are because the account customized them. */
  preservedCustomized: number;
  conflicts: number;
  unchanged: number;
}

export interface Plan {
  kind: 'install' | 'upgrade' | 'rollback';
  packId: string;
  fromVersion: string | null;
  toVersion: string | null;
  ops: Op[];
  conflicts: Conflict[];
  summary: PlanSummary;
}

export interface InstallEvent {
  id: string;
  kind: 'install' | 'upgrade' | 'rollback';
  fromVersion: string | null;
  toVersion: string | null;
  ops: Op[];
}
