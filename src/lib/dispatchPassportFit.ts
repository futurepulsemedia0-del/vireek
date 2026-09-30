/**
 * Dispatch x Technician Passport — client library.
 *
 * Turns passport skill/equipment confidence into a bounded dispatch score bonus.
 * Numbers come from public.dispatch_passport_fit(), which reuses the exact
 * confidence function behind the Technician Passport.
 */

import { supabase } from '@/lib/supabase';
import { skillLabel } from '@/lib/technicianIdentity';

export interface PassportFitRow {
  job_id: string;
  technician_id: string;
  service_key: string | null;
  service_confidence: number | null;
  service_jobs: number | null;
  equipment_key: string | null;
  equipment_confidence: number | null;
  equipment_jobs: number | null;
}

const SERVICE_MAX_BONUS = 12;
const SERVICE_MAX_PENALTY = 6;
const EQUIPMENT_MAX_BONUS = 8;
const EQUIPMENT_MAX_PENALTY = 4;

export async function fetchPassportFit(jobIds: string[]): Promise<PassportFitRow[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await supabase.rpc('dispatch_passport_fit', { p_job_ids: jobIds.slice(0, 200) });
  if (error) return [];
  return (data ?? []) as PassportFitRow[];
}

export function buildPassportFitMap(rows: PassportFitRow[]): Record<string, Record<string, PassportFitRow>> {
  const map: Record<string, Record<string, PassportFitRow>> = {};
  for (const r of rows) {
    (map[r.job_id] ??= {})[r.technician_id] = r;
  }
  return map;
}

/** 50% confidence is neutral; small samples are discounted so volume must be earned. */
function confidenceBonus(confidence: number | null, jobs: number | null, maxBonus: number, maxPenalty: number): number {
  if (confidence === null || !jobs || jobs <= 0) return 0;
  const weight = jobs >= 10 ? 1 : jobs >= 5 ? 0.7 : 0.35;
  const raw = ((confidence - 50) / 50) * maxBonus;
  const bounded = raw < 0 ? Math.max(raw, -maxPenalty) : Math.min(raw, maxBonus);
  return Math.round(bounded * weight);
}

export function passportFitBonus(fit: PassportFitRow | undefined): number {
  if (!fit) return 0;
  return (
    confidenceBonus(fit.service_confidence, fit.service_jobs, SERVICE_MAX_BONUS, SERVICE_MAX_PENALTY) +
    confidenceBonus(fit.equipment_confidence, fit.equipment_jobs, EQUIPMENT_MAX_BONUS, EQUIPMENT_MAX_PENALTY)
  );
}

function describe(kind: string, key: string, confidence: number, jobs: number): string {
  return `${confidence}% ${kind} confidence in ${skillLabel(key)} (${jobs} ${jobs === 1 ? 'job' : 'jobs'}${jobs < 5 ? ', provisional' : ''})`;
}

export function passportFitReasons(fit: PassportFitRow | undefined): string[] {
  if (!fit) return [];
  const reasons: string[] = [];
  if (fit.service_key && fit.service_confidence !== null && fit.service_jobs) {
    reasons.push(describe('skill', fit.service_key, fit.service_confidence, fit.service_jobs));
  }
  if (fit.equipment_key && fit.equipment_confidence !== null && fit.equipment_jobs) {
    reasons.push(describe('equipment', fit.equipment_key, fit.equipment_confidence, fit.equipment_jobs));
  }
  return reasons;
}

/** Single number shown on the dispatch chip: equipment confidence when known, else skill confidence. */
export function passportFitHeadline(fit: PassportFitRow | undefined): number | null {
  if (!fit) return null;
  if (fit.equipment_confidence !== null && fit.equipment_jobs) return fit.equipment_confidence;
  if (fit.service_confidence !== null && fit.service_jobs) return fit.service_confidence;
  return null;
}
