// supabase/functions/_shared/quote-ar/engine.ts
//
// Pure rules for the AR Product Visualizer. No Deno / DOM / network access on
// purpose: the edge function, the React app (src/lib/quoteAr.ts) and the
// Vitest suite all import this one file, so limits and validation can never
// drift apart.

export const QUOTE_AR_BUCKET = "quote-ar-models";
export const MAX_MODEL_BYTES = 40 * 1024 * 1024;
export const MAX_MODELS_PER_ACCOUNT = 200;
export const MAX_PREVIEWS_PER_QUOTE = 6;
export const SIGNED_URL_TTL_SECONDS = 1800;

/** Real-world size limits, millimetres. Mirrors the CHECK constraints in SQL. */
export const MIN_DIMENSION_MM = 10;
export const MAX_DIMENSION_MM = 6000;
export const MAX_CLEARANCE_MM = 3000;
/** Declared vs. measured model size may differ by this much before we warn. */
export const SCALE_TOLERANCE = 0.08;

export const GLB_MIME = "model/gltf-binary";
export const USDZ_MIME = "model/vnd.usdz+zip";

export const AR_CATEGORIES = [
  "furnace",
  "air_conditioner",
  "heat_pump",
  "air_handler",
  "mini_split",
  "water_heater",
  "tankless_water_heater",
  "boiler",
  "thermostat",
  "electrical_panel",
  "generator",
  "ev_charger",
  "other",
] as const;
export type ArCategory = (typeof AR_CATEGORIES)[number];

export const AR_CATEGORY_LABELS: Record<ArCategory, string> = {
  furnace: "Furnace",
  air_conditioner: "Air conditioner",
  heat_pump: "Heat pump",
  air_handler: "Air handler",
  mini_split: "Mini-split",
  water_heater: "Water heater",
  tankless_water_heater: "Tankless water heater",
  boiler: "Boiler",
  thermostat: "Thermostat",
  electrical_panel: "Electrical panel",
  generator: "Generator",
  ev_charger: "EV charger",
  other: "Other equipment",
};

export const AR_PLACEMENTS = ["floor", "wall"] as const;
export type ArPlacement = (typeof AR_PLACEMENTS)[number];

export const AR_EVENTS = ["viewed", "ar_launched", "ar_unsupported", "ar_failed"] as const;
export type ArEvent = (typeof AR_EVENTS)[number];

export const AR_PLATFORMS = ["ios", "android", "desktop", "other"] as const;
export type ArPlatform = (typeof AR_PLATFORMS)[number];

export type ArUnit = "in" | "cm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isArCategory(value: unknown): value is ArCategory {
  return typeof value === "string" && (AR_CATEGORIES as readonly string[]).includes(value);
}

export function isArPlacement(value: unknown): value is ArPlacement {
  return typeof value === "string" && (AR_PLACEMENTS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------
// Uploads
// ------------------------------------------------------------------

export type ModelKind = "glb" | "usdz";

export interface FileInfo {
  fileName: string;
  sizeBytes: number;
}

export type ModelFileCheck =
  | { ok: true }
  | { ok: false; code: "GLB_REQUIRED" | "GLB_TYPE" | "USDZ_TYPE" | "FILE_EMPTY" | "FILE_TOO_LARGE" };

function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i < 0 ? "" : fileName.slice(i + 1).toLowerCase();
}

/** Both files are validated by extension (browsers report GLB/USDZ MIME types inconsistently). */
export function validateModelFiles(glb: FileInfo | null, usdz: FileInfo | null): ModelFileCheck {
  if (!glb) return { ok: false, code: "GLB_REQUIRED" };
  if (extensionOf(glb.fileName) !== "glb") return { ok: false, code: "GLB_TYPE" };
  if (!Number.isFinite(glb.sizeBytes) || glb.sizeBytes < 1) return { ok: false, code: "FILE_EMPTY" };
  if (glb.sizeBytes > MAX_MODEL_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  if (usdz) {
    if (extensionOf(usdz.fileName) !== "usdz") return { ok: false, code: "USDZ_TYPE" };
    if (!Number.isFinite(usdz.sizeBytes) || usdz.sizeBytes < 1) return { ok: false, code: "FILE_EMPTY" };
    if (usdz.sizeBytes > MAX_MODEL_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  }
  return { ok: true };
}

/** `<ownerId>/<fileId>.glb|usdz` - the exact shape the SQL path check accepts. */
export function buildModelPath(ownerId: string, fileId: string, kind: ModelKind): string {
  const safeId = fileId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "model";
  return `${ownerId}/${safeId}.${kind}`;
}

export function mimeForKind(kind: ModelKind): string {
  return kind === "glb" ? GLB_MIME : USDZ_MIME;
}

export interface Dimensions {
  widthMm: number;
  depthMm: number;
  heightMm: number;
}

export type DimensionCheck = { ok: true } | { ok: false; code: "INVALID_DIMENSIONS" | "INVALID_CLEARANCE" };

export function validateDimensions(d: Dimensions, clearanceMm = 0): DimensionCheck {
  for (const v of [d.widthMm, d.depthMm, d.heightMm]) {
    if (!Number.isInteger(v) || v < MIN_DIMENSION_MM || v > MAX_DIMENSION_MM) {
      return { ok: false, code: "INVALID_DIMENSIONS" };
    }
  }
  if (!Number.isInteger(clearanceMm) || clearanceMm < 0 || clearanceMm > MAX_CLEARANCE_MM) {
    return { ok: false, code: "INVALID_CLEARANCE" };
  }
  return { ok: true };
}

// ------------------------------------------------------------------
// Units
// ------------------------------------------------------------------

export function inchesToMm(inches: number): number {
  return Math.round(inches * 25.4);
}

export function cmToMm(cm: number): number {
  return Math.round(cm * 10);
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export function formatLength(mm: number, unit: ArUnit): string {
  if (!Number.isFinite(mm)) return "-";
  return unit === "in" ? `${trimNumber(Math.round((mm / 25.4) * 10) / 10)} in` : `${trimNumber(Math.round(mm) / 10)} cm`;
}

/** "W 24 in × D 28 in × H 54 in" */
export function formatDimensions(d: Dimensions, unit: ArUnit): string {
  return `W ${formatLength(d.widthMm, unit)} × D ${formatLength(d.depthMm, unit)} × H ${formatLength(d.heightMm, unit)}`;
}

// ------------------------------------------------------------------
// Scale check: the failure mode that ruins an AR visualizer is a model
// exported at the wrong scale (mm vs m). Compare sorted extents so a rotated
// model still passes.
// ------------------------------------------------------------------

export interface ScaleCheck {
  ok: boolean;
  /** Worst relative difference across the three sorted extents (0 = identical). */
  worstDelta: number;
}

export function compareScale(declared: Dimensions, measured: Dimensions, tolerance = SCALE_TOLERANCE): ScaleCheck {
  const a = [declared.widthMm, declared.depthMm, declared.heightMm].sort((x, y) => x - y);
  const b = [measured.widthMm, measured.depthMm, measured.heightMm].sort((x, y) => x - y);
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    if (!(a[i] > 0) || !Number.isFinite(b[i])) return { ok: false, worstDelta: Infinity };
    worst = Math.max(worst, Math.abs(b[i] - a[i]) / a[i]);
  }
  return { ok: worst <= tolerance, worstDelta: worst };
}

/** glTF is metres; model-viewer's getDimensions() returns metres. */
export function metersToDimensions(x: number, y: number, z: number): Dimensions {
  return { widthMm: Math.round(x * 1000), depthMm: Math.round(z * 1000), heightMm: Math.round(y * 1000) };
}

// ------------------------------------------------------------------
// Platform + events
// ------------------------------------------------------------------

export function detectPlatform(userAgent: string, maxTouchPoints = 0): ArPlatform {
  const ua = userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  // iPadOS 13+ identifies as a Mac but has a touch screen.
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return "desktop";
  return "other";
}

export type ParsedEvent =
  | { ok: true; previewId: string; event: ArEvent; platform: ArPlatform | null }
  | { ok: false; error: "INVALID_EVENT" | "NOT_FOUND" };

export function parseEventBody(body: Record<string, unknown> | null): ParsedEvent {
  if (!body || !isUuid(body.preview_id)) return { ok: false, error: "NOT_FOUND" };
  const event = body.event;
  if (typeof event !== "string" || !(AR_EVENTS as readonly string[]).includes(event)) {
    return { ok: false, error: "INVALID_EVENT" };
  }
  const platform =
    typeof body.platform === "string" && (AR_PLATFORMS as readonly string[]).includes(body.platform)
      ? (body.platform as ArPlatform)
      : null;
  return { ok: true, previewId: body.preview_id, event: event as ArEvent, platform };
}

// ------------------------------------------------------------------
// Option scoping
// ------------------------------------------------------------------

/** A preview with no option shows for every option; otherwise only for that option. */
export function previewMatchesOption(previewOptionId: string | null, selectedOptionId: string | null): boolean {
  return previewOptionId === null || previewOptionId === selectedOptionId;
}
