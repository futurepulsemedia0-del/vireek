/** Trade Pack registry. Add a pack = add its manifest here + one row in `trade_packs`/`trade_log_types`. */

import { PEST_CONTROL_PACK } from './pestControl';
import { POOL_SERVICE_PACK } from './poolService';
import { LANDSCAPING_PACK } from './landscaping/manifest.ts';
import { SOLAR_PACK } from './solar';
import type { LogTypeDef, PackKey, TradePack } from './types';

export { LANDSCAPING_PACK, LANDSCAPING_FLAG, LANDSCAPING_ENTITLEMENT } from './landscaping/manifest.ts';
   /** Packs visible only behind a feature flag + account entitlement (never listed by default). */
   export const GATED_TRADE_PACKS: TradePack[] = [LANDSCAPING_PACK]; 
export * from './types';
export * from './framework';
export { PEST_CONTROL_PACK, PEST_CREDENTIAL, PEST_RESTRICTED_CREDENTIAL, computeStockBalance, summarizeActivity } from './pestControl';
export { POOL_SERVICE_PACK, CHEM_RANGES, evaluateChemistry, langelierIndex, saturation, chemStatus } from './poolService';
export type { ChemKey, ChemRange, ChemReadings, ChemStatus, ChemEvaluation, Saturation } from './poolService';
export * from './poolChemistry';
export * from './solar';
export * from './solarPipeline';
export * from './solarMonitoring';
export * from './solarFinancing';

... POOL_SERVICE_PACK, SOLAR_PACK];

export function getPack(key: string | null | undefined): TradePack | undefined {
  return TRADE_PACKS.find((p) => p.key === key);
}

export function packForIndustry(slug: string | null | undefined): TradePack | undefined {
  return TRADE_PACKS.find((p) => p.industrySlug === slug);
}

export function getLogType(pack: TradePack, entryType: string): LogTypeDef | undefined {
  return pack.logTypes.find((t) => t.key === entryType);
}

export function isPackKey(v: string): v is PackKey {
  return TRADE_PACKS.some((p) => p.key === v) || GATED_TRADE_PACKS.some((p) => p.key === v);
}
