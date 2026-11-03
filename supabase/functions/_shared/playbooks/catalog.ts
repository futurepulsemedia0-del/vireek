// supabase/functions/_shared/playbooks/catalog.ts — the 12 shipped playbooks.
// Shipping a new playbook or editing one is a code change plus a `version` bump
// (same philosophy as workflowPlaybooks.ts and tradePlaybookCatalog.ts).
import { COLD_SNAP, HEATWAVE, HURRICANE_WILDFIRE, POST_STORM, WATER_DAMAGE } from './catalogWeather.ts';
import { FALL_FURNACE, HOLIDAY_HOURS, PEAK_OVERFLOW, SLOW_SEASON, SPRING_TUNE_UP } from './catalogSeasonal.ts';
import { GRAND_OPENING, VACATION_CLOSED } from './catalogOps.ts';
import type { Playbook, PlaybookKey } from './types.ts';

export const PLAYBOOKS: Playbook[] = [
  HEATWAVE, COLD_SNAP, POST_STORM, HURRICANE_WILDFIRE, HOLIDAY_HOURS, SPRING_TUNE_UP,
  FALL_FURNACE, WATER_DAMAGE, PEAK_OVERFLOW, SLOW_SEASON, VACATION_CLOSED, GRAND_OPENING,
];

export function findPlaybook(key: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.key === (key as PlaybookKey));
}
