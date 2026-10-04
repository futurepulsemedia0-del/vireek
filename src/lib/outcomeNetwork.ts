/**
 * Vireek Outcome Intelligence Network — pure domain logic (no I/O).
 *
 * Mirrors the database rules in 20270205000000_outcome_intelligence_network.sql so the UI
 * can explain, validate and visualise exactly what the server enforces:
 *   - controlled vocabulary (taxonomy) is the only thing the network ever sees
 *   - success = fixed AND no callback AND no dispute, final 30 days after the job
 *   - published cells need >= 5 tenants and >= 10 matured cases
 */

export type OinTrade = 'hvac' | 'plumbing' | 'electrical';
export type TaxonomyKind = 'symptom' | 'failure_mode' | 'action' | 'part';
export type ClimateBand = 'tropical' | 'subtropical' | 'temperate' | 'cold' | 'subarctic' | 'unknown';

export const MATURITY_DAYS = 30;
export const MIN_CONTRIBUTORS = 5;
export const MIN_CASES = 10;

export interface TaxonomyItem {
  kind: TaxonomyKind;
  trade: OinTrade;
  key: string;
  label: string;
}

export interface OinSettings {
  user_id: string;
  contribute: boolean;
  consented_at: string | null;
  updated_at: string;
}

export interface OinOverview {
  contributing: boolean;
  contributors: number;
  network_cases: number;
  published_cells: number;
  last_computed_at: string | null;
  my_open: number;
  my_matured: number;
  min_contributors: number;
  min_cases: number;
}

export interface OinCase {
  id: string;
  job_id: string;
  trade: OinTrade;
  equipment_type: string;
  equipment_make: string;
  equipment_model: string;
  climate_band: ClimateBand;
  symptom_keys: string[];
  failure_mode: string;
  action_key: string;
  part_keys: string[];
  technician_id: string | null;
  cost_cents: number | null;
  duration_minutes: number | null;
  resolution: string | null;
  first_visit_fix: boolean | null;
  caused_callback: boolean | null;
  customer_disputed: boolean | null;
  customer_rating: number | null;
  status: 'open' | 'matured';
  success: boolean | null;
  matured_at: string | null;
  predicted_success: number | null;
  predicted_action_key: string | null;
  created_at: string;
}

export interface OinRecommendation {
  action_key: string;
  action_label: string;
  symptom_key: string;
  level: number;
  contributor_count: number;
  case_count: number;
  success_rate: number;
  wilson_low: number;
  wilson_high: number;
  first_visit_rate: number | null;
  callback_rate: number | null;
  median_cost_cents: number | null;
  median_duration_minutes: number | null;
  avg_rating: number | null;
  top_parts: { part: string; share: number }[];
}

export interface OinRecommendResult {
  matched_cells: number;
  recommendations: OinRecommendation[];
}

export const CLIMATE_OPTIONS: { value: ClimateBand; label: string }[] = [
  { value: 'unknown', label: 'Not specified' },
  { value: 'tropical', label: 'Tropical (< 23.5° latitude)' },
  { value: 'subtropical', label: 'Subtropical (23.5°–35°)' },
  { value: 'temperate', label: 'Temperate (35°–48°)' },
  { value: 'cold', label: 'Cold (48°–60°)' },
  { value: 'subarctic', label: 'Subarctic (60°+)' },
];

/** How specific the evidence behind a recommendation is (1 = most specific). */
export const LEVEL_SCOPE: Record<number, string> = {
  1: 'Same model · climate · diagnosis',
  2: 'Same make · climate · diagnosis',
  3: 'Same make · diagnosis',
  4: 'Same equipment type · diagnosis',
  5: 'Same model · climate',
  6: 'Same make · climate',
  7: 'Same make',
  8: 'Same equipment type',
};

// ------------------------------------------------------------------
// Normalisation (must match oin_norm / oin_trade_slug / oin_climate_band)
// ------------------------------------------------------------------

export function normalizeKey(value: string | null | undefined): string {
  const out = (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  return out || 'unknown';
}

export function tradeFromIndustry(industry: string | null | undefined): OinTrade | 'other' {
  const s = (industry ?? '').toLowerCase();
  if (/hvac|heat|cool|air.?cond|refrig/.test(s)) return 'hvac';
  if (/plumb|drain|water.?heater/.test(s)) return 'plumbing';
  if (/electr/.test(s)) return 'electrical';
  return 'other';
}

export function climateBandFromLatitude(lat: number | null | undefined): ClimateBand {
  if (lat == null || !Number.isFinite(lat) || lat < -90 || lat > 90) return 'unknown';
  const a = Math.abs(lat);
  if (a < 23.5) return 'tropical';
  if (a < 35) return 'subtropical';
  if (a < 48) return 'temperate';
  if (a < 60) return 'cold';
  return 'subarctic';
}

export function keyToLabel(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function labelMap(items: TaxonomyItem[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of items) m.set(`${i.kind}:${i.key}`, i.label);
  return m;
}

export function labelFor(map: Map<string, string>, kind: TaxonomyKind, key: string): string {
  return map.get(`${kind}:${key}`) ?? keyToLabel(key);
}

/**
 * Suggest taxonomy keys from free text (job notes, diagnosis text) by label-word overlap.
 * Deterministic and explainable; the technician always confirms.
 */
export function suggestFromText(text: string, items: TaxonomyItem[], limit = 3): string[] {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  if (hay.trim().length < 3) return [];
  const scored = items
    .map((item) => {
      const words = item.key.split('_').filter((w) => w.length >= 3);
      if (words.length === 0) return { key: item.key, score: 0 };
      const hits = words.filter((w) => hay.includes(` ${w}`)).length;
      return { key: item.key, score: hits / words.length };
    })
    .filter((s) => s.score >= 0.67)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return scored.slice(0, limit).map((s) => s.key);
}

// ------------------------------------------------------------------
// Confidence & formatting
// ------------------------------------------------------------------

export type Confidence = 'high' | 'medium' | 'low';

/** Based on evidence volume, tenant diversity, and how tight the interval is. */
export function confidenceTier(rec: Pick<OinRecommendation, 'case_count' | 'contributor_count' | 'wilson_low' | 'wilson_high'>): Confidence {
  const width = rec.wilson_high - rec.wilson_low;
  if (rec.case_count >= 50 && rec.contributor_count >= 10 && width <= 0.25) return 'high';
  if (rec.case_count >= 20 && rec.contributor_count >= 6 && width <= 0.4) return 'medium';
  return 'low';
}

export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

export function formatMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function daysUntilMature(completedAtIso: string | null, now = Date.now()): number | null {
  if (!completedAtIso) return null;
  const t = Date.parse(completedAtIso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t + MATURITY_DAYS * 86_400_000 - now) / 86_400_000));
}

/** Server errors look like "OIN_CODE: message" — show only the message. */
export function friendlyOinError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const msg = (error as { message?: unknown } | null)?.message;
  if (typeof msg !== 'string') return fallback;
  const m = /OIN_[A-Z_]+:\s*(.+)$/s.exec(msg);
  if (m?.[1]) return m[1].trim();
  return fallback;
}

// ------------------------------------------------------------------
// The outcome chain: Problem → … → Customer result
// ------------------------------------------------------------------

export type ChainState = 'done' | 'pending' | 'good' | 'bad';
export interface ChainStep {
  id: string;
  label: string;
  value: string;
  state: ChainState;
}

export function buildChain(c: OinCase, labels: Map<string, string>, technicianName?: string | null): ChainStep[] {
  const matured = c.status === 'matured';
  const eq = [c.equipment_make, c.equipment_type, c.equipment_model].filter((v) => v && v !== 'unknown').join(' ');
  const parts = c.part_keys.map((k) => labelFor(labels, 'part', k));
  const cost = [formatMoney(c.cost_cents), c.duration_minutes != null ? formatMinutes(c.duration_minutes) : null]
    .filter((v) => v && v !== '—')
    .join(' · ');

  const customer = !matured
    ? { value: 'Pending', state: 'pending' as ChainState }
    : c.customer_disputed
      ? { value: 'Disputed', state: 'bad' as ChainState }
      : c.customer_rating != null
        ? { value: `${c.customer_rating}/5`, state: (c.customer_rating >= 4 ? 'good' : 'done') as ChainState }
        : { value: 'No rating', state: 'done' as ChainState };

  return [
    { id: 'problem', label: 'Problem', value: eq || 'Equipment not linked', state: 'done' },
    { id: 'symptoms', label: 'Symptoms', value: c.symptom_keys.map((k) => labelFor(labels, 'symptom', k)).join(', '), state: 'done' },
    { id: 'diagnosis', label: 'Diagnosis', value: labelFor(labels, 'failure_mode', c.failure_mode), state: 'done' },
    { id: 'technician', label: 'Technician', value: technicianName ?? (c.technician_id ? 'Assigned' : 'Unassigned'), state: 'done' },
    { id: 'part', label: 'Part', value: parts.length ? parts.join(', ') : 'None', state: 'done' },
    { id: 'action', label: 'Action', value: labelFor(labels, 'action', c.action_key), state: 'done' },
    { id: 'cost', label: 'Cost', value: cost || '—', state: 'done' },
    {
      id: 'outcome',
      label: 'Outcome',
      value: matured ? (c.success ? 'Resolved' : 'Not resolved') : `Maturing (${MATURITY_DAYS}-day window)`,
      state: !matured ? 'pending' : c.success ? 'good' : 'bad',
    },
    {
      id: 'callback',
      label: 'Callback',
      value: !matured ? 'Pending' : c.caused_callback ? 'Callback needed' : 'No callback',
      state: !matured ? 'pending' : c.caused_callback ? 'bad' : 'good',
    },
    { id: 'customer', label: 'Customer result', value: customer.value, state: customer.state },
  ];
}

// ------------------------------------------------------------------
// Calibration: how honest were the network's predictions for YOUR jobs?
// ------------------------------------------------------------------

export interface CalibrationBin {
  label: string;
  count: number;
  predicted: number;
  actual: number;
}

export interface Calibration {
  sample: number;
  brier: number;
  bins: CalibrationBin[];
}

const BIN_EDGES: [number, number, string][] = [
  [0, 0.5, '< 50%'],
  [0.5, 0.7, '50–70%'],
  [0.7, 0.85, '70–85%'],
  [0.85, 1.0001, '85–100%'],
];

export function computeCalibration(cases: OinCase[]): Calibration | null {
  const rated = cases.filter((c) => c.status === 'matured' && c.success != null && c.predicted_success != null);
  if (rated.length < 10) return null;
  const brier = rated.reduce((s, c) => s + ((c.predicted_success as number) - (c.success ? 1 : 0)) ** 2, 0) / rated.length;
  const bins: CalibrationBin[] = [];
  for (const [lo, hi, label] of BIN_EDGES) {
    const inBin = rated.filter((c) => (c.predicted_success as number) >= lo && (c.predicted_success as number) < hi);
    if (inBin.length === 0) continue;
    bins.push({
      label,
      count: inBin.length,
      predicted: inBin.reduce((s, c) => s + (c.predicted_success as number), 0) / inBin.length,
      actual: inBin.filter((c) => c.success).length / inBin.length,
    });
  }
  return { sample: rated.length, brier, bins };
}
