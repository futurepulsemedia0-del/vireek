// Google Ads API (reporting + budgets), Local Services API (LSA leads) and
// Data Manager API (offline conversions). Versions are env-pinned because
// Google sunsets API versions roughly every 12 months:
//   GOOGLE_ADS_API_VERSION   default "v24"
// Secrets: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN

import { fetchJson, HttpError } from "./common.ts";

const ver = () => Deno.env.get("GOOGLE_ADS_API_VERSION") ?? "v24";
const ADS = () => `https://googleads.googleapis.com/${ver()}`;

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/adwords", // Ads + Local Services reporting + budget changes
  "https://www.googleapis.com/auth/datamanager", // offline conversion ingestion
];

export function googleAuthUrl(redirectUri: string, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", Deno.env.get("GOOGLE_ADS_CLIENT_ID") ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

const tokenCall = (params: Record<string, string>) =>
  fetchJson<{ access_token: string; expires_in: number; refresh_token?: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_ADS_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_ADS_CLIENT_SECRET") ?? "",
      ...params,
    }),
  }, 1);

export const exchangeGoogleCode = (code: string, redirectUri: string) =>
  tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
export const refreshGoogleToken = (refresh_token: string) => tokenCall({ grant_type: "refresh_token", refresh_token });

function adsHeaders(token: string, loginCustomerId?: string | null): HeadersInit {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN") ?? "",
    "Content-Type": "application/json",
  };
  if (loginCustomerId) h["login-customer-id"] = loginCustomerId;
  return h;
}

/** GAQL via searchStream; flattens all batches. */
export async function gaql(token: string, customerId: string, loginCustomerId: string | null, query: string): Promise<any[]> {
  const batches = await fetchJson<any[]>(`${ADS()}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers: adsHeaders(token, loginCustomerId),
    body: JSON.stringify({ query }),
  });
  return (Array.isArray(batches) ? batches : [batches]).flatMap((b) => b.results ?? []);
}

export async function listAccessibleCustomers(token: string): Promise<string[]> {
  const r = await fetchJson<{ resourceNames?: string[] }>(`${ADS()}/customers:listAccessibleCustomers`, { headers: adsHeaders(token) });
  return (r.resourceNames ?? []).map((n) => n.replace("customers/", ""));
}

export interface GoogleCustomer { id: string; name: string; currency: string; manager: boolean; loginCustomerId: string | null }

/** Resolves accessible customers; expands managers into their non-manager children. */
export async function discoverCustomers(token: string): Promise<{ customers: GoogleCustomer[]; managers: string[] }> {
  const out = new Map<string, GoogleCustomer>();
  const managers: string[] = [];
  for (const id of await listAccessibleCustomers(token)) {
    try {
      const [row] = await gaql(token, id, null, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1");
      const c = row?.customer;
      if (!c) continue;
      if (c.manager) {
        managers.push(id);
        const kids = await gaql(token, id, id,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager " +
          "FROM customer_client WHERE customer_client.level = 1 AND customer_client.status = 'ENABLED'");
        for (const k of kids) {
          const cc = k.customerClient;
          if (!cc || cc.manager) continue;
          out.set(String(cc.id), { id: String(cc.id), name: cc.descriptiveName ?? String(cc.id), currency: cc.currencyCode ?? "USD", manager: false, loginCustomerId: id });
        }
      } else if (!out.has(id)) {
        out.set(id, { id, name: c.descriptiveName ?? id, currency: c.currencyCode ?? "USD", manager: false, loginCustomerId: null });
      }
    } catch { /* inaccessible customer: skip */ }
  }
  return { customers: [...out.values()], managers };
}

export interface CampaignSnapshot {
  external_id: string; name: string; status: "enabled" | "paused" | "removed" | "unknown";
  daily_budget_cents: number | null; external_budget_ref: string | null; budget_editable: boolean;
}

const statusOf = (s: string): CampaignSnapshot["status"] => (s === "ENABLED" ? "enabled" : s === "PAUSED" ? "paused" : s === "REMOVED" ? "removed" : "unknown");

export async function fetchGoogleCampaigns(token: string, customerId: string, login: string | null): Promise<CampaignSnapshot[]> {
  const rows = await gaql(token, customerId, login,
    "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared " +
    "FROM campaign WHERE campaign.status != 'REMOVED'");
  return rows.map((r) => ({
    external_id: String(r.campaign.id),
    name: r.campaign.name,
    status: statusOf(r.campaign.status),
    daily_budget_cents: r.campaignBudget?.amountMicros ? Math.round(Number(r.campaignBudget.amountMicros) / 10_000) : null,
    external_budget_ref: r.campaignBudget?.resourceName ?? null,
    budget_editable: !!r.campaignBudget?.resourceName && !r.campaignBudget?.explicitlyShared,
  }));
}

export async function fetchGoogleDaily(token: string, customerId: string, login: string | null, since: string, until: string) {
  const rows = await gaql(token, customerId, login,
    `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`);
  return rows.map((r) => ({
    external_id: String(r.campaign.id), day: r.segments.date as string,
    impressions: Number(r.metrics.impressions ?? 0), clicks: Number(r.metrics.clicks ?? 0),
    cost_cents: Math.round(Number(r.metrics.costMicros ?? 0) / 10_000),
  }));
}

/** Sets a campaign's (non-shared) daily budget. */
export async function setGoogleBudget(token: string, customerId: string, login: string | null, budgetRef: string, newCents: number) {
  await fetchJson(`${ADS()}/customers/${customerId}/campaignBudgets:mutate`, {
    method: "POST",
    headers: adsHeaders(token, login),
    body: JSON.stringify({ operations: [{ updateMask: "amount_micros", update: { resourceName: budgetRef, amountMicros: String(newCents * 10_000) } }] }),
  }, 1); // no blind retries on a write
}

// ---------- Local Services Ads (reporting only; there is no budget API) ----------
const LSA = "https://localservices.googleapis.com/v1";

export async function lsaAccountReports(token: string, managerId: string): Promise<any[]> {
  const r = await fetchJson<{ accountReports?: any[] }>(`${LSA}/accountReports:search?query=manager_customer_id:${managerId}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.accountReports ?? [];
}

export async function lsaLeads(token: string, managerId: string, since: Date, until: Date): Promise<any[]> {
  const out: any[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({
      query: `manager_customer_id:${managerId}`, pageSize: "500",
      "startDate.year": String(since.getUTCFullYear()), "startDate.month": String(since.getUTCMonth() + 1), "startDate.day": String(since.getUTCDate()),
      "endDate.year": String(until.getUTCFullYear()), "endDate.month": String(until.getUTCMonth() + 1), "endDate.day": String(until.getUTCDate()),
    });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await fetchJson<{ detailedLeadReports?: any[]; nextPageToken?: string }>(`${LSA}/detailedLeadReports:search?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    out.push(...(r.detailedLeadReports ?? []));
    pageToken = r.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

// ---------- Offline conversions via the Data Manager API ----------
// Google's legacy uploadClickConversions is being retired for new integrations;
// events:ingest is the recommended path. Always run once with validateOnly.
export async function ingestGoogleConversions(args: {
  token: string; customerId: string; loginCustomerId: string | null; conversionActionId: string;
  events: { transactionId: string; eventTimestamp: string; valueUnits: number; currency: string; gclid?: string; gbraid?: string; wbraid?: string }[];
  validateOnly: boolean;
}): Promise<{ requestId?: string }> {
  const acct = (id: string) => ({ accountId: id, accountType: "GOOGLE_ADS" });
  return fetchJson(`https://datamanager.googleapis.com/v1/events:ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      destinations: [{
        operatingAccount: acct(args.customerId),
        ...(args.loginCustomerId ? { loginAccount: acct(args.loginCustomerId) } : {}),
        productDestinationId: args.conversionActionId,
      }],
      encoding: "HEX",
      validateOnly: args.validateOnly,
      events: args.events.map((e) => ({
        transactionId: e.transactionId,
        eventTimestamp: e.eventTimestamp,
        conversionValue: e.valueUnits,
        currency: e.currency,
        adIdentifiers: { gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid },
      })),
    }),
  }, 1);
}

export { HttpError };
