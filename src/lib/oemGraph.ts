/**
 * Vireek OEM Intelligence Graph — pure client logic.
 *
 *   Serial # → OEM → Model → Known Issue → Service Bulletin → Required Part → Warranty → Claim
 *
 * Everything here is deterministic and side-effect free (no network, no clock unless `now` is passed),
 * so it is fully unit-testable. The database (see
 * supabase/migrations/20270401000000_oem_intelligence_graph.sql) does the matching, serial decoding,
 * manufacture-date applicability and the privacy-preserving network benchmark. This file:
 *   1. normalises the RPC payloads defensively (a null or missing field can never crash the UI),
 *   2. evaluates warranty coverage from OEM terms + the unit's install date,
 *   3. finds *potential* warranty-claim opportunities (never promises one),
 *   4. turns the payload into the eight-step chain the UI renders,
 *   5. summarises / ranks the fleet.
 *
 * Nothing is invented: a link with no data is reported as "empty", never as "clean".
 */

// ---------------------------------------------------------------- types

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type MatchMethod = 'linked' | 'exact' | 'family' | 'manufacturer' | 'none';
export type Applicability = 'applies' | 'possible';
export type BenchmarkSignal = 'above_benchmark' | 'in_line' | 'below_benchmark';
export type WarrantyComponent = 'parts' | 'labor' | 'compressor' | 'heat_exchanger' | 'other';
export type StepStatus = 'ok' | 'attention' | 'critical' | 'empty';
export type StepKey = 'serial' | 'oem' | 'model' | 'issue' | 'bulletin' | 'part' | 'warranty' | 'claim';
export type WarrantyState = 'active' | 'active_if_registered' | 'expired' | 'unknown';

export interface OemEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  status: string | null;
  customer_id: string | null;
  customer_name: string | null;
}

export interface OemManufacturer {
  id: string;
  slug: string;
  name: string;
  support_url: string | null;
}

export interface OemModel {
  id: string;
  model_number: string;
  equipment_type: string;
  category: string | null;
  avg_lifespan_years: number | null;
  manual_url: string | null;
  source: string | null;
}

export interface DecodedSerial {
  date: string;
  precision: 'year' | 'month' | 'week';
  rule: string;
  verified: boolean;
}

export interface OemPart {
  id: string;
  part_number: string;
  part_name: string;
  category: string | null;
  avg_price: number | null;
  quantity: number;
  is_required: boolean;
}

export interface OemBulletin {
  id: string;
  bulletin_number: string;
  title: string;
  description: string | null;
  issued_date: string | null;
  source_url: string | null;
}

export interface OemRecall {
  id: string;
  recall_number: string;
  title: string;
  description: string | null;
  severity: Severity;
  issued_date: string | null;
  remedy: string | null;
  source_url: string | null;
}

export interface ObservedMode {
  failure_mode: string;
  failure_rate_pct: number;
  median_age_months: number | null;
}

export interface OemIssue {
  id: string;
  issue_key: string;
  title: string;
  symptom: string | null;
  root_cause: string | null;
  recommended_repair: string | null;
  severity: Severity;
  labor_minutes_min: number | null;
  labor_minutes_max: number | null;
  manufactured_from: string | null;
  manufactured_to: string | null;
  applicability: Applicability;
  scope: 'model' | 'manufacturer';
  source: string | null;
  source_url: string | null;
  bulletin: Pick<OemBulletin, 'id' | 'bulletin_number' | 'title' | 'issued_date' | 'source_url'> | null;
  recall: Pick<OemRecall, 'id' | 'recall_number' | 'title' | 'severity' | 'issued_date' | 'remedy' | 'source_url'> | null;
  parts: OemPart[];
  observed: ObservedMode | null;
}

export interface OemPattern {
  failure_mode: string;
  typical_age_months: number | null;
  sample_size: number;
  frequency_score: number;
  common_fix: string | null;
}

export interface OemWarrantyTerm {
  component: WarrantyComponent;
  months: number;
  registered_months: number | null;
  registration_window_days: number | null;
  transferable: boolean | null;
  notes: string | null;
  source_url: string | null;
  scope: 'model' | 'type' | 'manufacturer';
}

export interface OemDocument {
  id: string;
  doc_type: string;
  title: string;
  url: string;
  language: string;
  scope: 'model' | 'manufacturer';
}

export interface OemReliability {
  scope: 'family' | 'brand';
  model_family: string;
  units_observed: number;
  units_failed: number;
  contributor_count: number;
  failure_rate_pct: number;
  benchmark_rate_pct: number;
  lift: number | null;
  signal: BenchmarkSignal;
  median_age_months: number | null;
  window_months: number;
  computed_at: string | null;
  top_failure_modes: ObservedMode[];
}

export interface OemClaim {
  id: string;
  status: string;
  claim_number: string | null;
  part_description: string | null;
  failure_date: string | null;
  claim_deadline: string | null;
  submitted_at: string | null;
  claimed_amount_cents: number | null;
  approved_amount_cents: number | null;
  credit_received_cents: number | null;
}

export interface OemCoverage {
  model_matched: boolean;
  issues: number;
  warranty_terms: number;
  documents: number;
  reliability: boolean;
  serial_rule: boolean;
  has_serial: boolean;
}

export interface OemGraph {
  found: boolean;
  equipment: OemEquipment | null;
  match: {
    method: MatchMethod;
    confidence: number;
    manufacturer: OemManufacturer | null;
    model: OemModel | null;
  };
  serial: { decoded: DecodedSerial | null; excluded_issues: number };
  issues: OemIssue[];
  recalls: OemRecall[];
  bulletins: OemBulletin[];
  patterns: OemPattern[];
  warranty_terms: OemWarrantyTerm[];
  documents: OemDocument[];
  reliability: OemReliability | null;
  claims: OemClaim[];
  coverage: OemCoverage;
}

export interface OemFleetRow {
  equipment_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  match_method: MatchMethod;
  match_confidence: number;
  recall_count: number;
  bulletin_count: number;
  issue_count: number;
  /** Fleet rows carry the benchmark without its failure-mode list (top_failure_modes is always empty here). */
  reliability: OemReliability | null;
}

export interface OemNetworkStats {
  contributing_businesses: number;
  units_observed: number;
  models_published: number;
  window_months: number;
  computed_at: string | null;
}

export interface WarrantyStatus {
  component: WarrantyComponent;
  state: WarrantyState;
  /** ISO date the coverage that applies to this state ends (null when unknown). */
  expires_on: string | null;
  days_left: number | null;
  needs_registration: boolean;
  transferable: boolean | null;
  reason: string | null;
}

export interface ClaimOpportunity {
  issue_id: string;
  title: string;
  severity: Severity;
  part_names: string[];
  estimated_part_value: number | null;
  labor_minutes_min: number | null;
  labor_minutes_max: number | null;
  needs_registration: boolean;
  basis: 'oem_terms' | 'recorded_expiry';
  expires_on: string | null;
}

export interface ChainStep {
  key: StepKey;
  label: string;
  headline: string;
  detail: string[];
  status: StepStatus;
}

// ---------------------------------------------------------------- constants

export const STEP_LABELS: Record<StepKey, string> = {
  serial: 'Serial #',
  oem: 'OEM',
  model: 'Model',
  issue: 'Known issues',
  bulletin: 'Bulletins & recalls',
  part: 'Required parts',
  warranty: 'Warranty',
  claim: 'Claim',
};

export const COMPONENT_LABELS: Record<WarrantyComponent, string> = {
  parts: 'Parts',
  labor: 'Labor',
  compressor: 'Compressor',
  heat_exchanger: 'Heat exchanger',
  other: 'Other',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const SIGNAL_LABELS: Record<BenchmarkSignal, string> = {
  above_benchmark: 'Above benchmark',
  in_line: 'In line with benchmark',
  below_benchmark: 'Below benchmark',
};

export const MATCH_LABELS: Record<MatchMethod, string> = {
  linked: 'Confirmed link',
  exact: 'Exact model match',
  family: 'Model-family match',
  manufacturer: 'Manufacturer only',
  none: 'No OEM match',
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const OPEN_CLAIM_STATUSES = new Set(['eligible', 'packet_pending', 'submitted']);
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- tiny coercion helpers

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const strOr = (v: unknown, fallback: string): string => str(v) ?? fallback;
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const numOr = (v: unknown, fallback: number): number => num(v) ?? fallback;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const toSeverity = (v: unknown): Severity => (SEVERITIES.includes(v as Severity) ? (v as Severity) : 'medium');
const SIGNALS: readonly BenchmarkSignal[] = ['above_benchmark', 'in_line', 'below_benchmark'];
const toSignal = (v: unknown): BenchmarkSignal => (SIGNALS.includes(v as BenchmarkSignal) ? (v as BenchmarkSignal) : 'in_line');
const METHODS: readonly MatchMethod[] = ['linked', 'exact', 'family', 'manufacturer', 'none'];
const toMethod = (v: unknown): MatchMethod => (METHODS.includes(v as MatchMethod) ? (v as MatchMethod) : 'none');
const COMPONENTS: readonly WarrantyComponent[] = ['parts', 'labor', 'compressor', 'heat_exchanger', 'other'];
const toComponent = (v: unknown): WarrantyComponent => (COMPONENTS.includes(v as WarrantyComponent) ? (v as WarrantyComponent) : 'other');

/** Mirrors SQL atlas_norm(): lowercase alphanumerics only. */
export function normalizeKey(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------- payload normalisation

function normalizeObserved(raw: unknown): ObservedMode | null {
  if (!isRecord(raw)) return null;
  const mode = str(raw.failure_mode);
  if (!mode) return null;
  return { failure_mode: mode, failure_rate_pct: numOr(raw.failure_rate_pct, 0), median_age_months: num(raw.median_age_months) };
}

function normalizeReliability(raw: unknown): OemReliability | null {
  if (!isRecord(raw)) return null;
  return {
    scope: raw.scope === 'brand' ? 'brand' : 'family',
    model_family: strOr(raw.model_family, '*'),
    units_observed: numOr(raw.units_observed, 0),
    units_failed: numOr(raw.units_failed, 0),
    contributor_count: numOr(raw.contributor_count, 0),
    failure_rate_pct: numOr(raw.failure_rate_pct, 0),
    benchmark_rate_pct: numOr(raw.benchmark_rate_pct, 0),
    lift: num(raw.lift),
    signal: toSignal(raw.signal),
    median_age_months: num(raw.median_age_months),
    window_months: numOr(raw.window_months, 36),
    computed_at: str(raw.computed_at),
    top_failure_modes: asArray(raw.top_failure_modes).map(normalizeObserved).filter((m): m is ObservedMode => m !== null),
  };
}

function normalizePart(raw: unknown): OemPart | null {
  if (!isRecord(raw) || !str(raw.id)) return null;
  return {
    id: String(raw.id),
    part_number: strOr(raw.part_number, ''),
    part_name: strOr(raw.part_name, 'Part'),
    category: str(raw.category),
    avg_price: num(raw.avg_price),
    quantity: Math.max(1, numOr(raw.quantity, 1)),
    is_required: raw.is_required !== false,
  };
}

function normalizeIssue(raw: unknown): OemIssue | null {
  if (!isRecord(raw) || !str(raw.id)) return null;
  const bulletin = isRecord(raw.bulletin) && str(raw.bulletin.id)
    ? {
        id: String(raw.bulletin.id),
        bulletin_number: strOr(raw.bulletin.bulletin_number, ''),
        title: strOr(raw.bulletin.title, 'Service bulletin'),
        issued_date: str(raw.bulletin.issued_date),
        source_url: str(raw.bulletin.source_url),
      }
    : null;
  const recall = isRecord(raw.recall) && str(raw.recall.id)
    ? {
        id: String(raw.recall.id),
        recall_number: strOr(raw.recall.recall_number, ''),
        title: strOr(raw.recall.title, 'Recall'),
        severity: toSeverity(raw.recall.severity),
        issued_date: str(raw.recall.issued_date),
        remedy: str(raw.recall.remedy),
        source_url: str(raw.recall.source_url),
      }
    : null;
  return {
    id: String(raw.id),
    issue_key: strOr(raw.issue_key, ''),
    title: strOr(raw.title, 'Known issue'),
    symptom: str(raw.symptom),
    root_cause: str(raw.root_cause),
    recommended_repair: str(raw.recommended_repair),
    severity: toSeverity(raw.severity),
    labor_minutes_min: num(raw.labor_minutes_min),
    labor_minutes_max: num(raw.labor_minutes_max),
    manufactured_from: str(raw.manufactured_from),
    manufactured_to: str(raw.manufactured_to),
    applicability: raw.applicability === 'possible' ? 'possible' : 'applies',
    scope: raw.scope === 'manufacturer' ? 'manufacturer' : 'model',
    source: str(raw.source),
    source_url: str(raw.source_url),
    bulletin,
    recall,
    parts: asArray(raw.parts).map(normalizePart).filter((p): p is OemPart => p !== null),
    observed: normalizeObserved(raw.observed),
  };
}

function normalizeTerm(raw: unknown): OemWarrantyTerm | null {
  if (!isRecord(raw)) return null;
  const months = num(raw.months);
  if (months === null) return null;
  return {
    component: toComponent(raw.component),
    months,
    registered_months: num(raw.registered_months),
    registration_window_days: num(raw.registration_window_days),
    transferable: bool(raw.transferable),
    notes: str(raw.notes),
    source_url: str(raw.source_url),
    scope: raw.scope === 'model' || raw.scope === 'type' ? raw.scope : 'manufacturer',
  };
}

const EMPTY_COVERAGE: OemCoverage = {
  model_matched: false,
  issues: 0,
  warranty_terms: 0,
  documents: 0,
  reliability: false,
  serial_rule: false,
  has_serial: false,
};

/** Turns whatever the RPC returned into a fully-populated OemGraph. Never throws. */
export function normalizeOemGraph(raw: unknown): OemGraph {
  const empty: OemGraph = {
    found: false,
    equipment: null,
    match: { method: 'none', confidence: 0, manufacturer: null, model: null },
    serial: { decoded: null, excluded_issues: 0 },
    issues: [],
    recalls: [],
    bulletins: [],
    patterns: [],
    warranty_terms: [],
    documents: [],
    reliability: null,
    claims: [],
    coverage: { ...EMPTY_COVERAGE },
  };
  if (!isRecord(raw) || raw.found !== true || !isRecord(raw.equipment) || !str(raw.equipment.id)) return empty;

  const eq = raw.equipment;
  const match: Record<string, unknown> = isRecord(raw.match) ? raw.match : {};
  const mfr = isRecord(match.manufacturer) && str(match.manufacturer.id) ? match.manufacturer : null;
  const model = isRecord(match.model) && str(match.model.id) ? match.model : null;
  const serial: Record<string, unknown> = isRecord(raw.serial) ? raw.serial : {};
  const rawDecoded = serial.decoded;
  const decoded: DecodedSerial | null =
    isRecord(rawDecoded) && str(rawDecoded.date)
      ? {
          date: String(rawDecoded.date),
          precision: rawDecoded.precision === 'week' ? 'week' : rawDecoded.precision === 'month' ? 'month' : 'year',
          rule: strOr(rawDecoded.rule, 'Serial rule'),
          verified: rawDecoded.verified === true,
        }
      : null;
  const cov: Record<string, unknown> = isRecord(raw.coverage) ? raw.coverage : {};

  const issues = asArray(raw.issues).map(normalizeIssue).filter((i): i is OemIssue => i !== null);
  const terms = asArray(raw.warranty_terms).map(normalizeTerm).filter((t): t is OemWarrantyTerm => t !== null);
  const documents = asArray(raw.documents).flatMap((d): OemDocument[] =>
    isRecord(d) && str(d.id) && str(d.url)
      ? [{ id: String(d.id), doc_type: strOr(d.doc_type, 'other'), title: strOr(d.title, 'Document'), url: String(d.url), language: strOr(d.language, 'en'), scope: d.scope === 'model' ? 'model' : 'manufacturer' }]
      : [],
  );

  return {
    found: true,
    equipment: {
      id: String(eq.id),
      equipment_type: strOr(eq.equipment_type, 'equipment'),
      make: str(eq.make),
      model: str(eq.model),
      serial_number: str(eq.serial_number),
      install_date: str(eq.install_date),
      warranty_expires_at: str(eq.warranty_expires_at),
      status: str(eq.status),
      customer_id: str(eq.customer_id),
      customer_name: str(eq.customer_name),
    },
    match: {
      method: toMethod(match.method),
      confidence: numOr(match.confidence, 0),
      manufacturer: mfr
        ? { id: String(mfr.id), slug: strOr(mfr.slug, ''), name: strOr(mfr.name, 'Manufacturer'), support_url: str(mfr.support_url) }
        : null,
      model: model
        ? {
            id: String(model.id),
            model_number: strOr(model.model_number, ''),
            equipment_type: strOr(model.equipment_type, ''),
            category: str(model.category),
            avg_lifespan_years: num(model.avg_lifespan_years),
            manual_url: str(model.manual_url),
            source: str(model.source),
          }
        : null,
    },
    serial: { decoded, excluded_issues: numOr(serial.excluded_issues, 0) },
    issues,
    recalls: asArray(raw.recalls).flatMap((r): OemRecall[] =>
      isRecord(r) && str(r.id)
        ? [{ id: String(r.id), recall_number: strOr(r.recall_number, ''), title: strOr(r.title, 'Recall'), description: str(r.description), severity: toSeverity(r.severity), issued_date: str(r.issued_date), remedy: str(r.remedy), source_url: str(r.source_url) }]
        : [],
    ),
    bulletins: asArray(raw.bulletins).flatMap((b): OemBulletin[] =>
      isRecord(b) && str(b.id)
        ? [{ id: String(b.id), bulletin_number: strOr(b.bulletin_number, ''), title: strOr(b.title, 'Service bulletin'), description: str(b.description), issued_date: str(b.issued_date), source_url: str(b.source_url) }]
        : [],
    ),
    patterns: asArray(raw.patterns).flatMap((p): OemPattern[] =>
      isRecord(p) && str(p.failure_mode)
        ? [{ failure_mode: String(p.failure_mode), typical_age_months: num(p.typical_age_months), sample_size: numOr(p.sample_size, 0), frequency_score: numOr(p.frequency_score, 0), common_fix: str(p.common_fix) }]
        : [],
    ),
    warranty_terms: terms,
    documents,
    reliability: normalizeReliability(raw.reliability),
    claims: asArray(raw.claims).flatMap((c): OemClaim[] =>
      isRecord(c) && str(c.id)
        ? [{ id: String(c.id), status: strOr(c.status, 'eligible'), claim_number: str(c.claim_number), part_description: str(c.part_description), failure_date: str(c.failure_date), claim_deadline: str(c.claim_deadline), submitted_at: str(c.submitted_at), claimed_amount_cents: num(c.claimed_amount_cents), approved_amount_cents: num(c.approved_amount_cents), credit_received_cents: num(c.credit_received_cents) }]
        : [],
    ),
    coverage: {
      model_matched: cov.model_matched === true,
      issues: numOr(cov.issues, issues.length),
      warranty_terms: numOr(cov.warranty_terms, terms.length),
      documents: numOr(cov.documents, documents.length),
      reliability: cov.reliability === true,
      serial_rule: cov.serial_rule === true,
      has_serial: cov.has_serial === true,
    },
  };
}

/** Normalises the get_oem_graph_fleet() payload; drops rows without an id. */
export function normalizeFleet(raw: unknown): OemFleetRow[] {
  return asArray(raw).flatMap((r): OemFleetRow[] => {
    if (!isRecord(r) || !str(r.equipment_id)) return [];
    const rel = normalizeReliability(r.reliability);
    return [
      {
        equipment_id: String(r.equipment_id),
        equipment_type: strOr(r.equipment_type, 'equipment'),
        make: str(r.make),
        model: str(r.model),
        serial_number: str(r.serial_number),
        customer_id: str(r.customer_id),
        customer_name: str(r.customer_name),
        install_date: str(r.install_date),
        warranty_expires_at: str(r.warranty_expires_at),
        match_method: toMethod(r.match_method),
        match_confidence: numOr(r.match_confidence, 0),
        recall_count: numOr(r.recall_count, 0),
        bulletin_count: numOr(r.bulletin_count, 0),
        issue_count: numOr(r.issue_count, 0),
        reliability: rel,
      },
    ];
  });
}

// ---------------------------------------------------------------- dates

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parses 'YYYY-MM-DD' (or an ISO timestamp) to a UTC midnight timestamp; null if invalid. */
export function parseDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = ISO_DAY.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

export function toIsoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Adds calendar months in UTC, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso: string, months: number): string | null {
  const m = ISO_DAY.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1 + Math.trunc(months);
  const day = Number(m[3]);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return toIsoDay(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
}

const daysUntil = (iso: string, nowMs: number): number => Math.round((Date.parse(`${iso}T00:00:00Z`) - nowMs) / DAY_MS);

// ---------------------------------------------------------------- warranty

/**
 * Coverage per component from the OEM terms and the unit's install date.
 * `months` is coverage with no action by the owner; `registered_months` only applies if the unit was
 * registered, so a unit between the two is reported as 'active_if_registered' — never as plainly active.
 */
export function evaluateWarranty(graph: OemGraph, now: Date): WarrantyStatus[] {
  const install = graph.equipment?.install_date ?? null;
  const today = toIsoDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayMs = parseDay(today) as number;

  return graph.warranty_terms.map((term): WarrantyStatus => {
    const base = {
      component: term.component,
      transferable: term.transferable,
      needs_registration: false,
    };
    if (!install || parseDay(install) === null) {
      return { ...base, state: 'unknown', expires_on: null, days_left: null, reason: 'No install date on record for this unit.' };
    }
    const standardEnd = addMonths(install, term.months) as string;
    if (todayMs <= (parseDay(standardEnd) as number)) {
      return { ...base, state: 'active', expires_on: standardEnd, days_left: daysUntil(standardEnd, todayMs), reason: null };
    }
    if (term.registered_months !== null) {
      const registeredEnd = addMonths(install, term.registered_months) as string;
      if (todayMs <= (parseDay(registeredEnd) as number)) {
        return {
          ...base,
          state: 'active_if_registered',
          needs_registration: true,
          expires_on: registeredEnd,
          days_left: daysUntil(registeredEnd, todayMs),
          reason: 'Covered only if the unit was registered with the manufacturer.',
        };
      }
      return { ...base, state: 'expired', expires_on: registeredEnd, days_left: null, reason: null };
    }
    return { ...base, state: 'expired', expires_on: standardEnd, days_left: null, reason: null };
  });
}

/** Parts coverage: OEM terms first, otherwise the expiry date recorded on the equipment row. */
export function partsCoverage(
  graph: OemGraph,
  now: Date,
): { state: WarrantyState; basis: 'oem_terms' | 'recorded_expiry' | 'none'; expires_on: string | null; needs_registration: boolean } {
  const parts = evaluateWarranty(graph, now).find((w) => w.component === 'parts');
  if (parts && parts.state !== 'unknown') {
    return { state: parts.state, basis: 'oem_terms', expires_on: parts.expires_on, needs_registration: parts.needs_registration };
  }
  const recorded = graph.equipment?.warranty_expires_at ?? null;
  const recordedMs = parseDay(recorded);
  if (recorded && recordedMs !== null) {
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return { state: todayMs <= recordedMs ? 'active' : 'expired', basis: 'recorded_expiry', expires_on: toIsoDay(recordedMs), needs_registration: false };
  }
  return { state: 'unknown', basis: 'none', expires_on: null, needs_registration: false };
}

// ---------------------------------------------------------------- claims

const hasOpenClaim = (graph: OemGraph) => graph.claims.some((c) => OPEN_CLAIM_STATUSES.has(c.status));

/**
 * Potential warranty-claim opportunities: an applicable known issue that needs a part, on a unit whose
 * parts coverage is (or may be) active, with no claim already open. A *lead to review*, never a promise —
 * the OEM decides. Sorted by severity, then by part value.
 */
export function claimOpportunities(graph: OemGraph, now: Date): ClaimOpportunity[] {
  if (!graph.found || hasOpenClaim(graph)) return [];
  const coverage = partsCoverage(graph, now);
  if (coverage.state !== 'active' && coverage.state !== 'active_if_registered') return [];
  if (coverage.basis === 'none') return [];

  return graph.issues
    .filter((issue) => issue.parts.some((p) => p.is_required))
    .map((issue): ClaimOpportunity => {
      const required = issue.parts.filter((p) => p.is_required);
      const priced = required.filter((p) => p.avg_price !== null);
      return {
        issue_id: issue.id,
        title: issue.title,
        severity: issue.severity,
        part_names: required.map((p) => p.part_name),
        estimated_part_value: priced.length === 0 ? null : priced.reduce((sum, p) => sum + (p.avg_price as number) * p.quantity, 0),
        labor_minutes_min: issue.labor_minutes_min,
        labor_minutes_max: issue.labor_minutes_max,
        needs_registration: coverage.needs_registration,
        basis: coverage.basis === 'recorded_expiry' ? 'recorded_expiry' : 'oem_terms',
        expires_on: coverage.expires_on,
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        (b.estimated_part_value ?? 0) - (a.estimated_part_value ?? 0) ||
        a.title.localeCompare(b.title),
    );
}

// ---------------------------------------------------------------- formatting

export function formatLabor(min: number | null, max: number | null): string | null {
  const fmt = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${Math.round((m / 60) * 10) / 10} h`);
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min !== max) return `${fmt(min)} – ${fmt(max)}`;
  return fmt((min ?? max) as number);
}

export function formatMoney(value: number | null): string | null {
  if (value === null) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

export function formatPct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits).replace(/\.0+$/, '')}%`;
}

export function formatLift(lift: number | null): string | null {
  if (lift === null) return null;
  return `${lift.toFixed(1).replace(/\.0$/, '')}×`;
}

/** "14.2% of units had a failure vs 8.1% for the rest of the network (1.8×)". */
export function reliabilityHeadline(rel: OemReliability | null): string | null {
  if (!rel) return null;
  const lift = formatLift(rel.lift);
  return `${formatPct(rel.failure_rate_pct)} of units had a failure vs ${formatPct(rel.benchmark_rate_pct)} for the rest of the network${lift ? ` (${lift})` : ''}`;
}

export function humanizeKey(key: string): string {
  const s = key.replace(/_/g, ' ').trim();
  return s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatDecodedSerial(decoded: DecodedSerial | null): string | null {
  if (!decoded) return null;
  const d = parseDay(decoded.date);
  if (d === null) return null;
  const date = new Date(d);
  const year = String(date.getUTCFullYear());
  if (decoded.precision === 'year') return year;
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return decoded.precision === 'month' ? `${month} ${year}` : `week of ${month} ${date.getUTCDate()}, ${year}`;
}

// ---------------------------------------------------------------- the chain

const worst = (a: StepStatus, b: StepStatus): StepStatus => {
  const order: StepStatus[] = ['empty', 'ok', 'attention', 'critical'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
};

/** The eight-step chain, always in the same order, always honest about empty links. */
export function buildChain(graph: OemGraph, now: Date): ChainStep[] {
  const eq = graph.equipment;
  const steps: ChainStep[] = [];
  const label = STEP_LABELS;

  // 1. Serial
  const decoded = formatDecodedSerial(graph.serial.decoded);
  if (eq?.serial_number) {
    steps.push({
      key: 'serial',
      label: label.serial,
      headline: eq.serial_number,
      detail: decoded
        ? [`Manufactured ${decoded}${graph.serial.decoded?.verified ? '' : ' (decoding rule not yet verified)'}`]
        : ['Manufacture date unavailable — no decoding rule for this manufacturer yet.'],
      status: 'ok',
    });
  } else {
    steps.push({ key: 'serial', label: label.serial, headline: 'No serial on record', detail: ['Add the serial number to unlock serial-specific issues and claims.'], status: 'attention' });
  }

  // 2. OEM
  const mfr = graph.match.manufacturer;
  steps.push(
    mfr
      ? { key: 'oem', label: label.oem, headline: mfr.name, detail: [`Matched from “${eq?.make ?? ''}”`], status: 'ok' }
      : { key: 'oem', label: label.oem, headline: 'Not matched', detail: [eq?.make ? `“${eq.make}” is not in the OEM roster yet.` : 'No make on this unit.'], status: 'empty' },
  );

  // 3. Model
  const model = graph.match.model;
  if (model) {
    const exact = graph.match.method === 'exact' || graph.match.method === 'linked';
    steps.push({
      key: 'model',
      label: label.model,
      headline: model.model_number,
      detail: [
        MATCH_LABELS[graph.match.method],
        ...(model.avg_lifespan_years ? [`Typical lifespan ${model.avg_lifespan_years} years`] : []),
      ],
      status: exact ? 'ok' : 'attention',
    });
  } else {
    steps.push({
      key: 'model',
      label: label.model,
      headline: mfr ? 'Model not in catalog' : 'Not matched',
      detail: [eq?.model ? `“${eq.model}” has no catalog entry yet.` : 'No model on this unit.'],
      status: 'empty',
    });
  }

  // 4. Known issues
  const issueStatus = graph.issues.reduce<StepStatus>((acc, i) => worst(acc, i.severity === 'critical' || i.severity === 'high' ? 'critical' : 'attention'), 'empty');
  const possible = graph.issues.filter((i) => i.applicability === 'possible').length;
  steps.push(
    graph.issues.length > 0
      ? {
          key: 'issue',
          label: label.issue,
          headline: `${graph.issues.length} on record`,
          detail: [
            ...graph.issues.slice(0, 3).map((i) => i.title),
            ...(possible > 0 ? [`${possible} depend on a manufacture date we could not confirm`] : []),
          ],
          status: issueStatus,
        }
      : { key: 'issue', label: label.issue, headline: 'None on record', detail: ['Nothing on record yet — that is not the same as “no issues”.'], status: 'empty' },
  );

  // 5. Bulletins & recalls
  const recallSeverity = graph.recalls.reduce<StepStatus>((acc, r) => worst(acc, r.severity === 'critical' || r.severity === 'high' ? 'critical' : 'attention'), 'empty');
  const bulletinCount = graph.bulletins.length;
  const recallCount = graph.recalls.length;
  steps.push(
    bulletinCount + recallCount > 0
      ? {
          key: 'bulletin',
          label: label.bulletin,
          headline: [recallCount ? `${recallCount} recall${recallCount === 1 ? '' : 's'}` : null, bulletinCount ? `${bulletinCount} bulletin${bulletinCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '),
          detail: [...graph.recalls.slice(0, 2).map((r) => `Recall ${r.recall_number}: ${r.title}`), ...graph.bulletins.slice(0, 2).map((b) => `TSB ${b.bulletin_number}: ${b.title}`)],
          status: bulletinCount > 0 && recallSeverity === 'empty' ? 'attention' : recallSeverity,
        }
      : { key: 'bulletin', label: label.bulletin, headline: 'None on record', detail: ['No manufacturer bulletins or recalls linked to this model.'], status: 'empty' },
  );

  // 6. Required parts
  const parts = new Map<string, OemPart>();
  for (const issue of graph.issues) for (const p of issue.parts) if (p.is_required && !parts.has(p.id)) parts.set(p.id, p);
  const partList = [...parts.values()];
  const value = partList.filter((p) => p.avg_price !== null).reduce((s, p) => s + (p.avg_price as number) * p.quantity, 0);
  steps.push(
    partList.length > 0
      ? {
          key: 'part',
          label: label.part,
          headline: `${partList.length} part${partList.length === 1 ? '' : 's'}`,
          detail: [...partList.slice(0, 3).map((p) => `${p.part_name}${p.part_number ? ` (${p.part_number})` : ''}`), ...(value > 0 ? [`≈ ${formatMoney(value)} list value`] : [])],
          status: 'ok',
        }
      : { key: 'part', label: label.part, headline: 'None linked', detail: ['No known issue on this model has required parts yet.'], status: 'empty' },
  );

  // 7. Warranty
  const warranty = evaluateWarranty(graph, now);
  const coverage = partsCoverage(graph, now);
  if (warranty.length > 0 || coverage.basis === 'recorded_expiry') {
    const headline =
      coverage.state === 'active' ? 'Parts covered'
      : coverage.state === 'active_if_registered' ? 'Covered if registered'
      : coverage.state === 'expired' ? 'Parts coverage ended'
      : 'Coverage unclear';
    steps.push({
      key: 'warranty',
      label: label.warranty,
      headline,
      detail: [
        ...warranty.map((w) => {
          const name = COMPONENT_LABELS[w.component];
          if (w.state === 'unknown') return `${name}: add an install date to evaluate`;
          const when = w.expires_on ? ` to ${w.expires_on}` : '';
          return w.state === 'expired' ? `${name}: ended${when}` : `${name}: ${w.state === 'active' ? 'active' : 'active if registered'}${when}`;
        }),
        ...(coverage.basis === 'recorded_expiry' && coverage.expires_on ? [`Recorded expiry ${coverage.expires_on}`] : []),
      ],
      status: coverage.state === 'active' ? 'ok' : coverage.state === 'active_if_registered' ? 'attention' : 'empty',
    });
  } else {
    steps.push({ key: 'warranty', label: label.warranty, headline: 'No terms on record', detail: ['No OEM warranty terms for this model, and no expiry date recorded on the unit.'], status: 'empty' });
  }

  // 8. Claim
  const opportunities = claimOpportunities(graph, now);
  if (graph.claims.length > 0) {
    const latest = graph.claims[0];
    steps.push({
      key: 'claim',
      label: label.claim,
      headline: `${graph.claims.length} claim${graph.claims.length === 1 ? '' : 's'}`,
      detail: [`Latest: ${humanizeKey(latest.status)}${latest.claim_number ? ` (#${latest.claim_number})` : ''}`],
      status: hasOpenClaim(graph) ? 'attention' : 'ok',
    });
  } else if (opportunities.length > 0) {
    steps.push({
      key: 'claim',
      label: label.claim,
      headline: `${opportunities.length} potential`,
      detail: ['A known issue with a covered part — review before the next visit.'],
      status: 'attention',
    });
  } else {
    steps.push({ key: 'claim', label: label.claim, headline: 'No claims', detail: [], status: 'empty' });
  }

  return steps;
}

// ---------------------------------------------------------------- fleet

export type FleetFilter = 'all' | 'attention' | 'above_benchmark' | 'unmatched';

export const FLEET_FILTER_LABELS: Record<FleetFilter, string> = {
  all: 'All',
  attention: 'Needs attention',
  above_benchmark: 'Above benchmark',
  unmatched: 'Unmatched',
};

/** Higher = look at it first. Recalls dominate, then a worse-than-benchmark model, then issues/bulletins. */
export function fleetAttentionScore(row: OemFleetRow): number {
  const signal = row.reliability?.signal === 'above_benchmark' ? 4 : 0;
  return row.recall_count * 5 + signal + Math.min(row.issue_count, 5) + Math.min(row.bulletin_count, 3);
}

export function isUnmatched(row: OemFleetRow): boolean {
  return row.match_method === 'none' || row.match_method === 'manufacturer';
}

export function filterFleet(rows: OemFleetRow[], filter: FleetFilter, query: string): OemFleetRow[] {
  const q = query.trim().toLowerCase();
  return rows
    .filter((r) => {
      if (filter === 'attention' && fleetAttentionScore(r) === 0) return false;
      if (filter === 'above_benchmark' && r.reliability?.signal !== 'above_benchmark') return false;
      if (filter === 'unmatched' && !isUnmatched(r)) return false;
      if (q === '') return true;
      return `${r.make ?? ''} ${r.model ?? ''} ${r.equipment_type} ${r.customer_name ?? ''} ${r.serial_number ?? ''}`.toLowerCase().includes(q);
    })
    .sort((a, b) => fleetAttentionScore(b) - fleetAttentionScore(a) || (a.make ?? '').localeCompare(b.make ?? '') || (a.model ?? '').localeCompare(b.model ?? ''));
}

export interface FleetSummary {
  total: number;
  matched: number;
  matchedPct: number;
  aboveBenchmark: number;
  withRecalls: number;
  withIssues: number;
}

export function summarizeFleet(rows: OemFleetRow[]): FleetSummary {
  const matched = rows.filter((r) => !isUnmatched(r)).length;
  return {
    total: rows.length,
    matched,
    matchedPct: rows.length === 0 ? 0 : Math.round((matched / rows.length) * 100),
    aboveBenchmark: rows.filter((r) => r.reliability?.signal === 'above_benchmark').length,
    withRecalls: rows.filter((r) => r.recall_count > 0).length,
    withIssues: rows.filter((r) => r.issue_count > 0).length,
  };
}

/** What the graph knows and does not know about one unit — shown so the product never over-claims. */
export function dataCoverageItems(graph: OemGraph): Array<{ label: string; present: boolean }> {
  const c = graph.coverage;
  return [
    { label: 'Serial number', present: c.has_serial },
    { label: 'Manufacture date decoded', present: c.serial_rule },
    { label: 'Model in OEM catalog', present: c.model_matched },
    { label: 'Known issues', present: c.issues > 0 },
    { label: 'Warranty terms', present: c.warranty_terms > 0 },
    { label: 'Manuals & documents', present: c.documents > 0 },
    { label: 'Network benchmark', present: c.reliability },
  ];
}
