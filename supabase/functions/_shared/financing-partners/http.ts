import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
}

export interface Actor { userId: string; ownerId: string; canManage: boolean; isOwner: boolean }

export async function authenticate(req: Request, admin: SupabaseClient): Promise<Actor | Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "Invalid or expired session." }, 401);
  const userId = data.user.id;
  const [{ data: ownerId }, { data: canManage }] = await Promise.all([
    admin.rpc("fin_owner_of", { p_user: userId }),
    admin.rpc("fin_can_manage", { p_user: userId }),
  ]);
  if (!ownerId) return json({ error: "No account found." }, 403);
  return { userId, ownerId: ownerId as string, canManage: canManage === true, isOwner: ownerId === userId };
}

export async function readJson(req: Request, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function statusForError(code: string): number {
  switch (code) {
    case "forbidden": case "owner_required": return 403;
    case "unavailable": return 403;
    case "quote_not_found": case "not_found": return 404;
    case "already_referred": case "recently_shared": return 409;
    default: return 422;
  }
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
