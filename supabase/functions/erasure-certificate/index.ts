// supabase/functions/erasure-certificate/index.ts
//
// Authenticated download / verification of deletion certificates (gateway verify_jwt stays ON).
// Logic lives in _shared/compliance/erasureCertificateHandler.ts (unit-tested).
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (both provided by the runtime), ERASURE_CERT_SIGNING_KEY,
//      ERASURE_CERT_KEY_ID (optional, default "k1"), ERASURE_CERT_VERIFY_KEYS (optional JSON of retired keys).
// Uses the CALLER's token against RLS. No service-role key is used here.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadSigningKeys } from "../_shared/compliance/erasureCertificate.ts";
import { handleErasureCertificateRequest, type CertClient } from "../_shared/compliance/erasureCertificateHandler.ts";

Deno.serve((req: Request) => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  return handleErasureCertificateRequest(req, {
    verifyKeys: loadSigningKeys((n) => Deno.env.get(n)).verify,
    createUserClient: (token) =>
      url && anon
        ? (createClient(url, anon, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { Authorization: `Bearer ${token}` } },
          }) as unknown as CertClient)
        : null,
  });
});
