// Server-side module entitlement gate. Default OFF: no row in account_modules => disabled.
// Fails CLOSED: any RPC error or malformed input means "not enabled".
// Usage in an edge function (after the owner id is resolved from the verified caller, never from the body):
//   const denied = await requireModule(admin, ownerId, "supply_orders", corsHeaders);
//   if (denied) return denied;

export const MODULE_KEY_RE = /^[a-z][a-z0-9_]{2,40}$/;

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function isModuleEnabled(admin: RpcClient, ownerId: string, moduleKey: string): Promise<boolean> {
  if (!ownerId || !MODULE_KEY_RE.test(moduleKey)) return false;
  try {
    const { data, error } = await admin.rpc("has_module_for", { p_owner: ownerId, p_key: moduleKey });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Returns a 403 Response when the module is not enabled for the account, otherwise null. */
export async function requireModule(
  admin: RpcClient,
  ownerId: string,
  moduleKey: string,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  if (await isModuleEnabled(admin, ownerId, moduleKey)) return null;
  return new Response(JSON.stringify({ error: "module_not_enabled", module: moduleKey }), {
    status: 403,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
