// supabase/functions/voice-log-extract/index.ts
//
// Hands-free field assistant: one dictation (audio in the private `field-captures` bucket)
// -> transcript + structured job log DRAFT (findings, parts, time, customer notes) with
// per-field confidence. The AI only SUGGESTS: this function writes nothing to the job and
// never contacts a customer. The technician reviews and approves in the app.
//
// Auth    : caller JWT. Job access is verified through the existing get_job_brief() RPC
//           (returns {error:'not_found'|'forbidden'}). Service role is used only for the
//           quota RPC, the draft insert, and deleting the raw audio.
// Privacy : requires explicit consent; transcript/extraction are PII-redacted; raw audio is
//           deleted as soon as the draft is stored. Drafts are purged after 30 days.
// Secrets : GEMINI_API_KEY (required), GEMINI_MODEL (optional).

import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import {
  AUDIO_EXT_RE, RESPONSE_SCHEMA, SYSTEM_PROMPT, UUID_RE, VOICE_LANGS,
  expectedAudioPath, mimeFromExt, normalizeExtraction, type VoiceLang,
} from '../_shared/voice-log/extract.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const BUCKET = 'field-captures';
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const QUOTA_MAX_PER_HOUR = 40;
const QUOTA_WINDOW_SECONDS = 3600;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}');
    if (s === -1 || e <= s) return null;
    try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return null; }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const apiKey = Deno.env.get('GEMINI_API_KEY') ?? '';
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);
    if (!apiKey) return json({ error: 'Voice log is not configured yet.' }, 500);

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return json({ error: 'Invalid request body.' }, 400);

    const draftId = typeof body.draftId === 'string' ? body.draftId : '';
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    const ext = typeof body.ext === 'string' ? body.ext : '';
    const language: VoiceLang = (VOICE_LANGS as readonly string[]).includes(String(body.language)) ? (body.language as VoiceLang) : 'auto';
    if (body.consent !== true) return json({ error: 'Recording consent is required.' }, 400);
    if (!UUID_RE.test(draftId) || !UUID_RE.test(jobId) || !AUDIO_EXT_RE.test(ext)) return json({ error: 'Invalid request.' }, 400);

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const callerClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: 'Not authenticated.' }, 401);

    const audioPath = expectedAudioPath(user.id, jobId, draftId, ext);

    // Authorization: the caller must be allowed to see this job (assigned tech, or owner/admin).
    const { data: brief, error: briefErr } = await callerClient.rpc('get_job_brief', { p_job_id: jobId });
    if (briefErr || !brief || (brief as { error?: string }).error) return json({ error: 'Job not available.' }, 403);

    const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });

    // Idempotency: a retry for an already-stored draft returns it.
    const { data: existing } = await serviceClient.from('voice_log_drafts')
      .select('id, status, extraction, needs_review, transcript, created_at')
      .eq('id', draftId).eq('created_by', user.id).maybeSingle();
    if (existing) return json({ draft: existing, duplicate: true });

    const { data: allowed, error: quotaErr } = await serviceClient.rpc('consume_voice_log_quota', {
      p_user_id: user.id, p_max: QUOTA_MAX_PER_HOUR, p_window_seconds: QUOTA_WINDOW_SECONDS,
    });
    if (quotaErr) return json({ error: 'Could not verify your usage limit.' }, 500);
    if (allowed === false) return json({ error: 'Hourly voice log limit reached. Try again later.' }, 429);

    const { data: ownerId } = await callerClient.rpc('get_account_owner_id');
    if (!ownerId) return json({ error: 'Could not resolve your account.' }, 500);

    const dl = await callerClient.storage.from(BUCKET).download(audioPath);
    if (dl.error || !dl.data) return json({ error: 'The recording could not be read.' }, 422);
    if (dl.data.size > MAX_AUDIO_BYTES) return json({ error: 'Recording is over 10 MB.' }, 422);
    const audio = new Uint8Array(await dl.data.arrayBuffer());

    const langHint = language === 'auto' ? 'Language: detect automatically (en, es or fa).' : `Spoken language: ${language}.`;
    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
    const generationConfig: Record<string, unknown> = {
      temperature: 0.1, maxOutputTokens: 4000, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA,
    };
    if (model.includes('2.5')) generationConfig.thinkingConfig = { thinkingBudget: 512 };

    const gRes = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeFromExt(audioPath), data: toBase64(audio) } }, { text: langHint }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!gRes.ok) {
      console.error('[voice-log-extract] gemini', gRes.status);
      return json({ error: 'The AI is temporarily unavailable. Try again shortly.' }, 502);
    }
    const gData = await gRes.json();
    if (gData?.promptFeedback?.blockReason) return json({ error: 'The AI could not process this recording.' }, 422);
    const rawText: string = gData?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';

    const extraction = normalizeExtraction(extractJson(rawText));
    if (!extraction) return json({ error: 'Nothing usable was heard. Please record again.' }, 422);

    const { data: inserted, error: insErr } = await serviceClient.from('voice_log_drafts').insert({
      id: draftId, job_id: jobId, created_by: user.id, account_owner_id: ownerId,
      language: extraction.language, transcript: extraction.transcript, extraction,
      needs_review: extraction.needs_review, model, consent_at: new Date().toISOString(),
    }).select('id, status, extraction, needs_review, transcript, created_at').single();
    if (insErr) {
      console.error('[voice-log-extract] insert', insErr.code);
      return json({ error: 'Could not save the draft.' }, 500);
    }

    // Privacy: raw audio is no longer needed once the draft exists.
    const rm = await serviceClient.storage.from(BUCKET).remove([audioPath]);
    if (rm.error) console.error('[voice-log-extract] audio delete failed');

    return json({ draft: inserted });
  } catch (e) {
    console.error('[voice-log-extract] unhandled', e instanceof Error ? e.message : 'error');
    return json({ error: 'Something went wrong processing this recording.' }, 500);
  }
});
