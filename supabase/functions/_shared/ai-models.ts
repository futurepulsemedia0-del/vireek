// supabase/functions/_shared/ai-models.ts
//
// Vireek — AI Model Registry. THE ONLY place where a model-ID string may be written.
// Every call site reads its default model from here (MODELS.* / resolveModel()).
//
// CI: `npm run check:models` fails on any model-like string literal that is not an `id:` below.
// Process for adding / changing / retiring a model: docs/runbooks/model-change.md
// (mandatory ai-eval-run + ai-regression before switching a default).
//
// No imports and no top-level Deno access: loadable from Deno (edge), Vitest and node --test.

export type ModelProvider =
  | "gemini" | "groq" | "cerebras" | "cloudflare" | "openrouter"
  | "anthropic" | "cohere" | "openai" | "elevenlabs";

export type ModelPurpose = "chat" | "vision" | "image-generation" | "embedding" | "tts" | "router";

/** snapshot = dated/immutable id; alias = provider may move it silently; router = provider picks the model per request. */
export type ModelPinning = "snapshot" | "alias" | "router";

export type ModelStatus = "active" | "deprecated" | "retired";

export interface ModelEntry {
  /** Exact string sent to the provider. Must be unique. */
  readonly id: string;
  readonly provider: ModelProvider;
  readonly purpose: ModelPurpose;
  readonly pinning: ModelPinning;
  /** Provider snapshot/version when the id is (or can be mapped to) an immutable one; null when only an alias is known. */
  readonly pinnedVersion: string | null;
  /** CODEOWNERS handle (placeholders until replaced, see .github/CODEOWNERS). */
  readonly owner: string;
  readonly status: ModelStatus;
  /** ISO date (YYYY-MM-DD) announced by the provider; set when status is deprecated/retired. */
  readonly sunsetDate?: string;
  /** Registered id that replaces this one once its eval gate passed. Required when deprecated/retired. */
  readonly replacedBy?: string;
  readonly note?: string;
}

/** Stable keys for call sites. Values must exist in MODEL_REGISTRY (enforced by ai-models.test.ts). */
export const MODELS = {
  GEMINI_FLASH: "gemini-2.5-flash",
  GEMINI_FLASH_IMAGE: "gemini-2.5-flash-image",
  GROQ_LLAMA_70B: "llama-3.3-70b-versatile",
  CEREBRAS_LLAMA_70B: "llama-3.3-70b",
  CLOUDFLARE_LLAMA_70B: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  OPENROUTER_AUTO: "openrouter/auto",
  CLAUDE_SONNET: "claude-sonnet-5",
  CLAUDE_HAIKU: "claude-haiku-4-5-20251001",
  COHERE_COMMAND_R_PLUS: "command-r-plus",
  COHERE_EMBED_EN: "embed-english-v3.0",
  COHERE_EMBED_MULTILINGUAL: "embed-multilingual-v3.0",
  OPENAI_GPT_4O_MINI: "gpt-4o-mini",
  ELEVENLABS_FLASH: "eleven_flash_v2_5",
  ELEVENLABS_MULTILINGUAL: "eleven_multilingual_v2",
} as const;

export type ModelKey = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[ModelKey];

const OWNER_AI = "@OWNER_SECURITY"; // supabase/functions/_shared/ai-core/ owner in CODEOWNERS
const OWNER_BACKEND = "@OWNER_BACKEND";
const OWNER_VOICE = "@OWNER_VOICE";
const VERIFY = "[VERIFY] provider snapshot id not confirmed; alias may change upstream.";

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  { id: MODELS.GEMINI_FLASH, provider: "gemini", purpose: "chat", pinning: "alias", pinnedVersion: null, owner: OWNER_AI, status: "active",
    note: `Default for ai-core chain and most vision/JSON edge functions. ${VERIFY}` },
  { id: MODELS.GEMINI_FLASH_IMAGE, provider: "gemini", purpose: "image-generation", pinning: "alias", pinnedVersion: null, owner: OWNER_BACKEND, status: "active",
    note: `marketing-creative-generate. ${VERIFY}` },
  { id: MODELS.GROQ_LLAMA_70B, provider: "groq", purpose: "chat", pinning: "alias", pinnedVersion: null, owner: OWNER_AI, status: "active",
    note: `ai-core fallback #2. ${VERIFY}` },
  { id: MODELS.CEREBRAS_LLAMA_70B, provider: "cerebras", purpose: "chat", pinning: "alias", pinnedVersion: null, owner: OWNER_AI, status: "active",
    note: `ai-core fallback #3. ${VERIFY}` },
  { id: MODELS.CLOUDFLARE_LLAMA_70B, provider: "cloudflare", purpose: "chat", pinning: "alias", pinnedVersion: null, owner: OWNER_AI, status: "active",
    note: `ai-core fallback #4 (not used for JSON-mode chain). ${VERIFY}` },
  { id: MODELS.OPENROUTER_AUTO, provider: "openrouter", purpose: "router", pinning: "router", pinnedVersion: null, owner: OWNER_AI, status: "active",
    note: "ai-core last-resort fallback; OpenRouter picks the underlying model per request, so it can never be eval-pinned." },
  { id: MODELS.CLAUDE_SONNET, provider: "anthropic", purpose: "chat", pinning: "alias", pinnedVersion: null, owner: OWNER_AI, status: "active",
    note: `Anthropic adapter default (not in DEFAULT_CHAIN). ${VERIFY}` },
  { id: MODELS.CLAUDE_HAIKU, provider: "anthropic", purpose: "chat", pinning: "snapshot", pinnedVersion: "20251001", owner: OWNER_AI, status: "active",
    note: "Price-table entry only (costTracking); no default route uses it." },
  { id: MODELS.COHERE_COMMAND_R_PLUS, provider: "cohere", purpose: "chat", pinning: "alias", pinnedVersion: null, owner: OWNER_AI, status: "active",
    note: `Cohere adapter chat default. ${VERIFY}` },
  { id: MODELS.COHERE_EMBED_EN, provider: "cohere", purpose: "embedding", pinning: "snapshot", pinnedVersion: "v3.0", owner: OWNER_AI, status: "active",
    note: "Code default for embeddings (1024 dims). Changing embedding model requires re-embedding stored vectors." },
  { id: MODELS.COHERE_EMBED_MULTILINGUAL, provider: "cohere", purpose: "embedding", pinning: "snapshot", pinnedVersion: "v3.0", owner: OWNER_AI, status: "active",
    note: "Used by knowledge-embed workflow / knowledge-build (1024 dims). Do not mix with embed-english in one index." },
  { id: MODELS.OPENAI_GPT_4O_MINI, provider: "openai", purpose: "chat", pinning: "alias", pinnedVersion: null, owner: OWNER_BACKEND, status: "active",
    note: `ovb runtime default (OVB_CALLER_MODEL) and audit script default. ${VERIFY}` },
  { id: MODELS.ELEVENLABS_FLASH, provider: "elevenlabs", purpose: "tts", pinning: "alias", pinnedVersion: null, owner: OWNER_VOICE, status: "active",
    note: `_shared/voice/tts default (TTS_MODEL). ${VERIFY}` },
  { id: MODELS.ELEVENLABS_MULTILINGUAL, provider: "elevenlabs", purpose: "tts", pinning: "alias", pinnedVersion: null, owner: OWNER_VOICE, status: "active",
    note: `voice-studio-preview. ${VERIFY}` },
];

const BY_ID: ReadonlyMap<string, ModelEntry> = new Map(MODEL_REGISTRY.map((e) => [e.id, e]));

export const ALL_MODEL_IDS: readonly string[] = MODEL_REGISTRY.map((e) => e.id);

export function getModelEntry(id: string): ModelEntry | undefined {
  return BY_ID.get(id);
}

export function isRegisteredModel(id: string): boolean {
  return BY_ID.has(id);
}

type EnvGetter = (name: string) => string | null | undefined;

function denoEnv(name: string): string | undefined {
  const d = (globalThis as { Deno?: { env?: { get(n: string): string | undefined } } }).Deno;
  return d?.env?.get(name);
}

const warned = new Set<string>();
function warnOnce(key: string, payload: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(JSON.stringify({ event: "ai_model_registry", ...payload }));
}

/**
 * Resolve the model to call: first non-empty env override (in order), else `fallback`.
 * Same semantics as the previous `env(A) || env(B) || "literal"` expressions.
 *
 * Guard rails (never throw, a model change must not take a function down):
 *  - override not in registry: warn; with AI_MODEL_REGISTRY_STRICT=1 ignore it and use `fallback`.
 *  - deprecated model: warn. retired model: error log (provider will likely reject it).
 */
export function resolveModel(envNames: readonly string[], fallback: ModelId, getEnv: EnvGetter = denoEnv): string {
  let chosen: string = fallback;
  let source = "default";
  for (const name of envNames) {
    const v = getEnv(name)?.trim();
    if (v) { chosen = v; source = name; break; }
  }
  const entry = BY_ID.get(chosen);
  if (!entry) {
    warnOnce(`unreg:${chosen}`, { level: "warn", reason: "unregistered_model_override", model: chosen, source });
    if (getEnv("AI_MODEL_REGISTRY_STRICT") === "1") return fallback;
  } else if (entry.status === "deprecated") {
    warnOnce(`dep:${chosen}`, { level: "warn", reason: "deprecated_model", model: chosen, sunsetDate: entry.sunsetDate, replacedBy: entry.replacedBy });
  } else if (entry.status === "retired") {
    warnOnce(`ret:${chosen}`, { level: "error", reason: "retired_model", model: chosen, replacedBy: entry.replacedBy });
  }
  return chosen;
}
