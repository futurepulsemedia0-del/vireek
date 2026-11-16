import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapSmsFailure } from "../agent-run/followupTools.ts";
import { buildBlocked } from "./outboundGate.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NOW = new Date("2030-01-15T10:00:00.000Z");

describe("a blocked send is never retried in a loop", () => {
  it("governed run runtime: FRAUD_BLOCKED maps to policy_blocked (not retried), not 'transient' (retried 3x)", () => {
    const e = mapSmsFailure({ ok: false, reason: "FRAUD_BLOCKED", block: buildBlocked("ORG_SUSPENDED", "x", 403, NOW), detail: "x" });
    expect(e.errorClass).toBe("policy_blocked");
    expect(e.providerFault).toBe(false);
    expect(mapSmsFailure({ ok: false, reason: "A2P_NOT_APPROVED" }).errorClass).toBe("transient"); // unchanged
  });

  it("retry policy: only conditions that clear on their own are retryable, each with a concrete retryAt in the future", () => {
    for (const code of ["DAILY_SMS", "DAILY_CALLS", "DAILY_COST", "KILL_SWITCH", "GUARD_UNAVAILABLE", "CAMPAIGN_APPROVAL_REQUIRED"] as const) {
      const b = buildBlocked(code, "m", 429, NOW);
      expect(b.retryable).toBe(true);
      expect(Date.parse(b.retryAt as string)).toBeGreaterThan(NOW.getTime());
    }
    for (const code of ["ORG_SUSPENDED", "VERIFICATION_REQUIRED", "LIFETIME_COST", "CONSENT_REQUIRED", "PREMIUM_RATE", "INTERNATIONAL_LOCKED", "INVALID_NUMBER"] as const) {
      const b = buildBlocked(code, "m", 403, NOW);
      expect(b.retryable).toBe(false);
      expect(b.retryAt).toBeNull();
    }
  });

  // Static inspection of the queue / dispatcher code: each one consumes BlockedSend.retryAt / retryable instead of re-queuing.
  it.each([
    ["outbound-dialer/index.ts", ["fraud.blocked", "b.retryable && b.retryAt", "scheduled_for: b.retryAt"]],
    ["followup-agent-dispatcher/index.ts", ["typeof stepResult === \"object\"", "next_action_at: b.retryAt", "stop_reason: `fraud_guard:"]],
    ["workflow-engine-executor/index.ts", ["retryAt: b.retryAt", "outcome.retryAt"]],
    ["deferred-message-dispatcher/index.ts", ["blocked.retryable && blocked.retryAt", "send_after: blocked.retryAt"]],
    ["marketing-campaign-dispatcher/index.ts", ["guardBlock?.retryable", "next_send_at: guardBlock.retryAt"]],
    ["_shared/speed-to-lead/runtime.ts", ["b.retryable && b.retryAt", "next_attempt_at: b.retryAt"]],
    ["dialer-call/index.ts", ["dialer_defer_contact", "dialer_complete_attempt"]],
  ])("%s handles a block by parking until retryAt or ending the item", (path, needles) => {
    const text = src(path);
    for (const n of needles as string[]) expect(text).toContain(n);
  });
});
