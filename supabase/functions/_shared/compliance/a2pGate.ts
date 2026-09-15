// supabase/functions/_shared/compliance/a2pGate.ts
//
// NOT LEGAL ADVICE, but this IS a hard technical gate: carriers block
// unregistered A2P 10DLC traffic at the network level. This checks
// profiles.a2p_campaign_status BEFORE any send is attempted — see
// sendCompliantSms() in ../messaging/sendSms.ts, the only caller.

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export async function checkA2pApproved(
  admin: SupabaseClient,
  userId: string,
): Promise<{ approved: boolean; status: string }> {
  const { data, error } = await admin
    .from("profiles")
    .select("a2p_campaign_status")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) return { approved: false, status: "unknown" };
  return { approved: data.a2p_campaign_status === "approved", status: data.a2p_campaign_status };
}
