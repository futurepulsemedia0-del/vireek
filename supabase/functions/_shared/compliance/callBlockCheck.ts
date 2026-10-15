// supabase/functions/_shared/compliance/callBlockCheck.ts
//
// Live inbound block check, called from vapi-webhook's assistant-request
// BEFORE the AI connects. Decision logic lives in callBlockEngine.ts (shared
// with the dashboard). This file only loads the account's data and records
// the outcome.
//
// FAIL-OPEN BY DESIGN: any error, timeout or missing table returns
// "not blocked". A legitimate customer must never be rejected because the
// blocklist could not be read.

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  evaluateBlock,
  normalizePhone,
  isAnonymousCaller,
  RULE_LIMITS,
  type BlockCategory,
  type BlockDecision,
  type BlockRule,
  type RecentCall,
} from "./callBlockEngine.ts";

const OPEN: BlockDecision = { blocked: false, reason: "none", detail: "check_skipped" };

export async function checkInboundBlock(
  admin: SupabaseClient,
  userId: string,
  callerNumber: string | null,
  dialedNumber: string | null,
): Promise<BlockDecision> {
  try {
    const now = new Date();
    const anonymous = isAnonymousCaller(callerNumber);
    const key = anonymous ? null : normalizePhone(callerNumber as string);

    const { data: ruleRows } = await admin
      .from("call_block_rules")
      .select("id, name, kind, enabled, config")
      .eq("account_owner_id", userId)
      .eq("enabled", true);
    const rules = (ruleRows ?? []) as BlockRule[];

    const blocklist = new Map<string, BlockCategory>();
    let overrides: { id: string; phone: string; expiresAt: string; usesRemaining: number }[] = [];
    let recentCalls: RecentCall[] = [];

    if (key) {
      const [{ data: entry }, { data: ovr }] = await Promise.all([
        admin.from("call_blocklist").select("category").eq("account_owner_id", userId).eq("phone_number", key).maybeSingle(),
        admin
          .from("call_block_overrides")
          .select("id, phone_number, expires_at, uses_remaining")
          .eq("account_owner_id", userId)
          .eq("phone_number", key)
          .gt("expires_at", now.toISOString())
          .gt("uses_remaining", 0),
      ]);
      if (entry) blocklist.set(key, entry.category as BlockCategory);
      overrides = (ovr ?? []).map((o: { id: string; phone_number: string; expires_at: string; uses_remaining: number }) => ({
        id: o.id,
        phone: o.phone_number,
        expiresAt: o.expires_at,
        usesRemaining: o.uses_remaining,
      }));

      const repeat = rules.filter((r) => r.kind === "repeat_short_calls");
      if (repeat.length > 0) {
        const hours = Math.max(...repeat.map((r) => r.config.windowHours ?? RULE_LIMITS.windowHours.default));
        const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
        const { data: calls } = await admin
          .from("calls")
          .select("caller_phone, duration_seconds, call_datetime")
          .eq("user_id", userId)
          .eq("caller_phone", key)
          .gte("call_datetime", since)
          .limit(200);
        recentCalls = (calls ?? []).map((c: { caller_phone: string | null; duration_seconds: number | null; call_datetime: string }) => ({
          phone: c.caller_phone,
          durationSeconds: c.duration_seconds,
          at: c.call_datetime,
        }));
      }
    }

    const decision = evaluateBlock({ callerNumber, dialedNumber, now, recentCalls }, { blocklist, rules, overrides });

    if (decision.blocked) {
      await admin.rpc("call_block_record_hit", {
        p_owner: userId,
        p_phone: key,
        p_reason: decision.reason,
        p_rule: decision.ruleId ?? null,
        p_category: decision.category ?? null,
      });
    } else if (decision.reason === "override" && decision.overrideId) {
      await admin.rpc("call_block_consume_override", { p_override: decision.overrideId });
    }
    return decision;
  } catch (err) {
    console.error(JSON.stringify({ event: "call_block_check_failed", error: (err as Error).message }));
    return OPEN;
  }
}
