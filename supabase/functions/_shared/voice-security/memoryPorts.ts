// supabase/functions/_shared/voice-security/memoryPorts.ts
//
// In-memory implementation of VoiceSecurityPorts + VerificationPorts. It mirrors the SQL semantics in
// 20280501000000_voice_security_controls.sql (atomic counters, OTP attempt limits, one-shot pending actions,
// locking). Used by unit tests and the red-team harness; production uses ports.ts. The SQL itself is exercised
// by the PGlite test, so these two cannot silently drift (see the "sql parity" tests).

import type { PendingResult, StateDelta, VoiceSecurityPorts } from "./gate.ts";
import { hmacHex } from "./stepUp.ts";
import type { CustomerOnFile, VerificationPorts } from "./verifyTools.ts";
import type { AuditRecord, CallRef, CallSecurityState, SecurityMode } from "./types.ts";
import { EMPTY_CALL_STATE } from "./types.ts";

export interface MemoryWorld {
  clock: { now: number };
  mode: SecurityMode;
  customers: CustomerOnFile[]; // number on file = customer.phone
  canaries: Set<string>;
  sms: { to: string; body: string; customerId: string }[];
  audit: (AuditRecord & { tenantId: string })[];
}

export function newWorld(init: Partial<MemoryWorld> = {}): MemoryWorld {
  return { clock: { now: Date.UTC(2026, 10, 2, 12, 0, 0) }, mode: "normal", customers: [], canaries: new Set(), sms: [], audit: [], ...init };
}

const last10 = (s: string) => s.replace(/\D/g, "").slice(-10);

interface Challenge { callId: string; customerId: string; digest: string; attempts: number; expiresAt: number; consumed: boolean }
interface Pending { callId: string; tool: string; paramsHash: string; createdAt: number; expiresAt: number; consumed: boolean }

export function createMemoryPorts(
  world: MemoryWorld,
  scanInjection: VoiceSecurityPorts["scanInjection"],
  secret = "test-secret-do-not-use",
  opts: { failBackend?: () => boolean } = {},
): VoiceSecurityPorts & VerificationPorts {
  const states = new Map<string, CallSecurityState>();
  const rates = new Map<string, number>();
  const challenges: Challenge[] = [];
  const pendings = new Map<string, Pending>();
  const challengeCounts = new Map<string, number>();
  let seq = 0;

  const sk = (t: string, c: CallRef) => `${t}|${c.callId ?? "nocall"}`;
  const guard = () => { if (opts.failBackend?.()) throw new Error("backend down"); };
  const get = (t: string, c: CallRef): CallSecurityState => {
    const k = sk(t, c);
    let s = states.get(k);
    if (!s) { s = { ...EMPTY_CALL_STATE, counters: {} }; states.set(k, s); }
    return s;
  };

  return {
    secret,
    nowMs: () => world.clock.now,
    async getMode() { guard(); return world.mode; },
    async getCallState(t, c) { guard(); const s = get(t, c); return { ...s, counters: { ...s.counters } }; },
    async bumpCallState(t, c, d: StateDelta) {
      guard();
      const s = get(t, c);
      for (const [k, v] of Object.entries(d.counters ?? {})) s.counters[k] = (s.counters[k] ?? 0) + v;
      if (d.risk !== undefined) s.riskScore = Math.max(s.riskScore, d.risk);
      if (d.restricted) s.restricted = true;
      if (d.locked) s.locked = true;
    },
    async rateConsume(t, key, limit, windowSeconds) {
      guard();
      const bucket = Math.floor(world.clock.now / 1000 / windowSeconds);
      const k = `${t}|${key}|${bucket}`;
      const n = (rates.get(k) ?? 0) + 1;
      rates.set(k, n);
      return n <= limit;
    },
    hmac: (m) => hmacHex(secret, m),
    async audit(t, rec) { world.audit.push({ ...rec, tenantId: t }); },
    scanInjection,
    async isCanary(_t, values) { guard(); return values.some((v) => world.canaries.has(v.toLowerCase()) || world.canaries.has(last10(v))); },
    async pendingCreate(t, callId, tool, paramsHash, _summary, ttl) {
      guard();
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      pendings.set(id, { callId, tool, paramsHash, createdAt: world.clock.now, expiresAt: world.clock.now + ttl * 1000, consumed: false });
      void t;
      return id;
    },
    async pendingConsume(_t, callId, tool, paramsHash, id, minAgeMs): Promise<PendingResult> {
      guard();
      const p = pendings.get(id);
      if (!p || p.callId !== callId || p.tool !== tool || p.consumed) return "missing";
      if (p.paramsHash !== paramsHash) return "mismatch";
      if (world.clock.now > p.expiresAt) return "expired";
      if (world.clock.now - p.createdAt < minAgeMs) return "too_soon";
      p.consumed = true;
      return "ok";
    },

    // ---- VerificationPorts ----
    async findCustomerByPhone(_t, n) { return world.customers.find((c) => c.phone && last10(c.phone) === last10(n)) ?? null; },
    async issueChallenge(a) {
      guard();
      const s = get(a.tenantId, { callId: a.callId, kind: "inbound", callerNumber: null, dialedNumberId: null });
      if (s.locked) return { ok: false, reason: "locked" };
      const perCall = challenges.filter((c) => c.callId === a.callId).length;
      if (perCall >= a.maxPerCall) return { ok: false, reason: "too_many_challenges" };
      const dayKey = `${a.callerHash}|${Math.floor(world.clock.now / 86_400_000)}`;
      const n = (challengeCounts.get(dayKey) ?? 0) + 1;
      challengeCounts.set(dayKey, n);
      if (n > a.maxPerNumberDay) return { ok: false, reason: "number_daily_limit" };
      for (const c of challenges) if (c.callId === a.callId) c.consumed = true;
      challenges.push({ callId: a.callId, customerId: a.customerId, digest: a.digest, attempts: 0, expiresAt: world.clock.now + a.ttlSeconds * 1000, consumed: false });
      return { ok: true, reason: "issued" };
    },
    async checkChallenge(a) {
      guard();
      const s = get(a.tenantId, { callId: a.callId, kind: "inbound", callerNumber: null, dialedNumberId: null });
      if (s.locked) return { ok: false, reason: "locked" };
      const c = [...challenges].reverse().find((x) => x.callId === a.callId && !x.consumed && world.clock.now <= x.expiresAt);
      if (!c) return { ok: false, reason: "no_challenge" };
      c.attempts++;
      if (c.attempts > a.maxAttempts) { c.consumed = true; s.locked = true; return { ok: false, reason: "too_many_attempts" }; }
      if (c.digest !== a.digest) { s.counters.verify_fail = (s.counters.verify_fail ?? 0) + 1; return { ok: false, reason: "mismatch" }; }
      c.consumed = true;
      if (s.customerId && s.customerId !== c.customerId) s.kdPassedAt = null;
      s.customerId = c.customerId;
      s.otpPassedAt = world.clock.now;
      return { ok: true, reason: "ok", customerId: c.customerId };
    },
    async recordKnownDetails(a) {
      guard();
      const s = get(a.tenantId, { callId: a.callId, kind: "inbound", callerNumber: null, dialedNumberId: null });
      if (a.passed) {
        if (s.customerId && s.customerId !== a.customerId) s.otpPassedAt = null;
        s.customerId = a.customerId;
        s.kdPassedAt = world.clock.now;
      } else {
        s.kdFails++;
        s.counters.verify_fail = (s.counters.verify_fail ?? 0) + 1;
        if (s.kdFails >= a.maxFails) s.locked = true;
      }
      return { locked: s.locked };
    },
    async sendSms(_t, to, body, customerId) { world.sms.push({ to, body, customerId }); return true; },
  };
}
