// Deno-only helpers shared by every chat-* Edge Function.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type Db = SupabaseClient;

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function adminClient(): Db {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function siteUrl(): string {
  return (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/+$/, "");
}

export function functionsBase(): string {
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
}

export function integrationsRedirect(params: Record<string, string>): Response {
  const dest = new URL(`${siteUrl()}/dashboard/integrations`);
  for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
  return Response.redirect(dest.toString(), 302);
}

/** Resolves the signed-in user and requires them to be the account owner (same rule as AuthContext.isOwner). */
export async function requireOwner(req: Request, admin: Db): Promise<{ ownerId: string } | Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "Invalid or expired session." }, 401);
  const { data: profile } = await admin.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (profile?.role !== "owner") return json({ error: "Only the account owner can manage chat notifications." }, 403);
  return { ownerId: data.user.id };
}

/** Run work after the HTTP response (Slack/Teams require an answer within ~3s). */
export function runInBackground(work: Promise<unknown>): Promise<unknown> | void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const safe = work.catch((e) => console.error(JSON.stringify({ event: "chat_background_failed", error: e instanceof Error ? e.message : String(e) })));
  if (rt?.waitUntil) {
    rt.waitUntil(safe);
    return;
  }
  return safe;
}
