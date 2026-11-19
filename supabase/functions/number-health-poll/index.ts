// supabase/functions/number-health-poll/index.ts
//
// Polls a provider-agnostic reputation adapter for the spam-label status and call-attestation level of each active
// phone number, and stores the result in number_health. Two callers:
//  1. Cron (X-Cron-Secret = CRON_SECRET), body {"mode":"tick"}: every account, numbers not attempted in the last 5 hours.
//  2. A signed-in owner pressing "Check now", body {"mode":"user"}: only their own numbers, at most once per number
//     every 10 minutes.
//
// Deploy: supabase functions deploy number-health-poll
// Secrets: CRON_SECRET (same one safety-tick uses); NUMBER_REPUTATION_PROVIDER (optional, default "stub").
// Real providers: write a NumberReputationAdapter (see _shared/number-health/core.ts) and add it to ADAPTER_FACTORIES.
// Provider credentials belong in function secrets, never in code.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  BATCH_SIZE,
  applyOutcome,
  chunk,
  indexResults,
  resolveAdapter,
  type AdapterFactory,
  type Candidate,
  type HealthRowState,
  selectDue,
} from "../_shared/number-health/core.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Register real providers here. Only the stub exists today, so every result is "unknown" and the UI says so.
const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {};

const MAX_NUMBERS_PER_RUN = 500;
const LOOKUP_TIMEOUT_MS = 20_000;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

interface PhoneRow { id: string; account_id: string; phone_number: string }
interface HealthRow {
  phone_number_id: string; spam_label: string; attestation: string; label_sources: string[] | null; status: string;
  checked_at: string | null; last_attempt_at: string | null; consecutive_failures: number;
}

const toState = (h: HealthRow): HealthRowState => ({
  spamLabel: h.spam_label as HealthRowState["spamLabel"],
  attestation: h.attestation as HealthRowState["attestation"],
  labelSources: h.label_sources ?? [],
  status: h.status as HealthRowState["status"],
  checkedAt: h.checked_at ? new Date(h.checked_at) : null,
  lastAttemptAt: h.last_attempt_at ? new Date(h.last_attempt_at) : null,
  consecutiveFailures: h.consecutive_failures,
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey) return json({ error: "Server misconfiguration" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: { mode?: string } = {};
  try { body = await req.json(); } catch { /* empty body = tick */ }
  const mode = body.mode ?? "tick";

  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = !!cronSecret && constantTimeEqual(req.headers.get("X-Cron-Secret") ?? "", cronSecret);

  let ownerId: string | null = null;
  if (mode === "user") {
    const auth = req.headers.get("Authorization");
    if (!auth || !anonKey) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data } = await userClient.auth.getUser();
    ownerId = data.user?.id ?? null;
    if (!ownerId) return json({ error: "Unauthorized" }, 401);
  } else if (!isCron) {
    // Everything except an owner checking their own numbers is cron-only. No CRON_SECRET configured = refuse, never run open.
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const now = new Date();
    const { adapter, fellBack } = resolveAdapter(Deno.env.get("NUMBER_REPUTATION_PROVIDER"), ADAPTER_FACTORIES);
    if (fellBack) console.error(JSON.stringify({ event: "number_health_unknown_provider", note: "falling back to stub" }));

    let q = admin.from("phone_numbers").select("id, account_id, phone_number").eq("status", "active").limit(MAX_NUMBERS_PER_RUN);
    if (ownerId) q = q.eq("account_id", ownerId);
    const { data: phones, error: pErr } = await q;
    if (pErr) throw new Error(pErr.message);
    const numbers = (phones ?? []) as PhoneRow[];
    if (numbers.length === 0) return json({ ok: true, provider: adapter.id, live: adapter.isLive, checked: 0, skipped_recent: 0, skipped_invalid: 0, failed: 0, changes: 0 });

    const { data: healthRows } = await admin.from("number_health").select("phone_number_id, spam_label, attestation, label_sources, status, checked_at, last_attempt_at, consecutive_failures").in("phone_number_id", numbers.map((n) => n.id));
    const prevById = new Map<string, HealthRowState>((healthRows ?? []).map((h: HealthRow) => [h.phone_number_id, toState(h)]));

    const cands: Candidate[] = numbers.map((n) => ({ id: n.id, e164: n.phone_number, prev: prevById.get(n.id) ?? null }));
    const { due, skippedInvalid, skippedRecent } = selectDue(cands, now, mode === "user");
    const ownerOf = new Map(numbers.map((n) => [n.id, n.account_id]));

    let checked = 0, failed = 0, changeCount = 0;
    for (const group of chunk(due, BATCH_SIZE)) {
      const asked = group.map((g) => g.e164);
      let outcome;
      try {
        outcome = await adapter.lookup(asked, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      } catch (err) {
        // Adapters should not throw; if one does, treat the whole batch as a retryable provider failure.
        console.error(JSON.stringify({ event: "number_health_adapter_threw", provider: adapter.id, error: err instanceof Error ? err.name : "unknown" }));
        outcome = { ok: false as const, code: "provider_down" as const, retryable: true };
      }
      const answers = outcome.ok ? indexResults(asked, outcome.results) : new Map();

      for (const c of group) {
        const answer = answers.get(c.e164) ?? null;
        const { next, changes } = applyOutcome(c.prev, answer, now);
        const owner = ownerOf.get(c.id);
        if (!owner) continue;
        const errorCode = answer ? null : (outcome.ok ? "no_result" : outcome.code);
        const { error: upErr } = await admin.from("number_health").upsert({
          user_id: owner,
          phone_number_id: c.id,
          provider: adapter.id,
          provider_live: adapter.isLive,
          spam_label: next.spamLabel,
          attestation: next.attestation,
          label_sources: next.labelSources,
          status: next.status,
          checked_at: next.checkedAt ? next.checkedAt.toISOString() : null,
          last_attempt_at: next.lastAttemptAt ? next.lastAttemptAt.toISOString() : null,
          consecutive_failures: next.consecutiveFailures,
          last_error_code: errorCode,
          updated_at: now.toISOString(),
        }, { onConflict: "phone_number_id" });
        if (upErr) { failed++; continue; }
        if (answer) checked++; else failed++;
        if (changes.length > 0) {
          const { error: evErr } = await admin.from("number_health_events").insert(changes.map((ch) => ({ user_id: owner, phone_number_id: c.id, kind: ch.kind, from_value: ch.from, to_value: ch.to, provider: adapter.id })));
          if (!evErr) changeCount += changes.length;
        }
      }
    }
    // Phone numbers are never logged or returned: only counts.
    return json({ ok: true, provider: adapter.id, live: adapter.isLive, checked, skipped_recent: skippedRecent, skipped_invalid: skippedInvalid, failed, changes: changeCount });
  } catch (err) {
    console.error(JSON.stringify({ event: "number_health_poll_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Number health poll failed" }, 500);
  }
});
