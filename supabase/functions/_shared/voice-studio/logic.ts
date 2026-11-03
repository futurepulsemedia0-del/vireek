// Pure logic shared by browser and edge function => preview/production parity.
export const SCENARIOS = ["default", "emergency", "sales"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface Pronunciation { match: string; say: string }
export interface Tuning {
  speed: number; warmth: number; pauseMs: number;
  formality: "casual" | "neutral" | "formal";
  fillers: boolean;
  pronunciations: Pronunciation[];
}

export const LIMITS = { maxPronunciations: 50, maxMatch: 60, maxSay: 80, maxText: 600 } as const;
export const DEFAULT_TUNING: Tuning = { speed: 1, warmth: 0.5, pauseMs: 200, formality: "neutral", fillers: false, pronunciations: [] };

export const SCENARIO_PRESETS: Record<Scenario, Partial<Tuning>> = {
  default: {},
  emergency: { speed: 0.9, warmth: 0.35, pauseMs: 350, formality: "neutral", fillers: false },
  sales: { speed: 1.05, warmth: 0.8, pauseMs: 150, formality: "casual" },
};

const clamp = (n: unknown, lo: number, hi: number, fb: number): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fb;
  return Math.min(hi, Math.max(lo, v));
};

export function isScenario(v: unknown): v is Scenario {
  return typeof v === "string" && (SCENARIOS as readonly string[]).includes(v);
}

/** Never throws; always returns a safe, in-range Tuning. */
export function sanitizeTuning(input: unknown): Tuning {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const formality = o.formality === "casual" || o.formality === "formal" ? o.formality : "neutral";
  const raw = Array.isArray(o.pronunciations) ? o.pronunciations : [];
  const pronunciations: Pronunciation[] = [];
  for (const p of raw) {
    if (pronunciations.length >= LIMITS.maxPronunciations) break;
    if (!p || typeof p !== "object") continue;
    const m = String((p as Pronunciation).match ?? "").trim().slice(0, LIMITS.maxMatch);
    const s = String((p as Pronunciation).say ?? "").replace(/[<>&]/g, "").trim().slice(0, LIMITS.maxSay);
    if (m && s) pronunciations.push({ match: m, say: s });
  }
  return {
    speed: clamp(o.speed, 0.7, 1.2, 1),
    warmth: clamp(o.warmth, 0, 1, 0.5),
    pauseMs: Math.round(clamp(o.pauseMs, 0, 800, 200)),
    formality,
    fillers: o.fillers === true,
    pronunciations,
  };
}

export function tuningForScenario(base: unknown, scenario: Scenario, variant?: unknown): Tuning {
  if (variant) return sanitizeTuning(variant);
  return sanitizeTuning({ ...sanitizeTuning(base), ...SCENARIO_PRESETS[scenario] });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive, longest match first, single pass (no re-substitution). */
export function applyPronunciations(text: string, list: Pronunciation[]): string {
  const clean = list.filter((p) => p.match && p.say);
  if (!clean.length) return text;
  const byKey = new Map(clean.map((p) => [p.match.toLowerCase(), p.say]));
  const alt = [...byKey.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "giu");
  return text.replace(re, (m) => byKey.get(m.toLowerCase()) ?? m);
}

/** Text actually sent to the TTS provider. */
export function prepareSpeechText(text: string, t: Tuning): string {
  let out = applyPronunciations(text.slice(0, LIMITS.maxText), t.pronunciations);
  if (t.pauseMs >= 300) out = out.replace(/([.!?])\s+/g, "$1 ... ");
  return out.trim();
}

export function toProviderSettings(t: Tuning) {
  return {
    stability: Math.round((0.75 - t.warmth * 0.35) * 100) / 100,
    similarity_boost: 0.8,
    style: Math.round(t.warmth * 0.6 * 100) / 100,
    use_speaker_boost: true,
    speed: t.speed,
  };
}

export function estimateCostCents(chars: number, centsPer1kChars: number): number {
  return Math.max(0, Math.round((chars / 1000) * centsPer1kChars * 100) / 100);
}

/** RMS-normalize with a peak ceiling. Silence stays silence. */
export function normalizeSamples(x: Float32Array, targetRms = 0.1, peakCeiling = 0.98): Float32Array {
  let sum = 0, peak = 0;
  for (let i = 0; i < x.length; i++) { sum += x[i] * x[i]; peak = Math.max(peak, Math.abs(x[i])); }
  const rms = Math.sqrt(sum / (x.length || 1));
  if (rms < 1e-6 || peak < 1e-6) return Float32Array.from(x);
  const gain = Math.min(targetRms / rms, peakCeiling / peak);
  return Float32Array.from(x, (v) => v * gain);
}
