// supabase/functions/_shared/consumer-agent/handlers.ts
//
// Transport-independent core of the public Consumer Agent surface. All I/O goes through the injected PublicStore
// (the edge function wires it to Supabase RPCs; tests and the sandbox use in-memory stores), so every security
// rule below is unit-testable without a database.
//
// Order of checks for every tool call (cheap and safe first):
//   takedown -> rate limits -> argument validation -> tool logic. Write tool adds: anomaly assessment ->
//   proof-of-work (unknown agents) -> slot verification -> idempotent atomic insert.

import { canonicalJson } from "../agent-network/tools.ts";
import { computeFeedAvailability, type FeedSnapshot } from "../google-booking/availability.ts";
import { parseProfile, priceAnswer, type PublishedProfile } from "./profile.ts";
import { blocksAutoAccept } from "./sanitize.ts";
import {
  assessPrincipal, b64urlEncode, issueChallenge, limitsFor, POLICY, sha256Hex, verifyChallenge,
  type Limit, type Principal, type PrincipalStats,
} from "./security.ts";
import { CONSUMER_API_VERSION, getConsumerTool, SECTIONS, type ConsumerToolName } from "./spec.ts";

export interface CreateInput {
  slug: string; principal: string; principal_kind: Principal["kind"]; agent_name: string | null; idempotency_key: string; args_hash: string;
  service_type: string; requested_start: string; contact_name: string; contact_phone: string | null; contact_email: string | null;
  postal_code: string; address_line: string | null; description: string | null; risk_flags: string[]; ip_hash: string;
}
export type CreateResult =
  | { ok: true; replayed: boolean; request_id: string; status: "pending" | "held" | "accepted"; sla_due_at: string; hold_expires_at: string | null; expires_at: string }
  | { ok: false; error: string };

export interface LogEvent {
  slug: string; principal: string; ipHash: string; tool: string;
  outcome: "ok" | "invalid" | "denied" | "rate_limited" | "challenge_failed" | "blocked" | "error";
  errorCode?: string; flagged?: boolean; latencyMs?: number;
}

export interface PublicStore {
  profile(slug: string): Promise<unknown>;
  snapshot(slug: string): Promise<FeedSnapshot | null>;
  blockedStarts(slug: string): Promise<string[]>;
  areaCheck(slug: string, postal: string): Promise<"inside" | "outside" | "unknown">;
  /** Atomically counts every limit; allowed=false when ANY is exceeded. */
  hit(limits: Limit[]): Promise<{ allowed: boolean; retryAfter: number }>;
  isBlocked(ids: string[]): Promise<boolean>;
  block(principal: string, reasons: string[], hours: number): Promise<void>;
  stats(principal: string): Promise<PrincipalStats>;
  createRequest(input: CreateInput): Promise<CreateResult>;
  requestStatus(requestId: string): Promise<Record<string, unknown> | null>;
  log(e: LogEvent): Promise<void>;
}

export interface Ctx {
  slug: string;
  principal: Principal;
  ipHash: string;
  now: Date;
  store: PublicStore;
  secret: string;       // HMAC secret for challenges and status tokens
  urls: { statusBase: string };
}

export type Outcome =
  | { ok: true; data: Record<string, unknown>; status?: string }
  | { ok: false; code: string; message: string; retryAfter?: number; httpStatus: number; extra?: Record<string, unknown> };

const fail = (code: string, message: string, httpStatus: number, retryAfter?: number, extra?: Record<string, unknown>): Outcome =>
  ({ ok: false, code, message, httpStatus, retryAfter, extra });

const MESSAGES: Record<string, [string, number]> = {
  not_available: ["This business is not accepting agent requests right now.", 404],
  unknown_service: ["That service is not offered by this business.", 422],
  outside_service_area: ["The postal code is outside this business's service area.", 422],
  slot_unavailable: ["That time is no longer available. Call check_availability again and choose a returned time.", 409],
  daily_cap_reached: ["This business has reached its daily limit for agent requests. Try tomorrow or use the human booking page.", 429],
  idempotency_conflict: ["This idempotency_key was already used with different arguments. Use a new key.", 409],
  invalid: ["The request could not be processed.", 422],
};

export async function statusToken(secret: string, requestId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`status|${requestId}`)));
  return b64urlEncode(sig).slice(0, 43);
}

export async function verifyStatusId(secret: string, composite: string): Promise<string | null> {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(composite);
  if (!m) return null;
  const expected = await statusToken(secret, m[1].toLowerCase());
  return expected === m[2] ? m[1].toLowerCase() : null;
}

// ------------------------------------------------------------------
// Public (read) building blocks
// ------------------------------------------------------------------

export function projectProfile(p: PublishedProfile, sections: readonly string[] | undefined): Record<string, unknown> {
  const want = sections && sections.length ? new Set(sections) : new Set<string>(SECTIONS);
  const out: Record<string, unknown> = {
    schema: p.schema, slug: p.slug, name: p.name, timezone: p.timezone, request_mode: p.request_mode, published: p.published.filter((s) => want.has(s)),
  };
  for (const s of SECTIONS) if (want.has(s) && p.published.includes(s) && s !== "prices") {
    const key = s as Exclude<typeof s, "prices">;
    if (key === "services") out.services = p.services;
    if (key === "service_area") out.service_area = p.service_area;
    if (key === "hours") out.hours = p.hours;
    if (key === "reviews") out.reviews = p.reviews;
    if (key === "policies") out.policies = p.policies;
    if (key === "contact") out.contact = p.contact;
  }
  if (want.has("prices") && p.published.includes("prices")) out.prices = p.prices;
  return out;
}

const SLOT_TTL_MS = 120_000;

async function verifiedSlots(ctx: Ctx): Promise<{ ok: true; snap: FeedSnapshot; slots: { start: string; end: string; local_date: string; local_time: string }[]; timezone: string; duration: number } | { ok: false; reason: string }> {
  const snap = await ctx.store.snapshot(ctx.slug);
  if (!snap) return { ok: false, reason: "not_available" };
  const res = computeFeedAvailability(snap, ctx.now, { requirePublished: false, maxSlots: 400 });
  if (res.blocked || !res.timezone) return { ok: false, reason: res.blocked ?? "not_available" };
  const hidden = new Set(await ctx.store.blockedStarts(ctx.slug));
  const duration = snap.settings.duration_minutes > 0 ? snap.settings.duration_minutes : 60;
  const slots = res.slots.filter((s) => !hidden.has(s.start)).map((s) => ({
    start: s.start, end: new Date(Date.parse(s.start) + duration * 60_000).toISOString(), local_date: s.local_date, local_time: s.local_time,
  }));
  return { ok: true, snap, slots, timezone: res.timezone, duration };
}

// ------------------------------------------------------------------
// Tool execution
// ------------------------------------------------------------------

export async function runTool(ctx: Ctx, name: string, rawArgs: unknown): Promise<Outcome | { unknownTool: true }> {
  const def = getConsumerTool(name);
  if (!def) return { unknownTool: true };
  const t0 = Date.now();
  const base = { slug: ctx.slug, principal: ctx.principal.id, ipHash: ctx.ipHash, tool: def.name };
  const done = async (o: Outcome, outcome: LogEvent["outcome"], extra: Partial<LogEvent> = {}): Promise<Outcome> => {
    await ctx.store.log({ ...base, outcome, errorCode: o.ok ? undefined : o.code, latencyMs: Date.now() - t0, ...extra }).catch(() => undefined);
    return o;
  };

  try {
    if (await ctx.store.isBlocked([ctx.principal.id, ctx.ipHash])) {
      return await done(fail("blocked", "Access from this client is suspended. Contact the business directly.", 403), "blocked");
    }
    const rl = await ctx.store.hit(limitsFor(ctx.principal, ctx.slug, def.write, ctx.ipHash));
    if (!rl.allowed) return await done(fail("rate_limited", "Too many requests. Slow down and retry later.", 429, rl.retryAfter), "rate_limited");

    const v = def.validate(rawArgs ?? {});
    if (!v.ok) return await done(fail("invalid_arguments", v.error, 422), "invalid");
    const args = v.value;

    switch (def.name as ConsumerToolName) {
      case "get_business_info": {
        const p = parseProfile(await ctx.store.profile(ctx.slug));
        if (!p) return await done(fail("not_available", MESSAGES.not_available[0], 404), "denied");
        return await done({ ok: true, data: { api_version: CONSUMER_API_VERSION, business: projectProfile(p, args.sections as string[] | undefined) } }, "ok");
      }
      case "get_price_range": {
        const p = parseProfile(await ctx.store.profile(ctx.slug));
        if (!p) return await done(fail("not_available", MESSAGES.not_available[0], 404), "denied");
        return await done({ ok: true, data: priceAnswer(p, args.service as string | undefined) }, "ok");
      }
      case "check_availability": return await done(await checkAvailability(ctx, args), "ok");
      case "request_booking": {
        const o = await requestBooking(ctx, args);
        const flagged = Array.isArray(args.risk_flags) && (args.risk_flags as string[]).length > 0;
        return await done(o, o.ok ? "ok" : o.code === "challenge_required" || o.code === "challenge_failed" ? "challenge_failed" : o.code === "blocked" ? "blocked" : o.code === "rate_limited" ? "rate_limited" : "denied", { flagged });
      }
    }
    return await done(fail("unknown_tool", "Unknown tool.", 404), "error");
  } catch (e) {
    console.error(JSON.stringify({ event: "consumer_agent_tool_failed", tool: name, error: String((e as Error)?.message ?? e) }));
    return await done(fail("internal_error", "Something went wrong. Nothing was changed.", 500), "error");
  }
}

async function checkAvailability(ctx: Ctx, a: Record<string, unknown>): Promise<Outcome> {
  const prof = parseProfile(await ctx.store.profile(ctx.slug));
  const v = await verifiedSlots(ctx);
  if (!prof || !v.ok) return fail("not_available", MESSAGES.not_available[0], 404);

  if (typeof a.service_type === "string" && !v.snap.business.services.some((s) => s.trim().toLowerCase() === (a.service_type as string).toLowerCase())) {
    return fail("unknown_service", MESSAGES.unknown_service[0], 422);
  }
  let servesArea: boolean | null = null;
  if (typeof a.postal_code === "string") {
    const r = await ctx.store.areaCheck(ctx.slug, a.postal_code);
    servesArea = r === "unknown" ? null : r === "inside";
    if (r === "outside") return { ok: true, data: { serves_postal_code: false, slots: [], note: "This postal code is outside the business's service area." } };
  }
  const days = typeof a.days === "number" ? a.days : 7;
  const until = ctx.now.getTime() + days * 86_400_000;
  const slots = v.slots.filter((s) => Date.parse(s.start) <= until).slice(0, 40);

  let requested: Record<string, unknown> | undefined;
  if (typeof a.requested_start === "string") {
    const ok = v.slots.some((s) => s.start === a.requested_start);
    const near = [...v.slots].sort((x, y) => Math.abs(Date.parse(x.start) - Date.parse(a.requested_start as string)) - Math.abs(Date.parse(y.start) - Date.parse(a.requested_start as string))).slice(0, 3);
    requested = { available: ok, alternatives: ok ? [] : near };
  }
  return {
    ok: true,
    data: {
      timezone: v.timezone, slot_minutes: v.duration, serves_postal_code: servesArea,
      generated_at: ctx.now.toISOString(), valid_until: new Date(ctx.now.getTime() + SLOT_TTL_MS).toISOString(),
      request_mode: prof.request_mode, slots, requested,
      note: "Only times in `slots` can be requested. A request is not a confirmed appointment; the business must accept it.",
    },
  };
}

async function requestBooking(ctx: Ctx, a: Record<string, unknown>): Promise<Outcome> {
  const flags = (a.risk_flags as string[]) ?? [];

  // 1) Anomaly assessment BEFORE any expensive work.
  const stats = await ctx.store.stats(ctx.principal.id);
  const verdict = assessPrincipal(stats, ctx.principal.kind);
  if (verdict.action === "block") {
    await ctx.store.block(ctx.principal.id, verdict.reasons, 24);
    return fail("blocked", "Access from this client is suspended. Contact the business directly.", 403);
  }
  if (verdict.action === "throttle") return fail("rate_limited", "Too many unusual requests. Retry later.", 429, 600);

  // 2) Unknown agents must pay a small CPU cost; the difficulty rises with suspicious behaviour.
  if (ctx.principal.kind === "anonymous") {
    const c = a.challenge as { token: string; nonce: string } | null;
    if (!c) return fail("challenge_required", "Unsigned agents must solve the proof-of-work challenge: GET /v1/challenge, then pass {token, nonce} as arguments.challenge.", 401);
    const bits = verdict.action === "harder_challenge" ? POLICY.powHardBits : POLICY.powBaseBits;
    const check = await verifyChallenge(ctx.secret, c.token, c.nonce, bits, ctx.now);
    if (!check.ok) return fail("challenge_failed", `The challenge was rejected (${check.reason}). Request a new one from GET /v1/challenge.`, 401);
    const once = await ctx.store.hit([{ key: `pow:${check.id}`, windowSec: POLICY.powTtlSec + 60, max: 1 }]);
    if (!once.allowed) return fail("challenge_failed", "This challenge was already used. Request a new one.", 401);
  }

  // 3) The time must be one we would publish right now (verified windows minus held / contended slots).
  const v = await verifiedSlots(ctx);
  if (!v.ok) return fail("not_available", MESSAGES.not_available[0], 404);
  const start = a.requested_start as string;
  if (!v.slots.some((s) => s.start === start)) {
    const near = [...v.slots].sort((x, y) => Math.abs(Date.parse(x.start) - Date.parse(start)) - Math.abs(Date.parse(y.start) - Date.parse(start))).slice(0, 3);
    return fail("slot_unavailable", MESSAGES.slot_unavailable[0], 409, undefined, { alternatives: near });
  }

  // 4) Idempotent, atomic insert. The hash excludes the challenge (it legitimately differs on a retry).
  const { challenge: _c, ...semantic } = a;
  void _c;
  const argsHash = await sha256Hex(canonicalJson(semantic));
  const r = await ctx.store.createRequest({
    slug: ctx.slug, principal: ctx.principal.id, principal_kind: ctx.principal.kind,
    agent_name: (a.agent_name as string | null) ?? (ctx.principal.kind === "registered" ? ctx.principal.label : null),
    idempotency_key: a.idempotency_key as string, args_hash: argsHash,
    service_type: a.service_type as string, requested_start: start, contact_name: a.contact_name as string,
    contact_phone: (a.contact_phone as string | null) ?? null, contact_email: (a.contact_email as string | null) ?? null,
    postal_code: a.postal_code as string, address_line: (a.address_line as string | null) ?? null,
    description: (a.description as string | null) ?? null, risk_flags: flags, ip_hash: ctx.ipHash,
  });
  if (!r.ok) {
    const [message, http] = MESSAGES[r.error] ?? MESSAGES.invalid;
    return fail(MESSAGES[r.error] ? r.error : "invalid", message, http);
  }
  const token = await statusToken(ctx.secret, r.request_id);
  const accepted = r.status === "accepted";
  return {
    ok: true,
    status: r.status,
    data: {
      request_id: r.request_id, status: r.status, replayed: r.replayed,
      task_id: `${r.request_id}.${token}`, status_url: `${ctx.urls.statusBase}/${r.request_id}.${token}`,
      sla_due_at: r.sla_due_at, hold_expires_at: r.hold_expires_at, expires_at: r.expires_at,
      payment: "none_collected",
      message: accepted
        ? "The business accepted this request under its own pre-approved rules. Tell the homeowner it is scheduled by the business, not yet paid."
        : "Request received. It is NOT a confirmed appointment and no payment was taken. The business will accept or decline it and contact the homeowner.",
    },
  };
}

/** GET /v1/challenge: difficulty is raised for callers that already look unusual. */
export async function issueChallengeFor(ctx: Pick<Ctx, "store" | "ipHash" | "secret" | "now">) {
  const rl = await ctx.store.hit([{ key: `challenge:ip:${ctx.ipHash}`, windowSec: 60, max: POLICY.challengePerMinute }]);
  if (!rl.allowed) return fail("rate_limited", "Too many challenge requests.", 429, rl.retryAfter);
  const verdict = assessPrincipal(await ctx.store.stats(ctx.ipHash), "anonymous");
  if (verdict.action === "block") return fail("blocked", "Access from this client is suspended.", 403);
  const bits = verdict.action === "allow" ? POLICY.powBaseBits : POLICY.powHardBits;
  return { ok: true as const, data: await issueChallenge(ctx.secret, bits, ctx.now) as unknown as Record<string, unknown> };
}

/** Status for a request id + token (A2A tasks/get and GET /v1/requests/:id). PII-free. */
export async function getRequestStatus(ctx: Pick<Ctx, "store" | "secret">, composite: string): Promise<Outcome> {
  const id = await verifyStatusId(ctx.secret, composite);
  if (!id) return fail("not_found", "No such request.", 404);
  const row = await ctx.store.requestStatus(id);
  if (!row) return fail("not_found", "No such request.", 404);
  return { ok: true, data: { ...row, payment: "none_collected" } };
}

export { blocksAutoAccept };
