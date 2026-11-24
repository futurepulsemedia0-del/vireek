import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripe, StripeApiError } from "./stripe.ts";

/**
 * Homeowner payment protection — the only code that talks to Stripe for this feature.
 * Design: docs/payments/homeowner-payment-protection.md. Mechanism: card authorization hold only
 * (PaymentIntent capture_method=manual, direct charge on the contractor's connected account). Never platform-held funds.
 *
 * Callers (all authenticated inside this function; verify_jwt = false in config.toml):
 *   contractor / staff : Authorization: Bearer <user JWT>   actions: create, send_request, claim_completion, void, respond, staff_resolve
 *   homeowner          : { token }                           actions: view, authorize, sync, confirm, dispute
 *   scheduler          : X-Cron-Secret: PAYMENT_PROTECTION_CRON_SECRET   action: tick
 * Authorization rules live in the SQL RPCs (tenant scope, billing permission, staff check, state machine).
 * Pattern for every Stripe side effect: commit the state change first (capturing / voiding), then call Stripe with a
 * deterministic Idempotency-Key, then record the result. A crash in between is repaired by `tick`, never by guessing.
 */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const REASONS = ["work_not_done", "work_incomplete", "quality", "no_show", "price_mismatch", "other"];
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ fn: "payment-protection", event, ...fields }));

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Maps SQL error messages (stable pp_* prefixes and SQLSTATEs) to HTTP statuses. */
function mapDbError(e: { message?: string; code?: string }): HttpError {
  const m = e.message ?? "";
  if (m.startsWith("pp_feature_disabled")) return new HttpError(403, "Payment protection is not available.");
  if (m.startsWith("pp_invalid_transition") || m.startsWith("pp_hold_exists") || e.code === "23505") return new HttpError(409, m.replace(/^pp_[a-z_]+:?\s*/, "") || "That action is not allowed in the current state.");
  if (m.startsWith("pp_hold_not_found") || m.startsWith("pp_job_not_found") || m.startsWith("pp_no_open_dispute") || e.code === "P0002") return new HttpError(404, "Not found.");
  if (m.startsWith("pp_")) return new HttpError(422, m);
  if (e.code === "42501") return new HttpError(403, "You don't have permission to do that.");
  if (e.code === "28000") return new HttpError(401, "Invalid or expired session.");
  if (e.code === "22023") return new HttpError(400, m);
  log("db_error", { code: e.code, message: m.slice(0, 200) });
  return new HttpError(500, "Something went wrong.");
}

interface Ctx { admin: SupabaseClient; secretKey: string; siteUrl: string; linkTtlHours: number }

type Hold = {
  id: string; state: string; amount_cents: number; currency: string; stripe_account_id: string;
  checkout_session_id: string | null; payment_intent_id: string | null; capture_amount_cents: number | null;
  capture_before: string | null; token_expires_at: string | null;
};

async function loadHold(ctx: Ctx, id: string): Promise<Hold> {
  const { data, error } = await ctx.admin.from("payment_protection_holds")
    .select("id,state,amount_cents,currency,stripe_account_id,checkout_session_id,payment_intent_id,capture_amount_cents,capture_before,token_expires_at")
    .eq("id", id).maybeSingle();
  if (error) throw mapDbError(error);
  if (!data) throw new HttpError(404, "Not found.");
  return data as Hold;
}

async function transition(ctx: Ctx, holdId: string, event: string, actor: string, idem: string, patch: Record<string, unknown> = {}, detail: Record<string, unknown> = {}, actorId: string | null = null) {
  const { data, error } = await ctx.admin.rpc("pp_apply_transition", {
    p_hold: holdId, p_event: event, p_actor_kind: actor, p_actor: actorId, p_idem: idem, p_patch: patch, p_detail: detail,
  });
  if (error) throw mapDbError(error);
  return data as { status: string; state: string };
}

// ---------------------------------------------------------------- Stripe side effects

async function driveCapture(ctx: Ctx, holdId: string): Promise<string> {
  const hold = await loadHold(ctx, holdId);
  if (hold.state !== "capturing") return hold.state;
  if (!hold.payment_intent_id) { await transition(ctx, holdId, "capture_failed", "system", "capture_failed", {}, { reason: "no_payment_intent" }); return "needs_review"; }
  const amount = hold.capture_amount_cents ?? hold.amount_cents;
  try {
    const pi = await stripe<any>("GET", `payment_intents/${hold.payment_intent_id}`, ctx.secretKey, { account: hold.stripe_account_id });
    let done = pi;
    if (pi.status === "requires_capture") {
      done = await stripe<any>("POST", `payment_intents/${hold.payment_intent_id}/capture`, ctx.secretKey, {
        account: hold.stripe_account_id, params: { amount_to_capture: amount }, idempotencyKey: `pp-capture-${hold.id}-${amount}`,
      });
    }
    if (done.status !== "succeeded") throw new StripeApiError(409, "payment_intent_unexpected_state", `PaymentIntent is ${done.status}`);
    await transition(ctx, holdId, "capture_succeeded", "system", "capture_succeeded",
      { amount_captured_cents: done.amount_received ?? amount, charge_id: typeof done.latest_charge === "string" ? done.latest_charge : undefined },
      { amount_captured_cents: done.amount_received ?? amount });
    log("captured", { hold: holdId });
    return "released";
  } catch (e) {
    if (e instanceof StripeApiError && e.definitive) {
      await transition(ctx, holdId, "capture_failed", "system", "capture_failed", {}, { code: e.code, message: e.message.slice(0, 200) });
      log("capture_failed", { hold: holdId, code: e.code });
      return "needs_review";
    }
    // Unknown outcome (timeout / 5xx): stay in `capturing`. tick retries with the same Idempotency-Key.
    log("capture_ambiguous", { hold: holdId });
    return "capturing";
  }
}

async function driveVoid(ctx: Ctx, holdId: string): Promise<string> {
  const hold = await loadHold(ctx, holdId);
  if (hold.state !== "voiding") return hold.state;
  try {
    if (hold.payment_intent_id) {
      const pi = await stripe<any>("GET", `payment_intents/${hold.payment_intent_id}`, ctx.secretKey, { account: hold.stripe_account_id });
      if (pi.status === "requires_capture") {
        await stripe("POST", `payment_intents/${hold.payment_intent_id}/cancel`, ctx.secretKey, {
          account: hold.stripe_account_id, params: { cancellation_reason: "requested_by_customer" }, idempotencyKey: `pp-void-${hold.id}`,
        });
      } else if (pi.status !== "canceled") {
        throw new StripeApiError(409, "payment_intent_unexpected_state", `PaymentIntent is ${pi.status}`);
      }
    }
    await transition(ctx, holdId, "void_succeeded", "system", "void_succeeded");
    return "voided";
  } catch (e) {
    if (e instanceof StripeApiError && e.definitive) {
      await transition(ctx, holdId, "void_failed", "system", "void_failed", {}, { code: e.code, message: e.message.slice(0, 200) });
      return "needs_review";
    }
    return "voiding";
  }
}

/** Reads the checkout session / PaymentIntent and records the authorization. Trusts nothing in the browser. */
async function syncAuthorization(ctx: Ctx, holdId: string, actor: "homeowner" | "system"): Promise<string> {
  const hold = await loadHold(ctx, holdId);
  if (hold.state !== "awaiting_authorization" || !hold.checkout_session_id) return hold.state;
  const session = await stripe<any>("GET", `checkout/sessions/${hold.checkout_session_id}`, ctx.secretKey, { account: hold.stripe_account_id });
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!piId) return hold.state; // not paid yet
  const pi = await stripe<any>("GET", `payment_intents/${piId}`, ctx.secretKey, { account: hold.stripe_account_id, params: { expand: ["latest_charge"] } });

  const matches = pi.metadata?.pp_hold_id === hold.id && pi.amount === hold.amount_cents && String(pi.currency).toLowerCase() === hold.currency
    && pi.capture_method === "manual" && session.metadata?.pp_hold_id === hold.id;
  if (!matches) {
    log("authorization_mismatch", { hold: hold.id });
    await transition(ctx, hold.id, "authorization_failed", "system", "authorization_failed", {}, { reason: "mismatch" });
    return "failed";
  }
  if (pi.status === "canceled") {
    await transition(ctx, hold.id, "authorization_failed", "system", "authorization_failed", {}, { reason: "canceled" });
    return "failed";
  }
  if (pi.status !== "requires_capture") return hold.state;

  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const captureBefore: number | undefined = charge?.payment_method_details?.card?.capture_before;
  if (!captureBefore) {
    // Without a Stripe-reported expiry we cannot honour the "never outlive the hold" rule: release the card and fail.
    await stripe("POST", `payment_intents/${piId}/cancel`, ctx.secretKey, { account: hold.stripe_account_id, params: { cancellation_reason: "abandoned" }, idempotencyKey: `pp-noexp-${hold.id}` }).catch(() => undefined);
    await transition(ctx, hold.id, "authorization_failed", "system", "authorization_failed", {}, { reason: "no_capture_before" });
    return "failed";
  }
  await transition(ctx, hold.id, "authorized", actor, "authorized",
    { payment_intent_id: piId, charge_id: charge?.id, capture_before: new Date(captureBefore * 1000).toISOString() });
  log("authorized", { hold: hold.id });
  return "held";
}

// ---------------------------------------------------------------- handlers

async function homeownerHandler(ctx: Ctx, body: Record<string, unknown>) {
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new HttpError(404, "Not found.");
  const { data: view, error } = await ctx.admin.rpc("pp_hold_by_token", { p_token_hash: await sha256hex(token) });
  if (error) throw mapDbError(error);
  if (!view) throw new HttpError(404, "Not found.");
  const holdId = view.id as string;
  const action = String(body.action);

  const publicView = async () => {
    const { data } = await ctx.admin.rpc("pp_hold_by_token", { p_token_hash: await sha256hex(token) });
    if (!data) return null;
    const { stripe_account_id: _a, checkout_session_id: _c, payment_intent_id: _p, ...safe } = data;
    return safe;
  };

  if (action === "view") return { hold: await publicView() };

  if (action === "authorize") {
    const { data: enabled } = await ctx.admin.rpc("pp_is_enabled");
    if (!enabled) throw new HttpError(403, "Payment protection is not available.");
    if (view.state !== "awaiting_authorization") throw new HttpError(409, "This request can no longer be authorized.");
    const hold = await loadHold(ctx, holdId);
    if (hold.checkout_session_id) {
      // Never open a second card hold while the first session might still be (or have been) paid.
      const existing = await stripe<any>("GET", `checkout/sessions/${hold.checkout_session_id}`, ctx.secretKey, { account: hold.stripe_account_id });
      if (existing.status === "open" && existing.url) return { url: existing.url };
      if (existing.status === "complete") {
        const state = await syncAuthorization(ctx, hold.id, "homeowner");
        throw new HttpError(409, state === "held" ? "Your payment is already protected." : "Your payment is being confirmed. Please check again in a moment.");
      }
    }
    const bucket = Math.floor(Date.now() / 300_000);
    const session = await stripe<any>("POST", "checkout/sessions", ctx.secretKey, {
      account: hold.stripe_account_id,
      idempotencyKey: `pp-cs-${hold.id}-${bucket}`,
      params: {
        mode: "payment",
        payment_method_types: ["card"],
        client_reference_id: hold.id,
        metadata: { pp_hold_id: hold.id },
        line_items: [{ quantity: 1, price_data: { currency: hold.currency, unit_amount: hold.amount_cents, product_data: { name: "Service payment (held until you confirm the work)" } } }],
        payment_intent_data: { capture_method: "manual", metadata: { pp_hold_id: hold.id } },
        success_url: `${ctx.siteUrl}/protect/${token}?returned=1`,
        cancel_url: `${ctx.siteUrl}/protect/${token}`,
      },
    });
    const { error: upErr } = await ctx.admin.from("payment_protection_holds").update({ checkout_session_id: session.id }).eq("id", hold.id).eq("state", "awaiting_authorization");
    if (upErr) throw mapDbError(upErr);
    return { url: session.url };
  }

  if (action === "sync") {
    const state = await syncAuthorization(ctx, holdId, "homeowner");
    return { state, hold: await publicView() };
  }

  if (action === "confirm") {
    const r = await transition(ctx, holdId, "homeowner_confirm", "homeowner", "homeowner_confirm");
    const state = r.state === "capturing" ? await driveCapture(ctx, holdId) : r.state;
    return { state };
  }

  if (action === "dispute") {
    const reason = String(body.reason ?? "");
    const statement = String(body.statement ?? "").trim();
    if (!REASONS.includes(reason)) throw new HttpError(400, "Choose a reason.");
    if (statement.length < 10 || statement.length > 2000) throw new HttpError(400, "Please describe the problem in 10 to 2000 characters.");
    const { data, error: dErr } = await ctx.admin.rpc("pp_open_dispute", { p_hold: holdId, p_reason: reason, p_statement: statement });
    if (dErr) throw mapDbError(dErr);
    return { state: (data as { state: string }).state };
  }

  throw new HttpError(400, "Unknown action.");
}

async function userHandler(ctx: Ctx, jwt: string, body: Record<string, unknown>) {
  const caller = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
  });
  const { data: u, error: uErr } = await caller.auth.getUser(jwt);
  if (uErr || !u?.user) throw new HttpError(401, "Invalid or expired session.");
  const action = String(body.action);
  const holdId = typeof body.hold_id === "string" ? body.hold_id : "";
  const uuid = /^[0-9a-f-]{36}$/i;
  const rpc = async <T>(fn: string, args: Record<string, unknown>) => {
    const { data, error } = await caller.rpc(fn, args);
    if (error) throw mapDbError(error);
    return data as T;
  };

  switch (action) {
    case "create": {
      const amount = Number(body.amount_cents);
      if (!uuid.test(String(body.job_id)) || !Number.isSafeInteger(amount)) throw new HttpError(400, "job_id and a whole-number amount_cents are required.");
      const id = await rpc<string>("pp_create_hold", { p_job_id: body.job_id, p_amount_cents: amount, p_currency: String(body.currency ?? "usd") });
      return { hold_id: id };
    }
    case "send_request": {
      if (!uuid.test(holdId)) throw new HttpError(400, "hold_id required.");
      const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const expires = new Date(Date.now() + ctx.linkTtlHours * 3_600_000).toISOString();
      await rpc("pp_issue_token", { p_hold: holdId, p_token_hash: await sha256hex(token), p_expires: expires });
      return { url: `${ctx.siteUrl}/protect/${token}`, expires_at: expires };
    }
    case "claim_completion": {
      if (!uuid.test(holdId)) throw new HttpError(400, "hold_id required.");
      const r = await rpc<{ state: string }>("pp_claim_completion", { p_hold: holdId });
      return { state: r.state };
    }
    case "void": {
      if (!uuid.test(holdId)) throw new HttpError(400, "hold_id required.");
      const r = await rpc<{ state: string }>("pp_contractor_void", { p_hold: holdId });
      return { state: r.state === "voiding" ? await driveVoid(ctx, holdId) : r.state };
    }
    case "respond": {
      if (!uuid.test(holdId)) throw new HttpError(400, "hold_id required.");
      await rpc("pp_contractor_respond", { p_hold: holdId, p_body: String(body.body ?? "").trim() });
      return { ok: true };
    }
    case "staff_resolve": {
      if (!uuid.test(holdId)) throw new HttpError(400, "hold_id required.");
      const resolution = String(body.resolution);
      const r = await rpc<{ state: string }>("staff_pp_resolve_dispute", {
        p_hold: holdId, p_resolution: resolution, p_amount_cents: body.amount_cents == null ? null : Number(body.amount_cents), p_note: String(body.note ?? ""),
      });
      const state = r.state === "voiding" ? await driveVoid(ctx, holdId) : await driveCapture(ctx, holdId);
      return { state };
    }
    default:
      throw new HttpError(400, "Unknown action.");
  }
}

async function tick(ctx: Ctx) {
  const { data, error } = await ctx.admin.rpc("pp_due_work");
  if (error) throw mapDbError(error);
  const work = data as Record<string, string[]>;
  const out: Record<string, number> = {};
  const errors: Array<{ hold: string; step: string; message: string }> = [];
  const each = async (step: string, ids: string[], fn: (id: string) => Promise<unknown>) => {
    out[step] = 0;
    for (const id of ids ?? []) {
      try { await fn(id); out[step]++; } catch (e) { errors.push({ hold: id, step, message: (e as Error).message.slice(0, 200) }); }
    }
  };
  await each("reconcile_authorization", work.reconcile_authorization, (id) => syncAuthorization(ctx, id, "system"));
  await each("auto_release", work.auto_release, async (id) => { await transition(ctx, id, "auto_release", "system", "auto_release"); await driveCapture(ctx, id); });
  await each("drive_capturing", work.drive_capturing, (id) => driveCapture(ctx, id));
  await each("drive_voiding", work.drive_voiding, (id) => driveVoid(ctx, id));
  await each("expire", work.expire, async (id) => {
    let hold = await loadHold(ctx, id);
    const now = Date.now();
    if (hold.state === "awaiting_authorization") {
      if (!hold.token_expires_at || new Date(hold.token_expires_at).getTime() > now) return;
      // If the homeowner paid but never came back, record it instead of expiring (and orphaning a card hold).
      if (hold.checkout_session_id) {
        await syncAuthorization(ctx, id, "system");
        hold = await loadHold(ctx, id);
        if (hold.state !== "awaiting_authorization") return;
      }
    } else {
      if (!["held", "completion_claimed", "disputed"].includes(hold.state)) return;
      if (!hold.capture_before || new Date(hold.capture_before).getTime() > now) return;
      if (hold.payment_intent_id) {
        // Never expire a hold Stripe still reports as capturable (clock skew): let a later tick decide.
        const pi = await stripe<any>("GET", `payment_intents/${hold.payment_intent_id}`, ctx.secretKey, { account: hold.stripe_account_id });
        if (pi.status === "requires_capture" && new Date(hold.capture_before).getTime() > now - 3_600_000) return;
      }
    }
    await transition(ctx, id, "expire", "system", "expire");
  });
  log("tick", { ...out, errors: errors.length, expiring_soon: (work.expiring_soon ?? []).length });
  return { done: out, expiring_soon: (work.expiring_soon ?? []).length, errors };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
    if (!secretKey || !siteUrl) throw new HttpError(500, "Payments aren't configured on this server yet.");
    const ctx: Ctx = {
      admin: createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } }),
      secretKey, siteUrl,
      linkTtlHours: Math.min(Math.max(Number(Deno.env.get("PAYMENT_PROTECTION_LINK_TTL_HOURS") ?? "72") || 72, 1), 168),
    };
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const cron = Deno.env.get("PAYMENT_PROTECTION_CRON_SECRET");
    if (body.action === "tick") {
      if (!cron || req.headers.get("X-Cron-Secret") !== cron) throw new HttpError(401, "Unauthorized.");
      return json(await tick(ctx));
    }
    if (typeof body.token === "string") return json(await homeownerHandler(ctx, body));

    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) throw new HttpError(401, "Missing Authorization header.");
    return json(await userHandler(ctx, jwt, body));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    log("unhandled", { message: (e as Error).message?.slice(0, 200) });
    return json({ error: "Something went wrong." }, 500);
  }
});
