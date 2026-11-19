// supabase/functions/_shared/photo-authenticity/heuristics.ts
//
// Metadata CONSISTENCY heuristics. Output is a confidence with reasons, never a verdict.
//
// Read this before changing a weight:
//  * Everything in EXIF/XMP can be edited by anyone. "Supports" means "nothing here contradicts the capture
//    record", not "this is genuine". Only a valid C2PA signature adds real weight, and even that proves the
//    signer's claim and file integrity since signing, not that the scene was real.
//  * Missing metadata is NOT evidence of tampering (messaging apps, screenshots and the in-app camera strip it).
//    It is reported as `info` and, when it is all we have, the result is `insufficient` (confidence = null).
//  * Weights are expert judgement, NOT statistically calibrated. They only order signals; do not read the number
//    as a probability. Any change must bump ANALYZER_VERSION so stored reports are recomputed.

import type {
  C2paReport, CaptureContext, ConsistencyLevel, ConsistencyReason, ConsistencyReport, ImageMetadata, ParsedExifTime,
} from "./types.ts";

export const BASE_SCORE = 50;
export const MIN_SCORE = 5;
export const MAX_SCORE = 95;
export const MAX_SCORE_WITHOUT_VALID_C2PA = 85;

export const WEIGHTS = {
  c2paInvalid: -35,
  c2paGenerated: -45,
  c2paCaptureTrusted: 30,
  c2paCaptureUntrusted: 15,
  c2paIntactTrusted: 10,
  c2paIntactUntrusted: 5,
  generatorSoftware: -40,
  xmpGenerated: -40,
  pngGeneratorChunks: -30,
  editingSoftware: -15,
  xmpEditHistory: -10,
  dimensionsMismatch: -12,
  thumbnailMismatch: -15,
  modifiedAfterCapture: -8,
  cameraTags: 10,
  makerNote: 3,
  captureTimeFuture: -25,
  deviceTimeMatchExact: 12,
  deviceTimeMatchInferred: 8,
  deviceTimeMismatch: -12,
  predatesJob: -20,
  inJobWindow: 6,
} as const;

const EDITING_RE = /photoshop|lightroom|\bgimp\b|snapseed|pixelmator|affinity photo|paint\.net|canva|picsart|facetune|photopea|luminar|capture one|darktable|rawtherapee|\bvsco\b|lightx|pixlr|fotor|remini/i;
const GENERATOR_RE = /midjourney|dall[-·\s]?e|stable[\s-]?diffusion|firefly|\bimagen\b|comfyui|automatic1111|novelai|leonardo\.ai|ideogram|\bflux\b|dreamstudio|invokeai|runwayml/i;
const GENERATED_SOURCE_RE = /^(trainedalgorithmicmedia|compositewithtrainedalgorithmicmedia|compositesynthetic|algorithmicmedia)$/i;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function utcMs(t: ParsedExifTime): { ms: number; offsetKnown: boolean } {
  return t.offsetMinutes !== null ? { ms: t.localAsUtcMs - t.offsetMinutes * MIN, offsetKnown: true } : { ms: t.localAsUtcMs, offsetKnown: false };
}

const parseIso = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

function level(confidence: number | null): ConsistencyLevel {
  if (confidence === null) return "insufficient";
  return confidence >= 70 ? "strong" : confidence >= 40 ? "moderate" : "weak";
}

export function evaluateConsistency(meta: ImageMetadata, c2pa: C2paReport, ctx: CaptureContext): ConsistencyReport {
  const reasons: ConsistencyReason[] = [];
  const add = (code: string, effect: ConsistencyReason["effect"], weight: number, detail?: ConsistencyReason["detail"]) => {
    reasons.push({ code, effect, weight: effect === "info" ? 0 : weight, ...(detail ? { detail } : {}) });
  };

  // ---- C2PA (the only strong signal)
  let validC2pa = false;
  if (c2pa.status === "read") {
    if (c2pa.validation === "invalid") {
      add("c2pa_validation_failed", "weakens", WEIGHTS.c2paInvalid, { problems: c2pa.problems.join(",") || "other" });
    } else if (c2pa.validation === "valid") {
      validC2pa = true;
      const trusted = c2pa.trust === "trusted";
      if (c2pa.declaresGeneratedMedia) add("c2pa_declares_generated", "weakens", WEIGHTS.c2paGenerated);
      else if (c2pa.declaresCapture) add("c2pa_valid_capture_claim", "supports", trusted ? WEIGHTS.c2paCaptureTrusted : WEIGHTS.c2paCaptureUntrusted, { trusted });
      else add("c2pa_valid_intact", "supports", trusted ? WEIGHTS.c2paIntactTrusted : WEIGHTS.c2paIntactUntrusted, { trusted });
      if (c2pa.declaresEdits) add("c2pa_edits_declared", "info", 0);
    }
  }

  // ---- generator / editor fingerprints
  const tools = [meta.software, meta.creatorTool].filter((s): s is string => !!s);
  const generatorTool = tools.find((s) => GENERATOR_RE.test(s));
  const editorTool = tools.find((s) => EDITING_RE.test(s));
  if (generatorTool) add("generator_software", "weakens", WEIGHTS.generatorSoftware, { software: generatorTool.slice(0, 60) });
  if (meta.digitalSourceType && GENERATED_SOURCE_RE.test(meta.digitalSourceType) && !c2pa.declaresGeneratedMedia) {
    add("xmp_declares_generated", "weakens", WEIGHTS.xmpGenerated);
  }
  if (meta.generatorChunkKeywords.length > 0) add("png_generator_chunks", "weakens", WEIGHTS.pngGeneratorChunks);
  if (editorTool && !generatorTool) add("editing_software", "weakens", WEIGHTS.editingSoftware, { software: editorTool.slice(0, 60) });
  if (meta.hasEditHistory) add("xmp_edit_history", "weakens", WEIGHTS.xmpEditHistory);

  // ---- internal structure
  if (meta.exifPixelWidth && meta.exifPixelHeight && meta.width && meta.height) {
    const same = meta.exifPixelWidth === meta.width && meta.exifPixelHeight === meta.height;
    const swapped = meta.exifPixelWidth === meta.height && meta.exifPixelHeight === meta.width; // orientation-tolerant
    if (!same && !swapped) {
      add("dimensions_mismatch", "weakens", WEIGHTS.dimensionsMismatch, { exif: `${meta.exifPixelWidth}x${meta.exifPixelHeight}`, actual: `${meta.width}x${meta.height}` });
    }
  }
  if (meta.thumbnail && meta.width && meta.height) {
    const ratio = (w: number, h: number) => Math.max(w, h) / Math.min(w, h);
    const a = ratio(meta.thumbnail.width, meta.thumbnail.height);
    const b = ratio(meta.width, meta.height);
    if (Math.abs(a - b) / b > 0.04) add("thumbnail_mismatch", "weakens", WEIGHTS.thumbnailMismatch);
  }
  if (meta.dateTimeOriginal && meta.dateTimeModified) {
    // Wall-clock vs wall-clock: both are written by the same device in the same zone, and only one of them has an
    // OffsetTime tag, so mixing a UTC-adjusted value with a bare local one would invent a false gap.
    const o = meta.dateTimeOriginal.localAsUtcMs;
    const mo = meta.dateTimeModified.localAsUtcMs;
    if (mo - o > 10 * MIN) add("modified_after_capture", "weakens", WEIGHTS.modifiedAfterCapture, { minutes: Math.round((mo - o) / MIN) });
  }
  if (meta.make && meta.model && meta.captureSettingCount >= 2) {
    add("camera_tags_present", "supports", WEIGHTS.cameraTags, { make: meta.make.slice(0, 40), model: meta.model.slice(0, 40) });
    if (meta.hasMakerNote) add("maker_note_present", "supports", WEIGHTS.makerNote);
  }

  // ---- time against the capture record
  const captured = meta.dateTimeOriginal ?? meta.dateTimeDigitized;
  const received = parseIso(ctx.serverReceivedAt);
  if (captured && received !== null) {
    const { ms, offsetKnown } = utcMs(captured);
    const earliestUtc = offsetKnown ? ms : ms - 14 * HOUR; // local time -> UTC when the zone is unknown
    const latestUtc = offsetKnown ? ms : ms + 12 * HOUR;
    if (earliestUtc > received + 5 * MIN) {
      add("capture_time_in_future", "weakens", WEIGHTS.captureTimeFuture);
    } else {
      const device = ctx.deviceTimeStatus === "ok" ? parseIso(ctx.deviceCapturedAt) : null;
      if (ctx.captureSource === "in_app_camera" && device !== null) {
        if (offsetKnown) {
          const delta = ms - device;
          if (Math.abs(delta) <= 2 * MIN) add("capture_time_matches_device", "supports", WEIGHTS.deviceTimeMatchExact);
          else if (Math.abs(delta) > 10 * MIN) add("capture_time_differs_from_device", "weakens", WEIGHTS.deviceTimeMismatch, { minutes: Math.round(Math.abs(delta) / MIN) });
        } else {
          const delta = ms - device; // equals the zone offset when the clocks agree
          const steps = Math.round(delta / (15 * MIN));
          const residual = Math.abs(delta - steps * 15 * MIN);
          const plausibleZone = steps >= -48 && steps <= 56;
          if (plausibleZone && residual <= 2 * MIN) add("capture_time_matches_device", "supports", WEIGHTS.deviceTimeMatchInferred, { zoneInferred: true });
          else if (!plausibleZone || residual > 10 * MIN) add("capture_time_differs_from_device", "weakens", WEIGHTS.deviceTimeMismatch, { minutes: Math.round(residual / MIN) });
        }
      }
      const jobStart = parseIso(ctx.job?.arrivedAt) ?? parseIso(ctx.job?.startedAt);
      if (jobStart !== null) {
        if (latestUtc < jobStart - DAY) {
          add("predates_job", "weakens", WEIGHTS.predatesJob, { days: Math.floor((jobStart - latestUtc) / DAY) });
        } else if (offsetKnown) {
          const end = parseIso(ctx.job?.completedAt) ?? received;
          if (ms >= jobStart - HOUR && ms <= end + HOUR) add("capture_time_in_job_window", "supports", WEIGHTS.inJobWindow);
        }
      }
    }
  }

  // ---- information only
  if (meta.hasGps) add("exif_gps_present", "info", 0);
  if (!meta.hasExif && !meta.hasXmp) add(ctx.captureSource === "in_app_camera" ? "no_metadata_expected_in_app" : "no_metadata", "info", 0);
  if (!meta.parsedCompletely) add("metadata_partially_read", "info", 0);

  const informative = reasons.filter((r) => r.weight !== 0).length;
  if (informative === 0) return { kind: "metadata_consistency", notAVerdict: true, confidence: null, level: "insufficient", reasons };

  const raw = BASE_SCORE + reasons.reduce((s, r) => s + r.weight, 0);
  const cap = validC2pa ? MAX_SCORE : MAX_SCORE_WITHOUT_VALID_C2PA;
  const confidence = Math.round(Math.min(cap, Math.max(MIN_SCORE, raw)));
  return { kind: "metadata_consistency", notAVerdict: true, confidence, level: level(confidence), reasons };
}
