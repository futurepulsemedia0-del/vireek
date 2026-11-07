// supabase/functions/_shared/price-book/disconnect.ts
//
// Single implementation of "this FSM connection is gone": used by the user-initiated provider-disconnect function
// and by the Jobber APP_DISCONNECT webhook. Credentials are deleted FIRST (security), then the record is marked.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { deleteSecrets } from "../secrets/providerCredentials.ts";

export type PriceBookProvider = "jobber" | "service_titan" | "housecall_pro";

export async function markPriceBookDisconnected(admin: SupabaseClient, userId: string, provider: PriceBookProvider): Promise<void> {
  await deleteSecrets(admin, userId, provider);
  const { error } = await admin
    .from("price_book_connections")
    .update({
      status: "disconnected",
      jobber_access_token: null,
      jobber_refresh_token: null,
      jobber_token_expires_at: null,
      st_client_secret: null,
      st_app_key: null,
      hcp_api_key: null,
      last_sync_error: null,
    })
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw new Error("connection_update_failed");
}
