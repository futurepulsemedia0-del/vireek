// supabase/functions/_shared/win-cards/types.ts
// Pure, runtime-agnostic (Deno + Node/Vitest). No imports on purpose.

export const TRIGGER_TYPES = [
  "after_hours_booking",
  "emergency_handled",
  "recovered_large_job",
  "milestone_calls",
  "speed_to_lead_record",
  "five_star_ai_job",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export function isTriggerType(v: unknown): v is TriggerType {
  return typeof v === "string" && (TRIGGER_TYPES as readonly string[]).includes(v);
}

/** How trustworthy the dollar figure is. Drives the public wording ("Over $X" vs "Estimated $X–$Y"). */
export type ValueBasis = "collected" | "invoiced" | "estimate";

/**
 * OWNER-ONLY facts captured when the event is detected. Stored in win_cards.private_facts.
 * Nothing in here is ever returned by the public endpoint; it is used (a) to render the owner's
 * preview and (b) as the deny-list the PII scanner checks every public string against.
 */
export interface PrivateFacts {
  trigger: TriggerType;
  occurredAt: string; // ISO-8601
  valueCents?: number;
  valueBasis?: ValueBasis;
  milestone?: number; // milestone_calls
  responseMs?: number; // speed_to_lead_record
  previousBestMs?: number | null;
  /** Anything that identifies a person/place and must never reach a public string. */
  pii: string[];
}

export type Theme = "light" | "dark";
export type CardFormat = "square" | "og" | "story";

/** What the owner chose to show. Everything defaults to the most private option. */
export interface Selection {
  showValue: boolean;
  showTimeBucket: boolean;
  showMonth: boolean;
  showBusinessName: boolean;
  showCta: boolean;
  serviceLabel: string | null; // short owner-typed label, scanned for PII
  caption: string | null;
}

export const DEFAULT_SELECTION: Selection = {
  showValue: false,
  showTimeBucket: false,
  showMonth: false,
  showBusinessName: false,
  showCta: true,
  serviceLabel: null,
  caption: null,
};

/** Exactly what becomes public. Frozen into win_cards.public_fields at approval. */
export interface PublicFields {
  v: 1;
  trigger: TriggerType;
  headline: string;
  detail: string | null;
  valueText: string | null;
  valueIsEstimate: boolean;
  timeBucketText: string | null;
  serviceText: string | null;
  monthText: string | null;
  businessName: string | null;
  showCta: boolean;
  disclaimer: string | null;
  caption: string | null;
}

export interface CardSettings {
  timezone: string;
  businessHoursStart: number;
  businessHoursEnd: number;
  largeJobThresholdCents: number;
}

export const DEFAULT_CARD_SETTINGS: CardSettings = {
  timezone: "America/New_York",
  businessHoursStart: 8,
  businessHoursEnd: 18,
  largeJobThresholdCents: 200_000,
};
