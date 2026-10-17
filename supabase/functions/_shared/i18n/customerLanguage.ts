// supabase/functions/_shared/i18n/customerLanguage.ts
//
// Server-side glue for the customer language preference
// (customers.preferred_language). All functions are best-effort and NEVER
// throw: language is an enhancement, it must not be able to break a call
// webhook, an invoice email or an inbound SMS.
//
// Database side: see supabase/migrations/20271001000000_customer_preferred_language.sql
//   - find_customer_language(...)              service_role only
//   - record_detected_customer_language(...)   service_role only, "only if empty"

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { detectFromTranscript, detectLanguage, MIN_STORE_CONFIDENCE, NO_DETECTION, type DetectionResult } from "./detect.ts";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_META,
  SUPPORTED_LANGUAGES,
  isLanguageSource,
  languageName,
  normalizeLanguage,
  type LanguageCode,
  type LanguageSource,
} from "./languages.ts";
import { renderTemplate } from "./templates.ts";

export interface CustomerRef {
  customerId?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface FoundLanguage {
  language: LanguageCode;
  source: LanguageSource | null;
}

function warn(event: string, err: unknown): void {
  console.error(JSON.stringify({ event, error: err instanceof Error ? err.message : String(err) }));
}

/**
 * Looks a customer's language up: customer row (by id, then phone, then
 * email) and finally the language detected on their most recent call.
 * Returns null when nothing is known.
 */
export async function findCustomerLanguage(
  admin: SupabaseClient,
  userId: string,
  ref: CustomerRef,
): Promise<FoundLanguage | null> {
  if (!ref.customerId && !ref.phone && !ref.email) return null;
  try {
    const { data, error } = await admin.rpc("find_customer_language", {
      p_user_id: userId,
      p_customer_id: ref.customerId ?? null,
      p_phone: ref.phone ?? null,
      p_email: ref.email ?? null,
    });
    if (error) {
      warn("find_customer_language_failed", error.message);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    const language = normalizeLanguage(row?.language);
    if (!language) return null;
    return { language, source: isLanguageSource(row?.source) ? row.source : null };
  } catch (err) {
    warn("find_customer_language_threw", err);
    return null;
  }
}

/** Like findCustomerLanguage, but always returns a usable language. */
export async function resolveCustomerLanguage(
  admin: SupabaseClient,
  userId: string,
  ref: CustomerRef,
  fallback: LanguageCode = DEFAULT_LANGUAGE,
): Promise<LanguageCode> {
  return (await findCustomerLanguage(admin, userId, ref))?.language ?? fallback;
}

/**
 * Stores a detected language on the matching customer(s) ONLY if they have no
 * language yet (enforced atomically in SQL). Returns how many rows changed.
 */
export async function storeDetectedLanguage(
  admin: SupabaseClient,
  userId: string,
  ref: Pick<CustomerRef, "phone" | "email">,
  language: LanguageCode,
  confidence: number | null,
): Promise<number> {
  if (!ref.phone && !ref.email) return 0;
  try {
    const { data, error } = await admin.rpc("record_detected_customer_language", {
      p_user_id: userId,
      p_phone: ref.phone ?? null,
      p_email: ref.email ?? null,
      p_language: language,
      p_confidence: confidence,
    });
    if (error) {
      warn("record_detected_language_failed", error.message);
      return 0;
    }
    return typeof data === "number" ? data : 0;
  } catch (err) {
    warn("record_detected_language_threw", err);
    return 0;
  }
}

/**
 * Inbound SMS / email: detect from the message body and remember it if the
 * customer has no language yet. Short or ambiguous messages ("ok", "STOP")
 * are ignored — see MIN_STORE_CONFIDENCE.
 */
export async function recordLanguageFromMessage(
  admin: SupabaseClient,
  userId: string,
  ref: Pick<CustomerRef, "phone" | "email">,
  text: string,
): Promise<DetectionResult> {
  const detection = detectLanguage(text);
  if (!detection.language || detection.confidence < MIN_STORE_CONFIDENCE) return detection;
  await storeDetectedLanguage(admin, userId, ref, detection.language, detection.confidence);
  return detection;
}

/**
 * End-of-call: detect from the caller's words, stamp the call row, and
 * remember it on the customer if they have no language yet.
 */
export async function recordLanguageFromCall(
  admin: SupabaseClient,
  input: { userId: string; vapiCallId?: string | null; callerNumber?: string | null; transcript?: string | null },
): Promise<DetectionResult> {
  try {
    const detection = detectFromTranscript(input.transcript);
    if (!detection.language || detection.confidence < MIN_STORE_CONFIDENCE) return detection;

    if (input.vapiCallId) {
      const { error } = await admin
        .from("calls")
        .update({ detected_language_code: detection.language, detected_language_confidence: Number(detection.confidence.toFixed(2)) })
        .eq("user_id", input.userId)
        .eq("vapi_call_id", input.vapiCallId);
      if (error) warn("call_language_stamp_failed", error.message);
    }
    if (input.callerNumber) {
      await storeDetectedLanguage(admin, input.userId, { phone: input.callerNumber }, detection.language, detection.confidence);
    }
    return detection;
  } catch (err) {
    warn("record_language_from_call_threw", err);
    return NO_DETECTION;
  }
}

// ---------------------------------------------------------------------------
// Voice agent
// ---------------------------------------------------------------------------

/**
 * Text injected into the Vapi assistant through the `{{language_context}}`
 * template variable (assistantOverrides.variableValues).
 */
export function buildVoiceLanguageContext(language: LanguageCode | null): string {
  const supported = SUPPORTED_LANGUAGES.map((c) => languageName(c)).join(", ");
  if (language && language !== DEFAULT_LANGUAGE) {
    const name = languageName(language);
    return (
      `LANGUAGE: This customer's saved preferred language is ${name} (${language}). ` +
      `Speak ${name} from your very first sentence and keep using it. ` +
      `If the caller clearly answers in a different language, switch to theirs immediately and stay in it. ` +
      `Keep the business name, addresses, phone numbers and prices exactly as given. ` +
      `Safety and emergency instructions must be delivered in the caller's language too.`
    );
  }
  if (language === DEFAULT_LANGUAGE) {
    return (
      "LANGUAGE: This customer's saved preferred language is English. Speak English, " +
      "but if the caller clearly speaks another language, switch to it immediately and stay in it."
    );
  }
  return (
    `LANGUAGE: The caller's language is not known yet. Greet in English. If they speak another language ` +
    `(you can serve: ${supported}), switch to it immediately and stay in it for the whole call. ` +
    `If they speak a language outside that list, continue in simple English and offer to have a team member follow up. ` +
    `Safety and emergency instructions must be delivered in the caller's language.`
  );
}

/**
 * Localized opening line, used only when a NON-English preference is already
 * stored (otherwise the assistant's own configured greeting is kept).
 */
export function buildVoiceFirstMessage(
  language: LanguageCode | null,
  businessName: string | null | undefined,
  assistantName: string | null | undefined,
): string | null {
  if (!language || language === DEFAULT_LANGUAGE) return null;
  const business = businessName?.trim() || "";
  if (!business) return null; // never speak a greeting with a hole in it
  const assistant = assistantName?.trim() || renderTemplate("voice.assistantFallback", language);
  return renderTemplate("voice.firstMessage", language, { business, assistant });
}

/** Everything handleAssistantRequest needs, in one best-effort call. */
export async function resolveVoiceLanguage(
  admin: SupabaseClient,
  userId: string,
  callerNumber: string | null,
  assistantName: string | null,
): Promise<{ language: LanguageCode | null; context: string; firstMessage: string | null }> {
  const found = callerNumber ? await findCustomerLanguage(admin, userId, { phone: callerNumber }) : null;
  const language = found?.language ?? null;
  let firstMessage: string | null = null;
  if (language && language !== DEFAULT_LANGUAGE) {
    try {
      const { data } = await admin.from("profiles").select("company_name").eq("id", userId).maybeSingle();
      firstMessage = buildVoiceFirstMessage(language, (data?.company_name as string | null) ?? null, assistantName);
    } catch (err) {
      warn("voice_first_message_lookup_failed", err);
    }
  }
  return { language, context: buildVoiceLanguageContext(language), firstMessage };
}

/** For logging / UI. */
export function describeLanguage(code: LanguageCode): string {
  return `${LANGUAGE_META[code].nativeName} (${code})`;
}
