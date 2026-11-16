// scripts/chaos/lib/harness.ts
//
// Shared helpers for the voice chaos scenarios. Runs under plain Node (>=22.18, type stripping):
//   node --experimental-strip-types --no-warnings scripts/chaos/voice-all.ts
// It exercises the REAL pure modules (ledger, ladder, circuit breaker, TwiML fallback, reconcile, adapters,
// VoiceProvider, missedCallGuard) against in-memory fakes. It does NOT start Deno, Postgres, Vapi or Twilio.

import type { LedgerRow, LedgerStatus, LedgerStore, LedgerKey } from "../../../supabase/functions/_shared/voice-hardening/ledger.ts";

export interface Check { name: string; ok: boolean; detail?: string }
export interface ScenarioResult { scenario: string; checks: Check[] }

export class Recorder {
  readonly checks: Check[] = [];
  readonly scenario: string;
  constructor(scenario: string) { this.scenario = scenario; }
  check(name: string, ok: boolean, detail?: string): void {
    this.checks.push({ name, ok, detail: ok ? undefined : detail });
  }
  eq<T>(name: string, actual: T, expected: T): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    this.check(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  result(): ScenarioResult { return { scenario: this.scenario, checks: this.checks }; }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const jitter = (max: number) => sleep(Math.floor(Math.random() * max));

/**
 * In-memory ledger with the SAME uniqueness contract as table voice_webhook_events:
 * unique (user_id, vapi_call_id, event_type); claim() is atomic (no await between check and set).
 */
export class MemoryLedgerStore implements LedgerStore {
  readonly rows = new Map<string, LedgerRow & { key: LedgerKey; last_error?: string | null }>();
  private seq = 0;
  /** When set, every operation rejects: simulates the ledger/DB being unavailable. */
  down = false;
  clock = () => Date.now();

  private k(key: LedgerKey) { return `${key.userId}|${key.vapiCallId}|${key.eventType}`; }

  async claim(key: LedgerKey) {
    if (this.down) throw new Error("ledger unavailable");
    const id = this.k(key);
    const existing = this.rows.get(id);
    if (existing) return { row: { id: existing.id, status: existing.status, attempts: existing.attempts, updated_at: existing.updated_at }, created: false };
    const row = { id: `row-${++this.seq}`, status: "processing" as LedgerStatus, attempts: 1, updated_at: new Date(this.clock()).toISOString(), key };
    this.rows.set(id, row);
    return { row: { id: row.id, status: row.status, attempts: row.attempts, updated_at: row.updated_at }, created: true };
  }

  async reclaim(row: LedgerRow) {
    if (this.down) throw new Error("ledger unavailable");
    for (const r of this.rows.values()) {
      if (r.id === row.id && r.status === row.status && r.attempts === row.attempts) {
        r.status = "processing"; r.attempts += 1; r.updated_at = new Date(this.clock()).toISOString();
        return { id: r.id, status: r.status, attempts: r.attempts, updated_at: r.updated_at };
      }
    }
    return null;
  }

  async mark(id: string, patch: { status: LedgerStatus; last_error?: string | null }) {
    if (this.down) throw new Error("ledger unavailable");
    for (const r of this.rows.values()) if (r.id === id) { r.status = patch.status; r.last_error = patch.last_error ?? null; r.updated_at = new Date(this.clock()).toISOString(); }
  }
}

/** The business side effects a webhook produces, kept in memory so scenarios can count them. */
export class FakeWorld {
  readonly leads = new Map<string, { callId: string; transcript: string | null; at: number }>();
  readonly ownerAlerts: string[] = [];
  readonly sms: string[] = [];
  readonly inApp: string[] = [];
  leadWrites = 0;
  /** Makes the next N lead writes fail (DB error). */
  failLeadWrites = 0;

  writeLead(callId: string, transcript: string | null): void {
    if (this.failLeadWrites > 0) { this.failLeadWrites--; throw new Error("db write failed"); }
    this.leadWrites++;
    this.leads.set(callId, { callId, transcript, at: Date.now() });
  }
}

export function printResults(results: ScenarioResult[]): boolean {
  let allOk = true;
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.ok);
    console.log(`\n[${failed.length === 0 ? "PASS" : "FAIL"}] ${r.scenario}  (${r.checks.length - failed.length}/${r.checks.length})`);
    for (const c of r.checks) console.log(`   ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `  -> ${c.detail ?? ""}`}`);
    if (failed.length) allOk = false;
  }
  const total = results.reduce((n, r) => n + r.checks.length, 0);
  const bad = results.reduce((n, r) => n + r.checks.filter((c) => !c.ok).length, 0);
  console.log(`\n${allOk ? "ALL CHAOS SCENARIOS PASSED" : "CHAOS FAILURES"}: ${total - bad}/${total} checks`);
  return allOk;
}
