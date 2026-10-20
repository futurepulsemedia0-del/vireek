// supabase/functions/homeowner-delete-account/index.ts
// Permanently deletes a Vireek Home account (NOT a business account): removes
// uploaded photos, detaches the homeowner id from requests the businesses keep,
// then deletes the auth user (FK cascades remove profile, links, consent log).
// Businesses keep their own customer records — those are handled via their
// own data-request process.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });

  const accessToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return reply(401, { error: "Missing Authorization header." });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await admin.auth.getUser(accessToken);
  if (userErr || !userData?.user) return reply(401, { error: "Invalid or expired session." });
  const uid = userData.user.id;

  const [{ data: hp }, { data: biz }] = await Promise.all([
    admin.from("homeowner_profiles").select("id").eq("id", uid).maybeSingle(),
    admin.from("profiles").select("id").eq("id", uid).maybeSingle(),
  ]);
  if (!hp || biz) return reply(403, { error: "Only Vireek Home accounts can be deleted here." });

  // Photos (paged: a single list call returns at most 100 objects)
  for (let i = 0; i < 20; i++) {
    const { data: files } = await admin.storage.from("homeowner-uploads").list(uid, { limit: 100 });
    if (!files?.length) break;
    await admin.storage.from("homeowner-uploads").remove(files.map((f) => `${uid}/${f.name}`));
  }

  await admin.from("portal_requests").update({ homeowner_id: null, photo_paths: [] }).eq("homeowner_id", uid);

  const { error: delErr } = await admin.auth.admin.deleteUser(uid);
  if (delErr) {
    console.error("[homeowner-delete-account]", delErr.message);
    return reply(500, { error: "Couldn't delete the account. Please try again." });
  }
  return reply(200, { deleted: true });
});
