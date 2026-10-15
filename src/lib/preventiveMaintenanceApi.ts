/**
 * Preventive Maintenance Command Center - data access.
 *
 * Reads ONLY existing sources (equipment, customers, equipment_maintenance_alerts, pfn_forecasts,
 * commercial_contracts, team_members, jobs, job_equipment, service_part_kits, inventory_parts,
 * inventory_locations, parts_availability) plus the two new tables pm_work_items / pm_settings.
 * Optional sources degrade gracefully (the queue still works without parts or contracts);
 * the core sources (equipment, customers, pm tables) fail loudly so the page never shows a half-truth.
 */

import { supabase } from '@/lib/supabase';
import type { Job, TeamMember } from '@/lib/supabase';
import {
  PM_DEFAULT_SETTINGS,
  addDaysIso,
  normalizeSettings,
  todayIso,
  type PmContract,
  type PmCustomer,
  type PmEquipment,
  type PmForecast,
  type PmKitLine,
  type PmLifecycleAlert,
  type PmLocation,
  type PmPart,
  type PmSettings,
  type PmSignalKind,
  type PmStockRow,
  type PmWorkItem,
} from '@/lib/preventiveMaintenance';

const CHUNK = 150;
const ACTIVE_JOB_STATUSES = ['scheduled', 'en_route', 'in_progress'];

export interface PmSnapshot {
  settings: PmSettings;
  equipment: PmEquipment[];
  customers: PmCustomer[];
  alerts: PmLifecycleAlert[];
  forecasts: PmForecast[];
  contracts: PmContract[];
  workItems: PmWorkItem[];
  technicians: TeamMember[];
  jobsByTechnician: Record<string, Pick<Job, 'scheduled_datetime'>[]>;
  lastTechnicianByEquipment: Record<string, string>;
  kits: PmKitLine[];
  parts: PmPart[];
  stock: PmStockRow[];
  locations: PmLocation[];
  /** Optional sources that failed to load; the page shows a quiet notice instead of failing. */
  degraded: string[];
}

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown; detail?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

async function optional<T>(name: string, degraded: string[], run: () => PromiseLike<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    degraded.push(name);
    return fallback;
  }
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export async function loadSnapshot(): Promise<PmSnapshot> {
  const degraded: string[] = [];

  const [equipmentRes, workItemsRes, settingsRes] = await Promise.all([
    supabase
      .from('equipment')
      .select(
        'id, customer_id, equipment_type, make, model, serial_number, install_date, warranty_expires_at, expected_lifespan_years, service_interval_months, last_service_date',
      )
      .eq('status', 'active')
      .limit(5000),
    supabase
      .from('pm_work_items')
      .select(
        'id, equipment_id, status, signals, priority_score, due_by, snoozed_until, job_id, technician_id, scheduled_at, assignment_status, parts_status, parts_detail, notified_at, notified_channel, notify_error, completed_at, dismissed_at',
      )
      .in('status', ['planned', 'scheduled', 'notified', 'snoozed', 'dismissed'])
      .limit(5000),
    supabase
      .from('pm_settings')
      .select('due_soon_days, risk_threshold, seasonal_enabled, hemisphere, default_visit_minutes')
      .maybeSingle(),
  ]);
  if (equipmentRes.error) throw equipmentRes.error;
  if (workItemsRes.error) throw workItemsRes.error;
  if (settingsRes.error) throw settingsRes.error;

  const equipment = (equipmentRes.data ?? []) as PmEquipment[];
  const settings = settingsRes.data
    ? normalizeSettings({ ...settingsRes.data, risk_threshold: Number(settingsRes.data.risk_threshold) } as Partial<PmSettings>)
    : { ...PM_DEFAULT_SETTINGS };
  const workItems = ((workItemsRes.data ?? []) as PmWorkItem[]).map((w) => ({
    ...w,
    signals: (Array.isArray(w.signals) ? w.signals : []) as PmSignalKind[],
    parts_detail: Array.isArray(w.parts_detail) ? w.parts_detail : [],
  }));

  const customerIds = [...new Set(equipment.map((e) => e.customer_id))];
  const customerRows = await Promise.all(
    chunked(customerIds).map(async (ids) => {
      const { data, error } = await supabase
        .from('customers')
        .select('id, name, phone, email, address, customer_type')
        .in('id', ids);
      if (error) throw error;
      return (data ?? []) as PmCustomer[];
    }),
  );
  const customers = customerRows.flat();

  const horizonStart = addDaysIso(todayIso(), -1);
  const horizonEnd = addDaysIso(todayIso(), 60);

  const [alerts, forecasts, contracts, technicians, jobs, lastTech, kits, parts, stock, locations] = await Promise.all([
    optional(
      'lifecycle alerts',
      degraded,
      async () => {
        const { data, error } = await supabase
          .from('equipment_maintenance_alerts')
          .select('id, equipment_id, risk_level, predicted_issue, recommended_action, predicted_service_due')
          .eq('is_dismissed', false)
          .limit(5000);
        if (error) throw error;
        return (data ?? []) as PmLifecycleAlert[];
      },
      [] as PmLifecycleAlert[],
    ),
    optional(
      'failure forecasts',
      degraded,
      async () => {
        const { data, error } = await supabase
          .from('pfn_forecasts')
          .select('id, equipment_id, probability, band, top_mode_label, horizon_days, status, exposure_cents, recommended')
          .in('status', ['open', 'handed_off'])
          .limit(5000);
        if (error) throw error;
        return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          ...(r as unknown as PmForecast),
          probability: Number(r.probability),
          exposure_cents: Number(r.exposure_cents),
        }));
      },
      [] as PmForecast[],
    ),
    optional(
      'maintenance contracts',
      degraded,
      async () => {
        const { data, error } = await supabase
          .from('commercial_contracts')
          .select('id, customer_id, contract_name, contract_type, status, start_date, end_date')
          .eq('contract_type', 'maintenance_contract')
          .in('status', ['active', 'expiring_soon'])
          .limit(2000);
        if (error) throw error;
        return (data ?? []) as PmContract[];
      },
      [] as PmContract[],
    ),
    optional(
      'technicians',
      degraded,
      async () => {
        const { data, error } = await supabase
          .from('team_members')
          .select('*')
          .eq('role', 'technician')
          .eq('dispatch_enabled', true);
        if (error) throw error;
        return (data ?? []) as TeamMember[];
      },
      [] as TeamMember[],
    ),
    optional(
      'technician workload',
      degraded,
      async () => {
        const { data, error } = await supabase
          .from('jobs')
          .select('assigned_technician_id, scheduled_datetime')
          .in('job_status', ACTIVE_JOB_STATUSES)
          .not('assigned_technician_id', 'is', null)
          .gte('scheduled_datetime', `${horizonStart}T00:00:00Z`)
          .lte('scheduled_datetime', `${horizonEnd}T23:59:59Z`)
          .limit(5000);
        if (error) throw error;
        return (data ?? []) as { assigned_technician_id: string; scheduled_datetime: string }[];
      },
      [] as { assigned_technician_id: string; scheduled_datetime: string }[],
    ),
    optional(
      'service history',
      degraded,
      async () => {
        const out: Record<string, { tech: string; at: string }> = {};
        const rows = await Promise.all(
          chunked(equipment.map((e) => e.id)).map(async (ids) => {
            const { data, error } = await supabase
              .from('job_equipment')
              .select('equipment_id, jobs!inner(assigned_technician_id, scheduled_datetime, job_status)')
              .in('equipment_id', ids)
              .eq('jobs.job_status', 'completed');
            if (error) throw error;
            return (data ?? []) as unknown as {
              equipment_id: string;
              jobs: { assigned_technician_id: string | null; scheduled_datetime: string | null } | { assigned_technician_id: string | null; scheduled_datetime: string | null }[] | null;
            }[];
          }),
        );
        for (const r of rows.flat()) {
          const j = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
          if (!j?.assigned_technician_id || !j.scheduled_datetime) continue;
          const cur = out[r.equipment_id];
          if (!cur || j.scheduled_datetime > cur.at) out[r.equipment_id] = { tech: j.assigned_technician_id, at: j.scheduled_datetime };
        }
        return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.tech]));
      },
      {} as Record<string, string>,
    ),
    optional(
      'part kits',
      degraded,
      async () => {
        const { data, error } = await supabase.from('service_part_kits').select('service_type, part_id, quantity').limit(5000);
        if (error) throw error;
        return (data ?? []) as PmKitLine[];
      },
      [] as PmKitLine[],
    ),
    optional(
      'parts catalog',
      degraded,
      async () => {
        const { data, error } = await supabase.from('inventory_parts').select('id, name, part_number').eq('active', true).limit(5000);
        if (error) throw error;
        return (data ?? []) as PmPart[];
      },
      [] as PmPart[],
    ),
    optional(
      'parts availability',
      degraded,
      async () => {
        const { data, error } = await supabase
          .from('parts_availability')
          .select('part_id, location_id, location_name, location_type, quantity_available')
          .limit(10000);
        if (error) throw error;
        return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          ...(r as unknown as PmStockRow),
          quantity_available: Number(r.quantity_available),
        }));
      },
      [] as PmStockRow[],
    ),
    optional(
      'inventory locations',
      degraded,
      async () => {
        const { data, error } = await supabase
          .from('inventory_locations')
          .select('id, name, location_type, assigned_technician_id')
          .eq('active', true);
        if (error) throw error;
        return (data ?? []) as PmLocation[];
      },
      [] as PmLocation[],
    ),
  ]);

  const jobsByTechnician: Record<string, Pick<Job, 'scheduled_datetime'>[]> = {};
  for (const j of jobs) {
    (jobsByTechnician[j.assigned_technician_id] ??= []).push({ scheduled_datetime: j.scheduled_datetime });
  }

  return {
    settings,
    equipment,
    customers,
    alerts,
    forecasts,
    contracts,
    workItems,
    technicians,
    jobsByTechnician,
    lastTechnicianByEquipment: lastTech,
    kits,
    parts,
    stock,
    locations,
    degraded,
  };
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface ScheduleVisitInput {
  equipmentId: string;
  scheduledAtIso: string;
  technicianId: string | null;
  durationMinutes: number;
  serviceType: string;
  signals: PmSignalKind[];
  priorityScore: number;
  dueBy: string | null;
  parts: { part_id: string; location_id: string; quantity: number }[];
  note: string;
}

export interface ScheduleVisitResult {
  work_item_id: string;
  job_id: string;
  assignment: { status?: string; technician_name?: string | null; reason?: string } | null;
  parts_status: 'none' | 'reserved' | 'partial' | 'backordered';
  parts: { part_id: string; location_id: string; quantity: number; status: 'reserved' | 'backordered' }[];
}

export async function scheduleVisit(input: ScheduleVisitInput): Promise<ScheduleVisitResult> {
  const { data, error } = await supabase.rpc('pm_schedule_visit', {
    p_equipment_id: input.equipmentId,
    p_scheduled_at: input.scheduledAtIso,
    p_technician_id: input.technicianId,
    p_duration_minutes: input.durationMinutes,
    p_service_type: input.serviceType,
    p_signals: input.signals,
    p_priority_score: input.priorityScore,
    p_due_by: input.dueBy,
    p_parts: input.parts,
    p_note: input.note,
  });
  if (error) throw error;
  return data as ScheduleVisitResult;
}

/** Insert or update the single ACTIVE work item for a unit (snooze / dismiss). Safe against a concurrent insert. */
async function upsertActiveItem(
  equipmentId: string,
  customerId: string | null,
  patch: Record<string, unknown>,
): Promise<void> {
  const findActive = async () => {
    const { data, error } = await supabase
      .from('pm_work_items')
      .select('id, status')
      .eq('equipment_id', equipmentId)
      .in('status', ['planned', 'snoozed'])
      .maybeSingle();
    if (error) throw error;
    return data as { id: string; status: string } | null;
  };

  const existing = await findActive();
  if (existing) {
    const { error } = await supabase.from('pm_work_items').update(patch).eq('id', existing.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('pm_work_items').insert({ equipment_id: equipmentId, customer_id: customerId, ...patch });
  if (!error) return;
  if ((error as { code?: string }).code === '23505') {
    const raced = await findActive();
    if (raced) {
      const { error: e2 } = await supabase.from('pm_work_items').update(patch).eq('id', raced.id);
      if (e2) throw e2;
      return;
    }
    throw new Error('This unit already has a scheduled visit. Cancel that job first.');
  }
  throw error;
}

export async function snoozeUnit(
  equipmentId: string,
  customerId: string | null,
  days: number,
  meta: { signals: PmSignalKind[]; priorityScore: number; dueBy: string | null },
): Promise<void> {
  await upsertActiveItem(equipmentId, customerId, {
    status: 'snoozed',
    snoozed_until: addDaysIso(todayIso(), Math.max(1, Math.min(180, days))),
    signals: meta.signals,
    priority_score: meta.priorityScore,
    due_by: meta.dueBy,
  });
}

export async function dismissUnit(
  equipmentId: string,
  customerId: string | null,
  meta: { signals: PmSignalKind[]; priorityScore: number; dueBy: string | null },
): Promise<void> {
  await upsertActiveItem(equipmentId, customerId, {
    status: 'dismissed',
    dismissed_at: new Date().toISOString(),
    signals: meta.signals,
    priority_score: meta.priorityScore,
    due_by: meta.dueBy,
  });
}

export async function savePmSettings(userId: string, settings: PmSettings): Promise<void> {
  const clean = normalizeSettings(settings);
  const { error } = await supabase
    .from('pm_settings')
    .upsert({ user_id: userId, ...clean, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

export interface NotifyResult {
  ok: boolean;
  channel?: 'sms' | 'email';
  message?: string;
  to?: string;
}

export async function notifyCustomer(args: {
  workItemId: string;
  channel?: 'sms' | 'email' | 'auto';
  message?: string;
  dryRun?: boolean;
  force?: boolean;
}): Promise<NotifyResult> {
  const { data, error } = await supabase.functions.invoke('pm-notify-customer', { body: args });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not reach the notification service. Try again.'));
  if (data?.error) throw new Error(String(data.error));
  return data as NotifyResult;
}
