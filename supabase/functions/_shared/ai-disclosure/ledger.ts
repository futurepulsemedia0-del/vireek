// supabase/functions/_shared/ai-disclosure/ledger.ts
//
// DB glue for the AI Disclosure Proof Ledger (see
// supabase/migrations/20271112000000_ai_disclosure_proof_ledger.sql).
// Everything here is best-effort and NEVER throws: the ledger must not be able
// to break a call webhook.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { detectFromTranscript, MIN_STORE_CONFIDENCE } from "../i18n/detect.ts";
import { DEFAULT_LANGUAGE, normalizeLanguage, type LanguageCode } from "../i18n/languages.ts";
import { sendEmail } from "../notify/deliver.ts";
import { evaluateDisclosure, turnsFromTranscript, turnsFromVapiMessages, type ProofStatus } from "./match.ts";
import { DEFAULT_DISCLOSURE_SCRIPT, selectDisclosure, type DisclosureSelection } from "./select.ts";

const ALERT_PATH = "/dashboard/ai-disclosure-ledger";
const ALERT_STATUSES: ReadonlySet<ProofStatus> = new Set(["missing", "late", "partial"]);

function warn(event: string, err: unknown): void {
  console.error(JSON.stringify({ event, error: err instanceof Error ? err.message : String(err) }));
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DisclosureConfig {
  script: string;
  scriptLanguage: LanguageCode;
}

export async function loadDisclosureConfig(admin: SupabaseClient, userId: string): Promise<DisclosureConfig> {
  try {
    const { data } = await admin
      .from("business_profile")
      .select("ai_disclosure_script, ai_disclosure_language")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    return {
      script: (data?.ai_disclosure_script as string | undefined)?.trim() || DEFAULT_DISCLOSURE_SCRIPT,
      scriptLanguage: normalizeLanguage(data?.ai_disclosure_language) ?? DEFAULT_LANGUAGE,
    };
  } catch (err) {
    warn("ai_disclosure_config_load_failed", err);
    return { script: DEFAULT_DISCLOSURE_SCRIPT, scriptLanguage: DEFAULT_LANGUAGE };
  }
}

async function registerVersion(admin: SupabaseClient, userId: string, sel: DisclosureSelection): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc("ai_disclosure_register_version", {
      p_user_id: userId, p_language: sel.language, p_text: sel.text, p_source: sel.source,
    });
    if (error) { warn("ai_disclosure_register_failed", error.message); return null; }
    return typeof data === "string" ? data : null;
  } catch (err) {
    warn("ai_disclosure_register_threw", err);
    return null;
  }
}

export interface DisclosurePlan extends DisclosureSelection {
  versionId: string | null;
}

/**
 * Called from assistant-request: picks the wording for THIS caller, registers
 * the exact version and writes a 'pending' proof row (when the call id is known).
 */
export async function planDisclosure(
  admin: SupabaseClient,
  input: { userId: string; vapiCallId: string | null; callerLanguage: LanguageCode | null },
): Promise<DisclosurePlan | null> {
  try {
    const cfg = await loadDisclosureConfig(admin, input.userId);
    const selection = selectDisclosure({ script: cfg.script, scriptLanguage: cfg.scriptLanguage, callerLanguage: input.callerLanguage });
    const versionId = await registerVersion(admin, input.userId, selection);
    if (input.vapiCallId) {
      const { error } = await admin.from("call_ai_disclosures").upsert(
        {
          user_id: input.userId,
          vapi_call_id: input.vapiCallId,
          version_id: versionId,
          language: selection.language,
          selection_reason: selection.reason,
          disclosure_text: selection.text,
          disclosure_sha256: await sha256Hex(selection.text),
          status: "pending",
        },
        { onConflict: "user_id,vapi_call_id", ignoreDuplicates: true },
      );
      if (error) warn("ai_disclosure_plan_insert_failed", error.message);
    }
    return { ...selection, versionId };
  } catch (err) {
    warn("ai_disclosure_plan_threw", err);
    return null;
  }
}

export interface OutcomeInput {
  userId: string;
  vapiCallId: string;
  callId: string | null;
  /** Vapi end-of-call-report message (only artifact.messages / messages are read). */
  message: unknown;
  /** The (PCI-redacted) plain transcript the call row stores. */
  transcript: string | null;
  callStartedAt: string | null;
  durationSeconds: number | null;
}

async function raiseAlert(admin: SupabaseClient, userId: string, status: ProofStatus, vapiCallId: string): Promise<boolean> {
  const what: Record<string, string> = {
    missing: "did not contain the required AI disclosure",
    late: "stated the AI disclosure too late in the call",
    partial: "contained only part of the AI disclosure",
  };
  const title = "A call is missing its AI disclosure";
  const message = `A recent call ${what[status] ?? "has an AI disclosure problem"}. Review the Disclosure Ledger and check your assistant's first message.`;
  const { data, error } = await admin.rpc("ai_disclosure_raise_alert", {
    p_user_id: userId, p_type: "ai_disclosure_missing", p_title: title, p_message: message,
    p_action_url: `${ALERT_PATH}?call=${encodeURIComponent(vapiCallId)}`, p_dedupe_minutes: 60,
  });
  if (error) { warn("ai_disclosure_alert_failed", error.message); return false; }
  const created = data === true;
  if (created) {
    try {
      const { data: owner } = await admin.auth.admin.getUserById(userId);
      const to = owner?.user?.email;
      if (to) {
        await sendEmail(to, "Vireek: a call is missing its AI disclosure", `<p>${message}</p>`, message);
      }
    } catch (err) {
      warn("ai_disclosure_alert_email_failed", err);
    }
  }
  return created;
}

/** Called from end-of-call-report: proves (or disproves) the disclosure was spoken. */
export async function recordDisclosureOutcome(
  admin: SupabaseClient,
  input: OutcomeInput,
): Promise<{ status: ProofStatus } | null> {
  try {
    const { data: existing } = await admin
      .from("call_ai_disclosures")
      .select("id, status, version_id, language, selection_reason, disclosure_text, disclosure_sha256")
      .eq("user_id", input.userId)
      .eq("vapi_call_id", input.vapiCallId)
      .maybeSingle();

    // Vapi can redeliver the report: a finished proof row is never rewritten.
    if (existing && existing.status !== "pending") return { status: existing.status as ProofStatus };

    const cfg = await loadDisclosureConfig(admin, input.userId);
    const spoken = detectFromTranscript(input.transcript);
    const callerLanguage = spoken.language && spoken.confidence >= MIN_STORE_CONFIDENCE ? spoken.language : null;

    let planned = existing
      ? {
          versionId: existing.version_id as string | null,
          language: existing.language as LanguageCode,
          reason: existing.selection_reason as DisclosureSelection["reason"],
          text: existing.disclosure_text as string,
        }
      : null;
    if (!planned) {
      // assistant-request never reached us (static assistant, no call id): re-derive with the script as fallback.
      const sel = selectDisclosure({ script: cfg.script, scriptLanguage: cfg.scriptLanguage, callerLanguage: null });
      planned = { versionId: await registerVersion(admin, input.userId, sel), language: sel.language, reason: sel.reason, text: sel.text };
    }

    // Other wordings this account has used (an old script edit, a translation) still count as delivered.
    const { data: others } = await admin
      .from("ai_disclosure_versions")
      .select("id, disclosure_text")
      .eq("user_id", input.userId)
      .order("created_at", { ascending: false })
      .limit(20);
    const candidates = [
      { key: "planned", text: planned.text },
      ...((others ?? []) as Array<{ id: string; disclosure_text: string }>)
        .filter((v) => v.id !== planned!.versionId)
        .map((v) => ({ key: v.id, text: v.disclosure_text })),
    ];

    const startedMs = input.callStartedAt ? Date.parse(input.callStartedAt) : NaN;
    const msg = (input.message ?? {}) as { artifact?: { messages?: unknown }; messages?: unknown };
    const messageTurns = turnsFromVapiMessages(msg.artifact?.messages ?? msg.messages, Number.isNaN(startedMs) ? null : startedMs);
    const turns = messageTurns.length > 0 ? messageTurns : turnsFromTranscript(input.transcript);
    const { status, match } = evaluateDisclosure({ turns, candidates, durationSeconds: input.durationSeconds });

    const alternate = match.candidateKey && match.candidateKey !== "planned" ? match.candidateKey : null;
    let charOffset = match.charOffset;
    if (charOffset === null && match.excerpt && input.transcript) {
      const at = input.transcript.indexOf(match.excerpt.slice(0, 60));
      charOffset = at >= 0 ? at : null;
    }
    const secs = match.secondsFromStart;
    const proven = status === "delivered" || status === "late";
    const row = {
      user_id: input.userId,
      vapi_call_id: input.vapiCallId,
      call_id: input.callId,
      version_id: alternate ?? planned.versionId,
      language: planned.language,
      selection_reason: planned.reason,
      disclosure_text: alternate ? (candidates.find((c) => c.key === alternate)?.text ?? planned.text) : planned.text,
      disclosure_sha256: await sha256Hex(alternate ? (candidates.find((c) => c.key === alternate)?.text ?? planned.text) : planned.text),
      status,
      matched_via: match.found ? (alternate ? "alternate_version" : "planned") : null,
      delivered_at: proven && secs !== null && !Number.isNaN(startedMs) ? new Date(startedMs + secs * 1000).toISOString() : null,
      offset_seconds: secs !== null ? Number(secs.toFixed(2)) : null,
      transcript_char_offset: charOffset,
      matched_turn_index: match.turnIndex,
      match_score: match.score,
      evidence_excerpt: match.excerpt,
      transcript_sha256: input.transcript ? await sha256Hex(input.transcript) : null,
      detected_language: callerLanguage,
      language_mismatch: Boolean(callerLanguage && callerLanguage !== planned.language),
      call_started_at: Number.isNaN(startedMs) ? null : new Date(startedMs).toISOString(),
      call_duration_seconds: input.durationSeconds !== null ? Math.round(input.durationSeconds) : null,
    };

    const { error } = await admin.from("call_ai_disclosures").upsert(row, { onConflict: "user_id,vapi_call_id" });
    if (error) { warn("ai_disclosure_record_failed", error.message); return null; }

    if (ALERT_STATUSES.has(status)) {
      await raiseAlert(admin, input.userId, status, input.vapiCallId);
      await admin.from("call_ai_disclosures").update({ alerted_at: new Date().toISOString() })
        .eq("user_id", input.userId).eq("vapi_call_id", input.vapiCallId);
    }
    return { status };
  } catch (err) {
    warn("ai_disclosure_outcome_threw", err);
    return null;
  }
}
