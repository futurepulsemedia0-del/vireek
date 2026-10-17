// Email Settings API for /dashboard/settings/email.
//
// One authenticated POST endpoint, { action, ...args }:
//   get            -> current settings + inbound address + platform config flags
//   save           -> reply-to, signature, sender name/local part, inbound on/off
//   domain_add     -> register a sending domain with the provider (Resend), store DNS records
//   domain_verify  -> ask the provider to re-check DNS, store SPF/DKIM status
//   domain_remove  -> delete the domain at the provider and clear it locally
//   rotate_inbound -> issue a new inbound alias token (old alias stops routing)
//
// Scoping: every row is keyed by the ACCOUNT OWNER's profile id
// (accountOwnerId). Owners resolve to themselves; team members resolve via
// team_members.account_owner_id. Permission gate (server-side, mirrors the
// dashboard nav): owner OR can_edit_business_profile (custom roles override).
//
// NOT LIVE-VERIFIED against Resend's Domains API — see _shared/messaging/emailSettings.ts.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  SIGNATURE_MAX,
  buildInboundAddress,
  canManageEmailSettings,
  isValidEmail,
  normalizeDomain,
  normalizeLocalPart,
  sanitizeSenderName,
  sanitizeSignature,
  summarizeDomain,
} from "../_shared/messaging/emailSettings.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const RESEND = "https://api.resend.com";
const VERIFY_COOLDOWN_MS = 10_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const user = userData.user;

  // ---- resolve account owner + permission gate ----------------------
  const { data: profile } = await admin.from("profiles").select("id, role, email").eq("id", user.id).maybeSingle();
  let ownerId: string | null = profile?.role === "owner" ? user.id : null;
  let teamPermissions: Record<string, unknown> | null = null;
  let customRolePermissions: Record<string, unknown> | null = null;
  if (!ownerId) {
    const { data: tm } = await admin
      .from("team_members")
      .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
      .eq("member_email", profile?.email ?? user.email ?? "")
      .maybeSingle();
    if (tm?.account_owner_id) {
      ownerId = tm.account_owner_id;
      teamPermissions = (tm.permissions as Record<string, unknown> | null) ?? null;
      customRolePermissions = ((tm.custom_role as { permissions?: Record<string, unknown> } | null)?.permissions) ?? null;
    }
  }
  if (!ownerId) return json({ error: "FORBIDDEN", detail: "No account found for this user." }, 403);
  if (!canManageEmailSettings({ role: profile?.role, teamPermissions, customRolePermissions })) {
    return json({ error: "FORBIDDEN", detail: "You don't have permission to manage email settings." }, 403);
  }

  const args = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(args.action ?? "");

  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const inboundDomain = (Deno.env.get("INBOUND_EMAIL_DOMAIN") ?? "").trim().toLowerCase();

  async function loadAll() {
    const [{ data: settings }, { data: owner }] = await Promise.all([
      admin.from("email_settings").select("*").eq("user_id", ownerId).maybeSingle(),
      admin.from("profiles").select("inbound_email_token").eq("id", ownerId).maybeSingle(),
    ]);
    return {
      settings: settings ?? null,
      inboundAddress: buildInboundAddress(owner?.inbound_email_token, inboundDomain),
      platform: { emailConfigured: !!resendKey, inboundConfigured: !!inboundDomain },
    };
  }

  async function ensureRow() {
    await admin.from("email_settings").upsert({ user_id: ownerId }, { onConflict: "user_id", ignoreDuplicates: true });
  }

  async function resend(path: string, method: string, body?: unknown) {
    const res = await fetch(`${RESEND}${path}`, {
      method,
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, data, text };
  }

  try {
    switch (action) {
      case "get":
        return json(await loadAll());

      case "save": {
        const replyToRaw = String(args.replyTo ?? "").trim();
        if (replyToRaw && !isValidEmail(replyToRaw)) return json({ error: "INVALID", field: "replyTo", detail: "Enter a valid email address." }, 400);
        const signatureRaw = String(args.signature ?? "");
        if (signatureRaw.length > SIGNATURE_MAX * 2) return json({ error: "INVALID", field: "signature", detail: `Signature is limited to ${SIGNATURE_MAX} characters.` }, 400);
        const localPart = normalizeLocalPart(String(args.senderLocalPart ?? "hello"));
        if (!localPart) return json({ error: "INVALID", field: "senderLocalPart", detail: "Use letters, numbers, dots, dashes or underscores." }, 400);

        await ensureRow();
        const { error } = await admin
          .from("email_settings")
          .update({
            reply_to_email: replyToRaw ? replyToRaw.toLowerCase() : null,
            signature: sanitizeSignature(signatureRaw),
            sender_name: sanitizeSenderName(String(args.senderName ?? "")),
            sender_local_part: localPart,
            inbound_enabled: args.inboundEnabled !== false,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", ownerId);
        if (error) throw error;
        return json(await loadAll());
      }

      case "domain_add": {
        if (!resendKey) return json({ error: "NOT_CONFIGURED", detail: "Email isn't configured yet (missing RESEND_API_KEY)." }, 422);
        const domain = normalizeDomain(String(args.domain ?? ""));
        if (!domain) return json({ error: "INVALID", field: "domain", detail: "Enter a domain you own, like mail.yourcompany.com (free email domains aren't allowed)." }, 400);

        await ensureRow();
        const { data: current } = await admin.from("email_settings").select("sender_domain").eq("user_id", ownerId).maybeSingle();
        if (current?.sender_domain) return json({ error: "DOMAIN_EXISTS", detail: "Remove the current sender domain before adding another." }, 409);

        // Reserve first: the unique index rejects a domain another account already claimed.
        const { error: reserveError } = await admin
          .from("email_settings")
          .update({ sender_domain: domain, updated_at: new Date().toISOString() })
          .eq("user_id", ownerId);
        if (reserveError) {
          if ((reserveError as { code?: string }).code === "23505") return json({ error: "DOMAIN_IN_USE", detail: "That domain is already connected to another account." }, 409);
          throw reserveError;
        }

        const created = await resend("/domains", "POST", { name: domain });
        const createdId = (created.data as { id?: string } | null)?.id;
        if (!created.ok || !createdId) {
          await admin.from("email_settings").update({ sender_domain: null }).eq("user_id", ownerId);
          return json({ error: "PROVIDER_ERROR", detail: (created.data as { message?: string } | null)?.message ?? created.text.slice(0, 300) }, 422);
        }

        const summary = summarizeDomain(created.data);
        await admin
          .from("email_settings")
          .update({
            resend_domain_id: createdId,
            domain_status: summary.status === "verified" ? "verified" : "pending",
            spf_status: summary.spf,
            dkim_status: summary.dkim,
            dns_records: summary.records,
            domain_checked_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", ownerId);
        return json(await loadAll());
      }

      case "domain_verify": {
        if (!resendKey) return json({ error: "NOT_CONFIGURED", detail: "Email isn't configured yet (missing RESEND_API_KEY)." }, 422);
        const { data: row } = await admin
          .from("email_settings")
          .select("resend_domain_id, domain_checked_at")
          .eq("user_id", ownerId)
          .maybeSingle();
        if (!row?.resend_domain_id) return json({ error: "NO_DOMAIN", detail: "Add a sender domain first." }, 404);
        if (row.domain_checked_at && Date.now() - new Date(row.domain_checked_at).getTime() < VERIFY_COOLDOWN_MS) {
          return json({ error: "RATE_LIMITED", detail: "Checked a moment ago — wait a few seconds and try again." }, 429);
        }

        await resend(`/domains/${row.resend_domain_id}/verify`, "POST"); // triggers re-check; result read below
        const fresh = await resend(`/domains/${row.resend_domain_id}`, "GET");
        if (!fresh.ok) {
          return json({ error: "PROVIDER_ERROR", detail: (fresh.data as { message?: string } | null)?.message ?? fresh.text.slice(0, 300) }, 422);
        }
        const summary = summarizeDomain(fresh.data);
        await admin
          .from("email_settings")
          .update({
            domain_status: summary.status,
            spf_status: summary.spf,
            dkim_status: summary.dkim,
            dns_records: summary.records,
            domain_checked_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", ownerId);
        return json(await loadAll());
      }

      case "domain_remove": {
        const { data: row } = await admin.from("email_settings").select("resend_domain_id").eq("user_id", ownerId).maybeSingle();
        if (row?.resend_domain_id && resendKey) {
          const del = await resend(`/domains/${row.resend_domain_id}`, "DELETE");
          if (!del.ok && del.status !== 404) {
            return json({ error: "PROVIDER_ERROR", detail: (del.data as { message?: string } | null)?.message ?? del.text.slice(0, 300) }, 422);
          }
        }
        await admin
          .from("email_settings")
          .update({
            sender_domain: null,
            resend_domain_id: null,
            domain_status: "not_started",
            spf_status: "not_started",
            dkim_status: "not_started",
            dns_records: [],
            domain_checked_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", ownerId);
        return json(await loadAll());
      }

      case "rotate_inbound": {
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        const { error } = await admin.from("profiles").update({ inbound_email_token: token }).eq("id", ownerId);
        if (error) throw error;
        return json(await loadAll());
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "email_settings_failed", action, error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "INTERNAL", detail: "Something went wrong. Please try again." }, 500);
  }
});
