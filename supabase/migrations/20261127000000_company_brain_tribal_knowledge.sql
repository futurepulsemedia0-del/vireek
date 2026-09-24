// supabase/functions/tribal-knowledge-voice-capture/index.ts
//
// Company Brain — Voice Note Capture
//
// Input : a technician's short voice note (private bucket
//         `tribal-knowledge-media`), optional typed context.
// Output: a DRAFT knowledge_articles row (audience='team', source=
//         'voice_note') a human reviews before publishing — same
//         review step every other article source already goes through.
//
// Auth  : the caller's own JWT. The article insert runs as the caller
//         (RLS enforces tenant isolation); the service-role client is
//         used ONLY for the atomic quota RPC.
//
// Secrets: GEMINI_API_KEY (required), GEMINI_MODEL (optional) — reuses
//          the same secrets already set for field-estimate.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const MEDIA_BUCKET = "tribal-knowledge-media";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_NOTES_CHARS = 1000;
const QUOTA_MAX_PER_HOUR = 20;
const QUOTA_WINDOW_SECONDS = 3600;
const DELETE_AUDIO_AFTER_ANALYSIS = true;

const SYSTEM_PROMPT = `You turn a field technician's spoken voice note into ONE internal knowledge-base article other technicians can act on.

Rules:
1. Capture only what the technician actually said — never invent a symptom, part, model number or fix that isn't in the audio or notes.
2. Write for a technician audience: specific, concrete, actionable. Skip pleasantries and customer chit-chat.
3. "title" is the problem/fix in one line, phrased the way a technician would search for it (e.g. "Trane XR16 short-cycling after capacitor swap").
4. "summary" is a 1-2 sentence takeaway.
5. "body" is the full write-up: symptom, diagnosis steps, the actual fix, and any gotcha worth flagging to the next technician.
6. "category" is a short trade/service category (e.g. "HVAC", "Water Heater", "Electrical").
7. "keywords" are 3-8 short search terms (brand, model, part, symptom).
8. If the note has no reusable technical knowledge in it (e.g. it's just a customer status update, a schedule note, nothing a technician could act on later), set "useful" to false and leave the other fields empty.
9. Output ONLY the JSON object — no markdown, no commentary.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    useful: { type: "boolean" },
    title: { type: "string" },
    summary: { type: "string" },
    body: { type: "string" },
    category: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
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

function cleanMime(raw: string | undefined, fallback: string): string {
  const base = (raw ?? "").split(";")[0].trim().toLowerCase();
  if (!base || base === "application/octet-stream") return fallback;
  if (base === "audio/x-wav" || base === "audio/wave") return "audio/wav";
  return base;
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
    maxOutputTokens: 2000,
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
  };
  if (model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 512 };

  return await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...geminiHeaders(apiKey) },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(60_000),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let cleanupClient: ReturnType<typeof createClient> | null = null;
  let cleanupPath: string | null = null;
  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? "";

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
    if (!apiKey) return json({ error: "Voice capture is not configured yet (missing GEMINI_API_KEY)." }, 500);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid request body." }, 400);

    const audioPath: string | null = typeof body.audioPath === "string" ? body.audioPath : null;
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, MAX_NOTES_CHARS) : "";
    if (!audioPath && notes.length < 10) {
      return json({ error: "Add a voice note or at least a few words of notes." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    if (audioPath && (!audioPath.startsWith(`${user.id}/`) || audioPath.includes(".."))) {
      return json({ error: "Invalid media path." }, 400);
    }

    // ---- Atomic quota (service role, RPC only) ----------------------------
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

    // ---- Resolve the account owner (RLS insert target) + credit the technician ----
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

    if (DELETE_AUDIO_AFTER_ANALYSIS && audioPath) {
      cleanupClient = callerClient;
      cleanupPath = audioPath;
    }

    const parts: Record<string, unknown>[] = [];
    let audioIncluded = false;
    if (audioPath) {
      const res = await callerClient.storage.from(MEDIA_BUCKET).download(audioPath);
      if (res.error || !res.data) return json({ error: "The voice note could not be read." }, 422);
      if (res.data.size > MAX_AUDIO_BYTES) return json({ error: "The voice note is over 8 MB. Try a shorter note." }, 422);
      const buf = new Uint8Array(await res.data.arrayBuffer());
      parts.push({ text: "Technician voice note:" });
      parts.push({ inline_data: { mime_type: cleanMime(res.data.type, "audio/wav"), data: toBase64(buf) } });
      audioIncluded = true;
    }
    parts.push({ text: `Technician typed notes: ${notes || "none"}` });

    if (!audioIncluded && notes.length < 10) {
      return json({ error: "The voice note couldn't be read. Add a few words of notes instead." }, 422);
    }

    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    const geminiRes = await callGemini(model, apiKey, parts);

    if (!geminiRes.ok) {
      const t = await geminiRes.text().catch(() => "");
      console.error("[tribal-knowledge-voice-capture] Gemini error", geminiRes.status, t.slice(0, 300));
      return json({ error: "The AI is temporarily unavailable. Try again shortly." }, 502);
    }

    const data = await geminiRes.json();
    if (data?.promptFeedback?.blockReason) return json({ error: "The AI couldn't process this voice note." }, 422);
    const rawText: string = data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

    const result = extractJson(rawText);
    if (!result) return json({ error: "Couldn't make sense of this note. Try again with a clearer recording." }, 422);

    if (result.useful === false) {
      return json({ useful: false, message: "No reusable technical knowledge found in this note — nothing was saved." });
    }

    const title = typeof result.title === "string" ? result.title.trim().slice(0, 200) : "";
    const summary = typeof result.summary === "string" ? result.summary.trim().slice(0, 400) : "";
    const articleBody = typeof result.body === "string" ? result.body.trim() : "";
    const category = typeof result.category === "string" ? result.category.trim().slice(0, 60) : null;
    const keywords = Array.isArray(result.keywords) ? result.keywords.filter((k) => typeof k === "string").slice(0, 8) : [];

    if (!title || !articleBody) {
      return json({ error: "Couldn't extract a clear article from this note. Try again with more detail." }, 422);
    }

    const { data: article, error: insertError } = await callerClient
      .from("knowledge_articles")
      .insert({
        user_id: ownerId,
        title,
        summary,
        body: articleBody,
        category,
        keywords,
        audience: "team",
        status: "draft",
        source: "voice_note",
        contributed_by: contributedBy,
        created_by: user.id,
      })
      .select()
      .single();

    if (insertError) {
      console.error("[tribal-knowledge-voice-capture] insert failed", insertError.message);
      return json({ error: "Could not save the draft article." }, 500);
    }

    return json({ useful: true, article });
  } catch (e) {
    console.error("[tribal-knowledge-voice-capture] unhandled", e instanceof Error ? e.message : e);
    return json({ error: "Something went wrong capturing this note." }, 500);
  } finally {
    if (cleanupClient && cleanupPath) {
      await cleanupClient.storage.from(MEDIA_BUCKET).remove([cleanupPath]).catch(() => {});
    }
  }
});
