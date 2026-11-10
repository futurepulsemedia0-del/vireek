/**
 * Pest Ops — product inventory usage deduction (pure).
 *
 * Units convert only inside one family (mass, volume, count). Crossing families (e.g. fl oz → lb)
 * needs a product density, which is deliberately NOT guessed: such usage is recorded as an
 * "unconvertible" movement with delta 0 so the gap is visible instead of silently wrong.
 * KEEP IN SYNC with public.pest_unit_factor() in 20290301000000_pest_ops_pack.sql.
 */

import type { ProductUnit } from '../types';

export type UnitFamily = 'mass' | 'volume' | 'count';

/** Factors to the family base unit (grams, millilitres, each). `oz` is WEIGHT, `fl_oz` is volume. */
const UNIT_TABLE: Record<ProductUnit, { family: UnitFamily; factor: number }> = {
  g: { family: 'mass', factor: 1 },
  kg: { family: 'mass', factor: 1000 },
  oz: { family: 'mass', factor: 28.349523125 },
  lb: { family: 'mass', factor: 453.59237 },
  ml: { family: 'volume', factor: 1 },
  l: { family: 'volume', factor: 1000 },
  fl_oz: { family: 'volume', factor: 29.5735295625 },
  qt: { family: 'volume', factor: 946.352946 },
  gal: { family: 'volume', factor: 3785.411784 },
  each: { family: 'count', factor: 1 },
};

export const STOCK_DECIMALS = 4;

export function roundStock(n: number): number {
  const f = 10 ** STOCK_DECIMALS;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function unitFamily(unit: string): UnitFamily | null {
  return (UNIT_TABLE as Record<string, { family: UnitFamily }>)[unit]?.family ?? null;
}

/** Converts `qty` between units of the same family; null when incompatible or unknown. */
export function convertQuantity(qty: number, from: string, to: string): number | null {
  if (!Number.isFinite(qty)) return null;
  const a = (UNIT_TABLE as Record<string, { family: UnitFamily; factor: number }>)[from];
  const b = (UNIT_TABLE as Record<string, { family: UnitFamily; factor: number }>)[to];
  if (!a || !b || a.family !== b.family) return null;
  return roundStock((qty * a.factor) / b.factor);
}

export type MovementKind = 'receipt' | 'usage' | 'adjustment' | 'count' | 'void_reversal';

export interface StockState {
  onHand: number;
  unit: ProductUnit;
  reorderPoint: number | null;
}

export interface UsageInput {
  /** Ledger entry id — becomes the idempotency key, so replays never double-deduct. */
  ledgerEntryId: string;
  amount: number;
  unit: string;
}

export interface DeductionPlan {
  /** False = nothing to apply (invalid amount). */
  ok: boolean;
  /** Signed change in the product's stock unit (negative for usage). */
  delta: number;
  newOnHand: number;
  idempotencyKey: string;
  /** Set when the usage could not be converted into the stock unit. */
  unconvertible: boolean;
  /** Stock went below zero: record anyway (never block a compliance record), flag for recount. */
  negative: boolean;
  lowStock: boolean;
}

export function usageKey(ledgerEntryId: string): string {
  return `usage:${ledgerEntryId}`;
}

export function voidKey(ledgerEntryId: string): string {
  return `void:${ledgerEntryId}`;
}

/** Plans the deduction for one application. Pure: the database applies it atomically under a row lock. */
export function planUsageDeduction(stock: StockState, usage: UsageInput): DeductionPlan {
  const idempotencyKey = usageKey(usage.ledgerEntryId);
  const lowCheck = (onHand: number) => stock.reorderPoint !== null && onHand <= stock.reorderPoint;

  if (!Number.isFinite(usage.amount) || usage.amount <= 0) {
    return { ok: false, delta: 0, newOnHand: stock.onHand, idempotencyKey, unconvertible: false, negative: stock.onHand < 0, lowStock: lowCheck(stock.onHand) };
  }
  const converted = convertQuantity(usage.amount, usage.unit, stock.unit);
  if (converted === null) {
    return { ok: true, delta: 0, newOnHand: stock.onHand, idempotencyKey, unconvertible: true, negative: stock.onHand < 0, lowStock: lowCheck(stock.onHand) };
  }
  const newOnHand = roundStock(stock.onHand - converted);
  return { ok: true, delta: -converted, newOnHand, idempotencyKey, unconvertible: false, negative: newOnHand < 0, lowStock: lowCheck(newOnHand) };
}

/** Reversal for a voided application: gives back exactly what usage took (same conversion). */
export function planVoidReversal(stock: StockState, usage: UsageInput): DeductionPlan {
  const p = planUsageDeduction(stock, usage);
  const delta = p.unconvertible || !p.ok ? 0 : -p.delta;
  const newOnHand = roundStock(stock.onHand + delta);
  return { ...p, delta, newOnHand, idempotencyKey: voidKey(usage.ledgerEntryId), negative: newOnHand < 0, lowStock: stock.reorderPoint !== null && newOnHand <= stock.reorderPoint };
}

export interface MovementRow {
  delta: number;
  idempotencyKey: string;
}

/** Replays movements, skipping repeated idempotency keys — what the UNIQUE index does in Postgres. */
export function replayMovements(opening: number, movements: MovementRow[]): number {
  const seen = new Set<string>();
  let bal = opening;
  for (const m of movements) {
    if (seen.has(m.idempotencyKey)) continue;
    seen.add(m.idempotencyKey);
    bal = roundStock(bal + m.delta);
  }
  return bal;
}
