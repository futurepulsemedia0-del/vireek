// supabase/functions/_shared/import-framework/entities.ts
//
// Reference entity definitions: Vireek's existing customers and jobs tables, using the columns the
// current Import Wizard already writes (external_source/external_id included). Add an entity here
// (plus an allow-listed table in supabaseSink.ts) to make it importable — clients never name tables.

import type { EntityDefinitions, Issue } from "./types.ts";

// Same value sets the Import Wizard accepts (see data-import/upsert.ts).
const JOB_STATUSES = new Set(["scheduled", "en_route", "in_progress", "completed", "cancelled"]);
const INVOICE_STATUSES = new Set(["not_sent", "sent", "paid"]);

export const IMPORT_ENTITIES: EntityDefinitions = {
  customers: {
    name: "customers",
    table: "customers",
    matchKeys: ["phone", "email"],
    fields: {
      name: { type: "string", required: true, maxLength: 200 },
      phone: { type: "string", maxLength: 40 },
      email: { type: "string", maxLength: 254 },
      address: { type: "string", maxLength: 500 },
      notes: { type: "string", maxLength: 5000 },
      customer_type: { type: "string", maxLength: 20 },
    },
    validate: (v) => (v.customer_type !== undefined && v.customer_type !== "residential" && v.customer_type !== "commercial"
      ? [{ severity: "error", code: "CUSTOMER_TYPE_INVALID", field: "customer_type", message: "customer_type must map to residential or commercial (use an enum transform)." }]
      : []),
  },
  jobs: {
    name: "jobs",
    table: "jobs",
    dependsOn: ["customers"],
    references: { customer_ref: { entity: "customers", target: "customer_id" } },
    fields: {
      customer_name: { type: "string", required: true, maxLength: 200 },
      customer_phone: { type: "string", maxLength: 40 },
      service_type: { type: "string", maxLength: 200 },
      address: { type: "string", maxLength: 500 },
      scheduled_datetime: { type: "timestamp" },
      job_status: { type: "string", maxLength: 40 },
      invoice_amount: { type: "number", summable: true },
      invoice_status: { type: "string", maxLength: 40 },
    },
    validate: (v) => {
      const out: Issue[] = [];
      if (v.job_status !== undefined && !JOB_STATUSES.has(String(v.job_status))) out.push({ severity: "error", code: "JOB_STATUS_INVALID", field: "job_status", message: "job_status must map to scheduled, en_route, in_progress, completed or cancelled (use an enum transform)." });
      if (v.invoice_status !== undefined && !INVOICE_STATUSES.has(String(v.invoice_status))) out.push({ severity: "error", code: "INVOICE_STATUS_INVALID", field: "invoice_status", message: "invoice_status must map to not_sent, sent or paid (use an enum transform)." });
      return out;
    },
  },
};
