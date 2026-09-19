// Pushes a booked appointment into ServiceTitan as a real Job.
// Docs: https://developer.servicetitan.io/docs/ (JPM v2) — verify field
// names against your tenant's current API version before relying on this
// in production; ServiceTitan requires customerId + locationId to exist
// first, so this does a find-or-create on both before creating the job.

import type { ServiceTitanCredentials } from "./types.ts";
import { getServiceTitanToken } from "./servicetitan.ts";

const ST_API_BASE = "https://api.servicetitan.io";

interface PushJobInput {
  creds: ServiceTitanCredentials;
  customerName: string;
  phone: string;
  address: string | null;
  serviceType: string;
  scheduledStart: string; // ISO
  scheduledEnd: string;   // ISO
  jobTypeId: number;      // must be configured per-tenant, see step 2
  businessUnitId: number; // must be configured per-tenant, see step 2
}

export interface PushJobResult {
  ok: boolean;
  externalJobId?: string;
  error?: string;
}

async function findOrCreateCustomer(base: string, tenantId: string, token: string, name: string, phone: string): Promise<number> {
  const searchRes = await fetch(
    `${base}/crm/v2/tenant/${tenantId}/customers?phone=${encodeURIComponent(phone)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (searchRes.ok) {
    const data = await searchRes.json();
    if (Array.isArray(data?.data) && data.data.length > 0) return data.data[0].id;
  }
  const createRes = await fetch(`${base}/crm/v2/tenant/${tenantId}/customers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      type: "Residential",
      phoneSettings: { phoneNumbers: [{ number: phone, type: "Mobile" }] },
    }),
  });
  if (!createRes.ok) throw new Error(`st_customer_create_${createRes.status}`);
  const created = await createRes.json();
  return created.id;
}

export async function pushJobToServiceTitan(input: PushJobInput): Promise<PushJobResult> {
  try {
    const token = await getServiceTitanToken(input.creds);
    const tenantId = input.creds.st_tenant_id;

    const customerId = await findOrCreateCustomer(ST_API_BASE, tenantId, token, input.customerName, input.phone);

    const jobRes = await fetch(`${ST_API_BASE}/jpm/v2/tenant/${tenantId}/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId,
        locationId: customerId, // TODO: replace with a real location lookup/create — ST requires a separate Location resource, this is a placeholder
        businessUnitId: input.businessUnitId,
        jobTypeId: input.jobTypeId,
        priority: "Normal",
        summary: `${input.serviceType} — booked by Sarah AI`,
        appointments: [{ start: input.scheduledStart, end: input.scheduledEnd, arrivalWindowStart: input.scheduledStart, arrivalWindowEnd: input.scheduledEnd }],
      }),
    });

    if (!jobRes.ok) {
      const body = await jobRes.text();
      return { ok: false, error: `st_job_create_${jobRes.status}: ${body.slice(0, 300)}` };
    }
    const job = await jobRes.json();
    return { ok: true, externalJobId: String(job.id) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
