import { supabase, Equipment, Job, EquipmentMaintenanceAlert } from '@/lib/supabase';
import { HierarchySite, flattenRoomsForPicker } from '@/lib/siteHierarchy';

/**
 * Living Digital Twin of a Property.
 *
 * Deliberately reads existing tables only — no new schema:
 *  - customer_sites / buildings / floors / rooms via the existing
 *    get_customer_site_hierarchy() RPC (src/lib/siteHierarchy.ts)
 *  - equipment.room_id already scopes an asset to a room inside a site
 *    (added by the multi-location hierarchy migration)
 *  - jobs.site_id already scopes a job to a site
 *  - job_equipment links a job to the specific asset it touched
 *  - equipment_maintenance_alerts already produces predictive signals
 *
 * This file just assembles those into one "twin" for a single property
 * and derives the patterns (recurring failures, overdue service,
 * end-of-life) client-side — no new Postgres functions to get wrong.
 */

export interface PropertyTwinJobLink {
  job_id: string;
  equipment_id: string;
  service_type: string | null;
}

export interface PropertyTwin {
  site: HierarchySite | null;
  equipment: Equipment[];
  jobs: Job[];
  jobEquipmentLinks: PropertyTwinJobLink[];
  maintenanceAlerts: EquipmentMaintenanceAlert[];
}

export async function fetchPropertyTwin(customerId: string, siteId: string): Promise<PropertyTwin> {
  const { data: hierarchyData, error: hierarchyError } = await supabase.rpc('get_customer_site_hierarchy', {
    p_customer_id: customerId,
  });
  if (hierarchyError) throw hierarchyError;

  const sites = (hierarchyData as HierarchySite[]) ?? [];
  const site = sites.find((s) => s.id === siteId) ?? null;
  const roomIds = site ? flattenRoomsForPicker([site]).map((r) => r.roomId) : [];

  const [equipmentRes, jobsRes] = await Promise.all([
    roomIds.length
      ? supabase.from('equipment').select('*').in('room_id', roomIds)
      : Promise.resolve({ data: [] as Equipment[], error: null }),
    supabase.from('jobs').select('*').eq('site_id', siteId).order('scheduled_datetime', { ascending: false }),
  ]);
  if (equipmentRes.error) throw equipmentRes.error;
  if (jobsRes.error) throw jobsRes.error;

  const equipment = (equipmentRes.data as Equipment[]) ?? [];
  const jobs = (jobsRes.data as Job[]) ?? [];
  const equipmentIds = equipment.map((e) => e.id);
  const jobIds = jobs.map((j) => j.id);

  const [linksRes, alertsRes] = await Promise.all([
    jobIds.length
      ? supabase.from('job_equipment').select('job_id, equipment_id, service_type').in('job_id', jobIds)
      : Promise.resolve({ data: [] as PropertyTwinJobLink[], error: null }),
    equipmentIds.length
      ? supabase
          .from('equipment_maintenance_alerts')
          .select('*')
          .in('equipment_id', equipmentIds)
          .eq('is_dismissed', false)
      : Promise.resolve({ data: [] as EquipmentMaintenanceAlert[], error: null }),
  ]);
  if (linksRes.error) throw linksRes.error;
  if (alertsRes.error) throw alertsRes.error;

  return {
    site,
    equipment,
    jobs,
    jobEquipmentLinks: (linksRes.data as PropertyTwinJobLink[]) ?? [],
    maintenanceAlerts: (alertsRes.data as EquipmentMaintenanceAlert[]) ?? [],
  };
}

// ---- Derived, pure (no fetching) — easy to unit test, easy to reuse ----

export function serviceCountByEquipment(links: PropertyTwinJobLink[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const link of links) counts.set(link.equipment_id, (counts.get(link.equipment_id) ?? 0) + 1);
  return counts;
}

/** 3+ visits tied to the same asset reads as a recurring-failure pattern, not one-off wear. */
export const RECURRING_FAILURE_THRESHOLD = 3;

export function isRecurringFailure(equipmentId: string, counts: Map<string, number>): boolean {
  return (counts.get(equipmentId) ?? 0) >= RECURRING_FAILURE_THRESHOLD;
}

export function isOverdueForService(item: Pick<Equipment, 'last_service_date' | 'service_interval_months' | 'install_date'>): boolean {
  const base = item.last_service_date ?? item.install_date;
  if (!base) return false;
  const due = new Date(base);
  due.setMonth(due.getMonth() + item.service_interval_months);
  return due.getTime() < Date.now();
}

/** Within a year of its expected lifespan, or already past it. */
export function isNearingEndOfLife(item: Pick<Equipment, 'install_date' | 'expected_lifespan_years'>): boolean {
  if (!item.install_date) return false;
  const eol = new Date(item.install_date);
  eol.setFullYear(eol.getFullYear() + item.expected_lifespan_years);
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  return eol.getTime() - Date.now() < oneYearMs;
}

export interface PropertyTwinSummary {
  totalJobs: number;
  completedJobs: number;
  totalRevenueCents: number;
  avgJobValueCents: number;
  lastVisit: string | null;
  firstVisit: string | null;
}

export function summarizeJobs(jobs: Job[]): PropertyTwinSummary {
  const completed = jobs.filter((j) => j.job_status === 'completed');
  // invoice_amount is stored in dollars (decimal), not cents — same convention as
  // src/lib/technicianPerformance.ts and src/lib/tradePlaybooks.ts.
  const revenue = completed.reduce((sum, j) => sum + Math.round((j.invoice_amount ?? 0) * 100), 0);
  const dated = jobs.filter((j) => j.scheduled_datetime).map((j) => j.scheduled_datetime as string);
  return {
    totalJobs: jobs.length,
    completedJobs: completed.length,
    totalRevenueCents: revenue,
    avgJobValueCents: completed.length ? Math.round(revenue / completed.length) : 0,
    lastVisit: dated.length ? dated.reduce((a, b) => (a > b ? a : b)) : null,
    firstVisit: dated.length ? dated.reduce((a, b) => (a < b ? a : b)) : null,
  };
}
