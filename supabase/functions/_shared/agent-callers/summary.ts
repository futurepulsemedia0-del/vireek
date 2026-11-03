// supabase/functions/_shared/agent-callers/summary.ts
// Pure: the machine-friendly post-call summary (SMS / email). Minimal data on purpose — business name, the quote,
// the offered/held window and a reference code. NEVER customer, technician or owner details, never internal cost.

import type { PriceShape } from "./protocol.ts";

export interface SummaryInput {
  businessName: string;
  currency: string;
  service: string | null;
  zip: string | null;
  price: PriceShape | null;
  tripFee: { known: boolean; cents: number | null };
  windows: { id: string; startIso: string; label: string }[];
  hold: { code: string; status: "held" | "auto_booked"; windowStartIso: string; expiresAtIso: string | null } | null;
}

const money = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));
const clean = (s: string, max: number) => s.replace(/[\r\n=|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Stable key=value lines: trivially parseable by another agent, readable by a person. */
export function buildSummaryLines(s: SummaryInput): string[] {
  const lines = [
    "VIREEK_QUOTE_V1",
    `business=${clean(s.businessName, 60)}`,
    `answered_by=ai_assistant`,
    `service=${clean(s.service ?? "", 80)}`,
    `zip=${s.zip ?? ""}`,
    `currency=${s.currency}`,
    `price_model=${s.price?.model ?? "none"}`,
    `price_min=${money(s.price?.minCents)}`,
    `price_max=${money(s.price?.maxCents)}`,
    `price_note=estimate_from_price_list_final_confirmed_on_site`,
    `trip_fee=${s.tripFee.known ? money(s.tripFee.cents) : "confirmed_at_booking"}`,
  ];
  for (const w of s.windows) lines.push(`window_${w.id}=${w.startIso}`);
  if (s.hold) {
    lines.push(`hold_ref=${s.hold.code}`, `hold_status=${s.hold.status === "held" ? "held_pending_confirmation" : "booked"}`, `hold_window=${s.hold.windowStartIso}`);
    if (s.hold.expiresAtIso) lines.push(`hold_expires=${s.hold.expiresAtIso}`);
  } else {
    lines.push("hold_status=none");
  }
  return lines;
}

/** SMS body: keep under ~320 chars (2 segments). Drops optional window lines first. */
export function buildSummarySms(s: SummaryInput): string {
  const head = `${clean(s.businessName, 40)} (AI assistant) quote: ${clean(s.service ?? "service", 40)}${s.zip ? ` ${s.zip}` : ""}.`;
  const price = s.price ? ` Price ${s.price.maxCents != null ? `${money(s.price.minCents)}-${money(s.price.maxCents)}` : `${s.price.model === "starting_at" ? "from " : ""}${money(s.price.minCents)}`} ${s.currency}.` : "";
  const fee = ` Trip fee ${s.tripFee.known ? money(s.tripFee.cents) : "confirmed at booking"}.`;
  const hold = s.hold ? ` Ref ${s.hold.code} ${s.hold.status === "held" ? "(held, pending confirmation)" : "(booked)"} ${s.hold.windowStartIso}.` : "";
  let body = head + price + fee + hold;
  if (!s.hold && s.windows[0]) body += ` Next opening ${s.windows[0].startIso}.`;
  return body.slice(0, 320);
}

export function buildSummaryEmail(s: SummaryInput): { subject: string; text: string; html: string } {
  const lines = buildSummaryLines(s);
  const text = `${lines.join("\n")}\n`;
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  return { subject: `Quote from ${clean(s.businessName, 60)}${s.hold ? ` — ref ${s.hold.code}` : ""}`, text, html: `<pre style="font-family:monospace">${esc(text)}</pre>` };
}

/** Unambiguous alphabet (no 0/O/1/I/L). 6 chars ≈ 30^6 = 7×10^8 codes; uniqueness is enforced by a DB unique index. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function makeHoldCode(random: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[random[i] % ALPHABET.length];
  return out;
}
