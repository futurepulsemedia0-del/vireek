// supabase/functions/_shared/email-campaigns/engine.ts
//
// Audience resolution, recipient creation and Resend batch delivery for bulk
// email campaigns. Used by `email-campaigns` (user actions) and
// `email-campaign-dispatcher` (cron). Always scoped by the ACCOUNT OWNER id.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { resolveSegmentMembers, SegmentFilter } from "../marketing/segments.ts";
import { analyzeAudience, AudienceAnalysis, Contact, normalizeEmail } from "./audience.ts";
import { extractLinks, firstNameOf, renderEmail, singleLine } from "./render.ts";

// deno-lint-ignore no-explicit-any
type Admin = SupabaseClient<any, "public", any>;

export interface Campaign {
  id: string;
  user_id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body: string;
  from_name: string | null;
  reply_to: string | null;
  sender_address: string | null;
  audience: "all_opted_in" | "segment";
  segment_id: string | null;
  status: string;
  scheduled_at: string | null;
}

const CHUNK = 200;
export const BATCH_SIZE = 100; // Resend batch endpoint maximum
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MINUTES = 10;

export function functionsBase(): string {
  return `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1`;
}
export function siteUrl(): string {
  return (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
}

/** `Name <addr@domain>` from RESEND_FROM_EMAIL, with a safe display name. */
export function buildFrom(displayName: string): string {
  const raw = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  const addr = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim();
  const safe = singleLine(displayName).replace(/[<>"\\]/g, "").slice(0, 80);
  return safe ? `${safe} <${addr}>` : raw;
}

async function chunked<T, R>(items: T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await fn(items.slice(i, i + CHUNK))));
  return out;
}

export async function analyzeCampaignAudience(admin: Admin, c: Campaign): Promise<AudienceAnalysis> {
  let filter: SegmentFilter = { entity: "customer" };
  if (c.audience === "segment") {
    if (!c.segment_id) throw new Error("This campaign's audience was deleted. Pick another audience.");
    const { data: seg } = await admin
      .from("marketing_segments")
      .select("filter")
      .eq("id", c.segment_id)
      .eq("user_id", c.user_id)
      .maybeSingle();
    if (!seg) throw new Error("This campaign's audience was deleted. Pick another audience.");
    filter = (seg.filter ?? {}) as SegmentFilter;
  }

  const members = await resolveSegmentMembers(admin, c.user_id, filter);
  const contacts: Contact[] = members.map((m) => ({
    customer_id: m.customer_id,
    lead_id: m.lead_id,
    email: m.email,
    name: m.name,
  }));

  const { data: sup } = await admin.from("email_suppressions").select("email").eq("user_id", c.user_id).limit(100000);
  const suppressed = new Set<string>((sup ?? []).map((s: { email: string }) => normalizeEmail(s.email)));

  const customerIds = contacts.map((m) => m.customer_id).filter((x): x is string => !!x);
  const optedRows = await chunked(customerIds, async (ids) => {
    const { data, error } = await admin
      .from("customers")
      .select("id")
      .eq("user_id", c.user_id)
      .eq("marketing_opt_in", true)
      .in("id", ids);
    if (error) throw error;
    return (data ?? []) as { id: string }[];
  });

  return analyzeAudience(contacts, suppressed, new Set(optedRows.map((r) => r.id)));
}

/** Freezes the audience into recipient rows + tracked links and flips to 'sending'. Idempotent. */
export async function startCampaign(admin: Admin, c: Campaign): Promise<number> {
  const { count: existing } = await admin
    .from("email_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", c.id);

  if (!existing) {
    const analysis = await analyzeCampaignAudience(admin, c);
    if (analysis.eligible.length === 0) {
      await admin
        .from("email_campaigns")
        .update({ status: "failed", last_error: "No eligible recipients (everyone was excluded by consent, suppression or missing email).", completed_at: new Date().toISOString() })
        .eq("id", c.id);
      return 0;
    }
    for (let i = 0; i < analysis.eligible.length; i += 500) {
      const rows = analysis.eligible.slice(i, i + 500).map((r) => ({
        campaign_id: c.id,
        user_id: c.user_id,
        customer_id: r.customer_id,
        email: r.email,
        name: r.name,
      }));
      const { error } = await admin
        .from("email_campaign_recipients")
        .upsert(rows, { onConflict: "campaign_id,email_key", ignoreDuplicates: true });
      if (error) throw error;
    }
    const links = extractLinks(c.body).map((url) => ({ campaign_id: c.id, user_id: c.user_id, url }));
    if (links.length) {
      const { error } = await admin
        .from("email_campaign_links")
        .upsert(links, { onConflict: "campaign_id,url", ignoreDuplicates: true });
      if (error) throw error;
    }
  }

  await admin
    .from("email_campaigns")
    .update({ status: "sending", started_at: new Date().toISOString(), last_error: null })
    .eq("id", c.id)
    .in("status", ["scheduled", "sending"]);
  await admin.rpc("email_refresh_campaign_counts", { p_campaign: c.id });
  const { data } = await admin.from("email_campaigns").select("recipient_count").eq("id", c.id).single();
  return data?.recipient_count ?? 0;
}

interface ResendEmail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers: Record<string, string>;
}

async function companyNameOf(admin: Admin, userId: string): Promise<string> {
  const { data } = await admin.from("profiles").select("company_name").eq("id", userId).maybeSingle();
  return data?.company_name || "Your service provider";
}

/**
 * Sends one batch (<= 100) of queued recipients. Returns how many were attempted
 * (0 = nothing left). Safe to run concurrently: rows are claimed atomically.
 */
export async function sendBatch(admin: Admin, c: Campaign, companyName?: string): Promise<number> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("Email isn't configured yet (missing RESEND_API_KEY).");

  const { data: queued } = await admin
    .from("email_campaign_recipients")
    .select("id")
    .eq("campaign_id", c.id)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (!queued?.length) return 0;

  // Atomic claim: only rows still 'queued' are returned.
  const { data: claimed } = await admin
    .from("email_campaign_recipients")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .in("id", queued.map((q: { id: string }) => q.id))
    .eq("status", "queued")
    .select("id, email, name, token, attempts");
  if (!claimed?.length) return 0;

  // Re-check suppression at the moment of sending (someone may have unsubscribed since queueing).
  const { data: sup } = await admin
    .from("email_suppressions")
    .select("email")
    .eq("user_id", c.user_id)
    .in("email", claimed.map((r: { email: string }) => normalizeEmail(r.email)));
  const suppressed = new Set<string>((sup ?? []).map((s: { email: string }) => s.email));
  const toSkip = claimed.filter((r: { email: string }) => suppressed.has(normalizeEmail(r.email)));
  if (toSkip.length) {
    await admin
      .from("email_campaign_recipients")
      .update({ status: "skipped", error: "suppressed" })
      .in("id", toSkip.map((r: { id: string }) => r.id));
  }
  const toSend = claimed.filter((r: { email: string }) => !suppressed.has(normalizeEmail(r.email)));

  const { data: linkRows } = await admin.from("email_campaign_links").select("id, url").eq("campaign_id", c.id);
  const company = companyName ?? (await companyNameOf(admin, c.user_id));
  const from = buildFrom(c.from_name || company);
  const base = functionsBase();

  const emails: ResendEmail[] = toSend.map((r: { email: string; name: string | null; token: string }) => {
    const tracked = new Map<string, string>(
      (linkRows ?? []).map((l: { id: string; url: string }) => [l.url, `${base}/email-track?t=${r.token}&l=${l.id}`]),
    );
    const rendered = renderEmail({
      subject: c.subject,
      preheader: c.preheader,
      body: c.body,
      vars: { name: r.name || "there", first_name: firstNameOf(r.name), company_name: company },
      companyName: company,
      senderAddress: c.sender_address ?? "",
      trackedLinks: tracked,
      openPixelUrl: `${base}/email-track?t=${r.token}&k=o`,
      unsubscribeUrl: `${siteUrl()}/email/unsubscribe/${r.token}`,
    });
    return {
      from,
      to: [r.email],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(c.reply_to ? { reply_to: c.reply_to } : {}),
      headers: {
        // RFC 8058 one-click unsubscribe (required by Gmail/Yahoo bulk-sender rules).
        "List-Unsubscribe": `<${base}/email-unsubscribe?t=${r.token}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  });

  if (emails.length === 0) return claimed.length;

  const result = await postBatch(apiKey, emails);

  if (result.kind === "ok") {
    const now = new Date().toISOString();
    await Promise.all(
      toSend.map((r: { id: string }, i: number) =>
        admin
          .from("email_campaign_recipients")
          .update({ status: "sent", sent_at: now, provider_ref: result.ids[i] ?? null, error: null })
          .eq("id", r.id),
      ),
    );
  } else if (result.kind === "retry") {
    // Rate limit / provider outage: put them back unless they've exhausted their attempts.
    for (const r of toSend as { id: string; attempts: number }[]) {
      const attempts = r.attempts + 1;
      await admin
        .from("email_campaign_recipients")
        .update(
          attempts >= MAX_ATTEMPTS
            ? { status: "failed", attempts, error: result.error }
            : { status: "queued", attempts, claimed_at: null, error: result.error },
        )
        .eq("id", r.id);
    }
  } else {
    // The provider rejected the batch as invalid — isolate the bad address by sending singly.
    for (const [i, email] of emails.entries()) {
      const single = await postSingle(apiKey, email);
      await admin
        .from("email_campaign_recipients")
        .update(
          single.ok
            ? { status: "sent", sent_at: new Date().toISOString(), provider_ref: single.id, error: null }
            : { status: "failed", error: single.error },
        )
        .eq("id", toSend[i].id);
      await sleep(550); // stay under Resend's default 2 req/s
    }
  }

  await admin.rpc("email_refresh_campaign_counts", { p_campaign: c.id });
  return claimed.length;
}

type BatchResult = { kind: "ok"; ids: string[] } | { kind: "retry"; error: string } | { kind: "invalid"; error: string };

async function postBatch(apiKey: string, emails: ResendEmail[]): Promise<BatchResult> {
  try {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(emails),
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      return { kind: "ok", ids: ((json.data ?? []) as { id: string }[]).map((d) => d.id) };
    }
    const text = (await res.text()).slice(0, 300);
    if (res.status === 429 || res.status >= 500) return { kind: "retry", error: `Resend ${res.status}: ${text}` };
    if (res.status === 400 || res.status === 422) return { kind: "invalid", error: text };
    // 401/403 etc: configuration problem — retrying won't help, but don't burn the whole list silently.
    return { kind: "retry", error: `Resend ${res.status}: ${text}` };
  } catch (e) {
    return { kind: "retry", error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function postSingle(apiKey: string, email: ResendEmail): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(email),
    });
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const json = await res.json().catch(() => ({}));
    return { ok: true, id: json.id ?? "" };
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs up to `maxBatches` batches, honouring pause/cancel between batches, and finalises the campaign. */
export async function runCampaign(admin: Admin, c: Campaign, maxBatches: number, deadlineMs: number): Promise<void> {
  const company = await companyNameOf(admin, c.user_id);
  for (let i = 0; i < maxBatches && Date.now() < deadlineMs; i++) {
    const { data: fresh } = await admin.from("email_campaigns").select("status").eq("id", c.id).single();
    if (fresh?.status !== "sending") return;
    const attempted = await sendBatch(admin, c, company);
    if (attempted === 0) break;
    await sleep(600); // ~1.6 batch requests/second, under Resend's default 2 req/s
  }

  const { count } = await admin
    .from("email_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", c.id)
    .in("status", ["queued", "sending"]);
  if (!count) {
    await admin.rpc("email_refresh_campaign_counts", { p_campaign: c.id });
    await admin
      .from("email_campaigns")
      .update({ status: "sent", completed_at: new Date().toISOString() })
      .eq("id", c.id)
      .eq("status", "sending");
  }
}

/** Returns rows stuck in 'sending' (a crashed worker) to the queue. */
export async function reclaimStale(admin: Admin): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  await admin
    .from("email_campaign_recipients")
    .update({ status: "queued", claimed_at: null })
    .eq("status", "sending")
    .lt("claimed_at", cutoff);
}

export { renderEmail };
