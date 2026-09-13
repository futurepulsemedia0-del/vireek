// ServiceTitan: OAuth2 client_credentials grant + Pricebook v2 API.
// Verify field names (`price`, `active`, `category.name`) and base URL
// (production vs sandbox) against https://developer.servicetitan.io/
// before production use.

import type { NormalizedPriceItem } from "./types.ts";

const ST_AUTH_URL = "https://auth.servicetitan.io/connect/token";
const ST_API_BASE = "https://api.servicetitan.io";

export interface ServiceTitanCredentials {
  st_client_id: string;
  st_client_secret: string;
  st_app_key: string;
  st_tenant_id: string;
}

function assertCredentials(c: ServiceTitanCredentials) {
  if (!c.st_client_id || !c.st_client_secret || !c.st_app_key || !c.st_tenant_id) {
    throw new Error("servicetitan_missing_credentials");
  }
}

export async function getServiceTitanToken(creds: ServiceTitanCredentials): Promise<string> {
  assertCredentials(creds);
  const res = await fetch(ST_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.st_client_id,
      client_secret: creds.st_client_secret,
    }),
  });
  if (!res.ok) throw new Error(`servicetitan_auth_http_${res.status}`);
  const json = await res.json();
  if (!json?.access_token) throw new Error("servicetitan_auth_no_token");
  return json.access_token as string;
}

export async function fetchServiceTitanPricebook(creds: ServiceTitanCredentials): Promise<NormalizedPriceItem[]> {
  const token = await getServiceTitanToken(creds);
  const items: NormalizedPriceItem[] = [];
  let page = 1;
  const pageSize = 200;
  const MAX_PAGES = 50;

  while (page <= MAX_PAGES) {
    const url = `${ST_API_BASE}/pricebook/v2/${creds.st_tenant_id}/services?page=${page}&pageSize=${pageSize}&active=true`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "ST-App-Key": creds.st_app_key },
    });
    if (!res.ok) throw new Error(`servicetitan_pricebook_http_${res.status}`);
    const json = await res.json();
    const services: unknown[] = Array.isArray(json?.data) ? json.data : [];

    for (const raw of services) {
      const svc = raw as Record<string, unknown>;
      if (svc.id == null || typeof svc.name !== "string" || typeof svc.price !== "number") continue;
      const category = svc.category as Record<string, unknown> | null | undefined;
      items.push({
        external_id: String(svc.id),
        service_name: svc.name,
        category: typeof category?.name === "string" ? category.name : null,
        price_cents: Math.round((svc.price as number) * 100),
        active: svc.active !== false,
      });
    }

    if (!json?.hasMore) break;
    page += 1;
  }

  return items;
}
