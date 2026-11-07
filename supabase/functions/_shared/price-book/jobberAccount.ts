// supabase/functions/_shared/price-book/jobberAccount.ts
//
// Resolves the Jobber ACCOUNT id for an access token (`{ account { id } }`, per Jobber's "API Queries and Mutations"
// docs). Webhooks identify the installation by `accountId`, so we store it on the connection to route
// APP_DISCONNECT events to the right Vireek tenant(s).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { graphqlWithRetry, type RetryDeps } from "../http/retry.ts";
import { JOBBER_API_VERSION, JOBBER_GRAPHQL_URL } from "./jobber.ts";

export async function fetchJobberAccountId(accessToken: string, deps?: RetryDeps): Promise<string | null> {
  try {
    const body = await graphqlWithRetry<{ account?: { id?: unknown } }>(
      {
        url: JOBBER_GRAPHQL_URL,
        headers: { Authorization: `Bearer ${accessToken}`, "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION },
        query: "{ account { id } }",
      },
      { idempotent: true, maxAttempts: 2, timeoutMs: 6000 },
      deps,
    );
    const id = body.data?.account?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Best-effort: stores the account id on an existing connection row. Never throws. */
export async function recordJobberAccountId(admin: SupabaseClient, connectionId: string, accessToken: string): Promise<void> {
  const id = await fetchJobberAccountId(accessToken);
  if (!id) return;
  await admin.from("price_book_connections").update({ jobber_account_id: id }).eq("id", connectionId);
}
