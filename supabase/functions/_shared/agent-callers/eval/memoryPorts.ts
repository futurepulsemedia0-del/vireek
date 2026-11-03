// In-memory ports for the synthetic AI-caller harness. Same engine, no network. Latencies are SIMULATED
// (a budget model), so the harness proves the call graph stays inside budget — it does not measure production.

import type { PriceItemLite } from "../../price-book/match.ts";
import type { Coverage, OfferedWindow } from "../protocol.ts";
import type { AgentEventType } from "../funnel.ts";
import { EMPTY_STATE, type CommitOutcome, type Ports, type SessionState } from "../engine.ts";
import type { AbuseCounts } from "../safety.ts";

export interface World {
  items: PriceItemLite[];
  coverageByZip: Record<string, Coverage>;
  /** null = capacity engine disconnected. */
  windows: OfferedWindow[] | null;
  now: Date;
  holdsToday: number;
  prior: Omit<AbuseCounts, "callFlags">;
  takenWindowIds: Set<string>;
  smsOk: boolean;
  summaryDest24h: number;
  /** Simulated per-port latency in ms. */
  latency: { db: number; capacity: number; send: number };
}

export interface Recorder {
  events: { type: AgentEventType; detail?: Record<string, unknown> }[];
  commits: { windowId: string; mode: "hold" | "book"; service: string; zip: string; code: string }[];
  sms: { to: string; body: string }[];
  emails: { to: string; subject: string; text: string }[];
  /** Simulated milliseconds spent in ports during each engine call (reset by the harness per tool call). */
  simulatedMs: number;
  state: SessionState;
}

export function makePorts(world: World): { ports: Ports; rec: Recorder } {
  const rec: Recorder = { events: [], commits: [], sms: [], emails: [], simulatedMs: 0, state: { ...EMPTY_STATE } };
  const spend = (ms: number) => { rec.simulatedMs += ms; };
  const ports: Ports = {
    async loadState() { spend(world.latency.db); return structuredClone(rec.state); },
    async saveState(s) { spend(world.latency.db); rec.state = structuredClone(s); },
    async recordEvent(type, detail) { spend(world.latency.db); rec.events.push({ type, detail }); },
    async loadPriceItems() { spend(world.latency.db); return world.items; },
    async coverage(zip) { spend(world.latency.db); return world.coverageByZip[zip] ?? { status: "unknown", travelFeeCents: null }; },
    async windows() { spend(world.latency.capacity); return world.windows; },
    async abuseCounts() { spend(world.latency.db); return world.prior; },
    async holdsToday() { spend(world.latency.db); return world.holdsToday + rec.commits.length; },
    async summaryCounts() { spend(world.latency.db); return { toDestination24h: world.summaryDest24h, tenant24h: 0 }; },
    async commit(a): Promise<CommitOutcome> {
      spend(world.latency.capacity);
      if (world.takenWindowIds.has(a.window.id)) return { status: "unavailable", alternatives: (world.windows ?? []).filter((w) => w.id !== a.window.id).map((w) => w.label) };
      rec.commits.push({ windowId: a.window.id, mode: a.mode, service: a.service, zip: a.zip, code: a.code });
      return { status: "ok" };
    },
    async sendSms(to, body) { spend(world.latency.send); if (!world.smsOk) return false; rec.sms.push({ to, body }); return true; },
    async sendEmail(to, subject, text) { spend(world.latency.send); rec.emails.push({ to, subject, text }); return true; },
    now: () => world.now,
    random: () => new Uint8Array([1, 2, 3, 4, 5, 6]),
  };
  return { ports, rec };
}
