// supabase/functions/portal-api/index.ts
// Authenticated API for Customer Portal Submission. POST { action, ... } with the caller's JWT.
// Every state change goes through the SQL functions (portal_*) AS THE CALLER, so RLS / ownership / billing-permission / kill-switch
// checks are enforced by the database, not only here. The service-role client is used ONLY for storage, the credential vault and
// writes the caller has no grant for (evidence rows, remittance rows).
// Secrets: write-only. No action ever returns a credential value. All errors are passed through safeError().
// REQUIRED secrets: RESEND_API_KEY (email channel), PROVIDER_CREDENTIALS_KEY or PORTAL_CREDENTIALS_KEY (vault).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { evaluateGate } from "../_shared/portal/killSwitch.ts";
import { buildSubject, isSafeEmail, packetHash, sha256Hex, type PacketManifest } from "../_shared/portal/idempotency.ts";
import { buildCopyFields, readyForHuman, safeDeepLink, validateConfirmation, type ProfileConfig } from "../_shared/portal/packet.ts";
import { normalizeStatus } from "../_shared/portal/statusNormalizer.ts";
import { parseRemittanceText, matchRemittance } from "../_shared/portal/remittanceParser.ts";
import { safeError } from "../_shared/portal/redact.ts";
import { portalKeys, sanitizeSecretInput, sealPortalSecrets } from "../_shared/portal/portalVault.ts";
import { PORTAL_CHANNELS, type PortalChannel, type PortalState } from "../_shared/portal/stateMachine.ts";

type Row = Record<string, unknown>;
const MAX_PDF = 8 * 1024 * 1024;
const MAX_EVIDENCE = 5 * 1024 * 1024;
const BUCKET = "portal-evidence";

function cors(req: Request): Record<string, string> {
  const site = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const allowed = (Deno.env.get("PORTAL_ALLOWED_ORIGINS") || site).split(",").map((s) => s.trim());
  const o = req.headers.get("Origin") ?? "";
  return { "Access-Control-Allow-Origin": allowed.includes(o) ? o : allowed[0], "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" } });
class HttpError extends Error { constructor(public status: number, public code: string) { super(code); } }

function b64ToBytes(b64: string, max: number): Uint8Array {
  if (typeof b64 !== "string" || b64.length > Math.ceil(max * 1.4)) throw new HttpError(413, "file_too_large");
  let bin: string;
  try { bin = atob(b64); } catch { throw new HttpError(400, "file_invalid"); }
  if (bin.length > max) throw new HttpError(413, "file_too_large");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const isPdf = (b: Uint8Array) => b.length > 5 && String.fromCharCode(...b.slice(0, 5)) === "%PDF-";
const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const str = (v: unknown, max = 200): string => { if (typeof v !== "string" || v.length === 0 || v.length > max) throw new HttpError(400, "invalid_input"); return v; };
const uuid = (v: unknown): string => { const s = str(v, 36); if (!/^[0-9a-f-]{36}$/i.test(s)) throw new HttpError(400, "invalid_id"); return s; };

async function bytesHash(b: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

interface Ctx { admin: SupabaseClient; caller: SupabaseClient; userId: string; ownerId: string; isOwner: boolean }

async function authenticate(req: Request): Promise<Ctx> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "unauthorized");
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await caller.auth.getUser();
  if (!u?.user) throw new HttpError(401, "unauthorized");
  const { data: owner } = await caller.rpc("get_account_owner_id");
  const { data: can } = await caller.rpc("commercial_can_bill");
  if (!owner || can !== true) throw new HttpError(403, "billing_permission_required");
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  return { admin, caller, userId: u.user.id, ownerId: owner as string, isOwner: u.user.id === owner };
}

async function loadGate(ctx: Ctx, channel: PortalChannel, profileId: string) {
  const [{ data: g }, { data: a }, { data: p }, { data: c }] = await Promise.all([
    ctx.admin.from("portal_global_settings").select("automation_enabled, global_kill").eq("id", true).maybeSingle(),
    ctx.admin.from("portal_account_settings").select("*").eq("user_id", ctx.ownerId).maybeSingle(),
    ctx.admin.from("customer_portal_profiles").select("automation_kill").eq("id", profileId).eq("user_id", ctx.ownerId).maybeSingle(),
    ctx.admin.from("portal_consents").select("id").eq("profile_id", profileId).eq("user_id", ctx.ownerId).eq("consent_type", "automation").is("revoked_at", null).limit(1),
  ]);
  const flagOf = (k: string) => Boolean((a as Row | null)?.[k]);
  return evaluateGate({
    globalAutomationEnabled: Boolean((g as Row | null)?.automation_enabled), globalKill: Boolean((g as Row | null)?.global_kill),
    accountEnabled: flagOf("submission_enabled"), accountChannelEnabled: flagOf(`${channel}_channel_enabled`),
    accountAutomationKill: flagOf("automation_kill"), profileAutomationKill: Boolean((p as Row | null)?.automation_kill),
    channel, consentActive: ((c as Row[] | null) ?? []).length > 0,
  });
}

async function mySubmission(ctx: Ctx, id: string): Promise<Row> {
  const { data } = await ctx.caller.from("portal_submissions").select("*").eq("id", id).maybeSingle();   // RLS-scoped
  if (!data) throw new HttpError(404, "not_found");
  return data as Row;
}
async function transition(ctx: Ctx, id: string, to: PortalState, details: Record<string, unknown> = {}, dedupe?: string): Promise<Row> {
  const { data, error } = await ctx.caller.rpc("portal_apply_transition", { p_submission_id: id, p_to: to, p_actor_kind: "user", p_details: details, p_dedupe_key: dedupe ?? null });
  if (error) throw new HttpError(error.code === "42501" ? 403 : error.code === "55000" ? 409 : 422, safeError(error.message, []).slice(0, 120));
  return data as Row;
}
async function storeFile(ctx: Ctx, submissionId: string, kind: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ id: string; path: string; sha: string }> {
  const sha = await bytesHash(bytes);
  const path = `${ctx.ownerId}/${submissionId}/${kind}-${sha.slice(0, 16)}-${name}`;
  const up = await ctx.admin.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (up.error && !String(up.error.message).includes("already exists")) throw new HttpError(500, "storage_failed");
  const { data } = await ctx.admin.from("portal_evidence").insert({ user_id: ctx.ownerId, submission_id: submissionId, kind, storage_path: path, sha256: sha, redacted: false, created_by: ctx.userId }).select("id").single();
  return { id: (data as Row).id as string, path, sha };
}
async function rateLimit(ctx: Ctx, action: string, perMinute: number) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await ctx.admin.from("portal_submission_events").select("id", { count: "exact", head: true }).eq("user_id", ctx.ownerId).eq("actor_id", ctx.userId).gte("created_at", since);
  if ((count ?? 0) >= perMinute) throw new HttpError(429, `rate_limited:${action}`);
}

// ------------------------------------------------------------------------------------------------------------------
const handlers: Record<string, (ctx: Ctx, b: Row) => Promise<unknown>> = {
  // 1. enqueue + prepare. Idempotent per client request_id. A duplicate live submission is returned, never created.
  async enqueue(ctx, b) {
    await rateLimit(ctx, "enqueue", 30);
    const invoiceId = uuid(b.invoice_id), profileId = uuid(b.profile_id), channel = str(b.channel, 20) as PortalChannel, requestId = str(b.request_id, 80);
    if (!(PORTAL_CHANNELS as readonly string[]).includes(channel) || channel === "automation") throw new HttpError(400, "channel_not_supported_here");
    const gate = await loadGate(ctx, channel, profileId);
    if (!gate.allowed) throw new HttpError(409, gate.reason);

    const { data: inv } = await ctx.caller.from("invoices").select("id, invoice_number, line_items, tax_percent, due_date, created_at, customer_name").eq("id", invoiceId).maybeSingle();
    if (!inv) throw new HttpError(404, "invoice_not_found");
    const pdf = b64ToBytes(str(b.packet_pdf_base64, MAX_PDF * 2), MAX_PDF);
    if (!isPdf(pdf)) throw new HttpError(415, "packet_must_be_pdf");
    const pdfSha = await bytesHash(pdf);
    const { data: approval } = await ctx.caller.from("commercial_invoice_tracking").select("approval_id").eq("invoice_id", invoiceId).maybeSingle();
    let po: string | null = null;
    if ((approval as Row | null)?.approval_id) {
      const { data: ap } = await ctx.caller.from("commercial_approvals").select("po_number, work_order_number").eq("id", (approval as Row).approval_id as string).maybeSingle();
      po = ((ap as Row | null)?.po_number as string | null) ?? ((ap as Row | null)?.work_order_number as string | null) ?? null;
    }
    const items = (inv.line_items as { quantity?: number; unit_price?: number }[]) ?? [];
    const subtotal = items.reduce((s, l) => s + Math.round((l.quantity ?? 0) * (l.unit_price ?? 0) * 100), 0);
    const total = Math.round(subtotal * (1 + Number(inv.tax_percent ?? 0) / 100));
    const manifest: PacketManifest = { invoice_id: invoiceId, invoice_number: String(inv.invoice_number ?? ""), total_cents: total, currency: "USD", po_number: po,
      attachments: [{ name: "invoice.pdf", sha256: pdfSha, bytes: pdf.length }], fields: {} };
    if (!manifest.invoice_number) throw new HttpError(422, "invoice_number_required");
    const hash = await packetHash(manifest);
    const key = await sha256Hex(["portal", ctx.ownerId, invoiceId, profileId, channel, requestId].join("|"));

    const { data, error } = await ctx.caller.rpc("portal_enqueue_submission", { p_invoice_id: invoiceId, p_profile_id: profileId, p_channel: channel, p_packet_hash: hash, p_idempotency_key: key });
    if (error) throw new HttpError(error.code === "55000" ? 409 : error.code === "42501" ? 403 : 422, safeError(error.message).slice(0, 120));
    const r = (data as Row[])[0];
    if (r.o_duplicate) return { submission_id: r.o_submission_id, duplicate: true, state: r.o_state };
    await storeFile(ctx, r.o_submission_id as string, "packet", "invoice.pdf", pdf, "application/pdf");
    await transition(ctx, r.o_submission_id as string, "prepared", { packet_hash: hash });
    return { submission_id: r.o_submission_id, duplicate: false, state: "prepared", packet_version: r.o_packet_version };
  },

  // 2. e-mail-in channel: deterministic subject, packet attached, provider idempotency key, delivery tracking
  async send_email(ctx, b) {
    await rateLimit(ctx, "send_email", 20);
    const sub = await mySubmission(ctx, uuid(b.submission_id));
    if (sub.channel !== "email") throw new HttpError(409, "wrong_channel");
    if (sub.state !== "prepared") throw new HttpError(409, "not_prepared");
    const gate = await loadGate(ctx, "email", sub.profile_id as string);
    if (!gate.allowed) throw new HttpError(409, gate.reason);
    const { data: prof } = await ctx.caller.from("customer_portal_profiles").select("ap_email, name").eq("id", sub.profile_id as string).maybeSingle();
    const to = String((prof as Row | null)?.ap_email ?? "");
    if (!isSafeEmail(to)) throw new HttpError(422, "ap_email_invalid");
    const { data: inv } = await ctx.caller.from("invoices").select("invoice_number").eq("id", sub.invoice_id as string).maybeSingle();
    const { data: co } = await ctx.admin.from("profiles").select("company_name").eq("id", ctx.ownerId).maybeSingle();
    const { data: ev } = await ctx.admin.from("portal_evidence").select("storage_path").eq("submission_id", sub.id as string).eq("kind", "packet").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!ev) throw new HttpError(409, "packet_missing");
    const { data: file } = await ctx.admin.storage.from(BUCKET).download((ev as Row).storage_path as string);
    if (!file) throw new HttpError(500, "packet_unreadable");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { data: tracking } = await ctx.caller.from("commercial_invoice_tracking").select("approval_id").eq("invoice_id", sub.invoice_id as string).maybeSingle();
    let po: string | null = null;
    if ((tracking as Row | null)?.approval_id) { const { data: ap } = await ctx.caller.from("commercial_approvals").select("po_number").eq("id", (tracking as Row).approval_id as string).maybeSingle(); po = ((ap as Row | null)?.po_number as string | null) ?? null; }
    const company = String((co as Row | null)?.company_name ?? "Vireek customer");
    const subject = buildSubject({ invoiceNumber: String((inv as Row).invoice_number), poNumber: po, company });

    await transition(ctx, sub.id as string, "submitting", {}, `email-start:${sub.id}`);   // flags/kill switch re-checked in SQL
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const delivery = await ctx.admin.from("portal_email_deliveries").insert({ user_id: ctx.ownerId, submission_id: sub.id, to_address: to, subject, status: "queued" }).select("id").single();
    let messageId: string | null = null; let failure: string | null = null;
    if (!apiKey) failure = "email_not_configured";
    else {
      try {
        const res = await fetch("https://api.resend.com/emails", { method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": String(sub.idempotency_key).slice(0, 64) },
          body: JSON.stringify({ from: Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>", to: [to], subject,
            text: `Please find attached invoice ${String((inv as Row).invoice_number)}${po ? ` for PO ${po}` : ""}.\nSent on behalf of ${company}.`,
            attachments: [{ filename: `invoice-${String((inv as Row).invoice_number).replace(/[^\w.-]/g, "_")}.pdf`, content: btoa(String.fromCharCode(...bytes)) }],
            tags: [{ name: "portal_submission", value: String(sub.id) }] }) });
        if (res.ok) messageId = String(((await res.json()) as Row).id ?? ""); else failure = `email_http_${res.status}`;
      } catch { failure = "email_transport_error"; }
    }
    if (failure || !messageId) {
      await ctx.admin.from("portal_email_deliveries").update({ status: "failed", error: failure }).eq("id", (delivery.data as Row).id as string);
      await transition(ctx, sub.id as string, "failed", { code: failure ?? "unknown" });
      throw new HttpError(502, failure ?? "email_failed");
    }
    await ctx.admin.from("portal_email_deliveries").update({ status: "sent", provider_message_id: messageId }).eq("id", (delivery.data as Row).id as string);
    await transition(ctx, sub.id as string, "submitted", { reference: messageId, channel: "email" });
    return { state: "submitted", message_id: messageId };
  },

  // 3. assisted mode: copy-ready values + checklist + deep link; a person clicks through the portal
  async assisted_prepare(ctx, b) {
    const sub = await mySubmission(ctx, uuid(b.submission_id));
    if (sub.channel !== "assisted") throw new HttpError(409, "wrong_channel");
    const { data: ver } = await ctx.caller.from("portal_profile_versions").select("config").eq("profile_id", sub.profile_id as string).eq("version", sub.profile_version as number).maybeSingle();
    const { data: prof } = await ctx.caller.from("customer_portal_profiles").select("portal_url, contact, name").eq("id", sub.profile_id as string).maybeSingle();
    const { data: inv } = await ctx.caller.from("invoices").select("invoice_number, line_items, tax_percent, due_date, created_at, customer_name").eq("id", sub.invoice_id as string).maybeSingle();
    const cfg = ((ver as Row | null)?.config ?? { required_fields: [], checklist: [], status_map: {} }) as ProfileConfig;
    const items = ((inv as Row).line_items as { description?: string; quantity?: number; unit_price?: number }[]) ?? [];
    const total = Math.round(items.reduce((s, l) => s + (l.quantity ?? 0) * (l.unit_price ?? 0) * 100, 0) * (1 + Number((inv as Row).tax_percent ?? 0) / 100));
    const fields = buildCopyFields({ invoice_id: String(sub.invoice_id), invoice_number: String((inv as Row).invoice_number), po_number: null, total_cents: total, currency: "USD",
      issue_date: String((inv as Row).created_at).slice(0, 10), due_date: ((inv as Row).due_date as string | null) ?? null, supplier: { name: "" }, buyer: { name: String((inv as Row).customer_name) },
      lines: items.map((l) => ({ description: String(l.description ?? ""), quantity: l.quantity ?? 0, unit_cents: Math.round((l.unit_price ?? 0) * 100) })), attachments: [], fields: {} }, cfg);
    if (sub.state === "prepared" && readyForHuman(fields)) await transition(ctx, sub.id as string, "awaiting_human", { pause_reason: "assisted" });
    return { fields, checklist: cfg.checklist, deep_link: safeDeepLink((prof as Row | null)?.portal_url as string | null), ready: readyForHuman(fields) };
  },
  async assisted_confirm(ctx, b) {
    const sub = await mySubmission(ctx, uuid(b.submission_id));
    let evidenceId: string | null = null;
    if (b.evidence_base64) {
      const bytes = b64ToBytes(str(b.evidence_base64, MAX_EVIDENCE * 2), MAX_EVIDENCE);
      if (!isPng(bytes) && !isJpeg(bytes) && !isPdf(bytes)) throw new HttpError(415, "evidence_type_not_allowed");
      evidenceId = (await storeFile(ctx, sub.id as string, "confirmation_upload", isPng(bytes) ? "confirmation.png" : isJpeg(bytes) ? "confirmation.jpg" : "confirmation.pdf", bytes, isPng(bytes) ? "image/png" : isJpeg(bytes) ? "image/jpeg" : "application/pdf")).id;
    }
    const reference = typeof b.reference === "string" ? b.reference.trim() : null;
    const bad = validateConfirmation({ reference, evidenceId });
    if (bad) throw new HttpError(422, bad);
    return await transition(ctx, sub.id as string, "submitted", { reference, evidence_id: evidenceId, channel: "assisted" });
  },

  // 4. a person records what the portal now says; vocabulary mapping decides the state; unknown text never moves anything
  async record_status(ctx, b) {
    const sub = await mySubmission(ctx, uuid(b.submission_id));
    const { data: ver } = await ctx.caller.from("portal_profile_versions").select("config").eq("profile_id", sub.profile_id as string).eq("version", sub.profile_version as number).maybeSingle();
    const map = (((ver as Row | null)?.config as Row | undefined)?.status_map ?? {}) as Record<string, string>;
    const n = normalizeStatus(str(b.raw_status, 200), map);
    if (n.kind === "unknown") throw new HttpError(422, "unknown_status");
    return await transition(ctx, sub.id as string, n.state, { reason: typeof b.reason === "string" ? b.reason.slice(0, 2000) : undefined, raw_status: n.raw });
  },
  async cancel(ctx, b) { return await transition(ctx, uuid(b.submission_id), "cancelled", { reason: "user_cancelled" }); },
  async retry(ctx, b) { return await transition(ctx, uuid(b.submission_id), "queued", { reason: "user_retry" }); },
  async approve_run(ctx, b) { return await transition(ctx, uuid(b.submission_id), "submitting", { approved: true }); },

  // 5. credential vault: WRITE-ONLY. No action returns a value.
  async credentials_put(ctx, b) {
    if (!ctx.isOwner) throw new HttpError(403, "owner_only");
    const profileId = uuid(b.profile_id);
    const { data: p } = await ctx.admin.from("customer_portal_profiles").select("id").eq("id", profileId).eq("user_id", ctx.ownerId).maybeSingle();
    if (!p) throw new HttpError(404, "not_found");
    let bag: Record<string, string>;
    try { bag = sanitizeSecretInput((b.secrets ?? {}) as Record<string, unknown>); } catch (e) { throw new HttpError(422, (e as Error).message); }
    const keys = portalKeys((k) => Deno.env.get(k));
    if (keys.length === 0) throw new HttpError(500, "credential_key_missing");
    const ciphertext = await sealPortalSecrets(bag, keys[0], ctx.ownerId, profileId);
    const { data: existing } = await ctx.admin.from("portal_credentials").select("profile_id").eq("profile_id", profileId).maybeSingle();
    const { error } = await ctx.admin.from("portal_credentials").upsert({ profile_id: profileId, user_id: ctx.ownerId, ciphertext, field_names: Object.keys(bag), rotated_at: existing ? new Date().toISOString() : null, created_by: ctx.userId }, { onConflict: "profile_id" });
    if (error) throw new HttpError(500, "vault_write_failed");
    await ctx.admin.from("portal_credential_access_log").insert({ user_id: ctx.ownerId, profile_id: profileId, actor_id: ctx.userId, action: existing ? "rotate" : "write", purpose: "ui" });
    return { has_secret: true, fields: Object.keys(bag) };          // names only
  },
  async credentials_meta(ctx, b) {
    const { data } = await ctx.caller.rpc("portal_credential_meta", { p_profile_id: uuid(b.profile_id) });
    return (data as Row[] | null)?.[0] ?? { has_secret: false, fields: [] };
  },

  // 6. evidence: short-lived signed URL, only for rows the caller can see under RLS
  async evidence_url(ctx, b) {
    const { data: ev } = await ctx.caller.from("portal_evidence").select("storage_path").eq("id", uuid(b.evidence_id)).maybeSingle();
    if (!ev) throw new HttpError(404, "not_found");
    const { data } = await ctx.admin.storage.from(BUCKET).createSignedUrl((ev as Row).storage_path as string, 120);
    return { url: data?.signedUrl ?? null, expires_in: 120 };
  },

  // 7. remittance: rule-based parse of text/CSV only. Anything else (PDF, image) is stored for manual review. Never auto-applies.
  async remittance_ingest(ctx, b) {
    await rateLimit(ctx, "remittance", 20);
    const bytes = b64ToBytes(str(b.file_base64, MAX_EVIDENCE * 2), MAX_EVIDENCE);
    const hash = await bytesHash(bytes);
    const isText = !isPdf(bytes) && !isPng(bytes) && !isJpeg(bytes);
    const parsed = isText ? parseRemittanceText(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) : { payment_ref: null, paid_on: null, currency: null, lines: [], method: "rule" as const, requires_confirmation: true };
    const path = `${ctx.ownerId}/remittances/${hash.slice(0, 32)}`;
    await ctx.admin.storage.from(BUCKET).upload(path, bytes, { contentType: isText ? "text/plain" : isPdf(bytes) ? "application/pdf" : "application/octet-stream", upsert: false });
    const { data: rem, error } = await ctx.admin.from("portal_remittances").insert({ user_id: ctx.ownerId, profile_id: typeof b.profile_id === "string" ? uuid(b.profile_id) : null, source: "upload", storage_path: path,
      content_hash: hash, parse_method: parsed.method, status: "needs_review", payment_ref: parsed.payment_ref, paid_on: parsed.paid_on, currency: parsed.currency, }).select("id").single();
    if (error) { if (error.code === "23505") throw new HttpError(409, "remittance_already_ingested"); throw new HttpError(500, "remittance_store_failed"); }
    const nums = parsed.lines.map((l) => l.invoice_number);
    const { data: invs } = nums.length ? await ctx.admin.from("invoices").select("id, invoice_number, line_items, tax_percent").eq("user_id", ctx.ownerId).in("invoice_number", nums) : { data: [] };
    const { data: paid } = await ctx.admin.from("portal_remittance_lines").select("invoice_id").eq("user_id", ctx.ownerId).eq("resolution", "applied");
    const paidSet = new Set(((paid as Row[] | null) ?? []).map((r) => r.invoice_id as string));
    const refs = ((invs as Row[] | null) ?? []).map((i) => ({ id: i.id as string, invoice_number: String(i.invoice_number),
      total_cents: Math.round(((i.line_items as { quantity?: number; unit_price?: number }[]) ?? []).reduce((s, l) => s + (l.quantity ?? 0) * (l.unit_price ?? 0) * 100, 0) * (1 + Number(i.tax_percent ?? 0) / 100)),
      already_paid_via_remittance: paidSet.has(i.id as string) }));
    const matches = matchRemittance(parsed.lines, refs);
    if (matches.length) await ctx.admin.from("portal_remittance_lines").insert(matches.map((m) => ({ user_id: ctx.ownerId, remittance_id: (rem as Row).id, invoice_number: m.line.invoice_number, invoice_id: m.invoice_id, amount_cents: m.line.amount_cents, match_status: m.status })));
    return { remittance_id: (rem as Row).id, lines: matches.length, needs_manual_entry: parsed.lines.length === 0, requires_confirmation: true };
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const body = (await req.json().catch(() => null)) as Row | null;
    const action = typeof body?.action === "string" ? body.action : "";
    const h = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
    if (!body || !h) return json(req, { error: "unknown_action" }, 400);
    const ctx = await authenticate(req);
    return json(req, { ok: true, data: await h(ctx, body) });
  } catch (e) {
    if (e instanceof HttpError) return json(req, { ok: false, error: e.code }, e.status);
    console.error("portal-api", safeError(e));                      // never the raw error object: it could carry request data
    return json(req, { ok: false, error: "internal_error" }, 500);
  }
});
