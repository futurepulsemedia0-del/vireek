// supabase/functions/visual-estimate/index.ts
//
// Visual AI Estimating: downloads 1-3 photos the caller already uploaded to
// their own folder in the private `estimate-photos` bucket, sends them to
// Gemini's vision-capable generateContent endpoint, and returns a strict-
// JSON draft (detected issue + line items) for the Quotes builder to
// pre-fill. The AI never talks to the database and never sends anything to
// the customer directly — output is always a draft a human must review.
//
// Auth: caller's own Supabase JWT (Authorization header) — this is what
// lets us download the photo at all, since storage RLS only allows a user
// to read their own folder. No service-role client is used for the image
// fetch, only for the rate-limit counter (see the ai-assistant-query fix).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8MB each
const RATE_LIMIT_MAX_PER_HOUR = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const RESPONSE_SCHEMA = `Return ONLY a JSON object, no markdown, in exactly this shape:
{
  "detected_issue": "short plain-English description of what you see, e.g. 'Corroded copper pipe joint with active leak'",
  "service_type": "one of: plumbing, hvac, electrical, roofing, fencing, landscaping, general_handyman, other",
  "severity": "one of: low, medium, high, emergency",
  "confidence": 0.0 to 1.0,
  "line_items": [
    { "description": "specific labor or material line", "quantity": 1, "unit_price_cents": 0 }
  ]
}
Rules:
- 2 to 6 line_items. Be specific (e.g. "Replace 3ft of 1/2in copper pipe" not "Fix pipe").
- unit_price_cents is a CONSERVATIVE US national-average BALLPARK in cents (e.g. 15000 = $150). The business will review and correct every price before sending anything to a customer — never present this as final.
- If the photo doesn't show a clear, identifiable home-service issue, set service_type to "other", severity to "low", confidence below 0.3, and give your best single generic line item.
- Never invent brand names, addresses, or people from the image.`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const { storagePaths } = await req.json();
    if (!Array.isArray(storagePaths) || storagePaths.length === 0 || storagePaths.length > MAX_PHOTOS) {
      return json({ error: `Provide 1 to ${MAX_PHOTOS} storage paths.` }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    // Paths must live in the caller's own folder — belt-and-suspenders on
    // top of storage RLS, which would reject the download anyway.
    for (const p of storagePaths) {
      if (typeof p !== "string" || !p.startsWith(`${user.id}/`)) {
        return json({ error: "Invalid photo path." }, 400);
      }
    }

    // ---- Rate limit (service-role client, NOT the caller's) ----------------
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const rateLimitDb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const nowMs = Date.now();
    const { data: existingLimit } = await rateLimitDb
      .from("visual_estimate_rate_limit")
      .select("window_start, request_count")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingLimit && nowMs - new Date(existingLimit.window_start).getTime() < RATE_LIMIT_WINDOW_MS) {
      if (existingLimit.request_count >= RATE_LIMIT_MAX_PER_HOUR) {
        return json({ error: "You've hit the hourly limit for AI photo estimates. Try again in a bit." }, 429);
      }
      await rateLimitDb.from("visual_estimate_rate_limit")
        .update({ request_count: existingLimit.request_count + 1 })
        .eq("user_id", user.id);
    } else {
      await rateLimitDb.from("visual_estimate_rate_limit")
        .upsert({ user_id: user.id, window_start: new Date(nowMs).toISOString(), request_count: 1 });
    }

    // ---- Download photos (caller-scoped client → enforces storage RLS) ----
    const imageParts: { inline_data: { mime_type: string; data: string } }[] = [];
    for (const path of storagePaths) {
      const { data: blob, error: dlError } = await callerClient.storage.from("estimate-photos").download(path);
      if (dlError || !blob) return json({ error: `Could not read photo: ${path}` }, 404);
      if (blob.size > MAX_PHOTO_BYTES) return json({ error: "Each photo must be under 8MB." }, 400);

      const buf = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      imageParts.push({ inline_data: { mime_type: blob.type || "image/jpeg", data: base64 } });
    }

    // ---- Gemini vision call -------------------------------------------------
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "AI estimating is not configured yet (missing GEMINI_API_KEY)." }, 500);

    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: RESPONSE_SCHEMA }, ...imageParts] }],
          generationConfig: { maxOutputTokens: 800, temperature: 0.4, response_mime_type: "application/json" },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!geminiRes.ok) {
      const t = await geminiRes.text().catch(() => "");
      console.error("[visual-estimate] Gemini error", geminiRes.status, t.slice(0, 300));
      return json({ error: "The AI estimator is temporarily unavailable. You can still build the quote manually." }, 502);
    }

    const geminiData = await geminiRes.json();
    const rawText: string = geminiData?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

    let parsed: {
      detected_issue?: string; service_type?: string; severity?: string; confidence?: number;
      line_items?: { description: string; quantity: number; unit_price_cents: number }[];
    };
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch {
      return json({ error: "The AI response could not be parsed. Try again or build the quote manually." }, 502);
    }

    const lineItems = (parsed.line_items ?? [])
      .filter((li) => li && typeof li.description === "string" && li.description.trim())
      .slice(0, 6)
      .map((li) => ({
        description: String(li.description).slice(0, 200),
        quantity: Math.max(1, Math.round(Number(li.quantity) || 1)),
        unit_price_cents: Math.max(0, Math.round(Number(li.unit_price_cents) || 0)),
      }));

    if (lineItems.length === 0) {
      return json({ error: "Couldn't identify a clear estimate from this photo. Try a closer, well-lit photo, or build the quote manually." }, 422);
    }

    return json({
      detected_issue: String(parsed.detected_issue ?? "").slice(0, 300),
      service_type: String(parsed.service_type ?? "other"),
      severity: String(parsed.severity ?? "low"),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      line_items: lineItems,
    });
  } catch (err) {
    console.error("[visual-estimate] unhandled error", err);
    return json({ error: "Something went wrong generating the estimate." }, 500);
  }
});
