import { supabase } from '@/lib/supabase';
import {
  buildProvenanceManifest,
  canEmbedProvenance,
  embedId3Provenance,
  registryToCsv,
  sha256Hex,
  type AiCategory,
  type Enforcement,
  type EmotionBasis,
  type FeatureModality,
  type LegalReviewStatus,
  type RegistryRow,
} from '../../supabase/functions/_shared/ai-transparency/engine';

/**
 * AI Transparency — Supabase access. Permissions, the voice-emotion notice rule and
 * ownership scoping are enforced by SECURITY DEFINER RPCs (20271120000000_ai_transparency_compliance.sql).
 */

export interface RegistryFeature extends RegistryRow {
  description: string;
  notice_version: number;
  default_enabled: boolean;
  explicitly_set: boolean;
  legal_review_notes: string | null;
  updated_at: string | null;
  categories: AiCategory[];
  emotion_basis: EmotionBasis | null;
  modality: FeatureModality;
  enforcement: Enforcement;
  legal_review_status: LegalReviewStatus;
}

export interface FeatureState {
  feature_key: string;
  enabled: boolean;
  notice_ok: boolean;
  allowed: boolean;
}

function fail(error: { message?: string } | null, fallback: string): never {
  const msg = error?.message?.trim();
  // RPC exceptions we raise are user-readable; anything else gets the generic text.
  throw new Error(msg && msg.length < 200 ? msg : fallback);
}

export async function fetchRegistry(): Promise<RegistryFeature[]> {
  const { data, error } = await supabase.rpc('get_ai_transparency_registry');
  if (error) fail(error, 'Could not load the AI transparency registry.');
  return (Array.isArray(data) ? data : []) as RegistryFeature[];
}

export async function setFeature(
  featureKey: string,
  enabled: boolean,
  ack?: { noticeVersion: number },
): Promise<FeatureState> {
  const { data, error } = await supabase.rpc('set_ai_transparency_feature', {
    p_feature_key: featureKey,
    p_enabled: enabled,
    p_acknowledge_notice: Boolean(ack),
    p_notice_version: ack?.noticeVersion ?? null,
  });
  if (error) fail(error, 'Could not change this setting.');
  return data as FeatureState;
}

export async function setLegalReview(featureKey: string, status: LegalReviewStatus, notes: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_ai_transparency_legal_review', {
    p_feature_key: featureKey,
    p_status: status,
    p_notes: notes,
  });
  if (error) fail(error, 'Could not save the legal review status.');
}

/** Effective state for the signed-in account. Returns null when the state cannot be read. */
export async function fetchMyFeatureState(featureKey: string): Promise<FeatureState | null> {
  const { data, error } = await supabase.rpc('my_ai_transparency_feature_state', { p_feature_key: featureKey });
  if (error || !data) return null;
  return data as FeatureState;
}

export interface RegistryExport {
  schema: string;
  generated_at: string;
  account_owner_id: string;
  disclaimer: string;
  features: RegistryFeature[];
  events: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
}

export async function exportRegistry(): Promise<RegistryExport> {
  const { data, error } = await supabase.rpc('export_ai_transparency_registry', { p_provenance_limit: 5000 });
  if (error) fail(error, 'Could not export the registry.');
  return data as RegistryExport;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const today = () => new Date().toISOString().slice(0, 10);

export function downloadRegistryJson(bundle: RegistryExport): void {
  saveBlob(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), `vireek-ai-transparency-registry-${today()}.json`);
}

export function downloadRegistryCsv(bundle: RegistryExport): void {
  saveBlob(new Blob(['\uFEFF' + registryToCsv(bundle.features)], { type: 'text/csv;charset=utf-8;' }), `vireek-ai-transparency-registry-${today()}.csv`);
}

/**
 * Prepares an uploaded AI-voice audio file: embeds ID3 provenance when the container supports it
 * (MP3) and returns the sidecar details. Never throws — on any problem the original file is used.
 */
export async function prepareAiAudioUpload(
  file: File,
  mime: string,
  featureKey: string,
  provider: string,
): Promise<{ body: Blob; embedded: boolean; method: 'id3v2.4' | 'none'; sha256: string | null }> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    if (canEmbedProvenance(mime)) {
      const manifest = buildProvenanceManifest({
        subjectType: 'generated_audio',
        featureKey,
        provider,
        aiGeneratedAudio: true,
        aiProcessed: true,
        contentSha256: sha256,
      });
      const r = embedId3Provenance(bytes, manifest);
      if (r.embedded) return { body: new Blob([r.bytes as BlobPart], { type: mime }), embedded: true, method: r.method === 'none' ? 'none' : r.method, sha256 };
    }
    return { body: file, embedded: false, method: 'none', sha256 };
  } catch {
    return { body: file, embedded: false, method: 'none', sha256: null };
  }
}

/** Best-effort sidecar registration from the dashboard. Never throws. */
export async function registerProvenance(input: {
  subjectType: 'generated_audio' | 'stored_recording' | 'voice_clone';
  subjectRef: string;
  featureKey: string;
  provider: string;
  aiGeneratedAudio: boolean;
  aiProcessed?: boolean;
  embedded?: boolean;
  embedMethod?: 'id3v2.4' | 'none';
  contentSha256?: string | null;
}): Promise<void> {
  try {
    const manifest = buildProvenanceManifest({
      subjectType: input.subjectType,
      featureKey: input.featureKey,
      provider: input.provider,
      aiGeneratedAudio: input.aiGeneratedAudio,
      aiProcessed: input.aiProcessed ?? false,
      contentSha256: input.contentSha256 ?? null,
    });
    await supabase.rpc('register_ai_provenance', {
      p_subject_type: input.subjectType,
      p_subject_ref: input.subjectRef,
      p_feature_key: input.featureKey,
      p_provider: input.provider,
      p_ai_generated_audio: input.aiGeneratedAudio,
      p_ai_processed: input.aiProcessed ?? false,
      p_embedded: input.embedded ?? false,
      p_embed_method: input.embedMethod ?? null,
      p_content_sha256: input.contentSha256 ?? null,
      p_manifest: manifest,
    });
  } catch {
    /* provenance is best effort */
  }
}
