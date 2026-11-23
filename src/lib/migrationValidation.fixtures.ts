// Fixtures for the migration validation tests. Money is integer cents.
import type { ImportJobLite, MigrationSnapshot } from './migrationValidation';

export const job = (over: Partial<ImportJobLite> & Pick<ImportJobLite, 'import_type'>): ImportJobLite => ({
  id: `job-${over.import_type}`,
  source: 'jobber',
  status: 'completed',
  total_rows: 0,
  created_count: 0,
  updated_count: 0,
  skipped_count: 0,
  error_count: 0,
  warning_count: 0,
  created_at: '2029-03-01T10:00:00Z',
  ...over,
});

export const CLEAN_JOBS: ImportJobLite[] = [
  job({ import_type: 'customers', total_rows: 100, created_count: 90, updated_count: 8, skipped_count: 2 }),
  job({ import_type: 'jobs', total_rows: 400, created_count: 400 }),
  job({ import_type: 'invoices', total_rows: 380, created_count: 380 }),
  job({ import_type: 'line_items', total_rows: 900, created_count: 900 }),
  job({ import_type: 'payments', total_rows: 350, created_count: 350 }),
];

export const CLEAN_SNAPSHOT: MigrationSnapshot = {
  source: 'jobber',
  customers: { imported: 98, duplicate_groups_total: 0, duplicate_groups: [] },
  jobs: { imported: 400, unlinked_customer: 0, without_amount: 0, revenue_cents: 12_345_678 },
  invoices: { count: 380, unlinked_customer: 0, unlinked_job: 0, total_cents: 12_000_050, balance_cents: 150_025, totals_unverified: 0 },
  line_items: { count: 900 },
  payments: { count: 350, sum_cents: 11_850_025, unlinked_invoice: 0 },
  equipment: { count: 0 },
};

export const MESSY_SNAPSHOT: MigrationSnapshot = {
  ...CLEAN_SNAPSHOT,
  customers: {
    imported: 98,
    duplicate_groups_total: 1,
    duplicate_groups: [{ kind: 'name_address', size: 2, members: [{ id: 'c1', name: 'Ana Ruiz', imported: true }, { id: 'c2', name: 'ana  ruiz', imported: false }] }],
  },
  jobs: { imported: 400, unlinked_customer: 7, without_amount: 3, revenue_cents: 12_345_678 },
  invoices: { ...CLEAN_SNAPSHOT.invoices, unlinked_customer: 2, totals_unverified: 4 },
};
