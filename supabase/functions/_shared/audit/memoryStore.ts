// supabase/functions/_shared/audit/memoryStore.ts
// In-memory AuditStore that mirrors the SQL semantics (caps, cooldown, append-only consent with redaction, purge).
// Used by service.test.ts and the Playwright mock backend. NOT used in production.

import type {
  AuditRow, AuditSettings, AuditStore, BlockKind, CallRow, ClaimedCall, ConsentInsert, EmailJob, VerificationRow,
} from "./ports.ts";

export const DEFAULT_SETTINGS: AuditSettings = {
  enabled: true, otp_enabled: true, calls_enabled: true, followups_enabled: true, allowed_countries: ["US", "CA"],
  retention_days: 30, cooldown_days: 30, disabled_reason: null,
};

export class MemoryStore implements AuditStore {
  settings: AuditSettings = { ...DEFAULT_SETTINGS };
  limits = { dailyStartCap: 60, dailyBudgetCents: 3000, perAuditCapCents: 150 };
  clock: () => Date = () => new Date();
  rate = new Map<string, { start: number; n: number }>();
  blocks = new Set<string>();
  usage = { starts: 0, otp_sent: 0, calls_placed: 0, emails_sent: 0, spend: 0 };
  cooldown = new Map<string, number>();
  verifications = new Map<string, VerificationRow>();
  audits = new Map<string, AuditRow>();
  calls = new Map<string, CallRow>();
  consents: (ConsentInsert & { redacted: boolean })[] = [];
  events: { audit_id: string; kind: string; detail: Record<string, unknown> }[] = [];
  emails = new Map<string, EmailJob & { skip_reason?: string; provider_id?: string }>();
  suppressed = new Set<string>();
  benchmarkValue: unknown | null = null;
  private seq = 0;

  private now = () => this.clock().getTime();

  async getSettings() { return { ...this.settings }; }
  async consumeRate(key: string, max: number, windowSeconds: number) {
    const cur = this.rate.get(key);
    const t = this.now();
    if (!cur || t - cur.start > windowSeconds * 1000) { this.rate.set(key, { start: t, n: 1 }); return 1 <= max; }
    cur.n++;
    return cur.n <= max;
  }
  async isBlocked(kind: BlockKind, value: string) { return this.blocks.has(`${kind}:${value}`); }
  async addBlock(kind: BlockKind, value: string) { this.blocks.add(`${kind}:${value}`); }
  async tryStart() { if (this.usage.starts >= this.limits.dailyStartCap) return false; this.usage.starts++; return true; }
  async reserveDaily(cents: number) { if (this.usage.spend + cents > this.limits.dailyBudgetCents) return false; this.usage.spend += cents; return true; }
  async reserveAudit(auditId: string, cents: number) {
    const a = this.audits.get(auditId);
    if (!a || a.cost_cents_reserved + cents > this.limits.perAuditCapCents) return "audit_cap" as const;
    if (!(await this.reserveDaily(cents))) return "daily_budget" as const;
    a.cost_cents_reserved += cents;
    return "ok" as const;
  }
  async bump(field: "starts" | "otp_sent" | "calls_placed" | "emails_sent", n = 1) { this.usage[field] += n; }
  async cooldownActive(h: string) { return (this.cooldown.get(h) ?? 0) > this.now(); }
  async claimNumber(h: string) {
    if (await this.cooldownActive(h)) return false;
    this.cooldown.set(h, this.now() + this.settings.cooldown_days * 86_400_000);
    return true;
  }
  async releaseNumber(h: string) { this.cooldown.delete(h); }

  async insertVerification(v: VerificationRow) { this.verifications.set(v.id, { ...v }); }
  async getVerification(id: string) { const v = this.verifications.get(id); return v ? { ...v } : null; }
  async updateVerification(id: string, patch: Partial<VerificationRow>) { Object.assign(this.verifications.get(id) ?? {}, patch); }
  async supersedePending(phoneHash: string, exceptId: string) {
    for (const v of this.verifications.values()) if (v.phone_hash === phoneHash && v.id !== exceptId && v.status === "pending") v.status = "superseded";
  }

  async createAudit(a: AuditRow) { this.audits.set(a.id, structuredClone(a)); }
  async getAuditByTokenHash(h: string) { return [...this.audits.values()].find((a) => a.token_hash === h) ?? null; }
  async getAuditByShareHash(h: string) { return [...this.audits.values()].find((a) => a.share_token_hash === h) ?? null; }
  async getAudit(id: string) { return this.audits.get(id) ?? null; }
  async updateAudit(id: string, patch: Partial<AuditRow>) { Object.assign(this.audits.get(id) ?? {}, patch); }
  async deleteAudit(id: string) {
    if (!this.audits.has(id)) return false;
    for (const c of this.consents) if (c.audit_id === id) { c.phone_e164 = ""; c.email = ""; c.ip_address = null; c.user_agent = null; c.page_url = null; c.evidence = {}; c.redacted = true; }
    for (const [cid, c] of this.calls) if (c.audit_id === id) this.calls.delete(cid);
    for (const [eid, e] of this.emails) if (e.audit_id === id) this.emails.delete(eid);
    this.events = this.events.filter((e) => e.audit_id !== id);
    this.audits.delete(id);
    return true;
  }

  async insertCalls(rows: CallRow[]) {
    for (const r of rows) {
      const mine = [...this.calls.values()].filter((c) => c.audit_id === r.audit_id);
      if (r.slot < 1 || r.slot > 3 || mine.length >= 3 || mine.some((c) => c.slot === r.slot || c.condition === r.condition)) throw new Error("audit_calls constraint violated");
      this.calls.set(r.id, structuredClone(r));
    }
  }
  async listCalls(auditId: string) { return [...this.calls.values()].filter((c) => c.audit_id === auditId).sort((a, b) => a.slot - b.slot).map((c) => structuredClone(c)); }
  async getCall(id: string) { return this.calls.get(id) ?? null; }
  async getCallByProviderId(p: string) { return [...this.calls.values()].find((c) => c.vapi_call_id === p) ?? null; }
  async updateCall(id: string, patch: Partial<CallRow>) { Object.assign(this.calls.get(id) ?? {}, patch); }
  async cancelPendingCalls(auditId: string, reason: string) {
    let n = 0;
    for (const c of this.calls.values()) if (c.audit_id === auditId && c.status === "scheduled") { c.status = "cancelled"; c.skip_reason = reason; n++; }
    return n;
  }
  async claimDueCalls(limit: number): Promise<ClaimedCall[]> {
    const t = this.now();
    for (const c of this.calls.values()) if (c.status === "scheduled" && Date.parse(c.window_end) <= t) { c.status = "skipped"; c.skip_reason = "window_missed"; }
    const out: ClaimedCall[] = [];
    const due = [...this.calls.values()].filter((c) => {
      const a = this.audits.get(c.audit_id);
      return c.status === "scheduled" && Date.parse(c.scheduled_for) <= t && Date.parse(c.window_end) > t && a && ["scheduled", "running"].includes(a.status) && Date.parse(a.expires_at) > t;
    }).sort((x, y) => Date.parse(x.scheduled_for) - Date.parse(y.scheduled_for)).slice(0, limit);
    for (const c of due) {
      const a = this.audits.get(c.audit_id)!;
      c.status = "claimed"; c.claimed_at = new Date(t).toISOString();
      if (a.status === "scheduled") a.status = "running";
      out.push({ call_id: c.id, audit_id: c.audit_id, slot: c.slot, condition: c.condition, scheduled_for: c.scheduled_for, window_end: c.window_end, phone_e164: a.phone_e164, timezone: a.timezone, business_name: a.business_name });
    }
    return out;
  }
  async releaseStuck() {
    let n = 0; const t = this.now();
    for (const c of this.calls.values()) {
      if (c.status === "claimed" && c.claimed_at && t - Date.parse(c.claimed_at) > 3 * 60_000) { c.status = "failed"; c.skip_reason = "dial_state_unknown"; c.answer_kind = "unknown"; n++; }
      else if (c.status === "dialing" && c.placed_at && t - Date.parse(c.placed_at) > 20 * 60_000) { c.status = "failed"; c.skip_reason = "no_report"; c.answer_kind = "unknown"; n++; }
    }
    return n;
  }
  async listStaleDialing(before: string, limit: number) {
    return [...this.calls.values()].filter((c) => c.status === "dialing" && c.placed_at && c.placed_at < before).slice(0, limit).map((c) => structuredClone(c));
  }
  async completeReady() {
    const t = this.now(); const ids: string[] = [];
    for (const a of this.audits.values()) {
      const cs = [...this.calls.values()].filter((c) => c.audit_id === a.id);
      if (Date.parse(a.expires_at) <= t) for (const c of cs) if (c.status === "scheduled") { c.status = "skipped"; c.skip_reason = "audit_expired"; }
      if (["scheduled", "running"].includes(a.status) && cs.length && !cs.some((c) => ["scheduled", "claimed", "dialing"].includes(c.status))) {
        a.status = "complete"; a.completed_at = new Date(t).toISOString(); ids.push(a.id);
      }
    }
    return ids;
  }

  async insertConsent(c: ConsentInsert) { this.consents.push({ ...c, redacted: false }); }
  async hasConsent(auditId: string, scope: ConsentInsert["scope"]) { return this.consents.some((c) => c.audit_id === auditId && c.scope === scope && c.granted); }
  async addEvent(auditId: string, kind: string, detail: Record<string, unknown> = {}) { this.events.push({ audit_id: auditId, kind, detail }); }

  async queueEmails(rows: Omit<EmailJob, "id" | "status">[]) {
    for (const r of rows) {
      if ([...this.emails.values()].some((e) => e.audit_id === r.audit_id && e.step === r.step)) continue;
      const id = `e${++this.seq}`; this.emails.set(id, { ...r, id, status: "queued" });
    }
  }
  async claimDueEmails(limit: number) {
    const due = [...this.emails.values()].filter((e) => e.status === "queued" && Date.parse(e.send_at) <= this.now()).slice(0, limit);
    for (const e of due) e.status = "sending";
    return due.map((e) => ({ ...e }));
  }
  async finishEmail(id: string, status: "sent" | "skipped" | "failed", info: { skip_reason?: string; provider_id?: string } = {}) { Object.assign(this.emails.get(id) ?? {}, { status, ...info }); }
  async skipQueuedFollowups(auditId: string, reason: string) {
    for (const e of this.emails.values()) if (e.audit_id === auditId && e.kind === "followup" && e.status === "queued") { e.status = "skipped"; e.skip_reason = reason; }
  }
  async suppressEmail(h: string) { this.suppressed.add(h); }
  async isEmailSuppressed(h: string) { return this.suppressed.has(h); }

  async purgeExpired() {
    let n = 0;
    for (const a of [...this.audits.values()]) if (Date.parse(a.expires_at) <= this.now()) { await this.deleteAudit(a.id); n++; }
    return { audits_deleted: n };
  }
  async benchmark() { return this.benchmarkValue; }
}
