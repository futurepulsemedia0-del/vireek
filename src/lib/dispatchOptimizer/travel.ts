import { estimateTravelMinutes, type GeoPoint } from '../dispatchIntelligence.ts';
import type { TravelFn } from './types.ts';

export function haversineTravel(): TravelFn {
  return (a: GeoPoint, b: GeoPoint): number | null => {
    const r = estimateTravelMinutes(a, b);
    return r ? r.minutes : null;
  };
}

export interface TravelProvider {
  matrix(pairs: Array<[GeoPoint, GeoPoint]>): Promise<Array<number | null>>;
}

export async function buildTravelFn(
  points: GeoPoint[],
  provider?: TravelProvider | null,
): Promise<TravelFn> {
  const fallback = haversineTravel();
  if (!provider || points.length < 2) return fallback;
  const key = (p: GeoPoint) => `${p.lat},${p.lng}`;
  const pairs: Array<[GeoPoint, GeoPoint]> = [];
  for (const a of points) for (const b of points) if (a !== b) pairs.push([a, b]);
  try {
    const out = await provider.matrix(pairs);
    const table = new Map<string, number>();
    pairs.forEach(([a, b], i) => {
      const v = out[i];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) table.set(`${key(a)}|${key(b)}`, v);
    });
    return (a, b) => table.get(`${key(a)}|${key(b)}`) ?? fallback(a, b);
  } catch {
    return fallback;
  }
}
