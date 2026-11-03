// supabase/functions/_shared/voice/scopedClient.ts
//
// WHY THIS EXISTS
// Ask Vireek's loader (business-brain/loader.ts) reads calls/leads/quotes/invoices/customers WITHOUT an explicit
// user_id filter: it relies on Postgres RLS because it runs with the caller's JWT. A phone call has no JWT, so
// the voice function must use the service role, which BYPASSES RLS. Handing that client to the loader would read
// every tenant's rows. This wrapper makes the service role safe by construction:
//   - read-only: only `from(table).select(...)` exists (no insert/update/delete/rpc/storage/auth),
//   - every select is forced through `.eq(<owner column>, ownerId)`,
//   - fail closed: a table that is not in the allow-list throws instead of being read unscoped.
// Pure (structural typing only) so it is unit-tested with a fake builder.

/** table -> column that holds the account owner's id. Add a table here only after checking its schema. */
export const OWNER_COLUMN: Readonly<Record<string, string>> = {
  jobs: "user_id",
  calls: "user_id",
  leads: "user_id",
  quotes: "user_id",
  invoices: "user_id",
  customers: "user_id",
  on_call_schedules: "user_id",
  business_profile: "user_id",
  job_profitability: "user_id",
  revenue_recovery_events: "user_id",
  team_members: "account_owner_id",
};

// deno-lint-ignore no-explicit-any
type AnyBuilder = any;
export interface FromLike { from: (table: string) => AnyBuilder }

export class ScopeError extends Error {
  constructor(msg: string) { super(msg); this.name = "ScopeError"; }
}

export function scopedReadClient(admin: FromLike, ownerId: string): FromLike {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
    throw new ScopeError("scopedReadClient: ownerId must be a UUID");
  }
  return {
    from(table: string) {
      const col = Object.prototype.hasOwnProperty.call(OWNER_COLUMN, table) ? OWNER_COLUMN[table] : undefined;
      if (!col) throw new ScopeError(`scopedReadClient: table "${table}" is not allowed for voice reads`);
      const builder = admin.from(table);
      // Only `select` is exposed. Anything else is undefined, so `.update()/.insert()/.delete()/.rpc()` throw TypeError.
      return { select: (...args: unknown[]) => builder.select(...args).eq(col, ownerId) };
    },
  };
}
