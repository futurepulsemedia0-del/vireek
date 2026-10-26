// supabase/functions/_shared/messaging/optOut.ts
//
// Keyword consent handling shared by every inbound text-like channel (SMS, RCS, Apple
// Messages). The STOP list is the SAME one sms-webhook has always used, so an opt-out on
// any channel lands in the same dnc_suppressions table that sendCompliantSms() checks.
// Pure module: no I/O.

export const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
export const START_WORDS = new Set(["START", "UNSTOP"]);
export const HELP_WORDS = new Set(["HELP", "INFO"]);

export type ConsentKeyword = "stop" | "start" | "help";

/** Case/whitespace/punctuation-insensitive exact-word match, like carrier keyword handling. */
export function classifyKeyword(body: string | null | undefined): ConsentKeyword | null {
  const word = (body ?? "")
    .normalize("NFKC")
    .replace(/[\s\u200b-\u200d\ufeff]+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .toUpperCase();
  if (!word || word.includes(" ")) return null;
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (HELP_WORDS.has(word)) return "help";
  return null;
}

export function isStopKeyword(body: string | null | undefined): boolean {
  return classifyKeyword(body) === "stop";
}

export function optOutAckText(brand: string): string {
  return `${brand}: You're unsubscribed and won't receive more messages. Reply START to resubscribe.`;
}

export function optInAckText(brand: string): string {
  return `${brand}: You're resubscribed. Reply STOP at any time to opt out.`;
}

export function helpText(brand: string, phone?: string | null): string {
  return `${brand}: Reply STOP to opt out.${phone ? ` For help call ${phone}.` : ""}`;
}
