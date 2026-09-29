import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, type Job } from '@/lib/supabase';
import {
  computeJobRisk,
  DECISION_COLORS,
  DECISION_LABELS,
  DEFAULT_RISK_POLICY,
  DIMENSION_LABELS,
  LEVEL_COLORS,
  LEVEL_LABELS,
  RISK_DIMENSIONS,
  type RiskLevel,
  type RiskPolicy,
  type RiskReport,
} from '@/lib/riskIntelligence';
import { buildRiskInputs, fetchRiskPolicy, saveRiskPolicy } from '@/lib/riskIntelligenceApi';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

interface Row {
  job: Job;
  report: RiskReport;
  technicianName: string | null;
}

type LevelFilter = 'all' | RiskLevel;

function formatWhen(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const centsToDollars = (c: number | null): string => (c === null ? '' : String(Math.round(c / 100)));

// ============================================================
// POLICY CARD
// ============================================================

function PolicyCard({
  policy,
  canEdit,
  onSave,
}: {
  policy: RiskPolicy;
  canEdit: boolean;
  onSave: (p: RiskPolicy) => Promise<void>;
}) {
  const [limit, setLimit] = useState(centsToDollars(policy.liabilityLimitCents));
  const [highValue, setHighValue] = useState(centsToDollars(policy.highValueJobCents));
  const [types, setTypes] = useState(policy.highRiskServiceTypes.join(', '));
  const [requireAck, setRequireAck] = useState(policy.requireAckForHighRisk);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setLimit(centsToDollars(policy.liabilityLimitCents));
    setHighValue(centsToDollars(policy.highValueJobCents));
    setTypes(policy.highRiskServiceTypes.join(', '));
    setRequireAck(policy.requireAckForHighRisk);
  }, [policy]);

  const handleSave = async () => {
    const limitNum = limit.trim() === '' ? null : Number(limit);
    const highNum = Number(highValue);
    if ((limitNum !== null && (!Number.isFinite(limitNum) || limitNum <= 0)) || !Number.isFinite(highNum) || highNum <= 0) {
      toast('Enter valid positive dollar amounts.', 'error');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        liabilityLimitCents: limitNum === null ? null : Math.round(limitNum * 100),
        highValueJobCents: Math.round(highNum * 100),
        highRiskServiceTypes: types
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        requireAckForHighRisk: requireAck,
      });
      toast('Risk policy saved.', 'success');
    } catch {
      toast('Could not save the risk policy.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <h2 className="text-sm font-semibold text-text-primary">Risk policy</h2>
      <p className="mt-0.5 text-xs text-text-secondary">
        Thresholds that drive coverage decisions. Leave the liability limit empty to disable the limit check.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-secondary">
          Max liability per job (USD)
          <input type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} disabled={!canEdit} placeholder="e.g. 5000" className={`${inputClass} mt-1`} />
        </label>
        <label className="text-xs text-text-secondary">
          High-value job threshold (USD)
          <input type="number" min={0} value={highValue} onChange={(e) => setHighValue(e.target.value)} disabled={!canEdit} className={`${inputClass} mt-1`} />
        </label>
      </div>
      <label className="mt-3 block text-xs text-text-secondary">
        Extra high-risk service types (comma separated)
        <input type="text" value={types} onChange={(e) => setTypes(e.target.value)} disabled={!canEdit} placeholder="e.g. tree removal, demolition" className={`${inputClass} mt-1`} />
      </label>
      <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-primary">
        <input type="checkbox" checked={requireAck} onChange={(e) => setRequireAck(e.target.checked)} disabled={!canEdit} className="mt-0.5 h-4 w-4 rounded border-border accent-accent" />
        <span>
          Require a manager acknowledgement before dispatching flagged jobs
          <span className="block text-xs text-text-secondary">
            Jobs with a “manager review”, “refer to insurer” or “hold” decision cannot move to en route / in progress until someone records a reason.
          </span>
        </span>
      </label>
      {canEdit && (
        <div className="mt-4 flex justify-end border-t border-border/60 pt-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save policy
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function RiskIntelligencePage() {
  const { isOwner, profile, teamMember, permissions } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canEdit = isOwner || permissions.can_manage_team;

  const [policy, setPolicy] = useState<RiskPolicy>({ ...DEFAULT_RISK_POLICY });
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<LevelFilter>('all');

  const load = useCallback(async () => {
    if (!ownerId) return;
    setLoading(true);
    setError(false);
    try {
      const [jobsRes, teamRes, loadedPolicy] = await Promise.all([
        supabase
          .from('jobs')
          .select('*')
          .eq('user_id', ownerId)
          .in('job_status', ['scheduled', 'en_route', 'in_progress'])
          .order('scheduled_datetime', { ascending: true, nullsFirst: false })
          .limit(60),
        supabase.from('team_members').select('id, member_name').eq('account_owner_id', ownerId),
        fetchRiskPolicy(ownerId),
      ]);
      if (jobsRes.error) throw jobsRes.error;

      const jobs = (jobsRes.data ?? []) as Job[];
      const names = new Map<string, string | null>(
        ((teamRes.data ?? []) as { id: string; member_name: string | null }[]).map((m) => [m.id, m.member_name]),
      );
      const { inputs } = await buildRiskInputs(jobs, ownerId, loadedPolicy);

      const built: Row[] = [];
      for (const job of jobs) {
        const i = inputs.get(job.id);
        if (!i) continue;
        built.push({
          job,
          report: computeJobRisk(i),
          technicianName: job.assigned_technician_id ? (names.get(job.assigned_technician_id) ?? null) : null,
        });
      }
      built.sort((a, b) => b.report.overallScore - a.report.overallScore);

      setPolicy(loadedPolicy);
      setRows(built);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSavePolicy = async (p: RiskPolicy) => {
    if (!ownerId) return;
    await saveRiskPolicy(ownerId, p);
    await load();
  };

  const stats = useMemo(
    () => ({
      total: rows.length,
      high: rows.filter((r) => r.report.overallLevel === 'high').length,
      insurer: rows.filter((r) => r.report.coverage.decision === 'refer_to_insurer').length,
      hold: rows.filter((r) => r.report.coverage.decision === 'hold').length,
    }),
    [rows],
  );

  const visible = useMemo(() => (filter === 'all' ? rows : rows.filter((r) => r.report.overallLevel === filter)), [rows, filter]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ShieldAlert size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Risk Intelligence</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Every upcoming job scored on property, technician, liability, parts and warranty risk — with a coverage decision before dispatch.
              </p>
            </div>
          </div>
          <Link to="/dashboard/jobs" className="focus-ring shrink-0 rounded-xl border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
            Open jobs
          </Link>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: 'Upcoming jobs assessed', value: stats.total },
            { label: 'High overall risk', value: stats.high },
            { label: 'Refer to insurer', value: stats.insurer },
            { label: 'On hold', value: stats.hold },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-border bg-bg-primary p-4">
              <p className="text-2xl font-bold text-text-primary">{s.value}</p>
              <p className="mt-0.5 text-xs text-text-secondary">{s.label}</p>
            </div>
          ))}
        </div>

        <div className="mt-6">
          <PolicyCard policy={policy} canEdit={canEdit} onSave={handleSavePolicy} />
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text-primary">Upcoming jobs by risk</h2>
          <div className="flex gap-1.5">
            {(['all', 'high', 'medium', 'low'] as LevelFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                }`}
              >
                {f === 'all' ? 'All' : LEVEL_LABELS[f]}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="mt-6 flex items-center justify-center gap-2 py-10 text-sm text-text-secondary">
            <Loader2 size={16} className="animate-spin" /> Assessing jobs…
          </div>
        ) : error ? (
          <div className="mt-4 rounded-xl border border-border bg-bg-primary p-6 text-center text-sm text-text-secondary">
            Could not load risk data.{' '}
            <button type="button" onClick={() => void load()} className="focus-ring text-accent hover:underline">
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-4 rounded-xl border border-border bg-bg-primary p-6 text-center text-sm text-text-secondary">
            {rows.length === 0 ? 'No upcoming jobs to assess.' : 'No jobs at this risk level.'}
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {visible.map(({ job, report, technicianName }) => (
              <li key={job.id} className="rounded-xl border border-border bg-bg-primary p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      {job.customer_name}
                      {job.service_type ? ` — ${job.service_type}` : ''}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {formatWhen(job.scheduled_datetime)} · {technicianName ?? 'Unassigned'}
                      {job.address ? ` · ${job.address}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${LEVEL_COLORS[report.overallLevel]}`}>
                      {LEVEL_LABELS[report.overallLevel]} · {report.overallScore}
                    </span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${DECISION_COLORS[report.coverage.decision]}`}>
                      {DECISION_LABELS[report.coverage.decision]}
                    </span>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {RISK_DIMENSIONS.map((d) => (
                    <span key={d} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_COLORS[report.dimensions[d].level]}`}>
                      {DIMENSION_LABELS[d].replace(' Risk', '')}: {LEVEL_LABELS[report.dimensions[d].level]}
                    </span>
                  ))}
                </div>
                {report.flags.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs text-text-secondary">
                    {report.flags.slice(0, 3).map((f, i) => (
                      <li key={`${f.code}-${i}`}>• {f.title}</li>
                    ))}
                    {report.flags.length > 3 && <li>+ {report.flags.length - 3} more in the job&apos;s Risk panel</li>}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardLayout>
  );
}
