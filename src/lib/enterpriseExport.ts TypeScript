/**
 * Enterprise / Workspace Data Export
 * ----------------------------------
 * Distinct from personal "Export my data" (accountData.ts).
 * Scope = entire account-owner workspace (all rows the owner can read via RLS),
 * not a single user's private slice. Owner-only. Intended for Business & Enterprise.
 *
 * Client-side only: same RLS path as personal export. Large workspaces may hit
 * the row cap; truncated tables are marked explicitly in the payload.
 */

import { supabase } from '@/lib/supabase';
import { exportToCsv, type CsvColumn } from '@/lib/csvExport';
import type { PlanId } from '@/lib/pricing';

export const ENTERPRISE_EXPORT_PLANS: PlanId[] = ['business', 'enterprise'];

export const ENTERPRISE_ROW_CAP = 50_000;
const PAGE_SIZE = 1_000;

export type EnterpriseDatasetId =
  | 'business_profile'
  | 'calls'
  | 'leads'
  | 'jobs'
  | 'team_members'
  | 'integrations'
  | 'ai_insights'
  | 'review_requests';

export interface EnterpriseDatasetDef {
  id: EnterpriseDatasetId;
  label: string;
  description: string;
  /** Tables with created_at support date filtering */
  dateFilterable: boolean;
}

export const ENTERPRISE_DATASETS: EnterpriseDatasetDef[] = [
  {
    id: 'business_profile',
    label: 'Business profile',
    description: 'Company settings, hours, and workspace config.',
    dateFilterable: false,
  },
  {
    id: 'calls',
    label: 'Calls',
    description: 'Call records, transcripts, summaries, sentiment.',
    dateFilterable: true,
  },
  {
    id: 'leads',
    label: 'Leads',
    description: 'Leads captured from calls and channels.',
    dateFilterable: true,
  },
  {
    id: 'jobs',
    label: 'Jobs',
    description: 'Booked and scheduled jobs.',
    dateFilterable: true,
  },
  {
    id: 'team_members',
    label: 'Team members',
    description: 'Invites, roles, and permission flags.',
    dateFilterable: true,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Connected CRM / field-service apps.',
    dateFilterable: true,
  },
  {
    id: 'ai_insights',
    label: 'AI insights',
    description: 'Generated insights and coaching signals.',
    dateFilterable: true,
  },
  {
    id: 'review_requests',
    label: 'Review requests',
    description: 'Outbound review request history.',
    dateFilterable: true,
  },
];

export type ExportFormat = 'json' | 'csv';

export interface EnterpriseExportOptions {
  datasets: EnterpriseDatasetId[];
  format: ExportFormat;
  dateFrom?: string; // YYYY-MM-DD inclusive
  dateTo?: string;   // YYYY-MM-DD inclusive
}

export interface DatasetResult {
  id: EnterpriseDatasetId;
  rowCount: number;
  truncated: boolean;
  rows: unknown[];
}

export interface EnterpriseExportBundle {
  meta: {
    export_type: 'workspace';
    exported_at: string;
    exported_by_user_id: string;
    exported_by_email: string | null;
    company_name: string | null;
    plan: PlanId | null;
    date_from: string | null;
    date_to: string | null;
    datasets_requested: EnterpriseDatasetId[];
    row_cap: number;
    note: string;
  };
  datasets: Record<string, DatasetResult | { truncated: true; note: string; rows: unknown[]; rowCount: number }>;
}

function endOfDayIso(dateYmd: string): string {
  return `${dateYmd}T23:59:59.999Z`;
}

function startOfDayIso(dateYmd: string): string {
  return `${dateYmd}T00:00:00.000Z`;
}

async function fetchWorkspaceTable(
  table: string,
  opts: { dateFilterable: boolean; dateFrom?: string; dateTo?: string },
): Promise<{ rows: unknown[]; truncated: boolean }> {
  const rows: unknown[] = [];
  let from = 0;

  while (rows.length < ENTERPRISE_ROW_CAP) {
    const to = from + PAGE_SIZE - 1;
    let q = supabase.from(table).select('*').range(from, to);

    if (opts.dateFilterable) {
      if (opts.dateFrom) q = q.gte('created_at', startOfDayIso(opts.dateFrom));
      if (opts.dateTo) q = q.lte('created_at', endOfDayIso(opts.dateTo));
    }

    // Prefer newest first when capped so the export is still useful.
    if (opts.dateFilterable) {
      q = q.order('created_at', { ascending: false });
    }

    const { data, error } = await q;
    if (error) throw new Error(`Could not export "${table}": ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const truncated = rows.length >= ENTERPRISE_ROW_CAP;
  return { rows: rows.slice(0, ENTERPRISE_ROW_CAP), truncated };
}

export function isEnterpriseExportEligible(plan: PlanId | null | undefined, isOwner: boolean): boolean {
  if (!isOwner) return false;
  if (!plan) return false;
  return ENTERPRISE_EXPORT_PLANS.includes(plan);
}

/**
 * Builds a full workspace export object (does not download).
 * Caller must already have verified owner + plan eligibility.
 */
export async function buildEnterpriseWorkspaceExport(
  options: EnterpriseExportOptions,
): Promise<EnterpriseExportBundle> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) throw new Error('No active session');

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, email, company_name, plan, role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) throw new Error(`Could not load profile: ${profileError.message}`);
  if (!profile || profile.role !== 'owner') {
    throw new Error('Workspace export is only available to the account owner.');
  }
  if (!isEnterpriseExportEligible(profile.plan as PlanId, true)) {
    throw new Error('Workspace export requires a Business or Enterprise plan.');
  }

  const selected = options.datasets.length
    ? options.datasets
    : ENTERPRISE_DATASETS.map((d) => d.id);

  const datasets: EnterpriseExportBundle['datasets'] = {};

  for (const id of selected) {
    const def = ENTERPRISE_DATASETS.find((d) => d.id === id);
    if (!def) continue;

    const { rows, truncated } = await fetchWorkspaceTable(id, {
      dateFilterable: def.dateFilterable,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
    });

    datasets[id] = {
      id,
      rowCount: rows.length,
      truncated,
      rows,
      ...(truncated
        ? {
            note: `Capped at ${ENTERPRISE_ROW_CAP} rows. Contact support for a full archive.`,
          }
        : {}),
    } as DatasetResult & { note?: string };
  }

  // Best-effort audit entry (ignore failures — RLS may be insert-restricted).
  try {
    await supabase.from('audit_log').insert({
      action: 'workspace_data_export',
      actor_email: profile.email ?? user.email ?? null,
      metadata: {
        format: options.format,
        datasets: selected,
        date_from: options.dateFrom ?? null,
        date_to: options.dateTo ?? null,
      },
    });
  } catch {
    /* non-blocking */
  }

  return {
    meta: {
      export_type: 'workspace',
      exported_at: new Date().toISOString(),
      exported_by_user_id: user.id,
      exported_by_email: profile.email ?? user.email ?? null,
      company_name: profile.company_name ?? null,
      plan: (profile.plan as PlanId) ?? null,
      date_from: options.dateFrom ?? null,
      date_to: options.dateTo ?? null,
      datasets_requested: selected,
      row_cap: ENTERPRISE_ROW_CAP,
      note:
        'This is a workspace-level export for the account owner. It is separate from the personal “Export my data” download under Security.',
    },
    datasets,
  };
}

export function downloadEnterpriseJson(bundle: EnterpriseExportBundle): void {
  const company = (bundle.meta.company_name || 'workspace')
    .replace(/[^\w\-]+/g, '-')
    .slice(0, 40);
  const date = bundle.meta.exported_at.slice(0, 10);
  const filename = `vireek-workspace-export-${company}-${date}.json`;

  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Flatten object rows into CSV columns (keys union of first N rows). */
function inferCsvColumns(rows: Record<string, unknown>[]): CsvColumn<Record<string, unknown>>[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 50)) {
    Object.keys(row).forEach((k) => keys.add(k));
  }
  // Prefer stable, useful order
  const preferred = ['id', 'created_at', 'updated_at', 'name', 'email', 'phone', 'status'];
  const ordered = [
    ...preferred.filter((k) => keys.has(k)),
    ...[...keys].filter((k) => !preferred.includes(k)).sort(),
  ];
  return ordered.map((key) => ({
    header: key,
    accessor: (row) => {
      const v = row[key];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v as string | number | boolean;
    },
  }));
}

/**
 * Downloads one CSV per selected dataset that has rows.
 * Browsers may block multiple rapid downloads — we space them slightly.
 */
export async function downloadEnterpriseCsv(bundle: EnterpriseExportBundle): Promise<number> {
  const company = (bundle.meta.company_name || 'workspace')
    .replace(/[^\w\-]+/g, '-')
    .slice(0, 40);
  const date = bundle.meta.exported_at.slice(0, 10);
  let files = 0;

  // Manifest first
  const manifestRows = Object.values(bundle.datasets).map((d) => ({
    dataset: d.id,
    row_count: d.rowCount,
    truncated: d.truncated,
  }));
  exportToCsv(
    manifestRows,
    [
      { header: 'dataset', accessor: (r) => r.dataset },
      { header: 'row_count', accessor: (r) => r.row_count },
      { header: 'truncated', accessor: (r) => r.truncated },
    ],
    `vireek-workspace-manifest-${company}-${date}.csv`,
  );
  files += 1;

  for (const result of Object.values(bundle.datasets)) {
    if (!result.rows.length) continue;
    const rows = result.rows as Record<string, unknown>[];
    const columns = inferCsvColumns(rows);
    await new Promise((r) => setTimeout(r, 350));
    exportToCsv(
      rows,
      columns,
      `vireek-workspace-${result.id}-${company}-${date}.csv`,
    );
    files += 1;
  }

  return files;
}

export async function runEnterpriseExport(
  options: EnterpriseExportOptions,
): Promise<{ format: ExportFormat; fileCount: number }> {
  const bundle = await buildEnterpriseWorkspaceExport(options);
  if (options.format === 'json') {
    downloadEnterpriseJson(bundle);
    return { format: 'json', fileCount: 1 };
  }
  const fileCount = await downloadEnterpriseCsv(bundle);
  return { format: 'csv', fileCount };
}
