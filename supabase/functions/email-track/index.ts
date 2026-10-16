// supabase/functions/email-track/index.ts
//
// Public open/click tracker (no JWT — recipients' mail clients call it).
//   GET ?t=<recipient token>&k=o            -> records an open, returns a 1x1 GIF
//   GET ?t=<recipient token>&l=<link id>    -> records a click, 302 to the stored URL
//
// The redirect target is looked up server-side from email_campaign_links (never
// taken from the query string), so this endpoint cannot be used as an open redirect.
// Note: Apple Mail Privacy Protection and some security scanners pre-fetch images
// and links, so opens are an approximate signal (the UI says so).
//
// Deploy:  supabase functions deploy email-track --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isHttpUrl } from "../_shared/email-campaigns/render.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

function pixel(): Response {
  return new Response(GIF, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const t = url.searchParams.get("t") ?? "";
  const l = url.searchParams.get("l") ?? "";
  const isClick = l !== "";

  if (!UUID_RE.test(t) || (isClick && !UUID_RE.test(l))) {
    return isClick ? new Response("Not found", { status: 404 }) : pixel();
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    if (isClick) {
      const { data } = await admin.rpc("email_record_click", { p_token: t, p_link: l });
      if (typeof data === "string" && isHttpUrl(data)) {
        return new Response(null, { status: 302, headers: { Location: data, "Cache-Control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    }
    await admin.rpc("email_record_open", { p_token: t });
  } catch (e) {
    console.error("email-track error", e);
    if (isClick) return new Response("Temporarily unavailable", { status: 503 });
  }
  return pixel();
});
