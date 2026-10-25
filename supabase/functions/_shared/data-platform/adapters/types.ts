// supabase/functions/_shared/data-platform/adapters/types.ts
import type { DatasetKey } from "../catalog.ts";

export interface Check { name: string; ok: boolean; detail: string }

/** One warehouse. The runner owns batching, cursors and retries; adapters only execute. */
export interface WarehouseAdapter {
  /** Cheap, non-destructive probe: authenticates, reaches the schema/dataset, proves write access. */
  test(): Promise<Check[]>;
  /** Idempotent: create schema/dataset + tables, add new columns, write comments. */
  prepare(datasets: readonly DatasetKey[]): Promise<void>;
  /** Upsert by id. Rows are already transformed (catalog + meta columns). */
  upsert(dataset: DatasetKey, rows: Record<string, unknown>[]): Promise<void>;
  /** Mark rows of this account not written since `beforeIso` as deleted. */
  markDeleted(dataset: DatasetKey, accountId: string, beforeIso: string): Promise<void>;
  close(): Promise<void>;
}

export class AdapterError extends Error {
  constructor(message: string, public status: number | null = null) {
    super(message);
  }
}

export async function readJson(res: Response): Promise<Record<string, any>> {
  try {
    return (await res.json()) as Record<string, any>;
  } catch {
    return {};
  }
}
