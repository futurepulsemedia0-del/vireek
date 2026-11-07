// supabase/functions/sarah-learn-start/index.ts
//
// "Sarah Learns Your Business" step 1-2: read the owner's OWN public website
// (and/or pasted price list text), extract a cited, confidence-rated draft, and
// store it for review. Streams REAL progress as SSE (no fake timers).
//
// Safety: owner must attest the site is theirs; SSRF-safe fetcher; robots.txt
// honoured; page text is untrusted DATA (defanged + wrapped), never stored;
// model output is whitelisted and grounded in the sources (schema.ts).
//
// SSE wire format, one JSON object per "data:" line:
//   {"step":"run","run_id":"..."}
//   {"step":"fetch","url":"...","status":"fetched|blocked_robots|failed","code":"..."}
//   {"step":"extract","done":n,"total":m}
//   {"step":"done","run_id":"...","fields":n,"ms":n}
//   {"step":"error","message":"..."}

import { askVireekAi, safeFallbackMessage } from '../_shared/ai-core/index.ts';
import { authenticate, handle, HttpError, corsHeaders, sha256Hex, UUID_RE } from '../_shared/sarah-learn/edge.ts';
import {
  SafeFetchError,
  assertPublicHttpUrl,
  fetchWithRobots,
  loadRobots,
  type SafeFetchOptions,
} from '../_shared/sarah-learn/safeFetch.ts';
import { composeSourceText, defangInjection, extractCandidateLinks, normalizeForMatch } from '../_shared/sarah-learn/sanitize.ts';
import { mergeValidated, validateExtraction, type SourceText, type ValidatedField } from '../_shared/sarah-learn/schema.ts';
import { buildExtractionPrompt } from '../_shared/sarah-learn/prompts.ts';

const MAX_PAGES = 6;
const MAX_PASTED = 3600;
const RUNS_PER_HOUR = 8;
const sse = (o: Record<string, unknown>) => new TextEncoder().encode(`data: ${JSON.stringify(o)}\n\n`);

async function resolveHost(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const t of ['A', 'AAAA'] as const) {
    try {
      out.push(...(await Deno.resolveDns(host, t)));
    } catch {
      // no records of this type
    }
  }
  return out;
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no_json');
  return JSON.parse(cleaned.slice(start, end + 1));
}

interface PageSource {
  ref: string;
  kind: 'website_page' | 'pasted_text';
  url: string | null;
  label: string;
  text: string;
  flags: string[];
  hash: string;
  bytes: number;
}

Deno.serve(
  handle(async (req) => {
    const c = await authenticate(req);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new HttpError(400, 'Invalid JSON body.');

    const websiteRaw = typeof body.website_url === 'string' ? body.website_url.trim() : '';
    const pasted = typeof body.pasted_text === 'string' ? body.pasted_text.trim().slice(0, MAX_PASTED) : '';
    const locale = body.locale === 'es' ? 'es' : 'en';
    const parentId = typeof body.parent_run_id === 'string' && UUID_RE.test(body.parent_run_id) ? body.parent_run_id : null;

    if (!websiteRaw && pasted.length < 40) throw new HttpError(400, 'Add your website address or paste at least a few lines of text.');
    if (body.own_property_confirmed !== true) throw new HttpError(400, 'Please confirm this website belongs to your business.');

    let siteUrl: URL | null = null;
    if (websiteRaw) {
      try {
        siteUrl = assertPublicHttpUrl(/^https?:\/\//i.test(websiteRaw) ? websiteRaw : `https://${websiteRaw}`);
      } catch (e) {
        throw new HttpError(400, e instanceof SafeFetchError ? e.message : 'Invalid website address.');
      }
    }

    // Rate limit: runs per owner per hour (counted from our own table).
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await c.admin.from('sarah_learn_runs').select('id', { count: 'exact', head: true }).eq('user_id', c.ownerId).gte('created_at', since);
    if ((count ?? 0) >= RUNS_PER_HOUR) throw new HttpError(429, 'You have started several runs this hour. Please try again shortly.');

    if (parentId) {
      const { data: parent } = await c.admin.from('sarah_learn_runs').select('id').eq('id', parentId).eq('user_id', c.ownerId).maybeSingle();
      if (!parent) throw new HttpError(404, 'Previous run not found.');
    }

    const startedAt = Date.now();
    const { data: run, error: runErr } = await c.admin
      .from('sarah_learn_runs')
      .insert({
        user_id: c.ownerId,
        created_by: c.userId,
        status: 'sourcing',
        locale,
        own_property_confirmed_at: new Date().toISOString(),
        website_url: siteUrl ? siteUrl.toString() : null,
        parent_run_id: parentId,
      })
      .select('id')
      .single();
    if (runErr || !run) throw runErr ?? new Error('run insert failed');
    const runId = run.id as string;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (o: Record<string, unknown>) => controller.enqueue(sse(o));
        emit({ step: 'run', run_id: runId });
        try {
          const fetchOpts: SafeFetchOptions = { resolveDns: resolveHost, maxBytes: 1_200_000, timeoutMs: 8000 };
          const pages: PageSource[] = [];
          const sourceRows: Record<string, unknown>[] = [];

          const recordFailure = (url: string, status: 'blocked_robots' | 'failed', code: string, label: string) => {
            sourceRows.push({ run_id: runId, user_id: c.ownerId, kind: 'website_page', url: url.slice(0, 500), label, status, error_code: code });
            emit({ step: 'fetch', url, status, code });
          };

          if (siteUrl) {
            const robots = await loadRobots(siteUrl, fetchOpts).catch((e: unknown) => {
              if (e instanceof SafeFetchError) return null;
              throw e;
            });
            if (!robots) {
              recordFailure(siteUrl.toString(), 'failed', 'BLOCKED_HOST', 'Website');
            } else {
              let homeHtml = '';
              try {
                const home = await fetchWithRobots(siteUrl.toString(), robots, fetchOpts);
                homeHtml = home.text;
                const { text, flags } = composeSourceText(home.text);
                pages.push({ ref: 's1', kind: 'website_page', url: home.finalUrl, label: 'Home page', text, flags, hash: await sha256Hex(normalizeForMatch(text)), bytes: home.text.length });
                emit({ step: 'fetch', url: home.finalUrl, status: 'fetched' });
              } catch (e) {
                const code = e instanceof SafeFetchError ? e.code : 'NETWORK';
                recordFailure(siteUrl.toString(), code === 'BLOCKED_ROBOTS' ? 'blocked_robots' : 'failed', code, 'Home page');
              }

              if (homeHtml) {
                const links = extractCandidateLinks(homeHtml, siteUrl, MAX_PAGES - 1);
                for (const link of links) {
                  try {
                    const pg = await fetchWithRobots(link, robots, fetchOpts);
                    const { text, flags } = composeSourceText(pg.text);
                    if (text.length < 80) continue;
                    pages.push({ ref: `s${pages.length + 1}`, kind: 'website_page', url: pg.finalUrl, label: new URL(pg.finalUrl).pathname.slice(0, 100), text, flags, hash: await sha256Hex(normalizeForMatch(text)), bytes: pg.text.length });
                    emit({ step: 'fetch', url: pg.finalUrl, status: 'fetched' });
                  } catch (e) {
                    const code = e instanceof SafeFetchError ? e.code : 'NETWORK';
                    recordFailure(link, code === 'BLOCKED_ROBOTS' ? 'blocked_robots' : 'failed', code, 'Linked page');
                  }
                }
              }
            }
          }

          if (pasted.length >= 40) {
            const { text, flags } = defangInjection(pasted);
            pages.push({ ref: `s${pages.length + 1}`, kind: 'pasted_text', url: null, label: 'Pasted text', text, flags, hash: await sha256Hex(normalizeForMatch(text)), bytes: pasted.length });
            emit({ step: 'fetch', url: 'pasted', status: 'fetched' });
          }

          // Persist source rows (hashes only - never the page text).
          const idByRef = new Map<string, string>();
          for (const p of pages) {
            const { data: row, error } = await c.admin
              .from('sarah_learn_sources')
              .insert({ run_id: runId, user_id: c.ownerId, kind: p.kind, url: p.url?.slice(0, 500) ?? null, label: p.label, status: 'fetched', content_hash: p.hash, byte_size: p.bytes, injection_flags: p.flags })
              .select('id')
              .single();
            if (error) throw error;
            idByRef.set(p.ref, row.id as string);
          }
          if (sourceRows.length) await c.admin.from('sarah_learn_sources').insert(sourceRows);

          // Extraction, one model call per source (keeps each prompt under the AI Core limits).
          const batches: ValidatedField[][] = [];
          let done = 0;
          const queue = [...pages];
          const worker = async () => {
            for (let p = queue.shift(); p; p = queue.shift()) {
              try {
                const src: SourceText = { ref: p.ref, text: p.text };
                const prompt = buildExtractionPrompt([src]);
                const res = await askVireekAi({
                  task: 'onboarding_extract',
                  messages: [{ role: 'user', content: prompt.user }],
                  maxTokens: 1400,
                  temperature: 0,
                  jsonMode: true,
                  timeoutMs: 30000,
                  extraInstructions: prompt.system,
                  security: { userId: c.ownerId },
                });
                const valid = validateExtraction(extractJson(res.text), [src]);
                batches.push(valid);
              } catch (e) {
                console.error('[sarah-learn-start] extraction failed for a source:', e instanceof Error ? e.message : 'unknown');
              }
              done++;
              emit({ step: 'extract', done, total: pages.length });
            }
          };
          await Promise.all([worker(), worker(), worker()]);

          const merged = mergeValidated(batches);

          // Previous run values -> prev_value so a re-run can show a diff.
          const prev = new Map<string, unknown>();
          if (parentId) {
            const { data: old } = await c.admin.from('sarah_learn_fields').select('key,value').eq('run_id', parentId).eq('user_id', c.ownerId);
            for (const o of old ?? []) prev.set(o.key as string, o.value);
          }

          if (merged.length) {
            const rows = merged.map((f) => ({
              run_id: runId,
              user_id: c.ownerId,
              key: f.key,
              value: f.value,
              prev_value: prev.has(f.key) && JSON.stringify(prev.get(f.key)) !== JSON.stringify(f.value) ? prev.get(f.key) : null,
              confidence: f.confidence,
              assumed: f.assumed,
              sensitive: f.sensitive,
              origin: 'source',
              source_id: f.sourceRef ? (idByRef.get(f.sourceRef) ?? null) : null,
              citation: f.citation,
              status: 'pending',
            }));
            const { error } = await c.admin.from('sarah_learn_fields').insert(rows);
            if (error) throw error;
          }

          const ms = Date.now() - startedAt;
          await c.admin
            .from('sarah_learn_runs')
            .update({ status: 'drafted', first_draft_at: merged.length ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
            .eq('id', runId)
            .eq('user_id', c.ownerId);
          if (merged.length) await c.admin.from('sarah_learn_events').insert({ user_id: c.ownerId, run_id: runId, event: 'first_draft', ms, meta: { fields: merged.length, sources: pages.length } });
          console.log(`[sarah-learn-start] run=${runId} sources=${pages.length} fields=${merged.length} ms=${ms}`);
          emit({ step: 'done', run_id: runId, fields: merged.length, sources: pages.length, ms });
        } catch (err) {
          console.error('[sarah-learn-start] failed:', err instanceof Error ? err.message : 'unknown');
          await c.admin.from('sarah_learn_runs').update({ status: 'failed' }).eq('id', runId).eq('user_id', c.ownerId);
          emit({ step: 'error', message: safeFallbackMessage(err) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
    });
  }),
);
