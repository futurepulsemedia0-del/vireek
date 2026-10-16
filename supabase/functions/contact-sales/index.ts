// supabase/functions/contact-sales/index.ts
//
// Public enterprise "contact sales" endpoint. Validates, honeypots, rate-limits per IP (hashed), then calls
// submit_sales_inquiry (inquiry + optional demo slot in one transaction). Optionally emails the sales team.
//
// Secrets (notification is skipped when RESEND_API_KEY or SALES_NOTIFY_EMAIL is missing):
//   supabase secrets set RESEND_API_KEY=re_xxx SALES_NOTIFY_EMAIL="sales@yourdomain.com" \
//     RESEND_FROM_EMAIL="Vireek Sales <sales@yourdomain.com>"
// Deploy: supabase functions deploy contact-sales

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX = { name: 120, email: 254, title: 100, company: 120, phone: 40, message: 1500, short: 100 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEAM_SIZES = ["1-5", "6-15", "16-50", "51-200", "200+"];
const LOCATIONS = ["1", "2-5", "6-20", "21+"];
const BEST_TIMES = ["Morning 8-12", "Afternoon 12-5", "Evening 5-8"];
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const invalid = (message: string) => json({ error: "invalid", message }, 400);

async function notifySales(lead: {
  fullName: string; email: string; company: string; jobTitle: string; phone: string; teamSize: string;
  locations: string; bestTime: string; message: string; segment: string; priority: string; slotStart: string | null;
}) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const to = (Deno.env.get("SALES_NOTIFY_EMAIL") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!apiKey || to.length === 0) return;

  const tag = lead.priority === "high" ? "[HIGH] " : "";
  const rows: [string, string][] = [
    ["Name", lead.fullName], ["Email", lead.email], ["Company", lead.company], ["Role", lead.jobTitle],
    ["Phone", lead.phone], ["Best time to call", lead.bestTime], ["Team size", lead.teamSize],
    ["Locations", lead.locations], ["Segment", lead.segment],
    ["Demo booked", lead.slotStart ?? "No time chosen"], ["Message", lead.message],
  ];
  const html = `<table cellpadding="6" style="font-family:sans-serif;font-size:14px">${rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`)
    .join("")}</table>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("RESEND_FROM_EMAIL") || "Vireek Sales <sales@resend.dev>",
      to,
      reply_to: lead.email,
      subject: `${tag}${lead.segment.replace("_", " ")} lead: ${lead.company} (${lead.teamSize} people)`,
      html,
    }),
  });
  if (!res.ok) console.error("contact-sales notify failed:", res.status, await res.text().catch(() => ""));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return invalid("Invalid request.");

  // Honeypot: people never fill the hidden field. Pretend success and store nothing.
  if (str(body.website, 200)) return json({ ok: true, inquiryId: null, duplicate: false, booking: null });

  const fullName = str(body.fullName, MAX.name);
  const workEmail = str(body.workEmail, MAX.email).toLowerCase();
  const companyName = str(body.companyName, MAX.company);
  const jobTitle = str(body.jobTitle, MAX.title);
  const phone = str(body.phone, MAX.phone);
  const teamSize = str(body.teamSize, 10);
  const locations = str(body.locations, 10);
  const bestTime = str(body.bestTimeToCall, 30);
  const message = str(body.message, MAX.message);
  const smsConsent = body.smsConsent === true;

  if (fullName.length < 2) return invalid("Please enter your full name.");
  if (!EMAIL_RE.test(workEmail)) return invalid("Please enter a valid email address.");
  if (companyName.length < 2) return invalid("Please enter your company name.");
  if (!TEAM_SIZES.includes(teamSize)) return invalid("Please choose your team size.");
  if (!LOCATIONS.includes(locations)) return invalid("Please choose your number of locations.");
  if (bestTime && !BEST_TIMES.includes(bestTime)) return invalid("Please choose a valid time to call.");
  if (smsConsent && !phone) return invalid("Add a phone number to receive texts.");

  let slotStart: string | null = null;
  if (body.slotStart) {
    const parsed = new Date(String(body.slotStart));
    if (Number.isNaN(parsed.getTime())) return invalid("That time is not valid. Please pick another.");
    slotStart = parsed.toISOString();
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  // Per-IP rate limit (hashed IP, atomic counter). If the limiter itself fails we fail OPEN: losing a real
  // enterprise lead is worse than letting one extra request through; the email cap in the RPC still applies.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("cf-connecting-ip") ?? "unknown";
  const { data: allowed, error: limitError } = await admin.rpc("consume_sales_rate_limit", {
    p_ip_hash: await hashIp(ip),
    p_max: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (limitError) console.error("contact-sales rate limit error:", limitError.message);
  if (allowed === false) {
    return json(
      { error: "rate_limited", message: "You've sent a few requests already. Please try again in about an hour, or email us directly." },
      429,
    );
  }

  const { data, error } = await admin.rpc("submit_sales_inquiry", {
    p_full_name: fullName,
    p_email: workEmail,
    p_company_name: companyName,
    p_team_size: teamSize,
    p_locations: locations,
    p_job_title: jobTitle || null,
    p_phone: phone || null,
    p_message: message || null,
    p_best_time: bestTime || null,
    p_sms_consent: smsConsent,
    p_source: str(body.source, MAX.short) || "contact-sales",
    p_utm_source: str(body.utmSource, MAX.short) || null,
    p_utm_medium: str(body.utmMedium, MAX.short) || null,
    p_utm_campaign: str(body.utmCampaign, MAX.short) || null,
    p_slot_start: slotStart,
  });

  if (error) {
    if (error.message === "SLOT_TAKEN") {
      return json({ error: "slot_taken", message: "That time was just booked. Please pick another." }, 409);
    }
    if (error.code === "22023") return invalid(error.message);
    if (error.code === "54000") return json({ error: "rate_limited", message: error.message }, 429);
    console.error("contact-sales submit error:", error.code, error.message);
    return json({ error: "server", message: "We couldn't send your request. Please try again or email us." }, 500);
  }

  const result = data as {
    inquiry_id: string; duplicate: boolean; segment: string; priority: string;
    booking: { slot_start: string; slot_end: string } | null;
  };

  if (!result.duplicate) {
    const task = notifySales({
      fullName, email: workEmail, company: companyName, jobTitle, phone, teamSize, locations, bestTime, message,
      segment: result.segment, priority: result.priority, slotStart: result.booking?.slot_start ?? null,
    }).catch((err) => console.error("contact-sales notify error:", err));
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
    else await task;
  }

  return json({
    ok: true,
    inquiryId: result.inquiry_id,
    duplicate: result.duplicate,
    booking: result.booking ? { slotStart: result.booking.slot_start, slotEnd: result.booking.slot_end } : null,
  });
});
