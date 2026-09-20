import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Lock,
  GitBranch,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  ShieldAlert,
  Lightbulb,
  Users,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { supabase, Job, TeamMember, ReviewRequest } from '@/lib/supabase';
import { computeTechnicianPerformance } from '@/lib/technicianPerformance';
import {
  computeSkillGraph,
  getCoverageRisks,
  suggestTechniciansForJob,
  suggestGrowthPairing,
  type SkillGraph,
  type SkillLevel,
  type SkillNode,
  type AssignmentSuggestion,
} from '@/lib/technicianSkillGraph';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';

// ============================================================
// DISPLAY HELPERS
// ============================================================

const MAX_MATRIX_SERVICE_TYPES = 8;

function levelLabel(level: SkillLevel): string {
  switch (level) {
    case 'expert':
      return 'Expert';
    case 'proficient':
      return 'Proficient';
    case 'developing':
      return 'Developing';
    case 'novice':
      return 'Novice';
    default:
      return 'No data';
  }
}

function levelBadgeClasses(level: SkillLevel): string {
  switch (level) {
    case 'expert':
      return 'bg-success-500/10 text-success-500';
    case 'proficient':
      return 'bg-accent/10 text-accent';
    case 'developing':
      return 'bg-warning-500/10 text-warning-500';
    case 'novice':
      return 'bg-danger/10 text-danger';
    default:
      return 'bg-bg-tertiary text-text-secondary';
  }
}

function TrendIcon({ trend }: { trend: SkillNode['trend'] }) {
  if (trend === 'improving') return <TrendingUp size={13} className="text-success-500" />;
  if (trend === 'declining') return <TrendingDown size={13} className="text-danger" />;
  if (trend === 'steady') return <Minus size={13} className="text-text-secondary/60" />;
  return null;
}

// ============================================================
// MAIN PAGE
// ============================================================

export function TechnicianSkillGraphPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();

  const canAccess = isOwner || permissions.can_view_billing;

  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [allReviews, setAllReviews] = useState<ReviewRequest[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const [selectedTechnicianId, setSelectedTechnicianId] = useState<string | null>(null);
  const [assignmentServiceType, setAssignmentServiceType] = useState<string>('');

  const loadData = useCallback(async () => {
    if (!user || !canAccess) return;
    setDataLoading(true);
    try {
      const [techRes, jobsRes, reviewsRes] = await Promise.all([
        supabase.from('team_members').select('*').eq('role', 'technician').eq('invite_status', 'active'),
        supabase.from('jobs').select('*').not('assigned_technician_id', 'is', null),
        supabase.from('review_requests').select('*').not('rating', 'is', null),
      ]);
      if (techRes.error) throw techRes.error;
      setTechnicians((techRes.data as TeamMember[]) ?? []);
      setAllJobs((jobsRes.data as Job[]) ?? []);
      setAllReviews((reviewsRes.data as ReviewRequest[]) ?? []);
    } catch {
      // empty state below
    } finally {
      setDataLoading(false);
    }
  }, [user, canAccess]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const graph: SkillGraph = useMemo(
    () => computeSkillGraph(allJobs, allReviews, technicians),
    [allJobs, allReviews, technicians],
  );

  const coverageRisks = useMemo(() => getCoverageRisks(graph), [graph]);

  // Reuse Technician Performance OS's fleet aggregation (last 30 days) purely
  // for current utilization, so assignment suggestions account for who's
  // actually free right now, not just who's most skilled on paper.
  const utilizationByTechnician = useMemo(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    const perf = computeTechnicianPerformance(allJobs, allReviews, technicians, start, end);
    const map: Record<string, number | null> = {};
    for (const t of perf.byTechnician) map[t.technicianId] = t.utilizationRate;
    return map;
  }, [allJobs, allReviews, technicians]);

  const assignmentSuggestions: AssignmentSuggestion[] = useMemo(() => {
    if (!assignmentServiceType) return [];
    return suggestTechniciansForJob(assignmentServiceType, graph, { utilizationByTechnician });
  }, [assignmentServiceType, graph, utilizationByTechnician]);

  const matrixServiceTypes = graph.serviceTypes.slice(0, MAX_MATRIX_SERVICE_TYPES);

  const selectedTechnician = technicians.find((t) => t.id === selectedTechnicianId) ?? null;
  const selectedNodes = selectedTechnicianId
    ? [...(graph.nodesByTechnician.get(selectedTechnicianId) ?? [])].sort((a, b) => b.proficiencyScore - a.proficiencyScore)
    : [];
  const growthPairing = selectedTechnicianId ? suggestGrowthPairing(selectedTechnicianId, graph) : null;

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Skill Graph">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Skill Graph access is restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const hasData = technicians.length > 0 && graph.serviceTypes.length > 0;

  return (
    <DashboardLayout activeLabel="Skill Graph">
      <div className="mb-8 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <GitBranch size={22} className="text-accent" />
            Skill Graph & Coaching
          </h1>
          <p className="text-sm text-text-secondary">
            Recency-weighted proficiency per technician and service type, fleet coverage risk, and assignment suggestions.
          </p>
        </div>
      </div>

      {dataLoading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : !hasData ? (
        <EmptyState
          icon={GitBranch}
          title="Not enough job history yet"
          description="Once technicians have completed jobs with a service type set, their skill graph will show up here."
        />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            {/* Coverage risk */}
            {coverageRisks.length > 0 && (
              <Card className="p-6">
                <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
                  <ShieldAlert size={17} className="text-warning-500" />
                  Coverage risk
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  High-volume service types your fleet is thin on. Losing the wrong technician here would hurt.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {coverageRisks.map((risk) => (
                    <div key={risk.serviceType} className="rounded-xl border border-border/70 bg-bg-tertiary/40 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-text-primary">{risk.serviceType}</p>
                        <AlertTriangle size={14} className={risk.risk === 'no_coverage' ? 'text-danger' : 'text-warning-500'} />
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">
                        {risk.risk === 'no_coverage'
                          ? `No one is currently proficient (${risk.jobVolume} jobs booked).`
                          : `Only 1 technician is proficient (${risk.jobVolume} jobs booked).`}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Assignment suggestion tool */}
            <Card className="p-6">
              <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
                <Lightbulb size={17} className="text-accent" />
                Who should take this job?
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Pick a service type to get a ranked, explainable technician suggestion.
              </p>
              <select
                value={assignmentServiceType}
                onChange={(e) => setAssignmentServiceType(e.target.value)}
                className="focus-ring mt-4 w-full max-w-xs rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary sm:w-auto"
              >
                <option value="">Select a service type…</option>
                {graph.serviceTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>

              {assignmentServiceType && (
                <div className="mt-4 space-y-2">
                  {assignmentSuggestions.map((s, i) => (
                    <div
                      key={s.technicianId}
                      className="flex flex-col gap-2 rounded-xl border border-border/70 bg-bg-tertiary/30 p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-bg-tertiary text-[11px] font-bold text-text-secondary">
                            {i + 1}
                          </span>
                          <p className="text-sm font-semibold text-text-primary">{s.technicianName}</p>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${levelBadgeClasses(s.level)}`}>
                            {levelLabel(s.level)} · {s.score}
                          </span>
                        </div>
                        <ul className="mt-1.5 space-y-0.5 pl-8 text-xs text-text-secondary">
                          {s.reasoning.map((r, ri) => (
                            <li key={ri}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Skill matrix + technician detail */}
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <Card className="p-6">
                <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
                  <Users size={17} className="text-accent" />
                  Technicians
                </h2>
                <div className="mt-4 space-y-1.5">
                  {technicians.map((tech) => {
                    const nodes = graph.nodesByTechnician.get(tech.id) ?? [];
                    const expertCount = nodes.filter((n) => n.level === 'expert').length;
                    const proficientCount = nodes.filter((n) => n.level === 'proficient').length;
                    const isSelected = selectedTechnicianId === tech.id;
                    return (
                      <button
                        key={tech.id}
                        type="button"
                        onClick={() => setSelectedTechnicianId(tech.id)}
                        className={`focus-ring flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ${
                          isSelected
                            ? 'border-accent/40 bg-accent/5'
                            : 'border-border/70 bg-bg-tertiary/20 hover:border-accent/25'
                        }`}
                      >
                        <div>
                          <p className="text-sm font-semibold text-text-primary">
                            {tech.member_name || tech.member_email || 'Unnamed technician'}
                          </p>
                          <p className="text-xs text-text-secondary">
                            {expertCount} expert · {proficientCount} proficient skill{proficientCount === 1 ? '' : 's'}
                          </p>
                        </div>
                        <ChevronRight size={16} className="text-text-secondary/60" />
                      </button>
                    );
                  })}
                </div>
              </Card>

              <Card className="p-6">
                {!selectedTechnician ? (
                  <div className="flex h-full min-h-[200px] flex-col items-center justify-center text-center text-sm text-text-secondary">
                    Select a technician to see their full skill breakdown.
                  </div>
                ) : (
                  <div>
                    <h2 className="text-base font-semibold text-text-primary">
                      {selectedTechnician.member_name || selectedTechnician.member_email}
                    </h2>
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full min-w-[480px] text-sm">
                        <thead>
                          <tr className="border-b border-border/70 text-left text-xs text-text-secondary">
                            <th className="pb-2 font-medium">Service type</th>
                            <th className="pb-2 font-medium">Level</th>
                            <th className="pb-2 font-medium">Score</th>
                            <th className="pb-2 font-medium">FTF</th>
                            <th className="pb-2 font-medium">CSAT</th>
                            <th className="pb-2 font-medium">Trend</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedNodes.map((n) => (
                            <tr key={n.serviceType} className="border-b border-border/40 last:border-0">
                              <td className="py-2 pr-2 text-text-primary">{n.serviceType}</td>
                              <td className="py-2 pr-2">
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${levelBadgeClasses(n.level)}`}>
                                  {levelLabel(n.level)}
                                </span>
                              </td>
                              <td className="py-2 pr-2 text-text-primary">{n.level === 'no_data' ? '—' : n.proficiencyScore}</td>
                              <td className="py-2 pr-2 text-text-secondary">{n.firstTimeFixRate ?? '—'}</td>
                              <td className="py-2 pr-2 text-text-secondary">{n.csatAvg ?? '—'}</td>
                              <td className="py-2 pr-2">
                                <TrendIcon trend={n.trend} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {growthPairing && (
                      <div className="mt-5 rounded-xl border border-accent/25 bg-accent/5 p-4">
                        <div className="flex items-center gap-2">
                          <Lightbulb size={15} className="text-accent" />
                          <p className="text-sm font-semibold text-text-primary">Coaching suggestion</p>
                        </div>
                        <p className="mt-1 text-sm text-text-secondary">{growthPairing.reason}</p>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </div>

            {/* Fleet-wide matrix overview */}
            <Card className="p-6">
              <h2 className="text-base font-semibold text-text-primary">Fleet overview</h2>
              <p className="mt-1 text-sm text-text-secondary">Top {matrixServiceTypes.length} service types by volume.</p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border/70 text-left text-xs text-text-secondary">
                      <th className="py-2 pr-3 font-medium">Technician</th>
                      {matrixServiceTypes.map((type) => (
                        <th key={type} className="py-2 pr-3 font-medium">
                          {type}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {technicians.map((tech) => {
                      const nodes = graph.nodesByTechnician.get(tech.id) ?? [];
                      const byType = new Map(nodes.map((n) => [n.serviceType, n]));
                      return (
                        <tr key={tech.id} className="border-b border-border/40 last:border-0">
                          <td className="py-2 pr-3 font-medium text-text-primary">
                            {tech.member_name || tech.member_email || 'Unnamed'}
                          </td>
                          {matrixServiceTypes.map((type) => {
                            const n = byType.get(type);
                            return (
                              <td key={type} className="py-2 pr-3">
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${levelBadgeClasses(n?.level ?? 'no_data')}`}>
                                  {n && n.level !== 'no_data' ? n.proficiencyScore : '—'}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
