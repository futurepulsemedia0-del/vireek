/** Trade Pack registry. Add a pack = add its manifest here + one row in `trade_packs`/`trade_log_types`. */

import { PEST_CONTROL_PACK } from './pestControl';
import { POOL_SERVICE_PACK } from './poolService';
import type { LogTypeDef, PackKey, TradePack } from './types';

export * from './types';
export * from './framework';
export { PEST_CONTROL_PACK, PEST_CREDENTIAL, PEST_RESTRICTED_CREDENTIAL, computeStockBalance, summarizeActivity } from './pestControl';
export { POOL_SERVICE_PACK, CHEM_RANGES, evaluateChemistry, langelierIndex, saturation, chemStatus } from './poolService';

export const TRADE_PACKS: TradePack[] = [PEST_CONTROL_PACK, POOL_SERVICE_PACK];

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
  return TRADE_PACKS.some((p) => p.key === v);
}
