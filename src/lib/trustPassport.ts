/**
 * Technician Trust Passport — client library.
 *
 * Every field below comes from public.get_technician_trust_passport(),
 * a read-only SQL function with no backing writable table. There is no
 * "edit passport" function anywhere in this app on purpose — the only
 * way any of these numbers moves is a real job outcome changing.
 */

import { supabase } from '@/lib/supabase';

export interface TechnicianTrustPassport {
  technician_id: string;
  technician_name: string;
  certifications: string[];
  jobs_completed: number;
  first_time_fix_rate: number | null;
  callback_rate: number | null;
  customer_rating_avg: number | null;
  customer_rating_count: number;
  safety_compliance_rate: number | null;
  avg_margin_pct: number | null;
  verified_skill_count: number;
  unresolved_complaint_count: number;
  generated_at: string;
}

export async function fetchTrustPassports(windowDays = 90): Promise<TechnicianTrustPassport[]> {
  const { data, error } = await supabase.rpc('get_technician_trust_passport', {
    p_technician_id: null,
    p_window_days: windowDays,
  });
  if (error) throw error;
  return (data as TechnicianTrustPassport[]) ?? [];
}

export async function fetchTrustPassport(technicianId: string, windowDays = 90): Promise<TechnicianTrustPassport | null> {
  const { data, error } = await supabase.rpc('get_technician_trust_passport', {
    p_technician_id: technicianId,
    p_window_days: windowDays,
  });
  if (error) throw error;
  const rows = (data as TechnicianTrustPassport[]) ?? [];
  return rows[0] ?? null;
}

export function formatRate(v: number | null): string {
  return v === null ? '—' : `${v}%`;
}

export function rateColor(v: number | null, goodAbove: number): string {
  if (v === null) return 'text-text-secondary';
  if (v >= goodAbove) return 'text-success-500';
  if (v >= goodAbove - 15) return 'text-warning-500';
  return 'text-danger';
}
