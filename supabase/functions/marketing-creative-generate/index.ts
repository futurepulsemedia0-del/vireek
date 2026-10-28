// supabase/functions/marketing-creative-generate/index.ts
//
// Marketing Creative Studio: turns a REAL completed job or a REAL positive
// customer review (or an owner-typed topic) into either
//   - an ad / social image (+ headline, caption, CTA, hashtags), or
//   - a blog / local-SEO article (+ meta title/description, slug, keywords, FAQ).
//
// Runs AS the signed-in user (never the service role): every read goes through
// RLS and the insert + storage upload must pass the marketing_creatives /
// storage policies (owner or `can_edit_business_profile` only). Copy goes
// through the shared Vireek AI router (askVireekAi); the image goes to Gemini's
// image model. Output is always a DRAFT a person reviews — nothing is published.
//
// Schema: supabase/migrations/20280101000000_marketing_creative_studio.sql
// Secrets: GEMINI_API_KEY (+ optional GEMINI_IMAGE_MODEL, default gemini-2.5-flash-image)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi } from "../_shared/ai-core/index.ts";
import { AiCoreError } from "../_shared/ai-core/types.ts";
import {
  FORMAT_BY_ID,
  MAX_GENERATIONS_PER_HOUR,
  buildArticlePrompt,
  buildImagePrompt,
  buildSocialCopyPrompt,
  claimWarnings,
  cleanText,
  humanizeService,
  monthName,
  parseArticle,
  parseSocialCopy,
  reviewIsUsable,
  validateRequest,
  type GenerateRequest,
  type GroundingFacts,
} from "../_shared/marketing-creative/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const BUCKET = "marketing-creatives";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface ImageResult { bytes: Uint8Array; mime: string; model: string }

async function generateImage(prompt: string, aspect: string): Promise<ImageResult | { error: string }> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return { error: "Image generation is not configured yet (missing GEMINI_API_KEY)." };
  const model = Deno.env.get("GEMINI_IMAGE_MODEL") || DEFAULT_IMAGE_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const call = (withAspect: boolean) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          ...(withAspect ? { imageConfig: { aspectRatio: aspect } } : {}),
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

  let res = await call(true);
  // Older/other image models may reject imageConfig — retry once without it.
  if (res.status === 400) res = await call(false);

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error(JSON.stringify({ event: "marketing_creative_image_error", status: res.status, body: t.slice(0, 300) }));
    return { error: "The image generator is temporarily unavailable. Please try again in a moment." };
  }

  const data = await res.json();
  const parts: { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }[] =
    data?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inl = p.inlineData ?? p.inline_data;
    const b64 = inl?.data;
    if (!b64) continue;
    const mime = (p.inlineData?.mimeType ?? p.inline_data?.mime_type ?? "image/png").toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) continue;
    const bytes = b64ToBytes(b64);
    if (bytes.length > MAX_IMAGE_BYTES) return { error: "The generated image was too large. Please try again." };
    return { bytes, mime, model };
  }
  console.error(JSON.stringify({ event: "marketing_creative_no_image", finish: data?.candidates?.[0]?.finishReason ?? null }));
  return { error: "The image couldn't be generated for this topic. Try rewording it or choosing a different job." };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
    const parsed = validateRequest(raw);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const reqv: GenerateRequest = parsed.value;
    const meta = FORMAT_BY_ID[reqv.format];

    const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await db.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: ownerId } = await db.rpc("get_account_owner_id");
    if (typeof ownerId !== "string") return json({ error: "Account not found." }, 403);
    const { data: allowed } = await db.rpc("can_manage_branding");
    if (allowed !== true) return json({ error: "You don't have permission to create marketing content." }, 403);

    // ---- Rate limit: counted from the library itself (RLS-scoped) ----------
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recent } = await db
      .from("marketing_creatives")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .gte("created_at", since);
    if ((recent ?? 0) >= MAX_GENERATIONS_PER_HOUR) {
      return json({ error: "You've reached the hourly limit for AI marketing content. Try again in a bit." }, 429);
    }

    // ---- Ground the request in real facts ---------------------------------
    const { data: prof } = await db.from("profiles").select("company_name").eq("id", ownerId).maybeSingle();
    const facts: GroundingFacts = {
      businessName: cleanText(prof?.company_name, 120),
      serviceType: "",
      season: "",
      city: reqv.city,
      offer: reqv.offer,
      topic: reqv.topic,
      review: null,
    };
    let reviewBody: string | null = null;

    if (reqv.sourceType === "job" && reqv.sourceId) {
      const { data: job } = await db
        .from("jobs")
        .select("service_type, job_status, completed_at, scheduled_datetime")
        .eq("id", reqv.sourceId)
        .eq("user_id", ownerId)
        .maybeSingle();
      if (!job) return json({ error: "That job could not be found." }, 404);
      if (job.job_status !== "completed") return json({ error: "Only completed jobs can be used." }, 400);
      facts.serviceType = humanizeService(job.service_type);
      facts.season = monthName(job.completed_at ?? job.scheduled_datetime);
      // NOTE: customer name + address are deliberately never read.
    } else if (reqv.sourceType === "review" && reqv.sourceId) {
      const { data: rev } = await db
        .from("reviews")
        .select("rating, body")
        .eq("id", reqv.sourceId)
        .eq("user_id", ownerId)
        .maybeSingle();
      if (!rev) return json({ error: "That review could not be found." }, 404);
      if (!reviewIsUsable(rev.rating, rev.body)) {
        return json({ error: "Only positive reviews (4–5 stars) with a written comment can be used." }, 400);
      }
      reviewBody = cleanText(rev.body, 1500);
      facts.review = { rating: rev.rating, body: reviewBody };
    }

    const creativeId = crypto.randomUUID();
    const baseRow = {
      id: creativeId,
      user_id: ownerId,
      kind: meta.kind,
      format: reqv.format,
      source_type: reqv.sourceType,
      source_job_id: reqv.sourceType === "job" ? reqv.sourceId : null,
      source_review_id: reqv.sourceType === "review" ? reqv.sourceId : null,
      tone: reqv.tone,
      goal: reqv.goal,
    };

    const askJson = async (content: string, maxTokens: number) => {
      try {
        const r = await askVireekAi({
          task: "general",
          jsonMode: true,
          maxTokens,
          temperature: 0.7,
          timeoutMs: 45_000,
          messages: [{ role: "user", content }],
        });
        return r.text;
      } catch (e) {
        if (e instanceof AiCoreError && e.code === "GUARDRAIL_BLOCKED") return "BLOCKED";
        console.error(JSON.stringify({ event: "marketing_creative_ai_failed", error: e instanceof Error ? e.message : String(e) }));
        return null;
      }
    };

    // ======================= IMAGE =========================================
    if (meta.kind === "image") {
      const text = await askJson(buildSocialCopyPrompt(facts, reqv.tone, reqv.goal, meta.label), 900);
      if (text === "BLOCKED") return json({ error: "That content can't be used for marketing. Choose a different source." }, 422);
      const copy = text ? parseSocialCopy(text, reviewBody) : null;
      if (!copy) return json({ error: "The AI couldn't write usable copy this time. Please try again." }, 502);

      const imagePrompt = buildImagePrompt(copy.imageScene, facts.serviceType, reqv.tone, meta.aspect);
      const img = await generateImage(imagePrompt, meta.aspect);
      if ("error" in img) return json({ error: img.error }, 502);

      const ext = img.mime === "image/jpeg" ? "jpg" : img.mime === "image/webp" ? "webp" : "png";
      const imagePath = `${ownerId}/${creativeId}.${ext}`;
      const { error: upErr } = await db.storage.from(BUCKET).upload(imagePath, img.bytes, { contentType: img.mime, upsert: false });
      if (upErr) {
        console.error(JSON.stringify({ event: "marketing_creative_upload_failed", error: upErr.message }));
        return json({ error: "Could not save the generated image. Please try again." }, 500);
      }

      const { data: row, error: insErr } = await db
        .from("marketing_creatives")
        .insert({
          ...baseRow,
          title: copy.headline,
          headline: copy.headline,
          caption: copy.caption,
          cta: copy.cta,
          hashtags: copy.hashtags,
          quote: copy.quote || null,
          image_path: imagePath,
          image_prompt: imagePrompt,
          warnings: claimWarnings(`${copy.headline}\n${copy.caption}\n${copy.cta}`, reqv.offer),
          model: img.model,
        })
        .select("*")
        .single();
      if (insErr || !row) {
        await db.storage.from(BUCKET).remove([imagePath]);
        console.error(JSON.stringify({ event: "marketing_creative_insert_failed", error: insErr?.message }));
        return json({ error: "Could not save your creative. Please try again." }, 500);
      }
      return json({ creative: row });
    }

    // ======================= ARTICLE =======================================
    const articleFormat = reqv.format === "seo_local_page" ? "seo_local_page" : "blog_post";
    const text = await askJson(buildArticlePrompt(facts, reqv.tone, reqv.goal, articleFormat), 4500);
    if (text === "BLOCKED") return json({ error: "That content can't be used for marketing. Choose a different source." }, 422);
    const art = text ? parseArticle(text) : null;
    if (!art) return json({ error: "The AI couldn't write a complete article this time. Please try again." }, 502);

    const { data: row, error: insErr } = await db
      .from("marketing_creatives")
      .insert({
        ...baseRow,
        title: art.title,
        body: art.bodyMarkdown,
        meta_title: art.metaTitle,
        meta_description: art.metaDescription || null,
        slug: art.slug || null,
        keywords: art.keywords,
        faq: art.faq,
        warnings: claimWarnings(`${art.title}\n${art.bodyMarkdown}`, reqv.offer),
        model: null,
      })
      .select("*")
      .single();
    if (insErr || !row) {
      console.error(JSON.stringify({ event: "marketing_creative_insert_failed", error: insErr?.message }));
      return json({ error: "Could not save your article. Please try again." }, 500);
    }
    return json({ creative: row });
  } catch (err) {
    console.error(JSON.stringify({ event: "marketing_creative_unhandled", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
