// supabase/functions/onboarding-concierge/index.ts
//
// AI-native Onboarding Concierge — authenticated, streaming chat that
// replaces the wizard's rigid page-by-page flow with a natural
// conversation. A brand-new user just talks about their business; this
// function extracts structured setup fields from what they say and
// streams back a warm reply asking for whatever's still missing.
//
// ============================================================
// SECURITY MODEL (same philosophy as ai-assistant-query — read first)
// ============================================================
// The LLM NEVER writes to the database and is never given a database
// connection. This function's ONLY database access is: (1) verifying the
// caller's own JWT via supabase.auth.getUser(), and (2) rate-limit
// bookkeeping through a service-role client scoped to a single table
// that has no authenticated-role policies at all (see the migration).
//
// The model's structured output (a JSON object of setup fields) is run
// through `sanitizeExtracted()` below, which keeps ONLY a fixed
// whitelist of keys and, for every enum field, only a value from that
// field's fixed set of allowed values — anything else the model returns
// (extra keys, freeform strings where an enum is expected, malformed
// hours) is silently dropped, never passed through. The sanitized
// result is returned to the browser as data, not executed here; the
// actual `profiles` / `business_profile` writes happen client-side
// through the normal supabase-js client, under the exact same RLS
// policies that already protect those tables on every other page
// (OnboardingPage, BusinessProfilePage, etc.) — this function has no
// more write power over an account than the model output itself allows,
// which is none.
//
// LLM provider: routed through the Vireek AI Core, same automatic
// Gemini -> Groq -> Cerebras -> Cloudflare -> OpenRouter chain as every
// other AI feature (Cloudflare skipped for the JSON extraction step —
// see registry.ts). Two calls per turn: "onboarding_extract" (JSON,
// non-streamed) then "onboarding_concierge" (prose, streamed).
//
// STREAMING WIRE FORMAT, one JSON object per SSE "data:" line:
//   {"fields": {...}}                                  - sanitized extracted fields (sent once, first)
//   {"delta": "..."}                                    - a chunk of the concierge's reply
//   {"done": true, "provider": "...", "model": "..."}   - stream finished
//   {"error": "..."}                                    - something failed; stream ends
// Validation, auth and rate-limit checks happen up front and return a
// plain (non-streamed) JSON error response, exactly like site-assistant.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi, askVireekAiStream, safeFallbackMessage } from "../_shared/ai-core/index.ts";
import type { ChatMessage } from "../_shared/ai-core/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const sseHeaders = {
  ...corsHeaders,
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const MAX_MESSAGE_LENGTH = 600;
const MAX_HISTORY_TURNS = 8;
const RATE_LIMIT_MAX_PER_HOUR = 40;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ----------------------------------------------------------------
// Whitelisted, validated extraction output — see security note above.
// ----------------------------------------------------------------

interface ExtractedFields {
  full_name?: string;
  company_name?: string;
  phone?: string;
  forwarding_number?: string;
  primary_industry?: string;
  team_size?: string;
  service_area?: string;
  services_offered?: string[];
  current_call_handling?: string;
  scheduling_tool?: string;
  avg_job_value?: number;
  handles_emergency_calls?: string;
  business_hours?: Record<string, { open: string; close: string }>;
}

const PRIMARY_INDUSTRY_VALUES = new Set(["hvac", "plumbing", "electrical", "roofing", "general_home_services", "other"]);
const TEAM_SIZE_VALUES = new Set(["solo", "2-5", "6-15", "16+"]);
const CALL_HANDLING_VALUES = new Set(["in_house", "answering_service", "voicemail", "another_ai_tool", "none"]);
const SCHEDULING_TOOL_VALUES = new Set(["service_titan", "housecall_pro", "jobber", "other", "none"]);
const EMERGENCY_VALUES = new Set(["yes_premium", "yes_same_rate", "business_hours_only"]);
const DAY_KEYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanString(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim().slice(0, maxLen);
  return trimmed || undefined;
}

function sanitizeExtracted(raw: unknown): ExtractedFields {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: ExtractedFields = {};

  const fullName = cleanString(r.full_name, 120);
  if (fullName) out.full_name = fullName;
  const companyName = cleanString(r.company_name, 120);
  if (companyName) out.company_name = companyName;
  const phone = cleanString(r.phone, 30);
  if (phone) out.phone = phone;
  const forwardingNumber = cleanString(r.forwarding_number, 30);
  if (forwardingNumber) out.forwarding_number = forwardingNumber;
  const serviceArea = cleanString(r.service_area, 160);
  if (serviceArea) out.service_area = serviceArea;

  if (typeof r.primary_industry === "string" && PRIMARY_INDUSTRY_VALUES.has(r.primary_industry)) {
    out.primary_industry = r.primary_industry;
  }
  if (typeof r.team_size === "string" && TEAM_SIZE_VALUES.has(r.team_size)) {
    out.team_size = r.team_size;
  }
  if (typeof r.current_call_handling === "string" && CALL_HANDLING_VALUES.has(r.current_call_handling)) {
    out.current_call_handling = r.current_call_handling;
  }
  if (typeof r.scheduling_tool === "string" && SCHEDULING_TOOL_VALUES.has(r.scheduling_tool)) {
    out.scheduling_tool = r.scheduling_tool;
  }
  if (typeof r.handles_emergency_calls === "string" && EMERGENCY_VALUES.has(r.handles_emergency_calls)) {
    out.handles_emergency_calls = r.handles_emergency_calls;
  }
  if (typeof r.avg_job_value === "number" && Number.isFinite(r.avg_job_value) && r.avg_job_value >= 0) {
    out.avg_job_value = Math.round(r.avg_job_value * 100) / 100;
  }
  if (Array.isArray(r.services_offered)) {
    const services = r.services_offered
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 20);
    if (services.length) out.services_offered = services;
  }
  if (r.business_hours && typeof r.business_hours === "object") {
    const hours: Record<string, { open: string; close: string }> = {};
    for (const [day, val] of Object.entries(r.business_hours as Record<string, unknown>)) {
      if (!DAY_KEYS.has(day) || !val || typeof val !== "object") continue;
      const v = val as Record<string, unknown>;
      const open = typeof v.open === "string" && TIME_RE.test(v.open) ? v.open : null;
      const close = typeof v.close === "string" && TIME_RE.test(v.close) ? v.close : null;
      if (open && close) hours[day] = { open, close };
    }
    if (Object.keys(hours).length) out.business_hours = hours;
  }

  return out;
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

const ESSENTIAL_FIELD_LABELS: Record<string, string> = {
  company_name: "their company name",
  primary_industry: "their main trade/industry",
  service_area: "the area or city they service",
  services_offered: "which specific services they offer",
  current_call_handling: "how calls are handled today",
  business_hours: "their business hours",
  team_size: "how many people are on their team",
  scheduling_tool: "what scheduling/CRM software they use, if any",
  handles_emergency_calls: "how they handle after-hours/emergency calls",
};

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

function missingEssentials(known: Record<string, unknown>, justCaptured: ExtractedFields): string[] {
  const merged: Record<string, unknown> = { ...known, ...justCaptured };
  return Object.entries(ESSENTIAL_FIELD_LABELS)
    .filter(([key]) => isEmpty(merged[key]))
    .map(([, label]) => label);
}

function sseLine(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401, headers: jsonHeaders });
    }

    const body = await req.json().catch(() => null);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const history: ChatMessage[] = Array.isArray(body?.history) ? body.history : [];
    const known: Record<string, unknown> = body?.known && typeof body.known === "object" ? body.known : {};

    if (!message) {
      return new Response(JSON.stringify({ error: "Message is required." }), { status: 400, headers: jsonHeaders });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return new Response(JSON.stringify({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: jsonHeaders });
    }

    // Rate-limit bookkeeping through a service-role client — same
    // "no authenticated write path" pattern as ai_assistant_rate_limit
    // and site_assistant_rate_limit, built in correctly from day one
    // this time (see the migration for this table).
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const rateLimitDb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const nowMs = Date.now();

    const { data: existingLimit } = await rateLimitDb
      .from("onboarding_concierge_rate_limit")
      .select("window_start, request_count")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingLimit) {
      const windowAgeMs = nowMs - new Date(existingLimit.window_start).getTime();
      if (windowAgeMs < RATE_LIMIT_WINDOW_MS) {
        if (existingLimit.request_count >= RATE_LIMIT_MAX_PER_HOUR) {
          return new Response(
            JSON.stringify({ error: "You've sent a lot of setup messages this hour — take a short break and try again shortly." }),
            { status: 429, headers: jsonHeaders },
          );
        }
        await rateLimitDb
          .from("onboarding_concierge_rate_limit")
          .update({ request_count: existingLimit.request_count + 1 })
          .eq("user_id", user.id);
      } else {
        await rateLimitDb
          .from("onboarding_concierge_rate_limit")
          .update({ window_start: new Date(nowMs).toISOString(), request_count: 1 })
          .eq("user_id", user.id);
      }
    } else {
      await rateLimitDb.from("onboarding_concierge_rate_limit").insert({
        user_id: user.id,
        window_start: new Date(nowMs).toISOString(),
        request_count: 1,
      });
    }

    const trimmedHistory: ChatMessage[] = history.slice(-MAX_HISTORY_TURNS * 2).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).slice(0, MAX_MESSAGE_LENGTH),
    }));
    const turnMessages: ChatMessage[] = [...trimmedHistory, { role: "user", content: message }];

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Step 1: extract whatever setup fields this message contains.
        // Failure here degrades gracefully — the concierge still
        // replies conversationally, it just captured nothing this turn.
        let extracted: ExtractedFields = {};
        try {
          const extractResult = await askVireekAi({
            task: "onboarding_extract",
            messages: turnMessages,
            maxTokens: 400,
            jsonMode: true,
          });
          extracted = sanitizeExtracted(extractJson(extractResult.text));
        } catch (err) {
          console.error("[onboarding-concierge] extraction failed:", err);
        }
        controller.enqueue(sseLine({ fields: extracted }));

        // Step 2: stream a warm reply, informed by what's now known.
        const missing = missingEssentials(known, extracted);
        const guidance =
          missing.length > 0
            ? `Setup fields still missing: ${missing.join("; ")}. Ask about ONE of these next — whichever fits most naturally after what they just said.`
            : `Every essential setup field is now captured. Congratulate them warmly and tell them to hit "Finish setup" to go to their dashboard — don't ask anything further.`;

        let receivedAny = false;
        try {
          const result = await askVireekAiStream(
            {
              task: "onboarding_concierge",
              messages: turnMessages,
              maxTokens: 260,
              extraInstructions: guidance,
            },
            (delta) => {
              if (delta) receivedAny = true;
              controller.enqueue(sseLine({ delta }));
            },
          );
          console.log(
            `[onboarding-concierge] provider=${result.meta.provider} model=${result.meta.model} ` +
              `fallback=${result.meta.wasFallback} latencyMs=${result.meta.latencyMs}`,
          );
          if (!receivedAny) {
            controller.enqueue(sseLine({ delta: "Got it — what else can you tell me about your business?" }));
          }
          controller.enqueue(sseLine({ done: true, provider: result.meta.provider, model: result.meta.model }));
        } catch (err) {
          console.error("[onboarding-concierge] AI Core error (all providers failed):", err);
          controller.enqueue(sseLine({ error: safeFallbackMessage(err) }));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });
  } catch (err) {
    console.error("onboarding-concierge error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
