// supabase/functions/warranty-register/index.ts
//
// Public, unauthenticated endpoint behind /warranty/register.
//
// Deploy WITHOUT JWT verification (visitors have no session):
//   supabase functions deploy warranty-register --no-verify-jwt
// Secrets used: RESEND_API_KEY, RESEND_FROM_EMAIL (optional), SITE_URL (optional).
//
// Flow: validate -> atomic per-IP rate limit -> register_warranty() RPC
//       -> confirmation email (best effort; never fails the registration).
//
// Wire format
//   200 { ok: true, confirmationCode, passportCode|null, linked, duplicate, emailSent }
//   400 { error: "validation", message, fieldErrors }
//   404 { error: "passport_not_found", message, fieldErrors }
//   429 { error: "rate_limited", message }
//   5xx { error: "server", message }

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_PER_WINDOW = 5;
const WINDOW_SECONDS = 60 * 60;
const MAX_BODY_BYTES = 8 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max + 1) : "");
const isoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

interface Clean {
  name: string; email: string; phone: string; address: string; passportCode: string;
  equipmentType: string; make: string; model: string; serial: string;
  purchaseDate: string; installDate: string; installer: string; purchasedFrom: string;
}

function validate(b: Record<string, unknown>): { clean: Clean; fieldErrors: Record<string, string> } {
  const clean: Clean = {
    name: str(b.name, 120), email: str(b.email, 254).toLowerCase(), phone: str(b.phone, 30), address: str(b.address, 300),
    passportCode: str(b.passportCode, 80), equipmentType: str(b.equipmentType, 80), make: str(b.make, 80), model: str(b.model, 80),
    serial: str(b.serial, 60), purchaseDate: str(b.purchaseDate, 10), installDate: str(b.installDate, 10),
    installer: str(b.installer, 120), purchasedFrom: str(b.purchasedFrom, 120),
  };
  const e: Record<string, string> = {};
  if (clean.name.length < 2 || clean.name.length > 120) e.name = "Enter your full name.";
  if (clean.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) e.email = "Enter a valid email address.";
  if (clean.phone && (!/^[+\d\s().-]+$/.test(clean.phone) || clean.phone.replace(/\D/g, "").length < 7 || clean.phone.replace(/\D/g, "").length > 15)) {
    e.phone = "Enter a valid phone number, or leave it empty.";
  }
  if (clean.address.length > 300) e.address = "That address is too long.";
  if (!clean.equipmentType || clean.equipmentType.length > 80) e.equipmentType = "Choose the equipment type.";
  if (!clean.make || clean.make.length > 80) e.make = "Enter the brand.";
  if (clean.model.length > 80) e.model = "That model is too long.";
  if (clean.serial.length < 4 || clean.serial.length > 60 || !/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(clean.serial)) {
    e.serial = "Enter the serial number printed on the unit (4–60 letters or digits).";
  }
  const today = new Date();
  const tomorrow = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1)).toISOString().slice(0, 10);
  if (!isoDate(clean.purchaseDate) || clean.purchaseDate > tomorrow) e.purchaseDate = "Enter the purchase date (it can’t be in the future).";
  if (clean.installDate && (!isoDate(clean.installDate) || clean.installDate > tomorrow || (isoDate(clean.purchaseDate) && clean.installDate < clean.purchaseDate))) {
    e.installDate = "The install date must be on or after the purchase date.";
  }
  if (clean.installer.length > 120) e.installer = "That name is too long.";
  if (clean.purchasedFrom.length > 120) e.purchasedFrom = "That name is too long.";
  if (b.termsAccepted !== true) e.terms = "Please accept the terms to register.";
  return { clean, fieldErrors: e };
}

const RPC_ERRORS: Record<string, [string, string]> = {
  invalid_name: ["name", "Enter your full name."],
  invalid_email: ["email", "Enter a valid email address."],
  invalid_equipment: ["make", "Check the equipment type and brand."],
  invalid_serial: ["serial", "Enter the serial number printed on the unit."],
  invalid_date: ["purchaseDate", "Check the dates you entered."],
  invalid_purchase_date: ["purchaseDate", "The purchase date looks wrong. Check it and try again."],
  invalid_install_date: ["installDate", "The install date must be on or after the purchase date."],
  terms_required: ["terms", "Please accept the terms to register."],
  passport_not_found: ["passportCode", "We couldn’t find that passport code. Check the label on your unit, or leave it empty."],
};

const maskSerial = (s: string) => (s.replace(/\s/g, "").length <= 4 ? "••••" : `••••${s.replace(/\s/g, "").slice(-4)}`);

function buildEmail(input: { name: string; code: string; make: string; model: string; serial: string; purchaseDate: string; passportUrl: string | null }) {
  const product = [input.make, input.model].filter(Boolean).join(" ");
  const first = input.name.split(/\s+/)[0] || "there";
  const subject = `Warranty registration confirmed — ${input.code}`;
  const text = [
    `Hi ${first},`,
    "",
    "Your warranty registration is confirmed.",
    "",
    `Confirmation code: ${input.code}`,
    `Product: ${product}`,
    `Serial: ${maskSerial(input.serial)}`,
    `Purchase date: ${input.purchaseDate}`,
    input.passportUrl ? `Equipment passport: ${input.passportUrl}` : "",
    "",
    "Keep your proof of purchase (receipt or invoice) — you’ll need it if you make a warranty claim.",
    "If you didn’t register this equipment, you can ignore this email.",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111827;line-height:1.5">
<h2 style="margin:0 0 12px">Warranty registration confirmed</h2>
<p>Hi ${esc(first)}, your registration is complete.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr><td style="padding:6px 0;color:#6b7280">Confirmation code</td><td style="padding:6px 0;text-align:right;font-weight:700">${esc(input.code)}</td></tr>
<tr><td style="padding:6px 0;color:#6b7280">Product</td><td style="padding:6px 0;text-align:right">${esc(product)}</td></tr>
<tr><td style="padding:6px 0;color:#6b7280">Serial</td><td style="padding:6px 0;text-align:right">${esc(maskSerial(input.serial))}</td></tr>
<tr><td style="padding:6px 0;color:#6b7280">Purchase date</td><td style="padding:6px 0;text-align:right">${esc(input.purchaseDate)}</td></tr>
</table>
${input.passportUrl ? `<p><a href="${esc(input.passportUrl)}" style="color:#2563eb">View your equipment passport</a></p>` : ""}
<p style="color:#4b5563">Keep your proof of purchase (receipt or invoice) — you’ll need it if you make a warranty claim.</p>
<p style="color:#9ca3af;font-size:12px">If you didn’t register this equipment, you can ignore this email.</p>
</div>`;
  return { subject, html, text };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Method not allowed." }, 405);

  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "validation", message: "That request was too large.", fieldErrors: {} }, 413);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad body");
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "validation", message: "Invalid request.", fieldErrors: {} }, 400);
    }

    // Honeypot: real visitors never fill this. Answer like a success so bots learn nothing.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return json({ ok: true, confirmationCode: "WR-00000000", passportCode: null, linked: false, duplicate: false, emailSent: false });
    }

    const { clean, fieldErrors } = validate(body);
    if (Object.keys(fieldErrors).length > 0) {
      return json({ error: "validation", message: "Please fix the highlighted fields.", fieldErrors }, 400);
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("cf-connecting-ip") ?? "unknown";
    const { data: allowed, error: limitError } = await admin.rpc("wr_rate_limit_hit", {
      p_ip_hash: await hashIp(ip),
      p_max: MAX_PER_WINDOW,
      p_window_seconds: WINDOW_SECONDS,
    });
    if (limitError) {
      console.error("warranty-register rate limit failed:", limitError.message);
      return json({ error: "server", message: "We couldn’t process your registration right now. Please try again shortly." }, 503); // fail closed
    }
    if (allowed !== true) {
      return json({ error: "rate_limited", message: "You’ve submitted several registrations recently. Please try again in about an hour." }, 429);
    }

    const { data, error } = await admin.rpc("register_warranty", {
      p: {
        owner_name: clean.name, owner_email: clean.email, owner_phone: clean.phone, service_address: clean.address,
        passport_code: clean.passportCode, equipment_type: clean.equipmentType, make: clean.make, model: clean.model,
        serial_number: clean.serial, purchase_date: clean.purchaseDate, install_date: clean.installDate,
        installer_name: clean.installer, purchased_from: clean.purchasedFrom, terms_accepted: true,
      },
    });
    if (error || !data) {
      console.error("warranty-register rpc failed:", error?.message);
      return json({ error: "server", message: "We couldn’t save your registration. Please try again." }, 500);
    }

    if (data.ok !== true) {
      const mapped = RPC_ERRORS[String(data.error)];
      if (mapped) {
        return json(
          { error: data.error === "passport_not_found" ? "passport_not_found" : "validation", message: mapped[1], fieldErrors: { [mapped[0]]: mapped[1] } },
          data.error === "passport_not_found" ? 404 : 400,
        );
      }
      return json({ error: "server", message: "We couldn’t save your registration. Please try again." }, 500);
    }

    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    const passportCode: string | null = data.passport_code ?? null;
    let emailSent = false;

    // Duplicate = this unit + email is already registered: confirm again on screen, never re-email.
    if (data.duplicate !== true) {
      try {
        const mail = buildEmail({
          name: clean.name, code: data.confirmation_code, make: clean.make, model: clean.model, serial: clean.serial,
          purchaseDate: clean.purchaseDate, passportUrl: passportCode ? `${siteUrl}/e/${passportCode}` : null,
        });
        const sent = await sendEmail(clean.email, mail.subject, mail.html, mail.text);
        emailSent = sent.ok;
        if (!sent.ok) console.error("warranty-register email failed:", sent.error);
      } catch (e) {
        console.error("warranty-register email threw:", e instanceof Error ? e.message : e);
      }
      await admin
        .from("warranty_registrations")
        .update({ email_status: emailSent ? "sent" : "failed", email_sent_at: emailSent ? new Date().toISOString() : null })
        .eq("id", data.id);
    }

    return json({
      ok: true,
      confirmationCode: data.confirmation_code,
      passportCode,
      linked: Boolean(passportCode),
      duplicate: data.duplicate === true,
      emailSent,
    });
  } catch (e) {
    console.error("warranty-register unexpected:", e instanceof Error ? e.message : e);
    return json({ error: "server", message: "Something went wrong. Please try again." }, 500);
  }
});
