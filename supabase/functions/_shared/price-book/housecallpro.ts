// Housecall Pro: static API key auth (Bearer token, generated per company in
// HCP Settings → API Keys) — no OAuth flow, unlike Jobber/ServiceTitan.
//
// VERIFY before production: base URL, endpoint paths (`/customers`, `/jobs`,
// `/company`), and field names against https://docs.housecallpro.com/ — this
// was written from documented conventions as of this assistant's last
// verified knowledge, without live access to re-check the current API
// reference.

const HCP_API_BASE = "https://api.housecallpro.com";

export interface HousecallProJob {
  customerName: string;
  customerPhone: string | null;
  serviceType: string | null;
  address: string | null;
  scheduledDatetime: string | null;
}

async function hcpFetch(apiKey: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${HCP_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`housecallpro_http_${res.status}_${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Used at connect time to confirm the API key is valid before saving it. */
export async function verifyHousecallProKey(apiKey: string): Promise<void> {
  await hcpFetch(apiKey, "/company");
}

async function findOrCreateCustomer(apiKey: string, job: HousecallProJob): Promise<string> {
  if (job.customerPhone) {
    const search = await hcpFetch(apiKey, `/customers?q=${encodeURIComponent(job.customerPhone)}`);
    const existing = search?.customers?.[0] ?? search?.data?.[0];
    if (existing?.id) return String(existing.id);
  }

  const [firstName, ...rest] = job.customerName.trim().split(/\s+/);
  const lastName = rest.join(" ") || "—";

  const created = await hcpFetch(apiKey, "/customers", {
    method: "POST",
    body: JSON.stringify({
      first_name: firstName || job.customerName,
      last_name: lastName,
      mobile_number: job.customerPhone ?? undefined,
      addresses: job.address ? [{ street: job.address }] : undefined,
    }),
  });

  const customerId = created?.id ?? created?.customer?.id;
  if (!customerId) throw new Error("housecallpro_customer_create_no_id");
  return String(customerId);
}

/** Creates a Job directly on the company's Housecall Pro schedule. */
export async function createHousecallProJob(
  apiKey: string,
  job: HousecallProJob,
): Promise<{ externalId: string }> {
  const customerId = await findOrCreateCustomer(apiKey, job);

  const scheduledStart = job.scheduledDatetime ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const scheduledEnd = new Date(new Date(scheduledStart).getTime() + 2 * 60 * 60 * 1000).toISOString();

  const created = await hcpFetch(apiKey, "/jobs", {
    method: "POST",
    body: JSON.stringify({
      customer_id: customerId,
      description: job.serviceType ? `${job.serviceType} — booked by Sarah` : "Booked by Sarah",
      schedule: { scheduled_start: scheduledStart, scheduled_end: scheduledEnd },
      address: job.address ? { street: job.address } : undefined,
    }),
  });

  const externalId = created?.id ?? created?.job?.id;
  if (!externalId) throw new Error("housecallpro_job_create_no_id");
  return { externalId: String(externalId) };
}
