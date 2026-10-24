// supabase/functions/_shared/ai-transparency/gate.ts
//
// Edge-function side of the AI-transparency module (service role).
//   getFeatureGate(...)        -> may this AI feature run for this account right now?
//   recordProvenanceSidecar()  -> machine-readable provenance row (never throws)
//
// Both are BEST EFFORT with respect to the host function: a failure here must never
// break a call, a webhook or a business flow (see decideGate for fail-open/closed rules).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  buildProvenanceManifest,
  decideGate,
  findCatalogEntry,
  type FeatureStateRow,
  type GateDecision,
  type ProvenanceSubject,
} from "./engine.ts";

const TTL_MS = 30_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; decision: GateDecision }>();

export async function getFeatureGate(
  admin: SupabaseClient,
  ownerId: string,
  featureKey: string,
): Promise<GateDecision> {
  const entry = findCatalogEntry(featureKey);
  if (!entry) return decideGate(null, null);

  const ck = `${ownerId}:${featureKey}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.decision;

  let decision: GateDecision;
  try {
    const { data, error } = await admin.rpc("ai_transparency_feature_state", {
      p_user_id: ownerId,
      p_feature_key: featureKey,
    });
    if (error) throw error;
    const row = data as { enabled?: boolean; notice_ok?: boolean } | null;
    const state: FeatureStateRow | null =
      row && typeof row.enabled === "boolean" ? { enabled: row.enabled, notice_ok: row.notice_ok === true } : null;
    decision = decideGate(entry, state, false);
  } catch (err) {
    console.error("ai_transparency_gate_failed", featureKey, err instanceof Error ? err.message : err);
    // Do not cache a failure: the next call retries.
    return decideGate(entry, null, true);
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ck, { at: Date.now(), decision });
  return decision;
}

export interface SidecarInput {
  subjectType: ProvenanceSubject;
  subjectRef: string;
  featureKey: string;
  provider: string;
  aiGeneratedAudio: boolean;
  aiProcessed?: boolean;
  model?: string | null;
  contentSha256?: string | null;
  embedded?: boolean;
  embedMethod?: "id3v2.4" | "none" | null;
}

/** Writes one provenance row. Idempotent per (account, subject type, subject ref). Never throws. */
export async function recordProvenanceSidecar(
  admin: SupabaseClient,
  ownerId: string,
  i: SidecarInput,
): Promise<boolean> {
  try {
    const manifest = buildProvenanceManifest({
      subjectType: i.subjectType,
      featureKey: i.featureKey,
      provider: i.provider,
      aiGeneratedAudio: i.aiGeneratedAudio,
      aiProcessed: i.aiProcessed ?? false,
      model: i.model ?? null,
      contentSha256: i.contentSha256 ?? null,
    });
    const { error } = await admin.rpc("record_ai_provenance", {
      p_user_id: ownerId,
      p_subject_type: i.subjectType,
      p_subject_ref: i.subjectRef,
      p_feature_key: i.featureKey,
      p_provider: i.provider,
      p_ai_generated_audio: i.aiGeneratedAudio,
      p_ai_processed: i.aiProcessed ?? false,
      p_embedded: i.embedded ?? false,
      p_embed_method: i.embedMethod ?? null,
      p_content_sha256: i.contentSha256 ?? null,
      p_manifest: manifest,
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("ai_provenance_sidecar_failed", i.featureKey, err instanceof Error ? err.message : err);
    return false;
  }
}
