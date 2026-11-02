// supabase/functions/_shared/compliance/sweepBatches.ts
// Drives public.sweep_owned_rows in bounded batches until the work is done or maxBatches is reached.

export interface SweepRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface SweepParams {
  table: string;
  userId: string;
  dateColumn: string;
  cutoff: string;
  /** When set (non-empty), the PII columns are nulled instead of deleting rows. */
  pii?: string[];
  batchSize?: number;
  maxBatches?: number;
}

export async function sweepOwnedRows(client: SweepRpcClient, p: SweepParams): Promise<number> {
  const batchSize = p.batchSize ?? 5000;
  const maxBatches = p.maxBatches ?? 200;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { data, error } = await client.rpc("sweep_owned_rows", {
      p_table: p.table,
      p_user_id: p.userId,
      p_date_column: p.dateColumn,
      p_cutoff: p.cutoff,
      p_pii_columns: p.pii?.length ? p.pii : null,
      p_batch: batchSize,
    });
    if (error) throw new Error(`sweep_owned_rows(${p.table}): ${error.message}`);
    const n = typeof data === "number" ? data : Number(data);
    if (!Number.isFinite(n) || n < 0) throw new Error(`sweep_owned_rows(${p.table}): unexpected result`);
    total += n;
    if (n < batchSize) break;
  }
  return total;
}
