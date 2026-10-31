# INSTALL — Ask Vireek knowledge layer (apply in this order)

Everything below was dry-run against a scratch copy of your uploaded repo: every anchor below matched **exactly once**. If your local copy differs (the ZIP is older than your working tree), a Ctrl+F miss means that file changed — send me that snippet.

## 0. New files (copy as-is, paths mirror the repo)

- `supabase/migrations/20280401000000_site_assistant_knowledge.sql`
- `supabase/functions/_shared/ai-core/siteAssistantLogic.ts`, `siteKnowledge.ts`, `coreFacts.generated.ts`
- `scripts/knowledge-build.mjs`, `scripts/knowledge-eval.mjs`, `scripts/lib/knowledgeChunker.mjs`, `scripts/lib/knowledgeChunker.test.mjs`
- `knowledge/README.md`, `knowledge/does-not-do.md`, `knowledge/modules/_TEMPLATE.md`, `knowledge/site-chunks.generated.json`, `knowledge/coverage.generated.md`
- `eval/site-assistant.manual.json`, `eval/site-assistant.generated.json`
- `src/lib/siteAssistantLogic.test.ts`, `src/lib/siteAssistantPersonas.ts`, `src/lib/siteAssistantAdmin.ts`, `src/components/SiteAssistantExtras.tsx`, `src/pages/StaffAssistantGapsPage.tsx`

## 1. Edits to existing files (Ctrl+F the FIND text; REPLACE it with the block)

### E1 — `supabase/functions/_shared/ai-core/ragKnowledge.ts` — import hybrid retrieval

FIND (exactly once):
```
import type { TaskType } from "./types.ts";
```
REPLACE WITH:
```
import type { TaskType } from "./types.ts";
import { retrieveSiteKnowledge } from "./siteKnowledge.ts";
```

### E2 — `supabase/functions/_shared/ai-core/ragKnowledge.ts` — use hybrid retrieval first inside searchBrandKnowledge (legacy path stays as fallback)

FIND (exactly once):
```
  if (!trimmed) return [];
  if (!EMBEDDING_ADAPTER.isConfigured()) return [];
```
REPLACE WITH:
```
  if (!trimmed) return [];

  // Preferred path: hybrid public KB (site_kb_chunks, vector + keyword). If it is unavailable
  // (migration not applied / RPC error) we fall through to the legacy brand_knowledge lookup below.
  const hybrid = await retrieveSiteKnowledge(trimmed);
  if (hybrid.available) {
    return hybrid.matches.map((m) => ({
      id: m.id,
      source: m.topic,
      sourceUrl: m.url,
      title: m.status === "live" ? m.title : `${m.title} [${m.status.toUpperCase()}]`,
      content: m.content,
      similarity: m.similarity,
    }));
  }

  if (!EMBEDDING_ADAPTER.isConfigured()) return [];
```

### E3 — `supabase/functions/_shared/ai-core/knowledge.ts` — import generated facts

FIND (exactly once):
```
export type KnowledgeTopic =
```
REPLACE WITH:
```
import { INDUSTRIES_FACTS, PRICING_FACTS } from "./coreFacts.generated.ts";

export type KnowledgeTopic =
```

### E4 — `supabase/functions/_shared/ai-core/knowledge.ts` — pricing facts now generated from src/lib/pricing.ts (replace the whole multi-line `facts:` of the pricing entry)

REPLACE the range that STARTS with the first block and ENDS with (and includes) the second block:
```
    topic: "pricing",
    facts:
```
…through…
```
never billed.",
```
WITH:
```
    topic: "pricing",
    facts: PRICING_FACTS,
```

### E5 — `supabase/functions/_shared/ai-core/knowledge.ts` — industries facts now generated from src/lib/industries.ts (static text said 'six trades'; the data has 13)

REPLACE the range that STARTS with the first block and ENDS with (and includes) the second block:
```
    topic: "industries",
    facts:
```
…through…
```
not hardcoded.",
```
WITH:
```
    topic: "industries",
    facts: INDUSTRIES_FACTS,
```

### E6 — `supabase/functions/site-assistant/index.ts` — imports

FIND (exactly once):
```
import type { ChatMessage } from "../_shared/ai-core/types.ts";
```
REPLACE WITH:
```
import type { ChatMessage } from "../_shared/ai-core/types.ts";
import {
  buildSiteInstructions,
  buildSources,
  cacheKey,
  detectIntent,
  redactPii,
  suggestionsForIntent,
  type SourceLink,
} from "../_shared/ai-core/siteAssistantLogic.ts";
import { retrieveSiteKnowledge, toRetrievedChunks } from "../_shared/ai-core/siteKnowledge.ts";
import { CORE_FACTS } from "../_shared/ai-core/coreFacts.generated.ts";
```

### E7 — `supabase/functions/site-assistant/index.ts` — answer cache + safeEqual

FIND (exactly once):
```
const MAX_HISTORY_TURNS = 6;
```
REPLACE WITH:
```
const MAX_HISTORY_TURNS = 6;

// Frequent single-turn answers are replayed from memory (per edge isolate, 10 min) — no model
// call, no cost. Only grounded, non-handoff answers are cached; PUBLIC scope only.
interface CachedAnswer { at: number; text: string; sources: SourceLink[]; suggestions: string[] }
const ANSWER_CACHE = new Map<string, CachedAnswer>();
const ANSWER_TTL_MS = 10 * 60 * 1000;
const ANSWER_CACHE_MAX = 100;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

### E8 — `supabase/functions/site-assistant/index.ts` — eval-run rate-limit bypass (secret header)

FIND (exactly once):
```
    const ip =
```
REPLACE WITH:
```
    // CI eval runs (scripts/knowledge-eval.mjs) send a secret header to bypass the per-IP rate limit.
    const evalKey = Deno.env.get("SITE_ASSISTANT_EVAL_KEY") ?? "";
    const isEvalRun = evalKey.length >= 16 && safeEqual(req.headers.get("x-eval-key") ?? "", evalKey);

    const ip =
```

### E9 — `supabase/functions/site-assistant/index.ts` — apply the bypass

FIND (exactly once):
```
    if (currentCount >= MAX_REQUESTS_PER_HOUR) {
```
REPLACE WITH:
```
    if (!isEvalRun && currentCount >= MAX_REQUESTS_PER_HOUR) {
```

### E10 — `supabase/functions/site-assistant/index.ts` — replace the whole streaming block

REPLACE the range that STARTS with the first block and ENDS with (and includes) the second block:
```
    const stream = new ReadableStream<Uint8Array>({```
…through…
```
    return new Response(stream, { headers: sseHeaders });```
WITH:
```
    const startedAt = Date.now();
    const answerId = crypto.randomUUID();
    const intent = detectIntent(message);
    const singleTurn = trimmedHistory.length === 0;
    const key = cacheKey(message);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: Record<string, unknown>) => controller.enqueue(sseLine(payload));
        let firstTokenMs: number | null = null;
        let fullText = "";
        let receivedAny = false;

        // Privacy-safe log: redacted question only (no IP, no user id, no history). Best effort.
        const logAnswer = async (row: {
          grounded: boolean; topSimilarity: number; sources: SourceLink[]; provider: string | null;
          model: string | null; cached: boolean; handoff: boolean;
        }) => {
          const { error } = await supabase.from("site_assistant_log").insert({
            id: answerId,
            question_redacted: redactPii(message),
            intent,
            grounded: row.grounded,
            top_similarity: row.topSimilarity,
            source_urls: row.sources.map((s) => s.url),
            provider: row.provider,
            model: row.model,
            latency_ms: Date.now() - startedAt,
            first_token_ms: firstTokenMs,
            cached: row.cached,
            handoff: row.handoff,
          });
          if (error) console.error("[site-assistant] log insert failed:", error.message);
        };

        try {
          send({ answerId });

          // Hybrid retrieval (vector + keyword). Cached per question, so ai-core's own lookup is free.
          const retrieval = await retrieveSiteKnowledge(message);
          // If the new KB isn't available yet (migration not applied) we cannot judge grounding:
          // behave like before instead of forcing "I don't know" on every answer.
          const grounded = retrieval.available ? retrieval.grounded : true;
          const sources = buildSources(toRetrievedChunks(retrieval.matches), intent);
          const suggestions = suggestionsForIntent(intent);
          const handoff = intent === "human";
          send({ sources });

          const hit = singleTurn && !handoff ? ANSWER_CACHE.get(key) : undefined;
          if (hit && Date.now() - hit.at < ANSWER_TTL_MS) {
            firstTokenMs = Date.now() - startedAt;
            send({ delta: hit.text });
            send({ suggestions: hit.suggestions });
            await logAnswer({ grounded: true, topSimilarity: retrieval.topSimilarity, sources: hit.sources, provider: "cache", model: null, cached: true, handoff: false });
            send({ done: true, provider: "cache", model: "cache", answerId });
            return;
          }

          const result = await askVireekAiStream(
            {
              task: "general",
              messages: [...trimmedHistory, { role: "user", content: message }],
              maxTokens: 320,
              extraInstructions: buildSiteInstructions({ coreFacts: CORE_FACTS, intent, grounded }),
            },
            (delta) => {
              if (!delta) return;
              receivedAny = true;
              firstTokenMs ??= Date.now() - startedAt;
              fullText += delta;
              send({ delta });
            },
          );

          console.log(
            `[site-assistant] intent=${intent} grounded=${grounded} kb=${retrieval.available} cached=${retrieval.fromCache} ` +
              `provider=${result.meta.provider} model=${result.meta.model} latencyMs=${result.meta.latencyMs} ` +
              `firstTokenMs=${firstTokenMs} fallback=${result.meta.wasFallback} attempts=${JSON.stringify(result.meta.attempts)}`,
          );

          // Only inject the generic fallback line if the provider chain genuinely produced nothing.
          if (!receivedAny) send({ delta: "Sorry, could you rephrase that?" });

          if (handoff) send({ handoff: { reason: "user_requested_human" } });
          send({ suggestions });

          if (receivedAny && singleTurn && !handoff && grounded && retrieval.available) {
            if (ANSWER_CACHE.size >= ANSWER_CACHE_MAX) {
              const oldest = ANSWER_CACHE.keys().next().value;
              if (oldest !== undefined) ANSWER_CACHE.delete(oldest);
            }
            ANSWER_CACHE.set(key, { at: Date.now(), text: fullText, sources, suggestions });
          }

          await logAnswer({
            grounded, topSimilarity: retrieval.topSimilarity, sources,
            provider: result.meta.provider, model: result.meta.model, cached: false, handoff,
          });
          send({ done: true, provider: result.meta.provider, model: result.meta.model, answerId });
        } catch (err) {
          console.error("[site-assistant] AI Core error (all providers failed):", err);
          send({ error: safeFallbackMessage(err) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });```

### E11 — `src/lib/aiStream.ts` — new optional callbacks

FIND (exactly once):
```
  /** Called once the stream ends normally. */
```
REPLACE WITH:
```
  /** Server sent the answer id (used for feedback) — before any delta. */
  onAnswerId?: (id: string) => void;
  /** 1-3 "Learn more" links (site-relative paths). */
  onSources?: (sources: { title: string; url: string }[]) => void;
  /** Follow-up question chips. */
  onSuggestions?: (suggestions: string[]) => void;
  /** Server suggests offering a human hand-off. */
  onHandoff?: () => void;
  /** Called once the stream ends normally. */
```

### E12 — `src/lib/aiStream.ts` — destructure them

FIND (exactly once):
```
  onDone,
  onError,
  signal,
}: StreamAiChatOptions): Promise<void> {
```
REPLACE WITH:
```
  onDone,
  onError,
  onAnswerId,
  onSources,
  onSuggestions,
  onHandoff,
  signal,
}: StreamAiChatOptions): Promise<void> {
```

### E13 — `src/lib/aiStream.ts` — extend parsed SSE payload type

FIND (exactly once):
```
let parsed: { delta?: string; done?: boolean; error?: string; provider?: string; model?: string; fields?: Record<string, unknown> };
```
REPLACE WITH:
```
let parsed: { delta?: string; done?: boolean; error?: string; provider?: string; model?: string; fields?: Record<string, unknown>; answerId?: string; sources?: { title: string; url: string }[]; suggestions?: string[]; handoff?: unknown };
```

### E14 — `src/lib/aiStream.ts` — handle the new events

FIND (exactly once):
```
        } else if (parsed.fields) {
```
REPLACE WITH:
```
        } else if (parsed.answerId && !parsed.done) {
          onAnswerId?.(parsed.answerId);
        } else if (parsed.sources) {
          onSources?.(parsed.sources);
        } else if (parsed.suggestions) {
          onSuggestions?.(parsed.suggestions);
        } else if (parsed.handoff) {
          onHandoff?.();
        } else if (parsed.fields) {
```

### E15 — `src/components/SiteAssistant.tsx` — imports

FIND (exactly once):
```
import { ChatAvatar, MessageBubble, OnlineDot, StarterPromptChip, TypingIndicator } from '@/components/chat/ChatVisuals';
```
REPLACE WITH:
```
import { ChatAvatar, MessageBubble, OnlineDot, StarterPromptChip, TypingIndicator } from '@/components/chat/ChatVisuals';
import { SiteAssistantExtras, type AssistantMeta } from '@/components/SiteAssistantExtras';
import { PERSONAS, PERSONA_PROMPTS, type Persona } from '@/lib/siteAssistantPersonas';
```

### E16 — `src/components/SiteAssistant.tsx` — ChatMessage gets meta

FIND (exactly once):
```
  isError?: boolean;
  streaming?: boolean;
}
```
REPLACE WITH:
```
  isError?: boolean;
  streaming?: boolean;
  meta?: AssistantMeta;
}
```

### E17 — `src/components/SiteAssistant.tsx` — persona state

FIND (exactly once):
```
const [input, setInput] = useState('');
```
REPLACE WITH:
```
const [input, setInput] = useState('');
  const [persona, setPersona] = useState<Persona>('owner');
```

### E18 — `src/components/SiteAssistant.tsx` — collect meta from the stream

FIND (exactly once):
```
    await streamAiChat({
      functionName: 'site-assistant',
```
REPLACE WITH:
```
    const meta: AssistantMeta = {};
    await streamAiChat({
      functionName: 'site-assistant',
```

### E19 — `src/components/SiteAssistant.tsx` — merge meta on done

FIND (exactly once):
```
      onDone: () => {
        setThinking(false);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
      },
```
REPLACE WITH:
```
      onAnswerId: (id) => { meta.answerId = id; },
      onSources: (s) => { meta.sources = s; },
      onSuggestions: (s) => { meta.suggestions = s; },
      onHandoff: () => { meta.handoff = true; },
      onDone: () => {
        setThinking(false);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, meta: { ...meta } } : m)));
      },
```

### E20 — `src/components/SiteAssistant.tsx` — persona starter prompts

FIND (exactly once):
```
<p className="pl-11 text-xs font-medium text-text-secondary">Try asking:</p>
                  <div className="space-y-2 pl-11">
                    {STARTER_PROMPTS.map((p) => (
                      <StarterPromptChip key={p} label={p} onClick={() => ask(p)} />
                    ))}
                  </div>
```
REPLACE WITH:
```
<div role="tablist" aria-label="Who are you?" className="flex gap-1.5 pl-11">
                    {PERSONAS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="tab"
                        aria-selected={persona === p.id}
                        onClick={() => setPersona(p.id)}
                        className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${persona === p.id ? 'border-accent text-accent' : 'border-border text-text-secondary'}`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <p className="pl-11 text-xs font-medium text-text-secondary">Try asking:</p>
                  <div className="space-y-2 pl-11">
                    {PERSONA_PROMPTS[persona].map((p) => (
                      <StarterPromptChip key={p} label={p} onClick={() => ask(p)} />
                    ))}
                  </div>
```

### E21 — `src/components/SiteAssistant.tsx` — message list with sources/feedback/chips (needs the index `i`)

FIND (exactly once):
```
              {messages.map((m) => (
                <MessageBubble key={m.id} role={m.role} isError={m.isError} streaming={m.streaming}>
                  {m.text}
                </MessageBubble>
              ))}
```
REPLACE WITH:
```
              {messages.map((m, i) => (
                <div key={m.id} className="space-y-2">
                  <div dir="auto">
                    <MessageBubble role={m.role} isError={m.isError} streaming={m.streaming}>
                      {m.text}
                    </MessageBubble>
                  </div>
                  {m.role === 'assistant' && !m.streaming && !m.isError && m.meta && (
                    <SiteAssistantExtras
                      text={m.text}
                      meta={m.meta}
                      isLast={i === messages.length - 1}
                      disabled={thinking}
                      onAsk={ask}
                      transcript={() => messages.map((x) => `${x.role}: ${x.text}`).join('\n')}
                    />
                  )}
                </div>
              ))}
```

### E22 — `src/components/SiteAssistant.tsx` — live region for screen readers

FIND (exactly once):
```
<div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
```
REPLACE WITH:
```
<div ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions text" className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
```

### E23 — `src/components/SiteAssistant.tsx` — Escape closes the dialog

FIND (exactly once):
```
            aria-modal="true"
            aria-label="Ask Vireek"
```
REPLACE WITH:
```
            aria-modal="true"
            aria-label="Ask Vireek"
            onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
```

### E24 — `src/components/SiteAssistant.tsx` — auto text direction for RTL input

FIND (exactly once):
```
                placeholder="Ask anything about Vireek…"
```
REPLACE WITH:
```
                dir="auto"
                placeholder="Ask anything about Vireek…"
```

### E25 — `src/App.tsx` — lazy import of the staff page

FIND (exactly once):
```
const StaffValueScoreboardPage = lazy(() => import('@/pages/StaffValueScoreboardPage').then((m) => ({ default: m.StaffValueScoreboardPage })));
```
REPLACE WITH:
```
const StaffValueScoreboardPage = lazy(() => import('@/pages/StaffValueScoreboardPage').then((m) => ({ default: m.StaffValueScoreboardPage })));
const StaffAssistantGapsPage = lazy(() => import('@/pages/StaffAssistantGapsPage').then((m) => ({ default: m.StaffAssistantGapsPage })));
```

### E26 — `src/App.tsx` — staff route

FIND (exactly once):
```
<Route path="/staff/value-scoreboard" element={<StaffRoute><StaffValueScoreboardPage /></StaffRoute>} />
```
REPLACE WITH:
```
<Route path="/staff/value-scoreboard" element={<StaffRoute><StaffValueScoreboardPage /></StaffRoute>} />
        <Route path="/staff/assistant-gaps" element={<StaffRoute><StaffAssistantGapsPage /></StaffRoute>} />
```

### E27 — `package.json` — scripts

FIND (exactly once):
```
"docs:inventory": "node scripts/gen-docs-inventory.mjs",
```
REPLACE WITH:
```
"docs:inventory": "node scripts/gen-docs-inventory.mjs",
    "knowledge:build": "node scripts/knowledge-build.mjs",
    "knowledge:check": "node scripts/knowledge-build.mjs --check",
    "knowledge:embed": "node scripts/knowledge-build.mjs --embed",
    "knowledge:test": "node --test scripts/lib/knowledgeChunker.test.mjs",
    "knowledge:eval": "node scripts/knowledge-eval.mjs",
```

### E28 — `.github/workflows/ci.yml` — drift gate in the main CI

FIND (exactly once):
```
      - name: Typecheck
        run: npm run typecheck

```
REPLACE WITH:
```
      - name: Typecheck
        run: npm run typecheck

      - name: Knowledge base drift check (pricing/plans/industries/integrations vs Ask Vireek)
        run: npm run knowledge:check

      - name: Knowledge build unit tests
        run: npm run knowledge:test

```

### E29 — `.github/workflows/ai-regression.yml` — append a job (end of file)

Append at the very end of the file:
```yaml
  site-assistant-eval:
    name: Ask Vireek knowledge eval (>=150 cases)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Validate case files (offline)
        run: node scripts/knowledge-eval.mjs --dry
      - name: Run eval against the deployed site-assistant
        env:
          SITE_ASSISTANT_URL: ${{ secrets.SUPABASE_URL }}/functions/v1/site-assistant
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
          SITE_ASSISTANT_EVAL_KEY: ${{ secrets.SITE_ASSISTANT_EVAL_KEY }}
        run: node scripts/knowledge-eval.mjs
      - name: Upload eval results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: site-assistant-eval
          path: eval/results-latest.json
```

## 2. Dependencies / config
- `npm i -D esbuild@^0.21.5` (already present transitively via Vite 5; this pins it for scripts). `typescript` is already a devDependency.
- Supabase secrets: `COHERE_API_KEY` (exists), **`COHERE_EMBED_MODEL=embed-multilingual-v3.0`** (important: the default `embed-english-v3.0` is English-only; both are 1024-dim), **`SITE_ASSISTANT_EVAL_KEY`** (random 32+ chars; also add to GitHub secrets together with `SUPABASE_ANON_KEY`).
- Deploy order matters: SQL → `npm run knowledge:embed` → deploy `site-assistant` → deploy frontend. Until the table is populated the assistant keeps working on the legacy path (soft-fail by design).

## 3. Execution order
```
supabase db push                                   # applies 20280401000000_site_assistant_knowledge.sql
npm run knowledge:build                            # regenerate artifacts (commit them)
npm run knowledge:check && npm run knowledge:test  # drift gate + unit tests
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… COHERE_API_KEY=… COHERE_EMBED_MODEL=embed-multilingual-v3.0 npm run knowledge:embed
supabase functions deploy site-assistant
SITE_ASSISTANT_URL=…/functions/v1/site-assistant SUPABASE_ANON_KEY=… SITE_ASSISTANT_EVAL_KEY=… npm run knowledge:eval
```
Schedule `select purge_site_assistant_log(180);` (service role) monthly for log retention.

## 4. Rollback
SQL rollback statements are in the header of the migration. App side: revert E1/E2 and the site-assistant edits; the legacy `brand_knowledge` path is untouched.
