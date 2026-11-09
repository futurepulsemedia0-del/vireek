// supabase/functions/_shared/verticals/context.ts
//
// vapi-webhook imports { captureVerticalIntake, loadVerticalContext, resolveVoiceAssistantTenant } from this file,
// but it was MISSING from the repository (the "Voice Platform" feature that owns the voice_assistants table is not
// present in this snapshot: no migration, no module). This file restores the import contract so the webhook can load:
//
//   resolveVoiceAssistantTenant  -> null.   There is no voice_assistants table to resolve API-created assistants
//                                  against; the webhook treats null as "no Voice Platform match" (its documented,
//                                  additive fallback), so home-services behaviour is unchanged. DO NOT invent a table
//                                  here: if/when the Voice Platform migration exists, implement the lookup then.
//   loadVerticalContext          -> "".     Same contract as before for home-services accounts: prompts unchanged.
//   captureVerticalIntake        -> the Vertical AI structured intake (trade, symptom, urgency, safety flags) with the
//                                  deterministic emergency rules, plus a diagnosis PREDICTION written to
//                                  vertical_outcome_events so the outcome layer can later compare it to the confirmed cause.

import type { TraceCtx } from "../observability/recorder.ts";
import { causeKeyOf, lookupSymptoms, type SymptomPayload } from "../vertical-ai/ontology.ts";
import { recordPrediction } from "../vertical-ai/outcomeEvents.ts";
import { captureIntakeStructured, type Admin } from "../vertical-ai/runtime.ts";

export interface VoiceAssistantTenant { userId: string; vapiAssistantId: string | null; voiceAssistantId: string }

export async function resolveVoiceAssistantTenant(
  _admin: unknown, _ids: { vapiAssistantId?: string | null; phoneNumberId?: string | null },
): Promise<VoiceAssistantTenant | null> {
  return null;
}

export async function loadVerticalContext(_admin: unknown, _userId: string, _voiceAssistantId: string | null): Promise<string> {
  return "";
}

export interface IntakeCtx { userId: string; voiceAssistantId: string | null; vapiCallId?: string; trace?: TraceCtx | null; outdoorTempF?: number | null }

export async function captureVerticalIntake(admin: Admin, ctx: IntakeCtx, args: Record<string, unknown>): Promise<string> {
  const raw = args && typeof args.fields === "object" && args.fields !== null ? (args.fields as Record<string, unknown>) : {};
  const { intake, entries } = await captureIntakeStructured(admin, ctx.trace ?? null, raw, { outdoorTempF: ctx.outdoorTempF ?? null });

  const lines: string[] = [];
  if (intake.override && intake.emergencyInstruction) {
    lines.push(`SAFETY FIRST: treat this as an emergency. Say: "${intake.emergencyInstruction}" Then flag the emergency and transfer.`);
  }
  lines.push(`Recorded intake: trade=${intake.trade ?? "unknown"}, urgency=${intake.urgency}${intake.systemType !== "unknown" ? `, system=${intake.systemType}` : ""}${intake.systemAgeYears !== null ? `, system_age_years=${intake.systemAgeYears}` : ""}.`);
  if (intake.fieldsMissing.length > 0) {
    lines.push(`Still needed: ${intake.fieldsMissing.map((m) => (m === "trade" ? "whether this is heating/cooling, plumbing or electrical" : "a short description of the symptom")).join(" and ")}. Ask the caller; do not guess.`);
  }

  // Learning hook: remember what we predicted so the confirmed cause can be compared later (idempotent per call).
  if (ctx.vapiCallId && intake.symptomKey) {
    const hit = lookupSymptoms(entries, { text: intake.symptom ?? "", trade: intake.trade })[0];
    if (hit) {
      const causes = (hit.entry.payload as SymptomPayload).causes.map((c) => causeKeyOf(c.cause)).slice(0, 10);
      if (causes.length > 0) {
        await recordPrediction(admin as never, {
          userId: ctx.userId, kind: "diagnosis", subjectType: "call", subjectId: ctx.vapiCallId,
          predicted: { cause_keys: causes, symptom_key: intake.symptomKey }, evidenceIds: [`onto:${hit.entry.trade}:symptom:${hit.entry.key}@v${hit.entry.version}`],
        });
      }
    }
  }
  return lines.join(" ");
}
