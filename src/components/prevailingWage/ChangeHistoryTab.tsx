import { useCallback, useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { fetchAuditLog, type AuditEntry } from '@/lib/prevailingWageApi';
import { formatMoney } from '@/lib/prevailingWage';
import { Pill, SectionTitle } from './shared';

const TABLE_LABEL: Record<string, string> = {
  pw_wage_determinations: 'Wage table',
  pw_wage_rates: 'Rate',
  pw_overtime_rule_sets: 'Overtime rule set',
  pw_job_assignments: 'Job setup',
  pw_job_workers: 'Job worker',
  pw_worker_profiles: 'Worker profile',
};

const FIELD_LABEL: Record<string, string> = {
  base_rate_cents: 'base rate',
  fringe_cents: 'fringe',
  weekly_ot_after: 'weekly OT after',
  daily_ot_after: 'daily OT after',
  daily_dt_after: 'daily DT after',
  ot_multiplier: 'OT multiplier',
  dt_multiplier: 'DT multiplier',
  legal_review_status: 'legal review',
  classification: 'classification',
  fringe_plan_cents_per_hour: 'plan fringe',
  name: 'name',
  status: 'status',
};

const IGNORE = new Set(['updated_at', 'updated_by', 'created_at', 'created_by', 'legal_reviewed_at', 'locked_at']);

function show(key: string, v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (key.endsWith('_cents') || key.endsWith('_cents_per_hour')) return formatMoney(Number(v));
  return String(v);
}

function summarize(e: AuditEntry): string {
  const label = String((e.newData ?? e.oldData)?.classification ?? (e.newData ?? e.oldData)?.name ?? '');
  if (e.action === 'INSERT') return label ? `Added “${label}”` : 'Added';
  if (e.action === 'DELETE') return label ? `Deleted “${label}”` : 'Deleted';
  const changes: string[] = [];
  for (const [k, v] of Object.entries(e.newData ?? {})) {
    if (IGNORE.has(k) || !FIELD_LABEL[k]) continue;
    const before = e.oldData?.[k];
    if (JSON.stringify(before) !== JSON.stringify(v)) changes.push(`${FIELD_LABEL[k]}: ${show(k, before)} → ${show(k, v)}`);
  }
  const head = label ? `“${label}” ` : '';
  return changes.length ? `${head}${changes.join('; ')}` : `${head}updated`;
}

export function ChangeHistoryTab() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setRows(await fetchAuditLog(60));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <SkeletonCardList count={3} />;
  if (failed) return <EmptyStateError icon={History} onRetry={load} />;
  if (rows.length === 0) return <EmptyState icon={History} title="No changes recorded yet" description="Every change to a rate, rule or job setup is logged here with the old and new values." />;

  return (
    <Card className="p-4 sm:p-5">
      <SectionTitle hint="Most recent 60 changes to wage tables, rates, rules and setup.">Change history</SectionTitle>
      <ul className="divide-y divide-border/60">
        {rows.map((e) => (
          <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="text-text-primary">{summarize(e)}</p>
              <p className="text-xs text-text-secondary">{new Date(e.createdAt).toLocaleString('en-US')}</p>
            </div>
            <Pill>{TABLE_LABEL[e.tableName] ?? e.tableName}</Pill>
          </li>
        ))}
      </ul>
    </Card>
  );
}
