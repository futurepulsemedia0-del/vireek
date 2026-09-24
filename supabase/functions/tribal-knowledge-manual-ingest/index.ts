// supabase/functions/tribal-knowledge-manual-ingest/index.ts
//
// Company Brain — Manual / Spec-Sheet Ingestion
//
// Input : a manufacturer manual or spec-sheet PDF (private bucket
//         `tribal-knowledge-media`).
// Output: one or more DRAFT knowledge_articles rows (audience='team',
//         source='manual_upload'), one per distinct procedure/section
//         worth keeping. A knowledge_manual_uploads row tracks the run.
//
// Auth  : the caller's own JWT for the article inserts (RLS enforces
//         tenant isolation). Service role is used for the quota RPC
//         and for writing knowledge_manual_uploads (no client policy
//         on that table — same posture as every other AI-agent table
//         in this project).
//
// Secrets: GEMINI_API_KEY (required), GEMINI_MODEL (optional).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const MEDIA_BUCKET = "tribal-knowledge-media";
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_ARTICLES = 12;
const QUOTA_MAX_PER_HOUR = 20;
const QUOTA_WINDOW_SECONDS = 3600;

const SYSTEM_PROMPT = `You turn a manufacturer manual or spec sheet into a set of short, searchable internal knowledge-base articles for field technicians.

Rules:
1. Split the document into distinct, useful procedures or facts (e.g. "Reset sequence", "Error code E4", "Filter part numbers", "Wiring — 240V single phase"). Do not summarize the whole document as one article.
2. Only include content a technician would actually look up in the field: install steps, troubleshooting/error codes, part numbers, wiring/spec values, warranty/maintenance intervals. Skip legal boilerplate, marketing copy and safety-disclaimer filler.
3. Never invent a spec, part number or step not present in the document.
4. "title" is what a technician would search for (e.g. "Trane XR16 — Error code E4").
5. "summary" is a 1-2 sentence takeaway.
6. "body" is the full detail: steps, values, part numbers, in plain text.
7. "category" is a short trade/service category.
8. "keywords" are 3-8 short search terms (brand, model, part, code).
9. Produce at most ${MAX_ARTICLES} articles — merge closely related content rather than exceeding that.
10. If the document has no field-usable technical content, return an empty articles array.
11. Output ONLY the JSON object — no markdown, no commentary.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          body: { type: "string" },
          category: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
        },
        required: ["title", "body"],
      },
    },
  },
  required: ["articles"],
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
    maxOutputTokens: 8000,
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
    if (!apiKey) return json({ error: "Manual ingestion is not configured yet (missing GEMINI_API_KEY)." }, 500);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid request body." }, 400);

    const pdfPath: string | null = typeof body.pdfPath === "string" ? body.pdfPath : null;
    const fileName: string = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 200) : "Untitled manual";
    if (!pdfPath) return json({ error: "Upload a PDF first." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    if (!pdfPath.startsWith(`${user.id}/`) || pdfPath.includes("..")) {
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

    // knowledge_manual_uploads has no client write policy — service role only.
    const { data: uploadRow, error: uploadInsertError } = await serviceClient
      .from("knowledge_manual_uploads")
      .insert({ user_id: ownerId, file_name: fileName, storage_path: pdfPath, status: "processing", uploaded_by: contributedBy })
      .select()
      .single();
    if (uploadInsertError || !uploadRow) {
      return json({ error: "Could not start processing this file." }, 500);
    }

    const fail = async (message: string) => {
      await serviceClient.from("knowledge_manual_uploads")
        .update({ status: "failed", error_message: message.slice(0, 500), completed_at: new Date().toISOString() })
        .eq("id", uploadRow.id);
      return json({ error: message }, 422);
    };

    const res = await callerClient.storage.from(MEDIA_BUCKET).download(pdfPath);
    if (res.error || !res.data) return await fail("The PDF could not be read.");
    if (res.data.size > MAX_PDF_BYTES) return await fail("The PDF is over 10 MB. Try a smaller file for now.");

    const buf = new Uint8Array(await res.data.arrayBuffer());
    const parts = [
      { text: `Manual file name: ${fileName}` },
      { inline_data: { mime_type: "application/pdf", data: toBase64(buf) } },
    ];

    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    const geminiRes = await callGemini(model, apiKey, parts);

    if (!geminiRes.ok) {
      const t = await geminiRes.text().catch(() => "");
      console.error("[tribal-knowledge-manual-ingest] Gemini error", geminiRes.status, t.slice(0, 300));
      return await fail("The AI is temporarily unavailable. Try again shortly.");
    }

    const data = await geminiRes.json();
    if (data?.promptFeedback?.blockReason) return await fail("The AI couldn't process this file.");
    const rawText: string = data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

    const result = extractJson(rawText);
    const rawArticles = Array.isArray(result?.articles) ? (result!.articles as Record<string, unknown>[]) : [];

    const rows = rawArticles
      .slice(0, MAX_ARTICLES)
      .map((a) => ({
        user_id: ownerId,
        title: typeof a.title === "string" ? a.title.trim().slice(0, 200) : "",
        summary: typeof a.summary === "string" ? a.summary.trim().slice(0, 400) : "",
        body: typeof a.body === "string" ? a.body.trim() : "",
        category: typeof a.category === "string" ? a.category.trim().slice(0, 60) : null,
        keywords: Array.isArray(a.keywords) ? a.keywords.filter((k) => typeof k === "string").slice(0, 8) : [],
        audience: "team" as const,
        status: "draft" as const,
        source: "manual_upload" as const,
        contributed_by: contributedBy,
        created_by: user.id,
      }))
      .filter((a) => a.title && a.body);

    if (rows.length === 0) {
      await serviceClient.from("knowledge_manual_uploads")
        .update({ status: "done", articles_created: 0, completed_at: new Date().toISOString() })
        .eq("id", uploadRow.id);
      return json({ articlesCreated: 0, message: "No field-usable content found in this document." });
    }

    const { data: inserted, error: insertError } = await callerClient
      .from("knowledge_articles")
      .insert(rows)
      .select();

    if (insertError) {
      console.error("[tribal-knowledge-manual-ingest] insert failed", insertError.message);
      return await fail("Could not save the draft articles.");
    }

    await serviceClient.from("knowledge_manual_uploads")
      .update({ status: "done", articles_created: inserted?.length ?? 0, completed_at: new Date().toISOString() })
      .eq("id", uploadRow.id);

    return json({ articlesCreated: inserted?.length ?? 0, articles: inserted });
  } catch (e) {
    console.error("[tribal-knowledge-manual-ingest] unhandled", e instanceof Error ? e.message : e);
    return json({ error: "Something went wrong processing this file." }, 500);
  }
});
