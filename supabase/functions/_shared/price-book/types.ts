export interface NormalizedPriceItem {
  external_id: string;
  service_name: string;
  category: string | null;
  price_cents: number;
  active: boolean;
}

export interface PriceBookConnectionRow {
  id: string;
  user_id: string;
  provider: "service_titan" | "jobber";
  status: "connected" | "error" | "disconnected";
  st_client_id: string | null;
  st_client_secret: string | null;
  st_app_key: string | null;
  st_tenant_id: string | null;
  jobber_access_token: string | null;
  jobber_refresh_token: string | null;
  jobber_token_expires_at: string | null;
}
