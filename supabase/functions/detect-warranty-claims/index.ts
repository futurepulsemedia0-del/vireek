// supabase/functions/detect-warranty-claims/index.ts
//
// Daily warranty-claim detector. Finds completed jobs whose equipment was still under warranty and that have
// no warranty claim yet, and creates them as `needs_review`. Idempotent. Also expires claims 7 days past deadline.
// NOTHING is submitted to any manufacturer portal. Ever.
//
// Deploy WITHOUT JWT verification (auth is the shared secret):
//   supabase functions deploy detect-warranty-claims --no-verify-jwt
// Secret: WARRANTY_CRON_SECRET (required; empty => every call is rejected)
// Call:   POST with header `x-warranty-secret` (daily via pg_cron -> dispatch_warranty_detection()).
//         Optional JSON body: { owner_id?: uuid, lookback_days?: 1-730, limit?: 1-2000 }
// Run it BEFORE check-warranty-claim-deadlines so new claims get their alerts the same day.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleDetect } from "../_shared/warranty-recovery/detect-handler.ts";

Deno.serve((req: Request) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleDetect(req, {
    secret: Deno.env.get("WARRANTY_CRON_SECRET") ?? "",
    admin,
    log: (msg, extra) => console.error(msg, extra ?? {}),
  });
});
