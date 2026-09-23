import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

import { OWNED_TABLE_NAMES } from "../_shared/compliance/ownedTables.ts";
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Identify the caller from their own Supabase access token — never from
  // a client-supplied user id, so this function can only ever delete the
  // account of whoever is actually holding a valid session right now.
  const authHeader = req.headers.get("authorization") ?? "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);

  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const userId = userData.user.id;
  const userEmail = (userData.user.email ?? "").toLowerCase();

  let body: { confirmation?: string } = {};
  try {
    body = await req.json();
  } catch {
    // handled by the check below
  }

  // Server-side confirmation check. This is not just a disabled button on
  // the frontend — a leaked or stale access token alone is not enough to
  // trigger deletion; the caller must also know (and type) the account's
  // own email address.
  if (!body.confirmation || body.confirmation.trim().toLowerCase() !== userEmail) {
    return json({ error: "Confirmation email does not match your account." }, 400);
  }

  const { data: profileRow } = await admin
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (profileRow) {
    const { data: onHold } = await admin.rpc("has_active_legal_hold", { p_user_id: userId, p_dataset: null });
    if (onHold) {
      return json(
        { error: "This account has an active legal hold and cannot be deleted. Remove the hold in Data Governance settings first." },
        409
      );
    }

    // Account owner: wipe every table that stores this account's data
    // before removing the auth user. `team_members` and `profiles`
    // themselves cascade automatically once the auth user is deleted
    // (see 20260821101104_create_profiles_and_team_members.sql).
    for (const table of OWNED_TABLE_NAMES) {
      const { error } = await admin.from(table).delete().eq("user_id", userId);
      if (error) {
        return json({ error: `Failed to delete ${table}: ${error.message}` }, 500);
      }
    }
    // NOTE: if calls/recording_url points at a Supabase Storage bucket,
    // deleting these rows does NOT delete the underlying audio files.
    // Add a `storage.from('<your-bucket>').remove([...])` step here once
    // you confirm the bucket name — flagging it rather than guessing.
  } else {
    // Team member (not an owner): remove only their own membership
    // row(s), matched by email. Never touch another account's data.
    await admin.from("team_members").delete().eq("member_email", userEmail);
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    return json(
      { error: `Your data was removed, but the login itself could not be deleted: ${deleteError.message}` },
      500
    );
  }

  return json({ deleted: true });
});
