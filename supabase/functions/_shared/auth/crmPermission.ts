// supabase/functions/_shared/auth/crmPermission.ts
//
// Permission gate for connecting / disconnecting business-system integrations (Jobber, ServiceTitan, Housecall Pro,
// HubSpot). Uses the SAME database check that QuickBooks and CRM connections already use (`can_manage_crm()` ->
// has_account_permission('can_edit_business_profile')), evaluated as the CALLER (anon key + the caller's JWT), so the
// decision cannot be spoofed with the service role. Fails closed: an RPC error is a denial, never a pass.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

export interface PermissionDenied {
  status: 403 | 500;
  error: string;
}

/** Structural subset of the Supabase client that this gate needs (lets tests inject a fake). */
export interface PermissionRpc {
  rpc(fn: string): PromiseLike<{ data: unknown; error: unknown }>;
}

export async function denyUnlessCanManageCrm(jwt: string, caller?: PermissionRpc): Promise<PermissionDenied | null> {
  const client: PermissionRpc =
    caller ??
    (createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    }) as unknown as PermissionRpc);
  try {
    const { data, error } = await client.rpc("can_manage_crm");
    if (error) return { status: 500, error: "Could not verify your permissions." };
    if (data !== true) return { status: 403, error: "You don't have permission to manage integrations." };
    return null;
  } catch {
    return { status: 500, error: "Could not verify your permissions." };
  }
}
