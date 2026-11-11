// supabase/functions/_shared/import-framework/testFixtures.ts — shared fixtures for the framework's tests.

import { createCsvAdapter } from "./adapters/csv.ts";
import { IMPORT_ENTITIES } from "./entities.ts";
import { createMemoryBackend, createMemorySink, createMemoryStore, createMemoryTargetDb } from "./memory.ts";
import type { MemoryBackend, MemoryTargetDb, StoreHooks } from "./memory.ts";
import type { MappingConfig, SourceAdapter } from "./types.ts";

export const CUSTOMERS_CSV = `ID,Name,Phone,Email,Type
c1,Ann Lee,(555) 123-4567,ann@example.com,Residential
c2,Bob Ray,555-222-3333,bob@example.com,Commercial
c3,Cy Dee,,cy@example.com,Residential
c4,Di Fox,555-444-5555,di@example.com,residential
`;
export const JOBS_CSV = `JobID,CustID,Customer,Amount,Status,When
j1,c1,Ann Lee,"$1,250.50",Done,2027-01-05 09:00
j2,c2,Bob Ray,300,Done,2027-01-06 10:30
j3,c1,Ann Lee,99.5,Booked,2027-02-01 08:00
`;

export const MAPPING: MappingConfig = {
  version: 1,
  source: "csv",
  options: { timezone: "UTC" },
  entities: {
    customers: {
      key: { from: "ID" },
      fields: {
        name: { from: "Name", required: true },
        phone: { from: "Phone", transforms: [{ op: "phone_e164" }] },
        email: { from: "Email", transforms: [{ op: "email" }] },
        customer_type: { from: "Type", transforms: [{ op: "enum", map: { residential: "residential", commercial: "commercial" } }] },
      },
    },
    jobs: {
      key: { from: "JobID" },
      fields: {
        customer_ref: { from: "CustID" },
        customer_name: { from: "Customer", required: true },
        invoice_amount: { from: "Amount", transforms: [{ op: "money" }] },
        job_status: { from: "Status", transforms: [{ op: "enum", map: { done: "completed", booked: "scheduled" } }] },
        scheduled_datetime: { from: "When", transforms: [{ op: "timestamp" }] },
      },
    },
  },
};

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface Kit {
  backend: MemoryBackend;
  target: MemoryTargetDb;
  clock: { t: number };
  now: () => number;
  adapter: (files?: Record<string, string>) => SourceAdapter;
  common: (tenant: string, adapter?: SourceAdapter, hooks?: StoreHooks) => {
    tenantId: string; actorId: string; scopeKey: string; adapter: SourceAdapter; mapping: MappingConfig; defs: typeof IMPORT_ENTITIES;
    sink: ReturnType<typeof createMemorySink>; store: ReturnType<typeof createMemoryStore>; now: () => number; sleep: () => Promise<void>; batchSize: number;
  };
}
export function createKit(): Kit {
  const backend = createMemoryBackend();
  const target = createMemoryTargetDb({ customers: ["phone", "email"] });
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  return {
    backend, target, clock, now,
    adapter: (files = { customers: CUSTOMERS_CSV, jobs: JOBS_CSV }) => createCsvAdapter(files),
    common: (tenant, adapter, hooks) => ({
      tenantId: tenant, actorId: `user-${tenant}`, scopeKey: "acme-2027", adapter: adapter ?? createCsvAdapter({ customers: CUSTOMERS_CSV, jobs: JOBS_CSV }),
      mapping: clone(MAPPING), defs: IMPORT_ENTITIES, sink: createMemorySink(target, tenant), store: createMemoryStore(backend, tenant, hooks), now, sleep: () => Promise.resolve(), batchSize: 2,
    }),
  };
}

/** Wraps an adapter so the fake clock advances `step` ms per page read (to trigger deadlines deterministically). */
export function ticking(a: SourceAdapter, clock: { t: number }, step = 1): SourceAdapter {
  return { ...a, entities: () => a.entities(), columns: (e) => a.columns(e), fingerprint: () => a.fingerprint(), read: (e, c, l) => { clock.t += step; return a.read(e, c, l); } };
}
