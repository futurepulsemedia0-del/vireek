// Run: npm run test:scripts:state-dnc   (node --experimental-strip-types --no-warnings --test)
// Mock-only: no registry, network or database is contacted. Covers decide.ts (pure) and scrub.ts (mock admin).
import test from "node:test";
import assert from "node:assert/strict";
import { decideScrub, ageDays, isFresh, normalizePurpose, parseGateMode } from "../../supabase/functions/_shared/compliance/stateDnc/decide.ts";
import { scrubBeforeDial } from "../../supabase/functions/_shared/compliance/stateDnc/scrub.ts";

const NOW = new Date("2026-11-25T12:00:00Z");
const list = (id, jurisdiction, extra = {}) => ({
  id, jurisdiction, name: `list ${id}`, versionLabel: "v1", effectiveDate: "2026-11-01", expiresAt: null,
  activatedAt: "2026-11-02T00:00:00Z", rowCount: 3, contentSha256: "a".repeat(64), ...extra,
});
const rule = (jurisdiction, extra = {}) => ({ jurisdiction, appliesToPurposes: ["marketing", "service"], maxAgeDays: null, requireActiveList: false, ...extra });
const base = { purpose: "marketing", residency: { state: null, basis: "unknown" }, lists: [], rules: [], matchedListIds: new Set(), internalHit: false, now: NOW };

test("no lists configured: clear (nothing changes for accounts that import nothing)", () => {
  const o = decideScrub(base);
  assert.equal(o.decision, "clear");
  assert.equal(o.reasonCode, "NO_APPLICABLE_LIST");
});

test("internal opt-out always suppresses, even for emergency purpose", () => {
  assert.equal(decideScrub({ ...base, purpose: "emergency", internalHit: true }).decision, "suppressed");
});

test("confirmed TX resident: TX list and federal list apply, CA list does not", () => {
  const lists = [list("tx", "US-TX"), list("ca", "US-CA"), list("us", "US")];
  const res = { state: "TX", basis: "address" };
  assert.equal(decideScrub({ ...base, lists, residency: res, matchedListIds: new Set(["ca"]) }).decision, "clear");
  assert.equal(decideScrub({ ...base, lists, residency: res, matchedListIds: new Set(["tx"]) }).decision, "suppressed");
  assert.equal(decideScrub({ ...base, lists, residency: res, matchedListIds: new Set(["us"]) }).decision, "suppressed");
});

test("residency only presumed from the area code or unknown: strictest, a match on ANY state list holds the call", () => {
  const lists = [list("tx", "US-TX"), list("ca", "US-CA")];
  for (const residency of [{ state: "TX", basis: "phone" }, { state: null, basis: "unknown" }]) {
    assert.equal(decideScrub({ ...base, lists, residency, matchedListIds: new Set(["ca"]) }).decision, "suppressed");
  }
});

test("emergency purpose is exempt from lists unless a rule includes it", () => {
  const lists = [list("us", "US")];
  const m = new Set(["us"]);
  assert.equal(decideScrub({ ...base, purpose: "emergency", lists, matchedListIds: m }).decision, "clear");
  const r = [rule("US", { appliesToPurposes: ["emergency"] })];
  assert.equal(decideScrub({ ...base, purpose: "emergency", lists, rules: r, matchedListIds: m }).decision, "suppressed");
});

test("rule narrowing: a list whose rule excludes the purpose is not applied", () => {
  const lists = [list("tx", "US-TX")];
  const r = [rule("US-TX", { appliesToPurposes: ["marketing"] })];
  const res = { state: "TX", basis: "explicit" };
  assert.equal(decideScrub({ ...base, purpose: "service", lists, rules: r, residency: res, matchedListIds: new Set(["tx"]) }).decision, "clear");
  assert.equal(decideScrub({ ...base, purpose: "marketing", lists, rules: r, residency: res, matchedListIds: new Set(["tx"]) }).decision, "suppressed");
});

test("requireActiveList: missing list blocks (retryable); stale list blocks; fresh list passes", () => {
  const r = [rule("US-TX", { requireActiveList: true, maxAgeDays: 30 })];
  const res = { state: "TX", basis: "explicit" };
  const none = decideScrub({ ...base, rules: r, residency: res });
  assert.equal(none.decision, "blocked_no_list"); assert.equal(none.retryable, true);
  const old = decideScrub({ ...base, rules: r, residency: res, lists: [list("tx", "US-TX", { effectiveDate: "2026-01-01" })] });
  assert.equal(old.decision, "blocked_stale_list");
  const fresh = decideScrub({ ...base, rules: r, residency: res, lists: [list("tx", "US-TX", { effectiveDate: "2026-11-20" })] });
  assert.equal(fresh.decision, "clear");
});

test("a stale list is still used for membership (conservative) and a match beats a stale block", () => {
  const r = [rule("US-TX", { requireActiveList: true, maxAgeDays: 30 })];
  const o = decideScrub({ ...base, rules: r, residency: { state: "TX", basis: "explicit" },
    lists: [list("tx", "US-TX", { effectiveDate: "2026-01-01" })], matchedListIds: new Set(["tx"]) });
  assert.equal(o.decision, "suppressed");
});

test("expired list is not fresh; unknown age with a max age is not fresh", () => {
  assert.equal(isFresh(list("x", "US", { expiresAt: "2026-11-01T00:00:00Z" }), rule("US"), NOW), false);
  assert.equal(isFresh(list("x", "US", { effectiveDate: null, activatedAt: null }), rule("US", { maxAgeDays: 5 }), NOW), false);
  assert.equal(ageDays(list("x", "US", { effectiveDate: "2026-11-20" }), NOW), 5);
});

test("helpers: purpose defaults to marketing, gate mode defaults to shadow", () => {
  assert.equal(normalizePurpose(undefined), "marketing");
  assert.equal(normalizePurpose("weird"), "marketing");
  assert.equal(parseGateMode(undefined), "shadow");
  assert.equal(parseGateMode(" ENFORCE "), "enforce");
});

// ---------------------------------------------------------------- scrubBeforeDial with a mock admin
function mockAdmin({ lists = [], rules = [], entries = [], failTable = null, failProof = false } = {}) {
  const proofs = [];
  const calls = [];
  const admin = {
    from(table) {
      const q = { table, filters: {} };
      const chain = {
        select() { return chain; },
        eq(k, v) { q.filters[k] = v; return chain; },
        in(k, v) { q.filters[k] = v; return chain; },
        insert(row) { q.insert = row; return chain; },
        single() {
          if (failProof) return Promise.resolve({ data: null, error: { message: "boom" } });
          proofs.push(q.insert); return Promise.resolve({ data: { id: `proof-${proofs.length}` }, error: null });
        },
        then(res, rej) {
          calls.push({ table, filters: q.filters });
          if (table === failTable) return Promise.resolve({ data: null, error: { message: "db down" } }).then(res, rej);
          let data = [];
          if (table === "dnc_registry_lists") data = lists.filter((l) => l.account_owner_id === q.filters.account_owner_id);
          if (table === "dnc_state_rules") data = rules.filter((r) => r.account_owner_id === q.filters.account_owner_id);
          if (table === "dnc_registry_entries") data = entries.filter((e) => e.account_owner_id === q.filters.account_owner_id && e.phone_e164 === q.filters.phone_e164 && q.filters.list_id.includes(e.list_id));
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return { admin, proofs, calls };
}
const dbList = (id, owner, jurisdiction, extra = {}) => ({ id, account_owner_id: owner, jurisdiction, name: id, version_label: "v1", effective_date: "2026-11-20", expires_at: null, activated_at: "2026-11-21T00:00:00Z", row_count: 1, content_sha256: "b".repeat(64), ...extra });
const mk = (m, gateMode, extra = {}) => ({ admin: m.admin, gateMode, isInternallySuppressed: async () => false, now: () => NOW, log: () => {}, ...extra });
const req = { ownerId: "owner-A", phone: "(214) 555-0123", source: "unit", correlationId: "row-1" };

test("scrub: a number on the account's TX list is suppressed in enforce mode and the proof stores NO raw number", async () => {
  const m = mockAdmin({ lists: [dbList("L1", "owner-A", "US-TX")], entries: [{ list_id: "L1", account_owner_id: "owner-A", phone_e164: "+12145550123" }] });
  const r = await scrubBeforeDial(mk(m, "enforce"), { ...req, explicitState: "tx" });
  assert.equal(r.allow, false); assert.equal(r.decision, "suppressed"); assert.equal(r.retryable, false);
  assert.equal(m.proofs.length, 1);
  const p = m.proofs[0];
  assert.equal(p.decision, "suppressed"); assert.deepEqual(p.matched_list_ids, ["L1"]);
  assert.match(p.phone_sha256, /^[0-9a-f]{64}$/); assert.equal(p.phone_last4, "0123");
  assert.ok(!JSON.stringify(p).includes("2145550123"), "proof must not contain the phone number");
  assert.equal(p.lists[0].content_sha256, "b".repeat(64));
});

test("scrub: shadow mode records the would-block but never holds the call", async () => {
  const m = mockAdmin({ lists: [dbList("L1", "owner-A", "US-TX")], entries: [{ list_id: "L1", account_owner_id: "owner-A", phone_e164: "+12145550123" }] });
  const r = await scrubBeforeDial(mk(m, "shadow"), req);
  assert.equal(r.allow, true); assert.equal(r.wouldBlock, true); assert.equal(r.mode, "shadow");
  assert.equal(m.proofs[0].would_block, true); assert.equal(m.proofs[0].gate_mode, "shadow");
});

test("scrub: tenant isolation - another account's list and entries are never consulted", async () => {
  const m = mockAdmin({ lists: [dbList("L9", "owner-B", "US-TX")], entries: [{ list_id: "L9", account_owner_id: "owner-B", phone_e164: "+12145550123" }] });
  const r = await scrubBeforeDial(mk(m, "enforce"), req);
  assert.equal(r.allow, true); assert.equal(r.decision, "clear");
  for (const c of m.calls) assert.equal(c.filters.account_owner_id, "owner-A");
});

test("scrub: lookup failure fails CLOSED in enforce (retryable) and open in shadow, proof still written", async () => {
  const e = await scrubBeforeDial(mk(mockAdmin({ failTable: "dnc_registry_lists" }), "enforce"), req);
  assert.equal(e.allow, false); assert.equal(e.decision, "blocked_unavailable"); assert.equal(e.retryable, true); assert.ok(e.retryAt);
  const m = mockAdmin({ failTable: "dnc_state_rules" });
  const s = await scrubBeforeDial(mk(m, "shadow"), req);
  assert.equal(s.allow, true); assert.equal(m.proofs.length, 1);
});

test("scrub: proof write failure holds the call in enforce, not in shadow", async () => {
  const e = await scrubBeforeDial(mk(mockAdmin({ failProof: true }), "enforce"), req);
  assert.equal(e.allow, false); assert.equal(e.reasonCode, "PROOF_WRITE_FAILED"); assert.equal(e.proofId, null);
  const s = await scrubBeforeDial(mk(mockAdmin({ failProof: true }), "shadow"), req);
  assert.equal(s.allow, true);
});

test("scrub: invalid number is blocked (not retryable); internal DNC hit suppresses and is recorded", async () => {
  const bad = await scrubBeforeDial(mk(mockAdmin(), "enforce"), { ...req, phone: "abc" });
  assert.equal(bad.decision, "blocked_invalid_number"); assert.equal(bad.retryable, false);
  const m = mockAdmin();
  const hit = await scrubBeforeDial(mk(m, "enforce", { isInternallySuppressed: async () => true }), req);
  assert.equal(hit.decision, "suppressed"); assert.equal(m.proofs[0].internal_dnc_hit, true);
});

test("scrub: throwing dependencies never escape", async () => {
  const r = await scrubBeforeDial(mk(mockAdmin(), "enforce", { isInternallySuppressed: async () => { throw new Error("x"); } }), req);
  assert.equal(r.allow, false); assert.equal(r.decision, "blocked_unavailable");
});
