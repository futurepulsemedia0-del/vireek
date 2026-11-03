// supabase/functions/_shared/audit/testWorld.ts
// Test/e2e harness: real service + MemoryStore + mock providers + a controllable clock.
import { zonedToUtc } from "../messaging/quietHoursCore.ts";
import { MemoryStore } from "./memoryStore.ts";
import { GOOD_BUSINESS, MockBot, MockCalls, MockLookup, MockMailer, MockOtp, type MockBehaviour } from "./mock.ts";
import type { ApiResult, AuditDeps, AuditEnv, RequestMeta } from "./ports.ts";
import { applyProviderEvent, handleAction, runDueCalls, sendDueEmails } from "./service.ts";
import type { Condition } from "./types.ts";

export const TZ = "America/Chicago";
export const META: RequestMeta = { ip: "203.0.113.5", userAgent: "TestAgent/1.0", pageUrl: "https://vireek.com/audit" };
export const PHONE = "512-234-5678";
export const E164 = "+15122345678";

export function makeWorld(over: Partial<AuditEnv> = {}, start = zonedToUtc(2026, 11, 2, 8, 0, TZ)) {
  let t = start.getTime();
  const store = new MemoryStore();
  store.clock = () => new Date(t);
  const otp = new MockOtp();
  const calls = new MockCalls();
  const mailer = new MockMailer();
  const lookup = new MockLookup();
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  const deps: AuditDeps = {
    store, otp, calls, mailer, lookup, bot: new MockBot(), now: () => new Date(t), log: (event, data) => logs.push({ event, data }),
    env: {
      pepper: "pepper", tokenSecret: "token-secret", linkSecret: "link-secret", baseUrl: "https://vireek.com",
      functionsUrl: "https://x.supabase.co/functions/v1", postalAddress: "Vireek Inc, 1 Main St, Austin TX 78701", killSwitch: false,
      turnstileSiteKey: "site-key", lookupEnabled: false, ...over,
    },
  };
  const act = (action: string, body: unknown, meta: RequestMeta = META): Promise<ApiResult> => handleAction(deps, action, body, meta);
  const world = {
    deps, store, otp, calls, mailer, lookup, logs, act,
    setTime: (d: Date | string) => { t = new Date(d).getTime(); },
    advanceMs: (ms: number) => { t += ms; },
    now: () => new Date(t),
    startBody: (o: Record<string, unknown> = {}) => ({
      phone: PHONE, email: "owner@acme-hvac.com", business_name: "Acme HVAC", trade: "hvac", timezone: TZ, channel: "sms",
      consent_otp: true, attest_owner: true, bot_token: "human-ok-token", elapsed_ms: 6000, hp: "", ...o,
    }),
    /** start + verify; returns the report token and the proposed schedule */
    async verified(o: Record<string, unknown> = {}) {
      const s = await act("start", world.startBody(o));
      if (s.status !== 200) throw new Error(`start failed ${s.status} ${JSON.stringify(s.body)}`);
      const v = await act("verify", { verification_id: s.body.verification_id, code: world.otp.lastCode(E164) });
      if (v.status !== 200) throw new Error(`verify failed ${v.status} ${JSON.stringify(v.body)}`);
      return v.body as { token: string; proposed: { condition: Condition; scheduled_for: string }[]; untestable: unknown[] };
    },
    async scheduled(o: { followup?: boolean; start?: Record<string, unknown> } = {}) {
      const v = await world.verified(o.start);
      const r = await act("schedule", {
        token: v.token, business_hours: { days: [1, 2, 3, 4, 5], open: "08:00", close: "17:00" },
        slots: v.proposed.map((p) => ({ condition: p.condition, scheduled_for: p.scheduled_for })), consent_calls: true, followup_opt_in: o.followup === true,
      });
      if (r.status !== 200) throw new Error(`schedule failed ${r.status} ${JSON.stringify(r.body)}`);
      return { ...v, slots: v.proposed };
    },
    /** Walk the clock to each slot, dial, then deliver provider events for it. */
    async runAllCalls(behaviour: MockBehaviour = GOOD_BUSINESS) {
      calls.behaviour = behaviour;
      for (const c of [...store.calls.values()].sort((a, b) => a.slot - b.slot)) {
        world.setTime(new Date(Date.parse(c.scheduled_for) + 60_000));
        await runDueCalls(deps);
        const placed = [...store.calls.values()].find((x) => x.id === c.id)!;
        if (placed.vapi_call_id) {
          calls.conditionOf.set(placed.vapi_call_id, c.condition);
          const rep = calls.reportFor(placed.vapi_call_id, c.condition);
          await applyProviderEvent(deps, { type: "status-update", providerCallId: placed.vapi_call_id, auditCallId: c.id, status: "ringing", at: rep.ringingAt });
          await applyProviderEvent(deps, { type: "status-update", providerCallId: placed.vapi_call_id, auditCallId: c.id, status: "in-progress", at: rep.answeredAt });
          await applyProviderEvent(deps, { type: "end-of-call-report", providerCallId: placed.vapi_call_id, auditCallId: c.id, report: rep });
        }
      }
      await sendDueEmails(deps);
    },
  };
  return world;
}
export type World = ReturnType<typeof makeWorld>;
