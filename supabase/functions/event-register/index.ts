// supabase/functions/event-register/index.ts
//
// Public (no login) endpoint behind the registration form on /events.
// Deploy with --no-verify-jwt. All the real work (validation of the
// event, duplicate check, capacity, flood guard) happens atomically in
// the register_for_public_event() SQL function; this function adds
// input validation, a honeypot, the confirmation email, and optional
// newsletter opt-in (same newsletter_subscribers table as the footer).
//
// A duplicate registration returns the join link again but deliberately
// does NOT resend an email, so the form can't be used to spam an inbox.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface EventRow {
  slug: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  format: "online" | "in_person" | "hybrid";
  location_label: string | null;
  join_url: string | null;
  host_name: string | null;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function fail(status: number, reason: string, error: string) {
  return jsonResponse({ error, reason }, status);
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

function formatWhen(startsAt: string, endsAt: string, timeZone: string): string {
  const tz = safeTimeZone(timeZone);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(startsAt));
  const time = (iso: string, withZone: boolean) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", ...(withZone ? { timeZoneName: "short" as const } : {}) }).format(new Date(iso));
  return `${date}, ${time(startsAt, false)} – ${time(endsAt, true)}`;
}

function calendarStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function locationLabel(event: EventRow): string {
  if (event.format === "online") return "Online";
  if (event.format === "in_person") return event.location_label || "In person";
  return `${event.location_label || "In person"} + online`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));

    // Honeypot: real users never see or fill this field.
    if (typeof body.website === "string" && body.website.trim() !== "") return fail(400, "invalid", "Invalid request.");

    const slug = String(body.event_slug ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const marketing = body.marketing_opt_in === true;

    if (!SLUG_RE.test(slug) || slug.length < 3 || slug.length > 80) return fail(404, "not_found", "This event isn't available.");
    if (name.length < 2 || name.length > 100) return fail(400, "invalid", "Please enter your full name.");
    if (email.length > 254 || !EMAIL_RE.test(email)) return fail(400, "invalid", "Please enter a valid email address.");

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

    const { data, error } = await admin.rpc("register_for_public_event", { p_slug: slug, p_name: name, p_email: email, p_marketing: marketing });
    if (error) throw error;

    const result = data as { status: string; event?: EventRow } | null;
    switch (result?.status) {
      case "not_found":
        return fail(404, "not_found", "This event isn't available.");
      case "closed":
        return fail(409, "closed", "Registration for this event is closed.");
      case "full":
        return fail(409, "full", "This event is full.");
      case "rate_limited":
        return fail(429, "rate_limited", "Too many registrations right now. Please try again later.");
      case "registered":
      case "already_registered":
        break;
      default:
        throw new Error(`Unexpected register_for_public_event status: ${result?.status}`);
    }

    const event = result.event as EventRow;
    const joinUrl = typeof event.join_url === "string" && event.join_url.startsWith("https://") ? event.join_url : null;
    let emailSent = false;

    if (result.status === "registered") {
      if (marketing) {
        // Unique violation = already subscribed; any other failure must not block registration.
        await admin.from("newsletter_subscribers").insert({ email, source: "events" });
      }

      try {
        const pageUrl = `${siteUrl}/events?event=${encodeURIComponent(event.slug)}`;
        const when = formatWhen(event.starts_at, event.ends_at, event.timezone);
        const where = locationLabel(event);
        const calendarUrl =
          "https://calendar.google.com/calendar/render?" +
          new URLSearchParams({
            action: "TEMPLATE",
            text: event.title,
            dates: `${calendarStamp(event.starts_at)}/${calendarStamp(event.ends_at)}`,
            details: joinUrl ? `Join: ${joinUrl}\n\nEvent page: ${pageUrl}` : `Event page: ${pageUrl}`,
            location: where,
          }).toString();

        const joinButton = joinUrl
          ? `<a href="${escapeHtml(joinUrl)}" style="display: inline-block; margin: 8px 8px 0 0; padding: 12px 24px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Join link</a>`
          : "";

        const html = `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
          <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 16px;">You're registered</p>
          <h1 style="font-size: 22px; margin: 0 0 8px;">${escapeHtml(event.title)}</h1>
          <p style="margin: 0 0 4px; font-size: 15px;">${escapeHtml(when)}</p>
          <p style="margin: 0 0 20px; font-size: 15px; color: #4b5563;">${escapeHtml(where)}</p>
          <p style="margin: 0 0 8px; font-size: 15px;">Hi ${escapeHtml(name)}, your spot is saved.</p>
          ${joinButton}
          <a href="${escapeHtml(calendarUrl)}" style="display: inline-block; margin: 8px 0 0; padding: 12px 24px; background: #f3f4f6; color: #111827; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Add to Google Calendar</a>
          <p style="margin-top: 24px; font-size: 13px; color: #9ca3af;">Event details and updates: <a href="${escapeHtml(pageUrl)}" style="color: #6b7280;">${escapeHtml(pageUrl)}</a></p>
        </div>`;

        const text = [
          `You're registered: ${event.title}`,
          when,
          where,
          joinUrl ? `Join: ${joinUrl}` : "",
          `Add to Google Calendar: ${calendarUrl}`,
          `Event page: ${pageUrl}`,
        ]
          .filter(Boolean)
          .join("\n");

        const sent = await sendEmail(email, `You're registered: ${event.title}`, html, text);
        emailSent = sent.ok;
        if (!sent.ok) console.error(JSON.stringify({ event: "event_register_email_failed", error: sent.error }));
      } catch (emailError) {
        console.error(JSON.stringify({ event: "event_register_email_failed", error: emailError instanceof Error ? emailError.message : String(emailError) }));
      }
    }

    return jsonResponse({ status: result.status, join_url: joinUrl, email_sent: emailSent });
  } catch (error) {
    console.error(JSON.stringify({ event: "event_register_failed", error: error instanceof Error ? error.message : String(error) }));
    return fail(500, "error", "Something went wrong. Please try again.");
  }
});
