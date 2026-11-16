// supabase/functions/_shared/auth/integrationAccess.ts
//
// Pure (no Deno / npm: imports) access decision for "start or change a third-party integration".
// Fails closed: anything other than an explicit `true` from can_manage_integrations() is a 403.
// The Deno wrapper that builds the caller client lives in integrationAccessGuard.ts.

export interface CallerClient {
  auth: { getUser(): PromiseLike<{ data: { user: { id: string } | null }; error: unknown }> };
  rpc(fn: string): PromiseLike<{ data: unknown; error: unknown }>;
}

export type IntegrationAccess =
  | { ok: true; userId: string; ownerId: string }
  | { ok: false; status: 401 | 403; error: string };

export async function checkIntegrationAccess(caller: CallerClient, label: string, verb: "connect" | "disconnect" = "connect"): Promise<IntegrationAccess> {
  const { data: userData, error: userErr } = await caller.auth.getUser();
  const userId = userData?.user?.id;
  if (userErr || !userId) return { ok: false, status: 401, error: "Invalid or expired session." };

  const { data: ownerId, error: ownerErr } = await caller.rpc("get_account_owner_id");
  if (ownerErr || typeof ownerId !== "string" || !ownerId) return { ok: false, status: 401, error: "Could not resolve your account." };

  const { data: allowed, error: permErr } = await caller.rpc("can_manage_integrations");
  if (permErr || allowed !== true) return { ok: false, status: 403, error: `You don't have permission to ${verb} ${label}.` };

  return { ok: true, userId, ownerId };
}
