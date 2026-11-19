// supabase/functions/_shared/photo-authenticity/types.ts
//
// Shared types for the photo-authenticity analysis (C2PA reading + metadata consistency heuristics).
//
// WHAT THIS IS NOT: a forgery detector. Nothing here produces a verdict such as "authentic" or "fake".
// The consistency block reports a confidence that the file's metadata does not contradict itself or the
// capture record, together with the reasons that moved the number. Absence of metadata is NOT evidence of
// tampering (messaging apps, the in-app camera re-encode and screenshots all strip it), so "no data" is
// reported as `insufficient`, never as "low".

/** Bump whenever parsing, weights or thresholds change: stored reports with another version are re-analysed. */
export const ANALYZER_VERSION = "pa-1.0.0";

export type ImageFormat = "jpeg" | "png" | "webp" | "heic" | "unknown";

// ---------------------------------------------------------------- metadata (what the file says about itself)

export interface ParsedExifTime {
  /** Wall-clock text exactly as stored, "YYYY:MM:DD HH:MM:SS" normalised to ISO-like "YYYY-MM-DDTHH:MM:SS" (no zone). */
  local: string;
  /** Epoch ms of `local` read as if it were UTC. Only meaningful together with `offsetMinutes` or after offset inference. */
  localAsUtcMs: number;
  /** From OffsetTime* tags (minutes east of UTC), null when the file has none. */
  offsetMinutes: number | null;
}

export interface ImageMetadata {
  format: ImageFormat;
  /** True when the container was walked completely without hitting a bound or a structural error. */
  parsedCompletely: boolean;
  /** Reasons the parser stopped early or skipped something (stable codes, never file content). */
  parseNotes: string[];
  width: number | null;
  height: number | null;
  hasExif: boolean;
  hasXmp: boolean;
  /** Container carries a JUMBF/C2PA box (JPEG APP11, PNG caBX, WebP C2PA chunk). Presence only; validation is in c2pa.ts. */
  hasJumbf: boolean;
  make: string | null;
  model: string | null;
  software: string | null;
  /** XMP xmp:CreatorTool, sanitised. */
  creatorTool: string | null;
  /** XMP / EXIF digital source type token (last path segment of the IPTC URI), if any. */
  digitalSourceType: string | null;
  dateTimeOriginal: ParsedExifTime | null;
  dateTimeDigitized: ParsedExifTime | null;
  /** IFD0 DateTime (last modification by writing software). */
  dateTimeModified: ParsedExifTime | null;
  orientation: number | null;
  exifPixelWidth: number | null;
  exifPixelHeight: number | null;
  /** Count of capture-setting tags present (exposure, f-number, ISO, focal length, lens model). */
  captureSettingCount: number;
  hasMakerNote: boolean;
  /** GPS tags exist in the file. Coordinates are NEVER extracted or stored. */
  hasGps: boolean;
  thumbnail: { width: number; height: number } | null;
  /** XMP edit history (xmpMM:History / photoshop:History) present. */
  hasEditHistory: boolean;
  /** PNG text chunks used by image generators (keyword only, content is never read). */
  generatorChunkKeywords: string[];
}

// ---------------------------------------------------------------- C2PA

export type C2paReadStatus =
  | "not_present"        // reader found no manifest store
  | "read"               // manifest store parsed
  | "unsupported_format" // container/mime the reader does not handle
  | "too_large"          // skipped: above the CPU budget of the edge function
  | "unavailable"        // reader not configured in this runtime
  | "error";             // reader failed unexpectedly

export type C2paValidation = "valid" | "invalid" | "unknown";
/**
 * `not_evaluated`: no trust anchors are configured, so who signed it was NOT checked against any trust list.
 * `untrusted`: anchors are configured and the signer is not on them. `trusted`: anchors configured and matched.
 */
export type C2paTrust = "trusted" | "untrusted" | "not_evaluated";

export type C2paProblem =
  | "asset_changed_after_signing"
  | "signature_invalid"
  | "manifest_malformed"
  | "certificate_expired"
  | "certificate_invalid"
  | "timestamp_invalid"
  | "other";

export interface C2paReport {
  status: C2paReadStatus;
  validation: C2paValidation;
  trust: C2paTrust;
  problems: C2paProblem[];
  /** Raw validation status codes from the reader (bounded, pattern-checked). */
  statusCodes: string[];
  manifestCount: number;
  claimGenerator: string | null;
  signer: { issuer: string | null; commonName: string | null; algorithm: string | null; signedAt: string | null } | null;
  /** Actions declared by the signer (c2pa.created, c2pa.edited, ...), bounded. */
  actions: string[];
  digitalSourceTypes: string[];
  ingredientCount: number;
  /** Signer declares generated/synthetic media (trainedAlgorithmicMedia, algorithmicMedia, composites with them, ...). */
  declaresGeneratedMedia: boolean;
  /** Declared camera/computational capture (digitalCapture / computationalCapture). */
  declaresCapture: boolean;
  declaresEdits: boolean;
}

// ---------------------------------------------------------------- consistency (heuristics)

export type ReasonEffect = "supports" | "weakens" | "info";

export interface ConsistencyReason {
  /** Stable code; the UI maps it to translated text (photoProvenance:authenticity.reason.<code>). */
  code: string;
  effect: ReasonEffect;
  /** Signed points added to the base score. 0 for `info`. */
  weight: number;
  /** Small, sanitised, display-safe values referenced by the translated sentence. */
  detail?: Record<string, string | number | boolean>;
}

export type ConsistencyLevel = "strong" | "moderate" | "weak" | "insufficient";

export interface ConsistencyReport {
  kind: "metadata_consistency";
  /** Always true. Present so downstream code and exports can never lose the qualifier. */
  notAVerdict: true;
  /** 0-100, or null when nothing informative could be checked. */
  confidence: number | null;
  level: ConsistencyLevel;
  reasons: ConsistencyReason[];
}

export interface CaptureContext {
  captureSource: "in_app_camera" | "gallery_import" | "web_input" | "unknown";
  serverReceivedAt: string; // ISO
  deviceCapturedAt: string | null;
  deviceTimeStatus: "ok" | "missing" | "future" | "stale";
  offlineQueued: boolean;
  /** Job lifecycle timestamps (ISO) when known. */
  job: { arrivedAt: string | null; startedAt: string | null; completedAt: string | null } | null;
}

export interface AuthenticityReport {
  analyzerVersion: string;
  /** SHA-256 of the exact bytes analysed (equals the sealed original_sha256; the caller verifies it first). */
  analyzedSha256: string;
  analyzedBytes: number;
  metadata: {
    format: ImageFormat;
    parsedCompletely: boolean;
    hasExif: boolean;
    hasXmp: boolean;
    hasGps: boolean;
    camera: { make: string | null; model: string | null } | null;
    software: string | null;
    exifCapturedAt: string | null;
    width: number | null;
    height: number | null;
  };
  c2pa: C2paReport;
  consistency: ConsistencyReport;
}
