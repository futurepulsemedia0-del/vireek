/**
 * Presentation logic for the internal SOC 2 control dashboard (/staff/compliance-controls).
 * The rule that decides "fresh / overdue / failing" lives ONCE, in the SQL view
 * `compliance_control_status`; this file only sorts, summarises and exports what the view returns.
 *
 * READINESS tooling: nothing here is an attestation.
 */

export type ControlStatus = 'met' | 'partial' | 'missing';
export type EvidenceState = 'fresh' | 'overdue' | 'failing' | 'incomplete' | 'never' | 'not_applicable';
export type ControlCategory = 'security' | 'availability' | 'confidentiality';

export interface ControlRow {
  id: string;
  criteria: string[];
  category: ControlCategory;
  title: string;
  status: ControlStatus;
  owner_role: string;
  owner: string | null;
  frequency_days: number;
  collectors: string[];
  implementation: string[];
  gap: string;
  registry_version: string;
  last_evidence_at: string | null;
  oldest_evidence_at: string | null;
  next_due_at: string | null;
  evidence_state: EvidenceState;
}

export interface EvidenceRow {
  id: string;
  control_id: string;
  collector: string;
  collected_at: string;
  result: 'collected' | 'blocked' | 'error';
  outcome: 'pass' | 'fail' | 'info';
  sha256: string;
  storage_path: string | null;
  run_ref: string | null;
  source: 'ci' | 'edge' | 'manual';
}

/** States that need a human's attention (everything except fresh / not_applicable). */
export const ATTENTION_STATES: readonly EvidenceState[] = ['overdue', 'failing', 'incomplete', 'never'];

export const needsAttention = (c: ControlRow): boolean => ATTENTION_STATES.includes(c.evidence_state);

/** An item is "overdue" for the dashboard if evidence is stale, failing or was never collected. */
export const isOverdue = (c: ControlRow): boolean => needsAttention(c);

const STATE_RANK: Record<EvidenceState, number> = { failing: 0, overdue: 1, incomplete: 2, never: 3, fresh: 4, not_applicable: 5 };
const STATUS_RANK: Record<ControlStatus, number> = { missing: 0, partial: 1, met: 2 };

/** Worst first: attention states, then missing → partial → met, then id. Stable and pure. */
export function sortControls(rows: readonly ControlRow[]): ControlRow[] {
  return [...rows].sort(
    (a, b) => STATE_RANK[a.evidence_state] - STATE_RANK[b.evidence_state] || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.id.localeCompare(b.id),
  );
}

export interface Summary {
  total: number;
  byStatus: Record<ControlStatus, number>;
  byState: Record<EvidenceState, number>;
  needingAttention: number;
  unassignedOwners: number;
}

export function summarize(rows: readonly ControlRow[]): Summary {
  const byStatus: Record<ControlStatus, number> = { met: 0, partial: 0, missing: 0 };
  const byState: Record<EvidenceState, number> = { fresh: 0, overdue: 0, failing: 0, incomplete: 0, never: 0, not_applicable: 0 };
  let attention = 0;
  let unassigned = 0;
  for (const c of rows) {
    byStatus[c.status]++;
    byState[c.evidence_state]++;
    if (needsAttention(c)) attention++;
    if (!c.owner) unassigned++;
  }
  return { total: rows.length, byStatus, byState, needingAttention: attention, unassignedOwners: unassigned };
}

/** Neutralises spreadsheet formula injection and quotes RFC-4180 style. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEAD = ['control_id', 'criteria', 'category', 'title', 'declared_status', 'evidence_state', 'owner', 'proposed_owner_role', 'frequency_days', 'last_evidence_at', 'next_due_at', 'collectors', 'known_gap'];

/** Auditor export. Owner is blank (not invented) when nobody has been assigned. */
export function buildControlsCsv(rows: readonly ControlRow[]): string {
  const lines = [CSV_HEAD.join(',')];
  for (const c of sortControls(rows)) {
    lines.push(
      [c.id, c.criteria.join(' '), c.category, c.title, c.status, c.evidence_state, c.owner ?? '', c.owner_role, c.frequency_days, c.last_evidence_at ?? '', c.next_due_at ?? '', c.collectors.join(' '), c.gap]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function buildEvidenceIndexCsv(rows: readonly EvidenceRow[]): string {
  const head = ['evidence_id', 'control_id', 'collector', 'collected_at', 'result', 'outcome', 'sha256', 'storage_path', 'run_ref', 'source'];
  const lines = [head.join(',')];
  for (const e of rows) lines.push([e.id, e.control_id, e.collector, e.collected_at, e.result, e.outcome, e.sha256, e.storage_path ?? '', e.run_ref ?? '', e.source].map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Whole bundle as JSON with an explicit non-attestation notice. */
export function buildAuditorBundle(controls: readonly ControlRow[], evidence: readonly EvidenceRow[], generatedAt: Date): string {
  return JSON.stringify(
    {
      notice: 'Internal SOC 2 READINESS export. Not an attestation. Vireek holds no SOC 2 report. Raw evidence files are in the private compliance-evidence bucket; verify each against its sha256.',
      generatedAt: generatedAt.toISOString(),
      controls: sortControls(controls),
      evidenceIndex: evidence,
    },
    null,
    2,
  );
}
