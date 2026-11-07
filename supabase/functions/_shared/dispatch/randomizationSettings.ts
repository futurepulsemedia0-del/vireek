// Loads the per-business randomization settings. NEVER throws: any failure means "off" (legacy behaviour).
import { normalizeSettings, RANDOMIZATION_OFF, type RandomizationSettings } from './nearTieRandomization.ts';
import type { Db } from './rulesContext.ts';

export async function loadRandomizationSettings(db: Db, ownerId: string): Promise<RandomizationSettings> {
  try {
    const { data, error } = await db.from('dispatch_randomization_settings').select('enabled, epsilon, top_k, max_eta_delta_minutes, excluded_service_types, salt').eq('user_id', ownerId).limit(1);
    if (error) return RANDOMIZATION_OFF;
    return normalizeSettings(Array.isArray(data) ? data[0] : null);
  } catch {
    return RANDOMIZATION_OFF;
  }
}
