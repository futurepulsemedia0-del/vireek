/**
 * Living Digital Twin of a Property — /dashboard/customers/:customerId/sites/:siteId/twin
 *
 * One property, everything known about it in one place: its place in the
 * site hierarchy, every asset installed there, its full service history,
 * the failure patterns that history reveals, and the predictive
 * maintenance signals already computed for its equipment. Built entirely
 * on existing tables via src/lib/propertyTwin.ts — no new schema.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Building2,
  Wrench,
  AlertTriangle,
  Clock,
  Activity,
  DollarSign,
  ArrowLeft,
  Sparkles,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { formatSiteLocationLine, SITE_TYPE_LABELS } from '@/lib/siteHierarchy';
import { formatCents } from '@/lib/agentGovernance';
import {
  fetchPropertyTwin,
  serviceCountByEquipment,
  isRecurringFailure,
  isOverdueForService,
  isNearingEndOfLife,
  summarizeJobs,
  type PropertyTwin,
} from '@/lib/propertyTwin';

const RISK_STYLES: Record<string, string> = {
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-success-500/10 text-success-500',
};

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-2 flex items-center gap-2 text-text-secondary">{icon}<span className="text-xs font-medium">{label}</span></div>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}

export function PropertyDigitalTwinPage() {
  const { customerId, siteId } = useParams<{ customerId: string; siteId: string }>();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [twin, setTwin] = useState<PropertyTwin | null>(null);

  const load = useCallback(async () => {
    if (!customerId || !siteId) return;
    setLoading(true);
    try {
      setTwin(await fetchPropertyTwin(customerId, siteId));
    } catch {
      toast('Could not load the digital twin for this property.', 'error');
    } finally {
      setLoading(false);
    }
  }, [customerId, siteId, toast]);

  useEffect(() => { void load(); }, [load]);

  if (loading || !twin) {
    return <DashboardLayout activeLabel="Sites"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  if (!twin.site) {
    return (
      <DashboardLayout activeLabel="Sites">
        <div className="p-6"><p className="text-sm text-text-secondary">This property could not be found.</p></div>
      </DashboardLayout>
    );
  }

  const { site, equipment, jobs, jobEquipmentLinks, maintenanceAlerts } = twin;
  const summary = summarizeJobs(jobs);
  const counts = serviceCountByEquipment(jobEquipmentLinks);
  const alertsByEquipment = new Map(maintenanceAlerts.map((a) => [a.equipment_id, a]));

  return (
    <DashboardLayout activeLabel="Sites">
      <div className="space-y-6 p-6">
        <Link to={`/dashboard/customers/${customerId}/sites`} className="focus-ring flex w-fit items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
          <ArrowLeft size={12} /> Back to sites
        </Link>

        <div className="flex items-center gap-2">
          <Building2 className="text-cta" size={20} />
          <div>
            <p className="text-sm font-semibold text-text-primary">{site.name} — Digital Twin</p>
            <p className="text-xs text-text-secondary">
              {SITE_TYPE_LABELS[site.site_type]}
              {formatSiteLocationLine(site) ? ` · ${formatSiteLocationLine(site)}` : ''}
              {site.address ? ` · ${site.address}` : ''}
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={<Activity size={14} />} label="Service visits" value={String(summary.totalJobs)} />
          <StatCard icon={<DollarSign size={14} />} label="Lifetime revenue" value={formatCents(summary.totalRevenueCents)} />
          <StatCard icon={<Clock size={14} />} label="Last visit" value={summary.lastVisit ? new Date(summary.lastVisit).toLocaleDateString() : '—'} />
          <StatCard icon={<Wrench size={14} />} label="Equipment on site" value={String(equipment.length)} />
        </div>

        {/* Predictive signals — already-computed maintenance alerts, surfaced here in property context */}
        {maintenanceAlerts.length > 0 && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <div className="mb-3 flex items-center gap-2"><Sparkles size={16} className="text-cta" /><p className="text-sm font-semibold text-text-primary">Predicted issues</p></div>
            <div className="space-y-2">
              {maintenanceAlerts.map((a) => {
                const item = equipment.find((e) => e.id === a.equipment_id);
                return (
                  <div key={a.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-text-primary">{item ? `${item.make ?? ''} ${item.model ?? item.equipment_type}`.trim() : 'Equipment'}</p>
                      <p className="text-xs text-text-secondary">{a.predicted_issue}</p>
                      {a.recommended_action && <p className="text-xs text-text-secondary">→ {a.recommended_action}</p>}
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${RISK_STYLES[a.risk_level]}`}>{a.risk_level.toUpperCase()}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Equipment — the physical asset inventory of the property */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Equipment ({equipment.length})</p>
          {equipment.length === 0 ? (
            <p className="text-sm text-text-secondary">No equipment has been assigned to a room at this property yet.</p>
          ) : (
            <div className="space-y-2">
              {equipment.map((item) => {
                const recurring = isRecurringFailure(item.id, counts);
                const overdue = isOverdueForService(item);
                const eol = isNearingEndOfLife(item);
                return (
                  <div key={item.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-text-primary">{[item.make, item.model].filter(Boolean).join(' ') || item.equipment_type}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {recurring && <span className="rounded-full bg-danger-500/10 px-2 py-0.5 text-xs font-medium text-danger-500">Recurring failures ({counts.get(item.id)} visits)</span>}
                        {overdue && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-500">Overdue for service</span>}
                        {eol && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-500">Nearing end of life</span>}
                        {!recurring && !overdue && !eol && <span className="flex items-center gap-1 rounded-full bg-success-500/10 px-2 py-0.5 text-xs font-medium text-success-500"><CheckCircle2 size={11} /> Healthy</span>}
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {item.equipment_type}
                      {item.install_date ? ` · installed ${new Date(item.install_date).toLocaleDateString()}` : ''}
                      {item.last_service_date ? ` · last serviced ${new Date(item.last_service_date).toLocaleDateString()}` : ' · never serviced'}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Service history — the full timeline this twin is built from */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Service history ({jobs.length})</p>
          {jobs.length === 0 ? (
            <p className="text-sm text-text-secondary">No jobs recorded at this property yet.</p>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <div key={job.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text-primary">{job.service_type ?? 'Service visit'}</p>
                    <p className="text-xs text-text-secondary">{job.scheduled_datetime ? new Date(job.scheduled_datetime).toLocaleString() : 'Unscheduled'} · {job.job_status.replace('_', ' ')}</p>
                  </div>
                  {job.invoice_amount !== null && <span className="shrink-0 text-xs font-medium text-text-secondary">{formatCents(Math.round(job.invoice_amount * 100))}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {maintenanceAlerts.length === 0 && equipment.some((e) => isOverdueForService(e) || isNearingEndOfLife(e)) && (
          <div className="flex items-center gap-2 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4 text-sm text-warning-500">
            <AlertTriangle size={16} /> Some equipment above is overdue or aging, but has no predictive alert yet — check the Equipment Lifecycle page.
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
