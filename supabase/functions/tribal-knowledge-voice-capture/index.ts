// supabase/functions/tribal-knowledge-voice-capture/index.ts
//
// Company Brain — Technician Voice Note → Knowledge Article
//
// Input : an uploaded voice note (private bucket tribal-knowledge-media)
//         and/or typed notes.
// Output: EITHER a DRAFT knowledge_articles row (audience='team',
//         source='voice_note', status='draft', confidence_score set)
//         OR { useful: false, message } when there's nothing reusable.
//         A second technician later calls verify_knowledge_article()
//         (see the migration) to confirm it and publish it.
//
// Auth  : caller's own JWT for the article insert (RLS enforces tenant
//         isolation). Service role only for the shared quota RPC.
//
// Secrets: GEMINI_API_KEY (required, shared with tribal-knowledge-manual-ingest),
//          GEMINI_MODEL (optional).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const MEDIA_BUCKET = "tribal-knowledge-media";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const QUOTA_MAX_PER_HOUR = 20;
const QUOTA_WINDOW_SECONDS = 3600;

const SYSTEM_PROMPT = `You listen to a field technician's voice note (recorded after a job) — plus any typed notes — and decide whether it holds reusable field knowledge worth adding to the company's internal knowledge base.

Rules:
1. Only set useful=true when there is a concrete, reusable fact: a specific equipment brand/model + symptom + fix, an error code and its cause, a part number, or a step future technicians would want on that job type. Job-status chatter ("done, heading to the next one"), venting, or vague impressions with no fix are NOT useful.
2. If useful, produce exactly one article:
   - title: what a technician would search for later (e.g. "Trane XR16 — loud click on startup after compressor swap")
   - summary: 1-2 sentence takeaway
   - body: the symptom/condition and the fix, in full detail, cleaned up for clarity — keep any specific values, sequences or warnings the technician gave
   - category: short trade/service category
   - keywords: 3-8 short terms — brand, equipment model, error code, part number, whatever is actually named
   - confidence_score: integer 0-100, how specific and verifiable the claim is.
     80-100: names a specific model/symptom/fix or error code.
     40-79: a real, usable fix but light on specifics.
     0-39: a hunch or an unconfirmed pattern ("seems like X models do this sometimes").
3. Never invent a model number, part number or spec that wasn't said.
4. If not useful, set useful=false and a short "reason" (e.g. "No equipment, symptom or fix mentioned").
5. Output ONLY the JSON object — no markdown, no commentary.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    useful: { type: "boolean" },
    reason: { type: "string" },
    article: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        body: { type: "string" },
        category: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        confidence_score: { type: "integer" },
      },
      required: ["title", "body", "confidence_score"],
    },
  },
  required: ["useful"],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function audioMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    wav: "audio/wav", mp3: "audio/mpeg", mpeg: "audio/mpeg", m4a: "audio/mp4",
    mp4: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac",
  };
  return map[ext] ?? "audio/webm";
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const geminiHeaders = (apiKey: string) => ({ "x-goog-api-key": apiKey });

async function callGemini(model: string, apiKey: string, parts: Record<string, unknown>[]) {
  const generationConfig: Record<string, unknown> = {
    temperature: 0.2,
    maxOutputTokens: 4000,
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
  };
  if (model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 1024 };

  return await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...geminiHeaders(apiKey) },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(90_000),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? "";

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
    if (!apiKey) return json({ error: "Voice capture is not configured yet (missing GEMINI_API_KEY)." }, 500);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid request body." }, 400);

    const audioPath: string | null = typeof body.audioPath === "string" ? body.audioPath : null;
    const notes: string = typeof body.notes === "string" ? body.notes.trim().slice(0, 4000) : "";
    if (!audioPath && notes.length < 10) {
      return json({ error: "Add a voice note or a few words of notes." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    if (audioPath && (!audioPath.startsWith(`${user.id}/`) || audioPath.includes(".."))) {
      return json({ error: "Invalid file path." }, 400);
    }

    const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
    const { data: allowed, error: quotaError } = await serviceClient.rpc("consume_tribal_knowledge_quota", {
      p_user_id: user.id,
      p_max: QUOTA_MAX_PER_HOUR,
      p_window_seconds: QUOTA_WINDOW_SECONDS,
    });
    if (quotaError) return json({ error: "Could not verify your usage limit. Try again shortly." }, 500);
    if (allowed === false) return json({ error: "You've reached the hourly limit for knowledge capture. Try again in a bit." }, 429);

    const { data: ownerId } = await callerClient.rpc("get_account_owner_id");
    if (!ownerId) return json({ error: "Could not resolve your account." }, 500);

    let contributedBy: string | null = null;
    if (user.email) {
      const { data: member } = await callerClient
        .from("team_members")
        .select("id")
        .eq("member_email", user.email)
        .maybeSingle();
      contributedBy = member?.id ?? null;
    }

    const parts: Record<string, unknown>[] = [];
    if (audioPath) {
      const res = await callerClient.storage.from(MEDIA_BUCKET).download(audioPath);
      if (res.error || !res.data) return json({ error: "The voice note could not be read." }, 422);
      if (res.data.size > MAX_AUDIO_BYTES) return json({ error: "The voice note is over 10 MB. Try a shorter one." }, 422);
      const buf = new Uint8Array(await res.data.arrayBuffer());
      parts.push({ inline_data: { mime_type: audioMime(audioPath), data: toBase64(buf) } });
    }
    parts.push({ text: notes ? `Typed notes from the technician: ${notes}` : "No typed notes — audio only." });

    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    const geminiRes = await callGemini(model, apiKey, parts);

    if (!geminiRes.ok) {
      const t = await geminiRes.text().catch(() => "");
      console.error("[tribal-knowledge-voice-capture] Gemini error", geminiRes.status, t.slice(0, 300));
      return json({ error: "The AI is temporarily unavailable. Try again shortly." }, 502);
    }

    const data = await geminiRes.json();
    if (data?.promptFeedback?.blockReason) return json({ error: "The AI couldn't process this note." }, 422);
    const rawText: string = data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

    const result = extractJson(rawText);
    if (!result || result.useful !== true) {
      return json({ useful: false, message: (typeof result?.reason === "string" && result.reason) || "Nothing reusable found in this note." });
    }

    const a = (result.article ?? {}) as Record<string, unknown>;
    const title = typeof a.title === "string" ? a.title.trim().slice(0, 200) : "";
    const bodyText = typeof a.body === "string" ? a.body.trim() : "";
    if (!title || !bodyText) {
      return json({ useful: false, message: "Nothing reusable found in this note." });
    }
    const confidence = typeof a.confidence_score === "number"
      ? Math.max(0, Math.min(100, Math.round(a.confidence_score)))
      : 50;

    const row = {
      user_id: ownerId,
      title,
      summary: typeof a.summary === "string" ? a.summary.trim().slice(0, 400) : "",
      body: bodyText,
      category: typeof a.category === "string" ? a.category.trim().slice(0, 60) : null,
      keywords: Array.isArray(a.keywords) ? (a.keywords as unknown[]).filter((k) => typeof k === "string").slice(0, 8) : [],
      audience: "team" as const,
      status: "draft" as const,
      source: "voice_note" as const,
      contributed_by: contributedBy,
      confidence_score: confidence,
      created_by: user.id,
    };

    const { data: inserted, error: insertError } = await callerClient
      .from("knowledge_articles")
      .insert(row)
      .select()
      .single();

    if (insertError) {
      console.error("[tribal-knowledge-voice-capture] insert failed", insertError.message);
      return json({ error: "Could not save the draft article." }, 500);
    }

    return json({ useful: true, article: inserted });
  } catch (e) {
    console.error("[tribal-knowledge-voice-capture] unhandled", e instanceof Error ? e.message : e);
    return json({ error: "Something went wrong processing this voice note." }, 500);
  }
});
