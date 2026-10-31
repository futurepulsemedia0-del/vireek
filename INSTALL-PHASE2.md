# INSTALL — Phase 2 (apply after Phase 1)

## A. Files to REPLACE completely (they are files I gave you; copy the new version over the old one)

- `scripts/knowledge-build.mjs`
- `scripts/knowledge-eval.mjs`
- `supabase/functions/_shared/ai-core/siteAssistantLogic.ts`
- `supabase/functions/_shared/ai-core/siteKnowledge.ts` (adds the optional reranker)
- `src/components/SiteAssistantExtras.tsx`
- `src/pages/StaffAssistantGapsPage.tsx` (adds the 'copy knowledge doc template' button)

## B. NEW files

- `scripts/knowledge-draft-modules.mjs`
- `eval/site-assistant.redteam.json` (31 red-team cases; total eval is now 203)
- `.github/workflows/knowledge-embed.yml`

## C. Edits to existing project files (Ctrl+F the FIND text, replace with the block)

### P4 — `package.json` — draft generator script

FIND (exactly once):
```
"knowledge:eval": "node scripts/knowledge-eval.mjs",
```
REPLACE WITH:
```
"knowledge:eval": "node scripts/knowledge-eval.mjs",
    "knowledge:drafts": "node scripts/knowledge-draft-modules.mjs",
```

### P5 — `src/components/LiveChatWidget.tsx` — hand-off from Ask Vireek prefills the visitor's last question

FIND (exactly once):
```
    const openHandler = () => setOpen(true);
```
REPLACE WITH:
```
    const openHandler = (e: Event) => {
      setOpen(true);
      // Hand-off from Ask Vireek: prefill the visitor's last question so the human has context.
      const last = (e as CustomEvent<{ lastQuestion?: string }>).detail?.lastQuestion;
      if (last) setInput((prev) => prev || `I was asking Ask Vireek: "${last.slice(0, 300)}" and would like to talk to a person.`);
    };
```

### P7 — `src/components/SiteAssistant.tsx` — send the current page path to the function

FIND (exactly once):
```
      message: trimmed,
      history,
      signal: controller.signal,
```
REPLACE WITH:
```
      message: trimmed,
      history,
      extraBody: { page: window.location.pathname },
      signal: controller.signal,
```

### P11 — `supabase/functions/site-assistant/index.ts` — import page helpers

FIND (exactly once):
```
  detectIntent,
  redactPii,
```
REPLACE WITH:
```
  detectIntent,
  intentFromPage,
  redactPii,
  sanitizePage,
```

### P12 — `supabase/functions/site-assistant/index.ts` — read + sanitize the page

FIND (exactly once):
```
    const history: ChatMessage[] = Array.isArray(body?.history) ? body.history : [];
```
REPLACE WITH:
```
    const history: ChatMessage[] = Array.isArray(body?.history) ? body.history : [];
    const page = sanitizePage(body?.page);
```

### P13 — `supabase/functions/site-assistant/index.ts` — page-derived intent when the text alone is generic

FIND (exactly once):
```
    const intent = detectIntent(message);
```
REPLACE WITH:
```
    const textIntent = detectIntent(message);
    const intent = textIntent === "general" ? (intentFromPage(page) ?? "general") : textIntent;
```

### P14 — `supabase/functions/site-assistant/index.ts` — pass page into the prompt

FIND (exactly once):
```
extraInstructions: buildSiteInstructions({ coreFacts: CORE_FACTS, intent, grounded }),
```
REPLACE WITH:
```
extraInstructions: buildSiteInstructions({ coreFacts: CORE_FACTS, intent, grounded, page }),
```

## D. Settings
- Optional reranker: set Supabase secret `SITE_KB_RERANK=1` (and optionally `SITE_KB_RERANK_MODEL`, default `rerank-v3.5`). Leave it OFF until you have measured first-token latency on staging; it adds one network call. It soft-fails to the normal order on any error.
- Auto-sync workflow needs GitHub secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `COHERE_API_KEY`. The service-role key in CI is powerful: restrict the workflow to `main` (already done) and protect the branch.

## E. How to fill the knowledge gap (dashboard modules)
1. `npm run knowledge:drafts` writes `knowledge/_drafts/*.md`: one draft per dashboard page, containing the page's real on-screen text (about 365 of 400 routes; the rest are listed in `_drafts/INDEX.md`). Drafts are never ingested.
2. Open a draft, rewrite it as 3-6 factual sentences, set `plans:` and a real `verified:` date, move it to `knowledge/modules/`.
3. `npm run knowledge:build` then commit; the sync workflow (or `npm run knowledge:embed`) publishes it.
Do not move a draft unreviewed: raw UI text includes button labels and empty-state messages, and the assistant would repeat them as facts.
