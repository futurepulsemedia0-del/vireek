import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKLIST_PHASES, CHECKLIST_STEPS, MANUAL_STEP_IDS, evaluateChecklist } from './migrationChecklist';
import { buildValidationReport } from './migrationValidation';
import { CLEAN_JOBS, CLEAN_SNAPSHOT, MESSY_SNAPSHOT, job } from './migrationValidation.fixtures';

const appSource = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
const status = (s: ReturnType<typeof evaluateChecklist>, id: string) => s.steps.find((x) => x.id === id)?.status;

describe('checklist definition', () => {
  it('has unique ids, valid phases, and every phase has steps', () => {
    const ids = CHECKLIST_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of CHECKLIST_STEPS) expect(CHECKLIST_PHASES).toContain(s.phase);
    for (const p of CHECKLIST_PHASES) expect(CHECKLIST_STEPS.some((s) => s.phase === p)).toBe(true);
  });

  it('every linked screen is a real route in App.tsx', () => {
    for (const s of CHECKLIST_STEPS) {
      if (!s.href) continue;
      expect(appSource, `${s.id} → ${s.href}`).toContain(`path="${s.href}"`);
    }
  });

  it('every step id has an English title and body', () => {
    const en = JSON.parse(readFileSync(join(process.cwd(), 'src/locales/en/migration.json'), 'utf8')) as { steps: Record<string, { title?: string; body?: string }> };
    for (const s of CHECKLIST_STEPS) {
      expect(en.steps[s.id]?.title, s.id).toBeTruthy();
      expect(en.steps[s.id]?.body, s.id).toBeTruthy();
    }
  });
});

describe('evaluateChecklist', () => {
  it('starts at 0% with nothing done', () => {
    const s = evaluateChecklist(new Set(), null, [], 'jobber');
    expect(s.percent).toBe(0);
    expect(s.steps.every((x) => x.status === 'todo')).toBe(true);
  });

  it('marks manual steps from the saved set', () => {
    expect(status(evaluateChecklist(new Set(['freeze_window']), null, [], 'jobber'), 'freeze_window')).toBe('done');
  });

  it('derives import steps from finished jobs; ledger needs all three types', () => {
    const partial = evaluateChecklist(new Set(), null, CLEAN_JOBS.filter((j) => j.import_type !== 'payments'), 'jobber');
    expect(status(partial, 'import_customers')).toBe('done');
    expect(status(partial, 'import_ledger')).toBe('todo');
    expect(status(evaluateChecklist(new Set(), null, CLEAN_JOBS, 'jobber'), 'import_ledger')).toBe('done');
  });

  it('ignores another source’s imports', () => {
    expect(status(evaluateChecklist(new Set(), null, CLEAN_JOBS, 'service_titan'), 'import_customers')).toBe('todo');
  });

  it('a clean report with control totals completes the validation steps', () => {
    const report = buildValidationReport(CLEAN_SNAPSHOT, CLEAN_JOBS, { invoiceTotalCents: 12_000_050 });
    const s = evaluateChecklist(new Set(), report, CLEAN_JOBS, 'jobber');
    for (const id of ['validation_clean', 'review_duplicates', 'review_unmatched', 'money_reconciled']) expect(status(s, id), id).toBe('done');
  });

  it('money_reconciled stays todo until control totals are entered', () => {
    const s = evaluateChecklist(new Set(), buildValidationReport(CLEAN_SNAPSHOT, CLEAN_JOBS), CLEAN_JOBS, 'jobber');
    expect(status(s, 'money_reconciled')).toBe('todo');
  });

  it('flags attention for duplicates/unmatched and blocked for a money mismatch', () => {
    const messy = evaluateChecklist(new Set(), buildValidationReport(MESSY_SNAPSHOT, CLEAN_JOBS), CLEAN_JOBS, 'jobber');
    expect(status(messy, 'review_duplicates')).toBe('attention');
    expect(status(messy, 'review_unmatched')).toBe('attention');
    expect(status(messy, 'validation_clean')).toBe('attention');
    const off = evaluateChecklist(new Set(), buildValidationReport(CLEAN_SNAPSHOT, CLEAN_JOBS, { paymentsTotalCents: 1 }), CLEAN_JOBS, 'jobber');
    expect(status(off, 'money_reconciled')).toBe('blocked');
    expect(status(off, 'validation_clean')).toBe('blocked');
  });

  it('optional steps never hold back progress', () => {
    const all = new Set(MANUAL_STEP_IDS);
    const report = buildValidationReport(CLEAN_SNAPSHOT, CLEAN_JOBS, { invoiceTotalCents: 12_000_050 });
    const jobs = [...CLEAN_JOBS, job({ import_type: 'equipment', total_rows: 0 })].filter((j) => j.import_type !== 'equipment');
    expect(evaluateChecklist(all, report, jobs, 'jobber').percent).toBe(100);
  });
});
