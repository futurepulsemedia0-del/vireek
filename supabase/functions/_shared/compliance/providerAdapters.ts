// supabase/functions/_shared/compliance/providerAdapters.ts
//
// Provider-side erasure adapters (gap E5) behind ONE interface:
//
//     adapter.erase(subject) -> { status, proof }
//
// Adapters: Vapi (calls), Twilio (recordings + call logs), ElevenLabs (cloned voices), Resend (no delete API).
//
// NOT LIVE-VERIFIED. Every endpoint below is written from vendor documentation as remembered at authoring time and is
// exercised ONLY against mocked fetch in providerAdapters.test.ts. Before relying on this for a real erasure request:
//   TODO(owner): confirm each endpoint, auth scheme and 404/410 semantics against the vendor's current API reference and
//                against your plan, then run one erasure against a throw-away test account per provider.
//   TODO(owner): confirm whether the vendor keeps backups / derived copies after the API delete (list this in the DPA).
//   TODO(counsel): decide what the proof record must contain to count as evidence of erasure.
//
// Pure of Supabase: dependency-injected fetch + clock, so it runs under Deno, Node and Vitest.

export type ProviderName = "vapi" | "twilio" | "elevenlabs" | "resend";

/**
 * erased          every identifier is gone at the provider (a 404 counts as "already gone").
 * not_applicable  nothing to delete for this subject.
 * unsupported     the provider offers no deletion API we can call; manual action is required. Terminal.
 * failed          at least one identifier could not be deleted; see `retryable`.
 */
export type ErasureStatus = "erased" | "not_applicable" | "unsupported" | "failed";

export interface ErasureSubject {
  /** Account owner whose data is being erased. */
  accountId: string;
  /** Provider resource identifiers keyed by kind, e.g. { callIds: [...] }. Identifiers only — never PII. */
  resources: Record<string, string[]>;
}

export interface ErasureProof {
  provider: ProviderName;
  adapter: string;
  endpoint: string;
  at: string;
  attempted: number;
  deleted: number;
  alreadyGone: number;
  invalid: number;
  failed: Array<{ id: string; reason: string }>;
  note?: string;
  /** Always false: no adapter in this file has been run against a live provider account. */
  liveVerified: false;
}

export interface ErasureOutcome {
  status: ErasureStatus;
  proof: ErasureProof;
  /** Only meaningful when status === "failed". */
  retryable: boolean;
  /** Short machine-readable reason. Never contains response bodies, headers or credentials. */
  error?: string;
}

export interface ProviderErasureAdapter {
  readonly provider: ProviderName;
  erase(subject: ErasureSubject): Promise<ErasureOutcome>;
}

export interface ProviderEnv {
  elevenLabsKey?: string;
  vapiKey?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  resendKey?: string;
}

export interface AdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Per-request timeout. Default 8s. */
  timeoutMs?: number;
  /** Parallel requests per adapter. Default 4. */
  concurrency?: number;
}

// ------------------------------------------------------------------ identifier validation (blocks path injection)
export const ID_PATTERNS = {
  vapiCall: /^[A-Za-z0-9_-]{8,64}$/,
  elevenVoice: /^[A-Za-z0-9_-]{6,64}$/,
  twilioCall: /^CA[0-9a-fA-F]{32}$/,
  twilioRecording: /^RE[0-9a-fA-F]{32}$/,
  twilioAccount: /^AC[0-9a-fA-F]{32}$/,
} as const;

// ------------------------------------------------------------------ retry policy (pure)
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const BASE_BACKOFF_MS = 60_000;

/** attempt is 1-based (the attempt that just failed). Exponential, capped at 6 h, +/-20 % jitter. */
export function computeBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(Number.isFinite(attempt) ? attempt : 1));
  const raw = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(n - 1, 20));
  const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, rand()));
  return Math.min(MAX_BACKOFF_MS, Math.round(raw * jitter));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const s = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += s) out.push(items.slice(i, i + s));
  return out;
}

// ------------------------------------------------------------------ HTTP helper
type DeleteKind = "deleted" | "gone" | "retry" | "auth" | "fatal";
interface DeleteResult { kind: DeleteKind; reason: string }

async function httpDelete(
  f: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<DeleteResult> {
  try {
    const res = await f(url, { method: "DELETE", headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { kind: "deleted", reason: `http_${res.status}` };
    // 404 = already gone. 410 (Gone) is treated the same.
    if (res.status === 404 || res.status === 410) return { kind: "gone", reason: `http_${res.status}` };
    if (res.status === 401 || res.status === 403) return { kind: "auth", reason: `http_${res.status}` };
    if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
      return { kind: "retry", reason: `http_${res.status}` };
    }
    return { kind: "fatal", reason: `http_${res.status}` };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { kind: "retry", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error" };
  }
}

interface Target { id: string; url: string }

/** Deletes every target with bounded concurrency. Stops issuing requests after the first auth failure. */
async function deleteAll(
  f: typeof fetch,
  targets: Target[],
  headers: Record<string, string>,
  timeoutMs: number,
  concurrency: number,
): Promise<{ deleted: number; gone: number; failed: Array<{ id: string; reason: string; kind: DeleteKind }> }> {
  const out = { deleted: 0, gone: 0, failed: [] as Array<{ id: string; reason: string; kind: DeleteKind }> };
  let next = 0;
  let authBroken = false;
  const worker = async () => {
    for (;;) {
      if (authBroken) return;
      const i = next++;
      if (i >= targets.length) return;
      const t = targets[i];
      const r = await httpDelete(f, t.url, headers, timeoutMs);
      if (r.kind === "deleted") out.deleted++;
      else if (r.kind === "gone") out.gone++;
      else {
        out.failed.push({ id: t.id, reason: r.reason, kind: r.kind });
        if (r.kind === "auth") authBroken = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length || 1)) }, worker));
  // Targets never attempted because auth broke: report them so nothing is silently dropped.
  if (authBroken) {
    const seen = new Set(out.failed.map((x) => x.id));
    for (const t of targets) if (!seen.has(t.id)) out.failed.push({ id: t.id, reason: "not_attempted_auth_failure", kind: "auth" });
  }
  return out;
}

function baseProof(provider: ProviderName, adapter: string, endpoint: string, now: Date): ErasureProof {
  return { provider, adapter, endpoint, at: now.toISOString(), attempted: 0, deleted: 0, alreadyGone: 0, invalid: 0, failed: [], liveVerified: false };
}

/** Shared adapter body: validate ids -> delete -> fold into one outcome. */
async function runDeletion(opts: {
  provider: ProviderName;
  adapter: string;
  endpoint: string;
  ids: string[];
  pattern: RegExp;
  urlFor: (id: string) => string;
  headers: Record<string, string> | null;
  missingCredReason: string;
  deps: Required<Pick<AdapterDeps, "now" | "timeoutMs" | "concurrency">> & { f: typeof fetch };
}): Promise<ErasureOutcome> {
  const { deps } = opts;
  const proof = baseProof(opts.provider, opts.adapter, opts.endpoint, deps.now());
  const unique = [...new Set(opts.ids.filter((x) => typeof x === "string" && x.length > 0))];
  if (unique.length === 0) return { status: "not_applicable", proof, retryable: false };

  const valid = unique.filter((id) => opts.pattern.test(id));
  proof.invalid = unique.length - valid.length;
  if (valid.length === 0) {
    proof.note = "no identifier passed validation";
    return { status: "failed", proof, retryable: false, error: "invalid_identifiers" };
  }
  proof.attempted = valid.length;

  if (!opts.headers) {
    proof.failed = valid.map((id) => ({ id, reason: opts.missingCredReason }));
    return { status: "failed", proof, retryable: true, error: opts.missingCredReason };
  }

  const r = await deleteAll(deps.f, valid.map((id) => ({ id, url: opts.urlFor(id) })), opts.headers, deps.timeoutMs, deps.concurrency);
  proof.deleted = r.deleted;
  proof.alreadyGone = r.gone;
  proof.failed = r.failed.map(({ id, reason }) => ({ id, reason }));
  if (r.failed.length === 0) return { status: "erased", proof, retryable: false };
  const allPermanent = r.failed.every((x) => x.kind === "fatal");
  return { status: "failed", proof, retryable: !allPermanent, error: `${r.failed.length}_of_${valid.length}_failed:${r.failed[0].reason}` };
}

// ------------------------------------------------------------------ adapters
function resolveDeps(d: AdapterDeps | undefined) {
  return {
    f: d?.fetchImpl ?? fetch,
    now: d?.now ?? (() => new Date()),
    timeoutMs: d?.timeoutMs ?? 8000,
    concurrency: d?.concurrency ?? 4,
  };
}

/** Vapi: DELETE https://api.vapi.ai/call/{id}  (Bearer private key).  TODO(owner): verify against current Vapi docs. */
export function createVapiAdapter(env: ProviderEnv, d?: AdapterDeps): ProviderErasureAdapter {
  const deps = resolveDeps(d);
  return {
    provider: "vapi",
    erase: (s) => runDeletion({
      provider: "vapi", adapter: "vapi.delete_call.v1", endpoint: "DELETE https://api.vapi.ai/call/{id}",
      ids: s.resources.callIds ?? [], pattern: ID_PATTERNS.vapiCall,
      urlFor: (id) => `https://api.vapi.ai/call/${encodeURIComponent(id)}`,
      headers: env.vapiKey ? { Authorization: `Bearer ${env.vapiKey}` } : null,
      missingCredReason: "no_credentials:VAPI_PRIVATE_KEY", deps,
    }),
  };
}

/** ElevenLabs: DELETE https://api.elevenlabs.io/v1/voices/{voice_id}  (xi-api-key).  TODO(owner): verify. */
export function createElevenLabsAdapter(env: ProviderEnv, d?: AdapterDeps): ProviderErasureAdapter {
  const deps = resolveDeps(d);
  return {
    provider: "elevenlabs",
    erase: (s) => runDeletion({
      provider: "elevenlabs", adapter: "elevenlabs.delete_voice.v1", endpoint: "DELETE https://api.elevenlabs.io/v1/voices/{voice_id}",
      ids: s.resources.voiceIds ?? [], pattern: ID_PATTERNS.elevenVoice,
      urlFor: (id) => `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(id)}`,
      headers: env.elevenLabsKey ? { "xi-api-key": env.elevenLabsKey } : null,
      missingCredReason: "no_credentials:ELEVENLABS_API_KEY", deps,
    }),
  };
}

/**
 * Twilio: DELETE .../Accounts/{AccountSid}/Recordings/{RecordingSid}.json and .../Calls/{CallSid}.json (HTTP Basic).
 * Recordings are deleted first, then call logs. TODO(owner): verify; also confirm that deleting a Call resource is
 * enough for the call-log requirement of your DPA (Twilio keeps some billing metadata).
 * Scope: SIDs held in pbx_recordings / pbx_voicemails / pbx_calls / pbx_call_legs only.
 * TODO(owner): Vapi-originated Twilio calls and SMS/message logs are NOT covered (no SID is stored in the schema).
 */
export function createTwilioAdapter(env: ProviderEnv, d?: AdapterDeps): ProviderErasureAdapter {
  const deps = resolveDeps(d);
  const sid = env.twilioAccountSid ?? "";
  const token = env.twilioAuthToken ?? "";
  const credsOk = ID_PATTERNS.twilioAccount.test(sid) && token.length > 0;
  const headers = credsOk ? { Authorization: `Basic ${btoa(`${sid}:${token}`)}` } : null;
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  return {
    provider: "twilio",
    async erase(s) {
      const parts = [
        await runDeletion({
          provider: "twilio", adapter: "twilio.delete_recording.v1", endpoint: "DELETE /2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}.json",
          ids: s.resources.recordingSids ?? [], pattern: ID_PATTERNS.twilioRecording,
          urlFor: (id) => `${base}/Recordings/${encodeURIComponent(id)}.json`,
          headers, missingCredReason: "no_credentials:TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN", deps,
        }),
        await runDeletion({
          provider: "twilio", adapter: "twilio.delete_call.v1", endpoint: "DELETE /2010-04-01/Accounts/{AccountSid}/Calls/{Sid}.json",
          ids: s.resources.callSids ?? [], pattern: ID_PATTERNS.twilioCall,
          urlFor: (id) => `${base}/Calls/${encodeURIComponent(id)}.json`,
          headers, missingCredReason: "no_credentials:TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN", deps,
        }),
      ];
      return mergeOutcomes("twilio", "twilio.delete_recordings_and_calls.v1", parts, deps.now());
    },
  };
}

/**
 * Resend: there is no endpoint we can call to delete sent-email logs for a data subject.
 * Returns `unsupported` (terminal, NOT retried) with proof that explicitly says manual action is needed.
 * TODO(owner): confirm against Resend's current API/dashboard; if unsupported, file a deletion request with Resend
 *              support and record the ticket reference in the proof by hand.
 * TODO(counsel): decide whether `unsupported` is acceptable evidence for a given erasure request.
 */
export function createResendAdapter(_env: ProviderEnv, d?: AdapterDeps): ProviderErasureAdapter {
  const deps = resolveDeps(d);
  return {
    provider: "resend",
    erase(): Promise<ErasureOutcome> {
      const proof = baseProof("resend", "resend.manual.v1", "none (no deletion API called)", deps.now());
      proof.note = "No automated deletion available. Manual vendor request required. Not live-verified.";
      return Promise.resolve({ status: "unsupported", proof, retryable: false });
    },
  };
}

function mergeOutcomes(provider: ProviderName, adapter: string, parts: ErasureOutcome[], now: Date): ErasureOutcome {
  const active = parts.filter((p) => p.status !== "not_applicable");
  const proof = baseProof(provider, adapter, parts.map((p) => p.proof.endpoint).join(" + "), now);
  for (const p of parts) {
    proof.attempted += p.proof.attempted;
    proof.deleted += p.proof.deleted;
    proof.alreadyGone += p.proof.alreadyGone;
    proof.invalid += p.proof.invalid;
    proof.failed.push(...p.proof.failed);
  }
  if (active.length === 0) return { status: "not_applicable", proof, retryable: false };
  const failed = active.filter((p) => p.status === "failed");
  if (failed.length === 0) return { status: "erased", proof, retryable: false };
  return { status: "failed", proof, retryable: failed.some((p) => p.retryable), error: failed[0].error };
}

export function createAdapters(env: ProviderEnv, deps?: AdapterDeps): Record<ProviderName, ProviderErasureAdapter> {
  return {
    vapi: createVapiAdapter(env, deps),
    twilio: createTwilioAdapter(env, deps),
    elevenlabs: createElevenLabsAdapter(env, deps),
    resend: createResendAdapter(env, deps),
  };
}
