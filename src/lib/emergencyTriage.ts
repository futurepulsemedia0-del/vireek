import { supabase } from '@/lib/supabase';

/**
 * Emergency Customer Self-Triage — client library.
 *
 * Implements the flow:
 *   Emergency → immediate safety instruction → severity → required trade
 *   → available technician → dispatch
 *
 * Severity/trade/dispatch are decided server-side by submit_emergency_triage()
 * (20261210000000_emergency_customer_triage.sql), which reuses the existing
 * emergency_priority_for_job() scorer. Safety instructions live HERE, as a
 * fixed lookup — never generated, never dependent on a network call — so
 * step one of the flow is instant and never wrong. See the migration's
 * header comment for the reasoning.
 */

export type HazardId = 'gas' | 'water' | 'electric' | 'smoke' | 'other';

export interface HazardOption {
  id: HazardId;
  label: string;
  /** Shown immediately when this hazard is selected — before submit. */
  safetyInstructions: string[];
  /** True if this hazard alone should already read as "get to safety first". */
  lifeSafety: boolean;
}

export const HAZARD_OPTIONS: HazardOption[] = [
  {
    id: 'gas',
    label: 'Gas smell',
    lifeSafety: true,
    safetyInstructions: [
      "Don't turn any light switches, appliances, or your phone on or off inside.",
      "Don't light a match, lighter, or anything else.",
      'Get everyone out of the building right now and leave doors open behind you.',
      'Once outside, call your gas utility\'s emergency line or 911.',
    ],
  },
  {
    id: 'smoke',
    label: 'Smoke',
    lifeSafety: true,
    safetyInstructions: [
      'Get everyone out of the building immediately.',
      "Don't stop to grab belongings.",
      'Once outside, call 911 if you see flames or smoke is getting worse.',
      "Don't go back in for any reason.",
    ],
  },
  {
    id: 'electric',
    label: 'Electrical (sparks, burning smell, no power)',
    lifeSafety: true,
    safetyInstructions: [
      'Stay away from the outlet, panel, or fixture involved.',
      'If it\'s safe to reach, switch off the breaker for that area at your electrical panel.',
      "Don't touch anything wet near an electrical source.",
      'If you see active sparking or fire, get out and call 911.',
    ],
  },
  {
    id: 'water',
    label: 'Water leak / flooding',
    lifeSafety: false,
    safetyInstructions: [
      'If you know where it is, shut off the main water valve.',
      'Move anything electrical away from the water.',
      "Don't step into standing water near outlets or appliances.",
    ],
  },
  {
    id: 'other',
    label: 'Something else',
    lifeSafety: false,
    safetyInstructions: [],
  },
];

export function getHazardOption(id: HazardId): HazardOption | undefined {
  return HAZARD_OPTIONS.find((h) => h.id === id);
}

/**
 * Merges safety instructions for every selected hazard, life-safety hazards
 * (leave-the-building situations) always shown first and never truncated.
 */
export function getImmediateSafetyInstructions(hazards: HazardId[]): string[] {
  const selected = HAZARD_OPTIONS.filter((h) => hazards.includes(h.id));
  const lifeSafety = selected.filter((h) => h.lifeSafety);
  const other = selected.filter((h) => !h.lifeSafety);
  const lines: string[] = [];
  [...lifeSafety, ...other].forEach((h) => {
    h.safetyInstructions.forEach((line) => {
      if (!lines.includes(line)) lines.push(line);
    });
  });
  return lines;
}

export function hasLifeSafetyHazard(hazards: HazardId[]): boolean {
  return HAZARD_OPTIONS.some((h) => hazards.includes(h.id) && h.lifeSafety);
}

export const STARTED_AT_OPTIONS: { id: string; label: string }[] = [
  { id: 'just_now', label: 'Just now' },
  { id: 'last_hour', label: 'Within the last hour' },
  { id: 'today', label: 'Earlier today' },
  { id: 'before_today', label: 'Yesterday or earlier' },
];

export interface EmergencyTriageAnswer {
  whatHappened: string;
  hazards: HazardId[];
  startedAt: string;
  photoPath?: string | null;
  audioPath?: string | null;
}

export interface EmergencyTriageResult {
  tier: 'critical' | 'high' | 'standard';
  requiredTrade: string | null;
  assigned: boolean;
  technicianName: string | null;
  submissionId: string;
}

/** Uploads to a bucket namespaced by the portal token — see the migration's storage policies. */
export async function uploadEmergencyMedia(token: string, file: File, kind: 'photo' | 'audio'): Promise<string> {
  const ext = file.name.split('.').pop() || (kind === 'photo' ? 'jpg' : 'webm');
  const path = `${token}/${kind}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('emergency-triage-media').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function submitEmergencyTriage(
  token: string,
  answer: EmergencyTriageAnswer,
): Promise<EmergencyTriageResult | null> {
  const { data, error } = await supabase.rpc('submit_emergency_triage', {
    p_token: token,
    p_what_happened: answer.whatHappened,
    p_hazards: answer.hazards,
    p_started_at: answer.startedAt,
    p_photo_path: answer.photoPath ?? null,
    p_audio_path: answer.audioPath ?? null,
  });
  if (error || !data) return null;
  return {
    tier: data.tier,
    requiredTrade: data.required_trade ?? null,
    assigned: Boolean(data.assigned),
    technicianName: data.technician_name ?? null,
    submissionId: data.submission_id,
  };
}
