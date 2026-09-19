// Write-back layer: pushes a job Sarah just booked into whichever external
// CRM the tenant has connected (Jobber today; ServiceTitan and Housecall Pro
// land in the next two phases — job_external_syncs.provider is already sized
// for all three). This is what turns Vireek from "answers the phone and
// emails someone" into "books directly into the CRM you already run your
// business on."
//
// Called from vapi-webhook's toolBookAppointment right after the internal
// `jobs` row is inserted. Never throws — a failed push must never break the
// call or the internal booking; it's recorded in job_external_syncs so the
// dashboard can surface it and a human can finish the booking by hand.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { refreshJobberTokenIfNeeded } from "../price-book/jobber.ts";
import { createServiceTitanJob, type ServiceTitanJobConfig } from "../price-book/servicetitanJobs.ts";
import { createHousecallProJob } from "../price-book/housecallpro.ts";

export interface BookedJobForSync {
  id: string;
  customerName: string;
  customerPhone: string | null;
  serviceType: string | null;
  address: string | null;
  scheduledDatetime: string | null;
}

interface PriceBookConnectionRow {
  provider: string;
  status: string;
  jobber_access_token: string | null;
  jobber_refresh_token: string | null;
  jobber_token_expires_at: string | null;
  st_client_id: string | null;
  st_client_secret: string | null;
  st_app_key: string | null;
  st_tenant_id: string | null;
  st_business_unit_id: string | null;
  st_job_type_id: string | null;
  hcp_api_key: string | null;
}

const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
const JOBBER_API_VERSION = "2025-04-16";

async function recordSyncResult(
  admin: SupabaseClient,
  userId: string,
  jobId: string,
  provider: "jobber" | "service_titan" | "housecall_pro",
  result: { status: "synced" | "error" | "not_connected"; externalId?: string; externalType?: string; error?: string },
) {
  await admin.from("job_external_syncs").upsert(
    {
      user_id: userId,
      job_id: jobId,
      provider,
      status: result.status,
      external_id: result.externalId ?? null,
      external_type: result.externalType ?? null,
      error_message: result.error ?? null,
      synced_at: result.status === "synced" ? new Date().toISOString() : null,
    },
    { onConflict: "job_id,provider" },
  );
}

async function jobberGraphQL(accessToken: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(JOBBER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`jobber_graphql_http_${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`jobber_graphql_error_${json.errors[0]?.message ?? "unknown"}`);
  return json.data;
}

async function findOrCreateJobberClient(
  accessToken: string,
  customerName: string,
  customerPhone: string | null,
): Promise<string> {
  if (customerPhone) {
    const searchData = await jobberGraphQL(
      accessToken,
      `query FindClient($phone: String!) {
        clients(searchTerm: $phone, first: 1) {
          nodes { id }
        }
      }`,
      { phone: customerPhone },
    );
    const existingId = searchData?.clients?.nodes?.[0]?.id;
    if (existingId) return String(existingId);
  }

  const [firstName, ...rest] = customerName.trim().split(/\s+/);
  const lastName = rest.join(" ") || "—";

  const createData = await jobberGraphQL(
    accessToken,
    `mutation CreateClient($input: ClientCreateInput!) {
      clientCreate(input: $input) {
        client { id }
        userErrors { message }
      }
    }`,
    {
      input: {
        firstName: firstName || customerName,
        lastName,
        phones: customerPhone ? [{ number: customerPhone, description: "MAIN" }] : [],
      },
    },
  );

  const userErrors = createData?.clientCreate?.userErrors;
  if (userErrors?.length) throw new Error(`jobber_client_create_${userErrors[0]?.message ?? "unknown"}`);
  const clientId = createData?.clientCreate?.client?.id;
  if (!clientId) throw new Error("jobber_client_create_no_id");
  return String(clientId);
}

/**
 * Creates a Jobber "Request" — the object that lands in the contractor's
 * Jobber inbox tied to a real client, ready to convert into a quote/job.
 * Deliberately a Request rather than a Job: Jobber's jobCreate mutation
 * expects a quote/line-item context an inbound phone booking doesn't have,
 * and a bare Request is exactly what a human front-desk booking creates too
 * — nothing is lost, and dispatch still reviews it before it hits Jobber's
 * own calendar.
 *
 * VERIFY before production: `ClientCreateInput` and `RequestCreateInput`
 * field names against the current Jobber GraphQL schema (GraphiQL explorer
 * at https://developer.getjobber.com/docs/) — Jobber versions its API by
 * date header and these shapes can change between versions.
 */
async function pushJobToJobber(
  admin: SupabaseClient,
  userId: string,
  connection: PriceBookConnectionRow,
  job: BookedJobForSync,
): Promise<void> {
  try {
    let accessToken = connection.jobber_access_token ?? "";
    if (!accessToken) throw new Error("jobber_not_connected");

    const refreshed = await refreshJobberTokenIfNeeded({
      access_token: accessToken,
      refresh_token: connection.jobber_refresh_token ?? "",
      expires_at: connection.jobber_token_expires_at,
    });
    if (refreshed) {
      accessToken = refreshed.access_token;
      await admin
        .from("price_book_connections")
        .update({
          jobber_access_token: refreshed.access_token,
          jobber_refresh_token: refreshed.refresh_token,
          jobber_token_expires_at: refreshed.expires_at,
        })
        .eq("user_id", userId)
        .eq("provider", "jobber");
    }

    const clientId = await findOrCreateJobberClient(accessToken, job.customerName, job.customerPhone);

    const title = job.serviceType ? `${job.serviceType} — booked by Sarah` : "Booked by Sarah";
    const details = [
      job.address ? `Address: ${job.address}` : null,
      job.scheduledDatetime ? `Requested time: ${new Date(job.scheduledDatetime).toLocaleString()}` : null,
      "Source: Vireek AI receptionist",
    ].filter(Boolean).join("\n");

    const requestData = await jobberGraphQL(
      accessToken,
      `mutation CreateRequest($input: RequestCreateInput!) {
        requestCreate(input: $input) {
          request { id }
          userErrors { message }
        }
      }`,
      { input: { clientId, title, details } },
    );

    const userErrors = requestData?.requestCreate?.userErrors;
    if (userErrors?.length) throw new Error(`jobber_request_create_${userErrors[0]?.message ?? "unknown"}`);
    const requestId = requestData?.requestCreate?.request?.id;
    if (!requestId) throw new Error("jobber_request_create_no_id");

    await recordSyncResult(admin, userId, job.id, "jobber", {
      status: "synced",
      externalId: String(requestId),
      externalType: "request",
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "jobber_job_push_failed",
      user_id: userId,
      job_id: job.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    await recordSyncResult(admin, userId, job.id, "jobber", {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pushJobToServiceTitan(
  admin: SupabaseClient,
  userId: string,
  connection: PriceBookConnectionRow,
  job: BookedJobForSync,
): Promise<void> {
  try {
    if (!connection.st_business_unit_id || !connection.st_job_type_id) {
      throw new Error("servicetitan_job_config_missing");
    }
    const config: ServiceTitanJobConfig = {
      st_client_id: connection.st_client_id ?? "",
      st_client_secret: connection.st_client_secret ?? "",
      st_app_key: connection.st_app_key ?? "",
      st_tenant_id: connection.st_tenant_id ?? "",
      st_business_unit_id: connection.st_business_unit_id,
      st_job_type_id: connection.st_job_type_id,
    };

    const { externalId } = await createServiceTitanJob(config, {
      customerName: job.customerName,
      customerPhone: job.customerPhone,
      serviceType: job.serviceType,
      address: job.address,
      scheduledDatetime: job.scheduledDatetime,
    });

    await recordSyncResult(admin, userId, job.id, "service_titan", {
      status: "synced",
      externalId,
      externalType: "job",
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "servicetitan_job_push_failed",
      user_id: userId,
      job_id: job.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    await recordSyncResult(admin, userId, job.id, "service_titan", {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function pushJobToHousecallPro(
  admin: SupabaseClient,
  userId: string,
  connection: PriceBookConnectionRow,
  job: BookedJobForSync,
): Promise<void> {
  try {
    if (!connection.hcp_api_key) throw new Error("housecallpro_not_connected");

    const { externalId } = await createHousecallProJob(connection.hcp_api_key, {
      customerName: job.customerName,
      customerPhone: job.customerPhone,
      serviceType: job.serviceType,
      address: job.address,
      scheduledDatetime: job.scheduledDatetime,
    });

    await recordSyncResult(admin, userId, job.id, "housecall_pro", {
      status: "synced",
      externalId,
      externalType: "job",
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "housecallpro_job_push_failed",
      user_id: userId,
      job_id: job.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    await recordSyncResult(admin, userId, job.id, "housecall_pro", {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fan-out entry point called right after a job is booked internally. Looks
 * up which CRMs this tenant has connected and pushes to each. Never throws
 * — every provider branch swallows its own errors and records them in
 * job_external_syncs so a failed push shows up on the dashboard instead of
 * vanishing silently.
 */
export async function syncJobToExternalProviders(
  admin: SupabaseClient,
  userId: string,
  job: BookedJobForSync,
): Promise<void> {
  const { data: connections } = await admin
    .from("price_book_connections")
    .select("provider, status, jobber_access_token, jobber_refresh_token, jobber_token_expires_at, st_client_id, st_client_secret, st_app_key, st_tenant_id, st_business_unit_id, st_job_type_id, hcp_api_key")
    .eq("user_id", userId)
    .eq("status", "connected");

  if (!connections || connections.length === 0) return;

  for (const connection of connections as PriceBookConnectionRow[]) {
    if (connection.provider === "jobber") {
      await pushJobToJobber(admin, userId, connection, job);
    }
    if (connection.provider === "service_titan") {
      await pushJobToServiceTitan(admin, userId, connection, job);
    }
    if (connection.provider === "housecall_pro") {
      await pushJobToHousecallPro(admin, userId, connection, job);
    }
  }
}
