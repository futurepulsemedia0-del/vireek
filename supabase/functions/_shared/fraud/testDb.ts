// Test double for the fraud RPCs (shared by the sender tests). In-memory; fraud_reserve mirrors the SQL rule.
import type { FraudDb } from "./guard.ts";

export const US = "+12125550123";
export const UK = "+442071838750";
export const NOW = new Date("2030-01-15T10:00:00.000Z");

export interface Ctx {
  enforce: boolean;
  outbound_guard_mode?: "shadow" | "enforce";
  kill_outbound_calls: boolean;
  kill_sms: boolean;
  kill_international: boolean;
  status: "active" | "throttled" | "suspended";
  status_reason: string | null;
  outbound_unlocked: boolean;
  international_unlocked: boolean;
  voice_clone_unlocked: boolean;
  allowed_countries: string[];
  plan: string;
  account_age_days: number;
}

export const baseCtx = (over: Partial<Ctx> = {}): Ctx => ({
  enforce: true, outbound_guard_mode: "enforce", kill_outbound_calls: false, kill_sms: false, kill_international: false,
  status: "active", status_reason: null, outbound_unlocked: true, international_unlocked: false, voice_clone_unlocked: false,
  allowed_countries: [], plan: "free", account_age_days: 400, ...over,
});

/** In-memory stand-in for the fraud RPCs. fraud_reserve mirrors the SQL rule (add iff every cap holds). */
export function makeDb(ctx: Ctx | null | "error", marketing: Record<string, unknown> | null = { consent_mode: "off", has_consent: true, approval_required: false, campaign_status: "approved" }) {
  const usage = new Map<string, { calls: number; sms: number; cost: number }>();
  const life = { cost: 0 };
  const events: Record<string, unknown>[] = [];
  const callEvents = new Map<string, { reserved: number; external: string | null; day: string; settled: boolean }>();
  const rpcLog: { fn: string; args: Record<string, unknown> }[] = [];
  const bucketOf = (d: string) => usage.get(d) ?? { calls: 0, sms: 0, cost: 0 };
  const db: FraudDb = {
    rpc: async (fn, args = {}) => {
      rpcLog.push({ fn, args });
      if (fn === "fraud_guard_context") {
        if (ctx === "error") return { data: null, error: { message: "down" } };
        return { data: ctx, error: null };
      }
      if (fn === "fraud_marketing_checks") return { data: marketing, error: marketing ? null : { message: "down" } };
      if (fn === "fraud_request_campaign_approval") return { data: null, error: null };
      if (fn === "fraud_reserve") {
        const day = String(args.p_day);
        const b = { ...bucketOf(day) };
        b.calls += Number(args.p_calls); b.sms += Number(args.p_sms); b.cost += Number(args.p_cost);
        let denied: string | null = null;
        if (b.calls > Number(args.p_cap_calls)) denied = "DAILY_CALLS";
        else if (b.sms > Number(args.p_cap_sms)) denied = "DAILY_SMS";
        else if (b.cost > Number(args.p_cap_day_cost)) denied = "DAILY_COST";
        else if (args.p_cap_life_cost != null && life.cost + Number(args.p_cost) > Number(args.p_cap_life_cost)) denied = "LIFETIME_COST";
        if (denied) return { data: denied, error: null };
        usage.set(day, b);
        if (!day.startsWith("handoff:")) life.cost += Number(args.p_cost);
        return { data: null, error: null };
      }
      if (fn === "fraud_call_attach") {
        const e = callEvents.get(String(args.p_ref));
        if (e && e.external === null) e.external = String(args.p_external_id);
        return { data: null, error: null };
      }
      if (fn === "fraud_call_finish") {
        for (const e of callEvents.values()) {
          if (e.external === args.p_external_id && !e.settled) {
            e.settled = true;
            const refund = e.reserved - 0; // zero-second call: everything is refunded
            if (Number(args.p_duration) === 0) {
              const b = bucketOf(e.day); b.cost = Math.max(0, b.cost - refund); usage.set(e.day, b);
              life.cost = Math.max(0, life.cost - refund);
            }
          }
        }
        return { data: null, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "fraud_events") events.push(row);
        if (table === "fraud_call_events") callEvents.set(String(row.event_ref), { reserved: Number(row.reserved_cents), external: null, day: NOW.toISOString().slice(0, 10), settled: false });
        return { error: null };
      },
    }),
  };
  return { db, usage, events, callEvents, rpcLog, life };
}
