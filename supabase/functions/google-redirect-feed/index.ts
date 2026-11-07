// supabase/functions/google-redirect-feed/index.ts
//
// Generates the Google Actions Center "Appointments Redirect" feed files (Entity + Action + descriptors) from the
// merchants that are eligible (see get_google_redirect_merchants). It does NOT upload them: Google ingests via SFTP
// with credentials issued in the Partner Portal after approval. Run this on a schedule from an uploader you control
// and put the returned files on the SFTP server (full refresh daily). Names/contents follow the official spec.
//
//   POST  { }    header: X-Cron-Secret: <CRON_SECRET>
//   -> { generated_at, merchants, rejected:[{entityId,reason}], files:[{name,content}] }
//
// Secrets: CRON_SECRET, SITE_URL (default https://app.vireek.com).
// Deploy:  supabase functions deploy google-redirect-feed --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { timingSafeEqualStr } from "../_shared/price-book/jobberWebhookSignature.ts";
import { buildFeedFiles, partitionMerchants, type RedirectMerchant } from "../_shared/google-redirect/feeds.ts";

interface MerchantRow {
  user_id: string;
  slug: string;
  name: string;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || !timingSafeEqualStr(req.headers.get("X-Cron-Secret") ?? "", secret)) return json({ error: "Forbidden" }, 403);

  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data, error } = await admin.rpc("get_google_redirect_merchants");
  if (error || !Array.isArray(data)) {
    console.error(JSON.stringify({ event: "google_redirect_feed_read_failed" }));
    return json({ error: "Could not read merchants." }, 500);
  }

  const all: RedirectMerchant[] = (data as MerchantRow[]).map((r) => ({
    entityId: r.user_id,
    name: r.name,
    phone: r.phone,
    bookingUrl: `${siteUrl}/book/${encodeURIComponent(r.slug)}`,
    address: {
      country: (r.country ?? "").toUpperCase(),
      locality: r.city ?? "",
      region: r.state,
      postalCode: r.postal_code ?? "",
      streetAddress: [r.address_line1, r.address_line2].filter((s): s is string => !!s && s.trim().length > 0).join(", "),
    },
  }));

  const { valid, rejected } = partitionMerchants(all);
  const ts = Math.floor(Date.now() / 1000);
  const files = [...buildFeedFiles("entity", valid, ts), ...buildFeedFiles("action", valid, ts)];
  console.log(JSON.stringify({ event: "google_redirect_feed_generated", merchants: valid.length, rejected: rejected.length }));
  return json({ generated_at: new Date(ts * 1000).toISOString(), merchants: valid.length, rejected, files });
});
