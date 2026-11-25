/**
 * Segments = trade group x problem category.
 *
 * HONEST NOTE: in the current RRE data the category (hvac_cooling, plumbing_leak, ...) already implies the
 * trade, so "trade x category" is not richer than "category". The trade group is derived deterministically
 * from the category so the key stays stable if the engine later gains categories that share a trade.
 */
const TRADE_OF: Record<string, string> = {
  hvac_cooling: 'hvac',
  hvac_heating: 'hvac',
  plumbing_clog: 'plumbing',
  plumbing_leak: 'plumbing',
  water_heater: 'plumbing',
  electrical_power: 'electrical',
  appliance: 'appliance',
};

export function tradeGroupOf(category: string): string {
  return TRADE_OF[category] ?? 'other';
}

export function segmentKey(category: string | null | undefined): string {
  const c = typeof category === 'string' && category.trim() ? category.trim().toLowerCase().slice(0, 40) : 'unknown';
  return `${tradeGroupOf(c)}:${c}`;
}
