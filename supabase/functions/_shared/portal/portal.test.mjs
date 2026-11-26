// Run: node --experimental-strip-types --no-warnings --test supabase/functions/_shared/portal/portal.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PORTAL_STATES, TRANSITIONS, canTransition, assertTransition, isTerminal, validateRejection } from "./stateMachine.ts";
import { packetHash, idempotencyKey, buildSubject, oneLine, isSafeEmail } from "./idempotency.ts";
import { redactText, redactDeep, safeError, REDACTED } from "./redact.ts";
import { evaluateGate } from "./killSwitch.ts";
import { nextPollDelayMs, pollStopReason, POLL_BASE_MS, MAX_CONSECUTIVE_ERRORS } from "./pollSchedule.ts";
import { normalizeStatus } from "./statusNormalizer.ts";
import { MockPortalAdapter } from "./mockAdapter.ts";
import { GenericCxmlAdapter, buildInvoiceEnvelope, isSafeEndpoint, xmlEscape } from "./cxmlAdapter.ts";
import { parseRemittanceText, matchRemittance } from "./remittanceParser.ts";
import { sanitizeSecretInput, sealPortalSecrets, openPortalSecrets, portalKeys } from "./portalVault.ts";
import { runRecipe, validateRecipe } from "./recipe.ts";
import { buildCopyFields, readyForHuman, safeDeepLink, validateConfirmation } from "./packet.ts";

const packet = () => ({
  invoice_id: "inv-1", invoice_number: "INV-1001", po_number: "PO-77", total_cents: 150000, currency: "USD",
  issue_date: "2026-11-01", due_date: "2026-12-01", supplier: { name: "Acme HVAC" }, buyer: { name: "Big Property LLC" },
  lines: [{ description: "Compressor", quantity: 1, unit_cents: 150000 }],
  attachments: [{ name: "inv.pdf", sha256: "a".repeat(64), bytes: 1000 }], fields: { gl: "6100" },
});

// ---------- state machine ----------
test("state machine: every state is listed and terminals are exactly rejected/paid/cancelled", () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...PORTAL_STATES].sort());
  assert.deepEqual(PORTAL_STATES.filter(isTerminal).sort(), ["cancelled", "paid", "rejected"]);
});
test("state machine: legality", () => {
  assert.ok(canTransition("queued", "prepared"));
  assert.ok(canTransition("submitted", "rejected"));
  for (const bad of [["queued", "submitted"], ["paid", "queued"], ["rejected", "approved"], ["approved", "rejected"], ["submitting", "paid"]])
    assert.throws(() => assertTransition(bad[0], bad[1]), /illegal_transition/);
});
test("state machine: TS matrix equals the SQL matrix in the migration (drift guard)", () => {
  const sql = readFileSync(new URL("../../../migrations/20290401000000_customer_portal_submission.sql", import.meta.url), "utf8");
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    const m = new RegExp(`WHEN '${from}'\\s+THEN p_to IN \\(([^)]*)\\)`).exec(sql);
    if (tos.length === 0) { assert.ok(!m || m[1].trim() === "", `${from} must have no exits`); continue; }
    assert.ok(m, `SQL missing ${from}`);
    const sqlTos = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(sqlTos, [...tos].sort(), `matrix drift at ${from}`);
  }
});
test("rejection requires a reason", () => {
  assert.throws(() => validateRejection("  "), /rejection_reason_required/);
  assert.equal(validateRejection(" Missing PO "), "Missing PO");
});

// ---------- idempotency / subject ----------
test("packet hash is order-independent for attachments and key-order independent", async () => {
  const a = packet(); const b = { ...packet(), attachments: [{ name: "z.pdf", sha256: "b".repeat(64), bytes: 2 }, ...packet().attachments] };
  const c = { ...b, attachments: [...b.attachments].reverse() };
  assert.equal(await packetHash(b), await packetHash(c));
  assert.notEqual(await packetHash(a), await packetHash(b));
});
test("idempotency key is deterministic and request-scoped", async () => {
  const k1 = await idempotencyKey("u", "i", "h", "email", "r1");
  assert.equal(k1, await idempotencyKey("u", "i", "h", "email", "r1"));
  assert.notEqual(k1, await idempotencyKey("u", "i", "h", "email", "r2"));
  assert.notEqual(k1, await idempotencyKey("other", "i", "h", "email", "r1"));
});
test("subject is deterministic and header-injection safe", () => {
  const s = buildSubject({ invoiceNumber: "INV-1\r\nBcc: evil@x.com", poNumber: "PO-1", company: "Acme\n" });
  assert.ok(!/[\r\n]/.test(s));
  assert.equal(s, buildSubject({ invoiceNumber: "INV-1\r\nBcc: evil@x.com", poNumber: "PO-1", company: "Acme\n" }));
  assert.equal(buildSubject({ invoiceNumber: "A1", company: "Co" }), "Invoice A1 | Co");
  assert.ok(!isSafeEmail("a@b.com\nBcc:x@y.com")); assert.ok(isSafeEmail("ap@customer.com"));
  assert.equal(oneLine("a\u2028b"), "a b");
});

// ---------- redaction ----------
test("redaction removes secrets from text, objects and errors", () => {
  const pw = "S3cr3t-Pa55!";
  assert.ok(!redactText(`login failed for password=${pw} and Bearer abcdefghijkl`, [pw]).includes(pw));
  const o = redactDeep({ user: "bob", password: pw, nested: { api_key: "k", note: `x ${pw}` } }, [pw]);
  assert.equal(o.password, REDACTED); assert.equal(o.nested.api_key, REDACTED); assert.ok(!JSON.stringify(o).includes(pw));
  assert.ok(!safeError(new Error(`boom ${pw}`), [pw]).includes(pw));
});

// ---------- kill switch ----------
const gate = (o = {}) => evaluateGate({ globalAutomationEnabled: true, globalKill: false, accountEnabled: true, accountChannelEnabled: true, accountAutomationKill: false, profileAutomationKill: false, channel: "automation", consentActive: true, ...o });
test("gate defaults deny and every kill wins", () => {
  assert.equal(gate().allowed, true);
  for (const [o, r] of [[{ globalKill: true }, "global_kill_switch"], [{ accountEnabled: false }, "feature_disabled"], [{ accountChannelEnabled: false }, "channel_disabled"],
    [{ globalAutomationEnabled: false }, "automation_not_enabled_platform"], [{ accountAutomationKill: true }, "account_kill_switch"],
    [{ profileAutomationKill: true }, "portal_kill_switch"], [{ consentActive: false }, "consent_required"]])
    assert.deepEqual(gate(o), { allowed: false, reason: r });
  assert.equal(gate({ channel: "email", consentActive: false, globalAutomationEnabled: false }).allowed, true);
});

// ---------- polling ----------
test("poll delay: jitter bounds, backoff growth, caps, stop conditions", () => {
  assert.ok(nextPollDelayMs(0, () => 0) >= POLL_BASE_MS * 0.8 - 1 && nextPollDelayMs(0, () => 0.999) <= POLL_BASE_MS * 1.2 + 1);
  assert.ok(nextPollDelayMs(3, () => 0.5) > nextPollDelayMs(0, () => 0.5));
  assert.ok(nextPollDelayMs(50, () => 0.999) <= 48 * 60 * 60_000 * 1.2 + 1);
  const base = { attempts: 0, consecutiveErrors: 0, createdAtMs: 0, terminal: false };
  assert.equal(pollStopReason(base, 1000), null);
  assert.equal(pollStopReason({ ...base, terminal: true }, 1), "terminal");
  assert.equal(pollStopReason({ ...base, consecutiveErrors: MAX_CONSECUTIVE_ERRORS }, 1), "too_many_errors");
  assert.equal(pollStopReason(base, 121 * 24 * 3600_000), "too_old");
});

// ---------- status normaliser ----------
test("status normalisation: profile map wins, unknown never maps", () => {
  assert.deepEqual(normalizeStatus("Payment Scheduled"), { kind: "state", state: "scheduled_for_payment", raw: "Payment Scheduled" });
  assert.equal(normalizeStatus("Weird", { weird: "rejected" }).state, "rejected");
  assert.equal(normalizeStatus("Ready to ship").kind, "unknown");
  assert.equal(normalizeStatus("x", { x: "not_a_state" }).kind, "unknown");
});

// ---------- mock adapter ----------
test("mock adapter: validate, idempotent submit, status, failure modes", async () => {
  const a = new MockPortalAdapter();
  assert.deepEqual(a.validate(packet()), []);
  assert.ok(a.validate({ ...packet(), attachments: [] }).some((i) => i.field === "attachments"));
  const r1 = await a.submit(packet(), "k"); const r2 = await a.submit(packet(), "k");
  assert.equal(r1.reference, r2.reference);
  a.setStatus(r1.reference, "Rejected", "Missing PO");
  assert.deepEqual(await a.getStatus(r1.reference), { ok: true, rawStatus: "Rejected", rejectionReason: "Missing PO", retryable: false });
  a.failNextSubmit = "transient"; assert.equal((await a.submit(packet(), "k2")).retryable, true);
  assert.equal(a.capabilities().verified_against_vendor, false);
});

// ---------- cXML adapter (fixtures only) ----------
const cfg = { endpoint: "https://ap.example.com/cxml", fromIdentity: "ACME", toIdentity: "BIGPROP", senderSecret: "s3cret-shared", payloadIdPrefix: "vireek-", now: () => new Date("2026-11-23T00:00:00Z") };
test("cXML envelope is well-formed, escaped and has no injection", () => {
  const p = { ...packet(), lines: [{ description: `Part <b>&"x"`, quantity: 2, unit_cents: 5000 }], total_cents: 10000 };
  const x = buildInvoiceEnvelope(p, cfg, "a".repeat(40));
  assert.ok(x.includes("Part &lt;b&gt;&amp;&quot;x&quot;") && !x.includes("<b>"));
  assert.ok(x.includes('invoiceID="INV-1001"') && x.includes('orderID="PO-77"') && x.includes("<Money currency=\"USD\">50.00</Money>"));
  assert.equal(xmlEscape("a\u0000b"), "ab");
});
test("cXML adapter: endpoint guard, success, 5xx retryable, 4xx permanent, transport error", async () => {
  for (const bad of ["http://x.com", "https://localhost/x", "https://10.0.0.1/x", "https://u:p@x.com/", "ftp://x"]) assert.equal(isSafeEndpoint(bad), false);
  const mk = (res) => new GenericCxmlAdapter(cfg, { post: async () => res() }, async () => null);
  assert.equal((await mk(() => ({ status: 200, text: '<cXML><Response><Status code="200" text="OK">OK</Status></Response></cXML>' })).submit(packet(), "k".repeat(40))).ok, true);
  assert.equal((await mk(() => ({ status: 503, text: "" })).submit(packet(), "k")).retryable, true);
  assert.equal((await mk(() => ({ status: 400, text: "" })).submit(packet(), "k")).retryable, false);
  assert.equal((await mk(() => { throw new Error("net"); }).submit(packet(), "k")).retryable, true);
  const unsafe = new GenericCxmlAdapter({ ...cfg, endpoint: "http://x" }, { post: async () => { throw new Error("must not call"); } }, async () => null);
  assert.equal((await unsafe.submit(packet(), "k")).error, "validation_failed");
});

// ---------- remittance ----------
test("remittance: rule parse + matching; unparsed text requires confirmation", () => {
  const doc = "Remittance Advice\nPayment ref: ACH-998877\nDate 2026-11-20 USD\nInvoice INV-1001   $1,500.00\nInvoice INV-1002   200.00\nInvoice NOPE-1  10.00";
  const r = parseRemittanceText(doc);
  assert.equal(r.payment_ref, "ACH-998877"); assert.equal(r.paid_on, "2026-11-20"); assert.equal(r.lines[0].amount_cents, 150000);
  assert.equal(r.requires_confirmation, false);
  const m = matchRemittance(r.lines, [{ id: "1", invoice_number: "INV-1001", total_cents: 150000, already_paid_via_remittance: false }, { id: "2", invoice_number: "INV-1002", total_cents: 25000, already_paid_via_remittance: false }]);
  assert.deepEqual(m.map((x) => x.status), ["matched", "amount_mismatch", "unmatched"]);
  assert.equal(matchRemittance([r.lines[0], r.lines[0]], [{ id: "1", invoice_number: "INV-1001", total_cents: 150000, already_paid_via_remittance: false }])[1].status, "duplicate");
  assert.equal(parseRemittanceText("gibberish").requires_confirmation, true);
});

// ---------- vault ----------
test("vault: round-trip, AAD binds account+profile, wrong key fails, ciphertext has no plaintext, input is sanitised", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const tok = await sealPortalSecrets({ username: "bob", password: "hunter2-hunter2" }, key, "user-A", "prof-1");
  assert.ok(tok.startsWith("v2.") && !tok.includes("hunter2"));
  assert.deepEqual(await openPortalSecrets(tok, [key], "user-A", "prof-1"), { username: "bob", password: "hunter2-hunter2" });
  await assert.rejects(openPortalSecrets(tok, [key], "user-B", "prof-1"), /credential_decrypt_failed/);
  await assert.rejects(openPortalSecrets(tok, [key], "user-A", "prof-2"), /credential_decrypt_failed/);
  await assert.rejects(openPortalSecrets(tok, [Buffer.alloc(32, 9).toString("base64")], "user-A", "prof-1"), /credential_decrypt_failed/);
  assert.throws(() => sanitizeSecretInput({ cookie: "x" }), /secret_field_not_allowed/);
  assert.throws(() => sanitizeSecretInput({ password: "  " }), /secret_empty/);
  assert.deepEqual(portalKeys((k) => ({ PROVIDER_CREDENTIALS_KEY: key })[k]), [key]);
  assert.deepEqual(portalKeys(() => undefined), []);
});

// ---------- recipe runner against a fake driver ----------
function fakeDriver(over = {}) {
  const log = []; const present = new Set(["#u", "#p", "#inv", "#send", "#ref", "#msg"]);
  const d = { log, present, challenge: null, host: "127.0.0.1:4010", typed: [],
    goto: async (u) => { log.push(["goto", u]); }, currentHost: async () => d.host, exists: async (s) => d.present.has(s),
    fill: async (s, t) => { d.typed.push([s, t]); log.push(["fill", s]); }, click: async (s) => { log.push(["click", s]); }, text: async (s) => (s === "#ref" ? "REF-123" : "Submitted OK"),
    screenshot: async (n, mask) => { log.push(["shot", n, mask]); return `evidence/${n}.png`; }, detectChallenge: async () => d.challenge, ...over };
  return d;
}
const recipe = () => ({ id: "mock", version: 1, allowedHosts: ["127.0.0.1:4010"], steps: [
  { kind: "goto", url: "http://127.0.0.1:4010/login" }, { kind: "fill", selector: "#u", value: { secret: "username" } }, { kind: "fill", selector: "#p", value: { secret: "password" } },
  { kind: "fill", selector: "#inv", value: { field: "invoice_number" } }, { kind: "screenshot", name: "before submit" }, { kind: "approvalGate" },
  { kind: "click", selector: "#send", mutates: true }, { kind: "captureRef", selector: "#ref" }] });
const ctx = (o = {}) => ({ fields: { invoice_number: "INV-1" }, secrets: { username: "bob", password: "hunter2-hunter2" }, dryRun: false, requireApproval: true, approved: true, isHalted: async () => false, onEvent: (e) => ctx.events.push(e), ...o });
ctx.events = [];
const L = { allowInsecureLocalhost: true };

test("recipe: validation rejects scripting kinds, bad hosts, http, un-gated mutations", () => {
  assert.ok(validateRecipe({ ...recipe(), steps: [{ kind: "evaluate", code: "x" }] }, L)[0].includes("kind_not_allowed"));
  assert.ok(validateRecipe({ ...recipe(), allowedHosts: ["other.com"] }, L).some((e) => e.includes("host_not_allowed")));
  assert.ok(validateRecipe(recipe()).some((e) => e.includes("https_required")));
  assert.ok(validateRecipe({ ...recipe(), steps: [{ kind: "click", selector: "#x", mutates: true }] }, L).some((e) => e.includes("needs_approval_gate")));
});
test("recipe: happy path captures reference; secrets typed but never in events/results/screenshot names; password masked", async () => {
  ctx.events = []; const d = fakeDriver(); const r = await runRecipe(recipe(), d, ctx(), L);
  assert.equal(r.status, "succeeded"); assert.equal(r.reference, "REF-123");
  const blob = JSON.stringify([ctx.events, r, d.log.filter((x) => x[0] === "shot")]);
  assert.ok(!blob.includes("hunter2") && !blob.includes("bob"));
  assert.ok(d.log.find((x) => x[0] === "shot")[2].includes('input[type="password"]'));
  assert.equal(d.typed.length, 3);
});
test("recipe: approval gate pauses before the mutating click (default ON)", async () => {
  const d = fakeDriver(); const r = await runRecipe(recipe(), d, ctx({ approved: false }), L);
  assert.deepEqual([r.status, r.reason], ["paused_human", "approval_required"]); assert.ok(!d.log.some((x) => x[0] === "click"));
});
test("recipe: dry-run never types or clicks mutations", async () => {
  const d = fakeDriver(); const r = await runRecipe(recipe(), d, ctx({ dryRun: true, approved: false }), L);
  assert.equal(r.status, "dry_run_complete"); assert.equal(d.typed.length, 0); assert.ok(!d.log.some((x) => x[0] === "click"));
});
test("recipe: drift (selector missing) fails safe, once, no retries", async () => {
  const d = fakeDriver(); d.present.delete("#inv"); let calls = 0; const o = { ...d, exists: async (s) => { if (s === "#inv") calls++; return d.present.has(s); } };
  const r = await runRecipe(recipe(), o, ctx(), L);
  assert.deepEqual([r.status, r.step, r.reason], ["drift", 3, "selector_missing"]); assert.equal(calls, 1); assert.ok(!d.log.some((x) => x[0] === "click"));
});
test("recipe: MFA and CAPTCHA pause for a human, nothing is typed after", async () => {
  for (const kind of ["mfa", "captcha"]) {
    const d = fakeDriver({ detectChallenge: async () => kind }); const r = await runRecipe(recipe(), d, ctx(), L);
    assert.deepEqual([r.status, r.reason], ["paused_human", kind]); assert.equal(d.typed.length, 0);
  }
});
test("recipe: kill switch flipped mid-run stops in-flight work before the next step", async () => {
  const d = fakeDriver(); let halted = false; const o = { ...d, fill: async (s, t) => { d.typed.push([s, t]); halted = true; } };
  const r = await runRecipe(recipe(), o, ctx({ isHalted: async () => halted }), L);
  assert.equal(r.status, "halted"); assert.equal(d.typed.length, 1); assert.ok(!d.log.some((x) => x[0] === "click"));
});
test("recipe: navigating off the allow-list aborts", async () => {
  const d = fakeDriver({ currentHost: async () => "evil.example" }); assert.equal((await runRecipe(recipe(), d, ctx(), L)).reason, "host_not_allowed");
});
test("recipe: a driver error never leaks and does not retry", async () => {
  const d = fakeDriver({ click: async () => { throw new Error("password=hunter2-hunter2"); } }); const r = await runRecipe(recipe(), d, ctx(), L);
  assert.deepEqual([r.status, r.reason], ["failed", "driver_error"]); assert.ok(!JSON.stringify(r).includes("hunter2"));
});

// ---------- assisted packet ----------
test("assisted: copy fields flag missing required values; deep links must be https; confirmation needs ref or evidence", () => {
  const cfgp = { required_fields: [{ key: "inv", label: "Invoice #", source: "invoice_number", required: true }, { key: "amt", label: "Amount", source: "total_cents", required: true }, { key: "gl", label: "GL", source: "fields.gl", required: true }, { key: "x", label: "X", source: "fields.nope", required: true }], checklist: [], status_map: {} };
  const f = buildCopyFields(packet(), cfgp);
  assert.equal(f[1].value, "1500.00"); assert.equal(f[3].missing, true); assert.equal(readyForHuman(f), false);
  assert.equal(safeDeepLink("javascript:alert(1)"), null); assert.equal(safeDeepLink("http://x.com"), null); assert.ok(safeDeepLink("https://portal.example.com/a"));
  assert.equal(validateConfirmation({}), "reference_or_evidence_required"); assert.equal(validateConfirmation({ reference: "R1" }), null);
});
