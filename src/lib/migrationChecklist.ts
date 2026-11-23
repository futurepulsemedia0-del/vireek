// src/lib/migrationChecklist.ts
//
// The guided competitor-switching checklist: static step definitions + a pure evaluator.
// "auto" steps derive their state from the import history and the post-import validation report
// (migrationValidation.ts); "manual" steps are ticked by a person and persisted per account + source
// in migration_checklist_progress. Step ids are stable: they are DB keys and i18n keys
// (migration.steps.<id>.title / .body).

import { latestJobsByEntity, type ImportJobLite, type MigrationEntity, type MigrationSource, type ValidationReport } from './migrationValidation';

export type ChecklistPhase = 'prepare' | 'import' | 'validate' | 'cutover' | 'stabilize';
export const CHECKLIST_PHASES: readonly ChecklistPhase[] = ['prepare', 'import', 'validate', 'cutover', 'stabilize'];

export type StepStatus = 'done' | 'todo' | 'attention' | 'blocked';

export interface ChecklistStepDef {
  id: string;
  phase: ChecklistPhase;
  kind: 'auto' | 'manual';
  /** Optional steps never hold back the progress percentage. */
  optional?: boolean;
  /** In-app screen that completes or helps with the step. Must be a real route (enforced by a test). */
  href?: string;
}

export const CHECKLIST_STEPS: readonly ChecklistStepDef[] = [
  { id: 'export_data', phase: 'prepare', kind: 'manual', href: '/dashboard/imports' },
  { id: 'freeze_window', phase: 'prepare', kind: 'manual' },
  { id: 'control_totals', phase: 'prepare', kind: 'manual' },
  { id: 'invite_team', phase: 'prepare', kind: 'manual', href: '/dashboard/team' },
  { id: 'import_customers', phase: 'import', kind: 'auto', href: '/dashboard/imports' },
  { id: 'import_jobs', phase: 'import', kind: 'auto', href: '/dashboard/imports' },
  { id: 'import_ledger', phase: 'import', kind: 'auto', optional: true, href: '/dashboard/imports' },
  { id: 'import_equipment', phase: 'import', kind: 'auto', optional: true, href: '/dashboard/imports' },
  { id: 'connect_price_book', phase: 'import', kind: 'manual', href: '/dashboard/price-book' },
  { id: 'connect_accounting', phase: 'import', kind: 'manual', optional: true, href: '/dashboard/accounting' },
  { id: 'validation_clean', phase: 'validate', kind: 'auto' },
  { id: 'review_duplicates', phase: 'validate', kind: 'auto', href: '/dashboard/customers' },
  { id: 'review_unmatched', phase: 'validate', kind: 'auto', href: '/dashboard/imports' },
  { id: 'money_reconciled', phase: 'validate', kind: 'auto' },
  { id: 'spot_check', phase: 'validate', kind: 'manual', href: '/dashboard/jobs' },
  { id: 'phone_forwarding', phase: 'cutover', kind: 'manual', href: '/dashboard/phone-numbers' },
  { id: 'parallel_run', phase: 'cutover', kind: 'manual' },
  { id: 'cutover_day', phase: 'cutover', kind: 'manual' },
  { id: 'train_team', phase: 'stabilize', kind: 'manual', href: '/dashboard/learn' },
  { id: 'old_system_readonly', phase: 'stabilize', kind: 'manual' },
  { id: 'week1_review', phase: 'stabilize', kind: 'manual', href: '/dashboard/imports' },
];

export const STEP_IDS: ReadonlySet<string> = new Set(CHECKLIST_STEPS.map((s) => s.id));
export const MANUAL_STEP_IDS: ReadonlySet<string> = new Set(CHECKLIST_STEPS.filter((s) => s.kind === 'manual').map((s) => s.id));

export interface EvaluatedStep extends ChecklistStepDef { status: StepStatus }

export interface ChecklistState {
  steps: EvaluatedStep[];
  requiredTotal: number;
  requiredDone: number;
  percent: number;
}

const IMPORT_STEP_ENTITY: Record<string, MigrationEntity[]> = {
  import_customers: ['customers'],
  import_jobs: ['jobs'],
  import_ledger: ['invoices', 'line_items', 'payments'],
  import_equipment: ['equipment'],
};

function autoStatus(id: string, report: ValidationReport | null, jobs: ImportJobLite[], source: MigrationSource): StepStatus {
  const latest = latestJobsByEntity(jobs, source);
  const entities = IMPORT_STEP_ENTITY[id];
  if (entities) {
    // Ledger counts as done only when ALL three ledger types have a finished run — half a ledger reconciles to nothing.
    return entities.every((e) => latest[e]) ? 'done' : 'todo';
  }
  if (!report || report.verdict === 'not_started') return 'todo';
  const checks = report.checks;
  switch (id) {
    case 'validation_clean':
      return report.verdict === 'blocked' ? 'blocked' : report.verdict === 'review' ? 'attention' : 'done';
    case 'review_duplicates':
      return report.duplicateGroupsTotal > 0 ? 'attention' : 'done';
    case 'review_unmatched':
      return checks.filter((c) => c.group === 'unmatched').every((c) => c.status === 'pass') ? 'done' : 'attention';
    case 'money_reconciled': {
      const money = checks.filter((c) => c.group === 'money');
      if (money.some((c) => c.status === 'fail')) return 'blocked';
      if (!money.some((c) => c.status === 'pass' && c.id !== 'money.invoice_lines_dont_add_up')) return 'todo'; // no control totals entered
      return money.some((c) => c.status === 'warn') ? 'attention' : 'done';
    }
    default:
      return 'todo';
  }
}

export function evaluateChecklist(manualDone: ReadonlySet<string>, report: ValidationReport | null, jobs: ImportJobLite[], source: MigrationSource): ChecklistState {
  const steps: EvaluatedStep[] = CHECKLIST_STEPS.map((s) => ({
    ...s,
    status: s.kind === 'manual' ? (manualDone.has(s.id) ? 'done' : 'todo') : autoStatus(s.id, report, jobs, source),
  }));
  const required = steps.filter((s) => !s.optional);
  const requiredDone = required.filter((s) => s.status === 'done').length;
  return { steps, requiredTotal: required.length, requiredDone, percent: required.length ? Math.round((requiredDone / required.length) * 100) : 0 };
}
