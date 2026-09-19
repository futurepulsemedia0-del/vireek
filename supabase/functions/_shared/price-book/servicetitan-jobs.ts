// ServiceTitan job write-back: find-or-create Customer + Location, then
// create a Job via the JPM v2 API. Unlike Jobber's Request object,
// ServiceTitan's Jobs API requires a businessUnitId and jobTypeId that are
// specific to each tenant's own ServiceTitan configuration — these are
// collected once at connect time (see price-book-connect-servicetitan) and
// stored on price_book_connections.
//
// VERIFY before production: endpoint paths, field names (`customers`,
// `locations`, `jobs`, `summary`, `priority`) against
// https://developer.servicetitan.io/ (CRM v2 + JPM v2 sections) — ServiceTitan
// evolves this API and the exact request/response shape should be confirmed
// against a live sandbox tenant before this touches real customers.

import { getServiceTitanToken, type ServiceTitanCredentials } from "./servicetitan.ts";

const ST_API_BASE = "https://api.servicetitan.io";

export interface ServiceTitanJobConfig extends ServiceTitanCredentials {
  st_business_unit_id: string;
  st_job_type_id: string;
}

export interface BookedJobForServiceTitan {
  customerName: string;
  customerPhone: string | null;
  serviceType: string | null;
  address: string | null;
  scheduledDatetime: string | null;
}

async function stFetch(token: string, appKey: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${ST_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "ST-App-Key": appKey,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`servicetitan_http_${res.status}_${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function findOrCreateCustomer(
  token: string,
  config: ServiceTitanJobConfig,
  job: BookedJobForServiceTitan,
): Promise<{ customerId: number; locationId: number }> {
  const base = `/crm/v2/tenant/${config.st_tenant_id}`;

  if (job.customerPhone) {
    const search = await stFetch(
      token,
      config.st_app_key,
      `${base}/customers?phone=${encodeURIComponent(job.customerPhone)}&pageSize=1`,
    );
    const existing = search?.data?.[0];
    if (existing?.id && existing?.locations?.[0]?.id) {
      return { customerId: existing.id, locationId: existing.locations[0].id };
    }
  }

  const created = await stFetch(token, config.st_app_key, `${base}/customers`, {
    method: "POST",
    body: JSON.stringify({
      name: job.customerName,
      type: "Residential",
      phoneSettings: job.customerPhone ? { phoneNumbers: [{ number: job.customerPhone, type: "Mobile" }] } : undefined,
      address: job.address ? { street: job.address } : undefined,
    }),
  });

  const customerId = created?.id;
  const locationId = created?.locations?.[0]?.id ?? created?.locationId;
  if (!customerId || !locationId) throw new Error("servicetitan_customer_create_incomplete");
  return { customerId, locationId };
}

/**
 * Creates a Job in ServiceTitan directly on the tenant's schedule (unlike
 * Jobber's Request-based push, ServiceTitan's Jobs API books straight in —
 * businessUnitId/jobTypeId already encode which crew/queue it belongs to).
 */
export async function createServiceTitanJob(
  config: ServiceTitanJobConfig,
  job: BookedJobForServiceTitan,
): Promise<{ externalId: string }> {
  const token = await getServiceTitanToken(config);
  const { customerId, locationId } = await findOrCreateCustomer(token, config, job);

  const summary = job.serviceType ? `${job.serviceType} — booked by Sarah` : "Booked by Sarah";
  const scheduledStart = job.scheduledDatetime ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const scheduledEnd = new Date(new Date(scheduledStart).getTime() + 2 * 60 * 60 * 1000).toISOString();

  const created = await stFetch(token, config.st_app_key, `/jpm/v2/tenant/${config.st_tenant_id}/jobs`, {
    method: "POST",
    body: JSON.stringify({
      customerId,
      locationId,
      businessUnitId: Number(config.st_business_unit_id),
      jobTypeId: Number(config.st_job_type_id),
      priority: "Normal",
      summary,
      appointments: [{ start: scheduledStart, end: scheduledEnd }],
    }),
  });

  const externalId = created?.id;
  if (!externalId) throw new Error("servicetitan_job_create_no_id");
  return { externalId: String(externalId) };
}
