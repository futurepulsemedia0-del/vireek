// supabase/functions/_shared/billing/notices/noticeLog.ts
// One idempotent record per (user, kind, key) in billing_notice_log. Pure TS: the client is injected.

export type NoticeKind =
  | "renewal_30d"
  | "subscription_started"
  | "cancellation_scheduled"
  | "price_change"
  | "payment_suspended"
  | "fraud_throttled"
  | "fraud_suspended";

export interface NoticeClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface SendResult {
  ok: boolean;
  channels: string[];
  error?: string;
}

export type NoticeOutcome = "sent" | "duplicate" | "failed";

/**
 * claim -> send -> complete. A failed or thrown send releases the claim so the next run retries;
 * a duplicate (replayed webhook, overlapping cron) never sends twice.
 */
export async function sendNoticeOnce(
  admin: NoticeClient,
  userId: string,
  kind: NoticeKind,
  key: string,
  send: () => Promise<SendResult>,
): Promise<NoticeOutcome> {
  const args = { p_user_id: userId, p_kind: kind, p_key: key };
  const claim = await admin.rpc("claim_billing_notice", args);
  if (claim.error) throw new Error(`claim_billing_notice: ${claim.error.message}`);
  if (claim.data !== true) return "duplicate";

  let result: SendResult;
  try {
    result = await send();
  } catch (e) {
    await admin.rpc("release_billing_notice", args);
    console.error(JSON.stringify({ event: "billing_notice_send_threw", kind, error: e instanceof Error ? e.message : String(e) }));
    return "failed";
  }
  if (!result.ok) {
    await admin.rpc("release_billing_notice", args);
    console.error(JSON.stringify({ event: "billing_notice_send_failed", kind, error: result.error ?? "unknown" }));
    return "failed";
  }
  const done = await admin.rpc("complete_billing_notice", { ...args, p_channels: result.channels });
  if (done.error) console.error(JSON.stringify({ event: "billing_notice_complete_failed", kind, error: done.error.message }));
  return "sent";
}
