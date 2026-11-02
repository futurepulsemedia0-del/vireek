/** Measured time-to-first-success: seconds from a key's creation to its first 2xx request. Pure. */
export interface KeyStamp {
  id: string;
  created_at: string;
}
export interface LogStamp {
  api_key_id: string;
  status: number;
  created_at: string;
}

export function timeToFirstSuccess(
  keys: readonly KeyStamp[],
  logs: readonly LogStamp[],
): { keyId: string; seconds: number } | null {
  let best: { keyId: string; seconds: number } | null = null;
  for (const key of keys) {
    const created = Date.parse(key.created_at);
    const first = logs
      .filter((l) => l.api_key_id === key.id && l.status >= 200 && l.status < 300)
      .map((l) => Date.parse(l.created_at))
      .filter((t) => Number.isFinite(t) && t >= created)
      .sort((a, b) => a - b)[0];
    if (first === undefined) continue;
    const seconds = Math.round((first - created) / 1000);
    if (!best || seconds < best.seconds) best = { keyId: key.id, seconds };
  }
  return best;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}
