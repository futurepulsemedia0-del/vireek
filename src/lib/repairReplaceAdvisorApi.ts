import { supabase, type Customer, type Equipment } from '@/lib/supabase';
import { fetchPassport, passportCodeForEquipment, passportUrl, type PassportEvent } from '@/lib/equipmentPassport';
import { runRebateAnalysis, type RebateRequest, type ReplacementOption } from '@/lib/rebateIntelligence';
import { fetchBrandSettings } from '@/lib/branding';
import type { ForecastSignal, RebateSummary, RepairEvent } from '@/lib/repairReplaceAdvisor';
import { buildRepairHistory, toForecastSignal, toRebateSummary, type ForecastRow, type JobEquipmentRow } from '@/lib/repairReplaceAdvisorInputs';

/**
 * I/O for the Repair-vs-Replace Advisor. Everything read here already exists in Vireek:
 *   equipment + customers            -> the unit and who owns it
 *   job_equipment + jobs             -> repair history with what the customer paid
 *   equipment passport (RPC)         -> repair events recorded by ANY contractor
 *   pfn_forecasts                    -> the Predictive Failure Network forecast
 *   rebate-intelligence (function)   -> incentives for the replacement option
 * Nothing is written. Optional sources fail soft: the advisor still runs and lists what is missing.
 */

export interface AdvisorContext {
  equipment: Equipment;
  customer: Pick<Customer, 'id' | 'name' | 'email' | 'phone' | 'address' | 'customer_type'> | null;
  history: RepairEvent[];
  forecast: ForecastSignal | null;
  passport: { code: string; url: string } | null;
  /** Sources that could not be read, for the data-gaps list. */
  unavailable: string[];
}

const EQUIPMENT_COLUMNS =
  'id, user_id, customer_id, room_id, equipment_type, make, model, serial_number, install_date, install_job_id, warranty_expires_at, warranty_notes, expected_lifespan_years, service_interval_months, last_service_date, notes, status, created_at, updated_at';

export async function fetchAdvisorEquipment(equipmentId: string): Promise<Equipment | null> {
  const { data, error } = await supabase.from('equipment').select(EQUIPMENT_COLUMNS).eq('id', equipmentId).maybeSingle();
  if (error) throw error;
  return (data as Equipment | null) ?? null;
}

async function fetchCustomer(customerId: string) {
  const { data } = await supabase.from('customers').select('id, name, email, phone, address, customer_type').eq('id', customerId).maybeSingle();
  return (data as AdvisorContext['customer']) ?? null;
}

async function fetchJobRepairRows(equipmentId: string): Promise<JobEquipmentRow[]> {
  const { data, error } = await supabase
    .from('job_equipment')
    .select('service_type, jobs(service_type, scheduled_datetime, job_status, invoice_amount)')
    .eq('equipment_id', equipmentId)
    .limit(200);
  if (error) throw error;
  // PostgREST returns the joined row as an object (many-to-one) but some typings say array.
  return ((data as unknown as { service_type: string | null; jobs: JobEquipmentRow['jobs'] | JobEquipmentRow['jobs'][] }[]) ?? []).map((r) => ({
    service_type: r.service_type,
    jobs: Array.isArray(r.jobs) ? (r.jobs[0] ?? null) : r.jobs,
  }));
}

async function fetchLatestForecast(equipmentId: string): Promise<ForecastSignal | null> {
  const { data, error } = await supabase
    .from('pfn_forecasts')
    .select('probability, horizon_days, band, confidence, calibrated, top_mode_label, modes, issued_at')
    .eq('equipment_id', equipmentId)
    .in('status', ['open', 'handed_off'])
    .order('issued_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return toForecastSignal(((data as unknown as ForecastRow[]) ?? [])[0] ?? null);
}

/** Loads everything the advisor knows about one machine. Only the equipment row is required. */
export async function loadAdvisorContext(equipmentId: string): Promise<AdvisorContext> {
  const equipment = await fetchAdvisorEquipment(equipmentId);
  if (!equipment) throw new Error('That equipment record was not found in your account.');
  const unavailable: string[] = [];

  const [customer, jobRows, passportCode, forecast] = await Promise.all([
    fetchCustomer(equipment.customer_id).catch(() => null),
    fetchJobRepairRows(equipmentId).catch(() => {
      unavailable.push('job history');
      return [] as JobEquipmentRow[];
    }),
    passportCodeForEquipment(equipmentId).catch(() => null),
    fetchLatestForecast(equipmentId).catch(() => {
      unavailable.push('predictive forecast');
      return null;
    }),
  ]);

  let events: PassportEvent[] = [];
  if (passportCode) {
    try {
      events = (await fetchPassport(passportCode)).events ?? [];
    } catch {
      unavailable.push('equipment passport history');
    }
  }

  return {
    equipment,
    customer,
    history: buildRepairHistory(jobRows, events),
    forecast,
    passport: passportCode ? { code: passportCode, url: passportUrl(passportCode) } : null,
    unavailable,
  };
}

/** Runs Rebate Intelligence for a single replacement option and reduces it for the advisor. Throws on failure. */
export async function analyzeReplacementRebates(req: Omit<RebateRequest, 'options'> & { option: ReplacementOption }): Promise<{ summary: RebateSummary; analysisId: string | null }> {
  const { option, ...rest } = req;
  const res = await runRebateAnalysis({ ...rest, options: [option] });
  const result = res.report.options.find((o) => o.key === option.key) ?? res.report.options[0];
  if (!result) throw new Error('Rebate Intelligence returned no result for this option.');
  return { summary: toRebateSummary(result, res.report, option.manufacturer_rebate_cents ?? 0), analysisId: res.analysisId };
}

/** The sender name the business set up for customer communication, used as the proposal's "prepared by". */
export async function fetchProposalBusinessName(ownerId: string): Promise<string | null> {
  try {
    return (await fetchBrandSettings(ownerId))?.email_sender_name?.trim() || null;
  } catch {
    return null;
  }
}
