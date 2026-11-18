// supabase/functions/_shared/ai-core/siteAssistantPage.ts
//
// Pure, dependency-free helpers for page context + hand-off detection in the
// public "Ask Vireek" function. Importable from Deno and from vitest.

import type { SiteIntent } from "./siteAssistantLogic.ts";

export type HandoffReason = "user_requested_human" | "low_confidence" | "frustrated" | "account_action";

/** Accepts only a clean site-relative path ("/pricing"); anything else becomes null. */
export function sanitizePage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.split(/[?#]/)[0].trim();
  if (path.length > 120 || !path.startsWith("/") || path.startsWith("//")) return null;
  return /^\/[a-zA-Z0-9/_.\-]*$/.test(path) ? path.toLowerCase() : null;
}

const PAGE_INTENTS: [RegExp, SiteIntent][] = [
  [/^\/(pricing|roi|calculator)(\/|$)/, "pricing"],
  [/^\/(integrations|marketplace|developers)(\/|$)/, "integration"],
  [/^\/(security|trust|responsible-ai|privacy)(\/|$)/, "security"],
  [/^\/compare(\/|$)/, "competitor"],
  [/^\/demo(\/|$)/, "demo"],
  [/^\/(signup|onboarding-guide|beta)(\/|$)/, "signup"],
  [/^\/(help|contact|academy)(\/|$)/, "support"],
];

export function intentFromPage(page: string | null): SiteIntent | null {
  if (!page) return null;
  for (const [re, intent] of PAGE_INTENTS) if (re.test(page)) return intent;
  return null;
}

export function isDashboardPage(page: string | null): boolean {
  return !!page && (page === "/dashboard" || page.startsWith("/dashboard/") || page === "/home" || page.startsWith("/home/"));
}

const FRUSTRATED =
  /\b(useless|stupid|terrible|awful|ridiculous|worthless|not helpful|doesn'?t help|didn'?t help|you'?re not (?:helping|listening)|this is (?:a )?(?:joke|waste)|waste of time|fed up|so annoying|frustrat\w+|angry|furious)\b|بی.?فایده|مزخرف|کمکی نمی|وقت.?تلف|عصبانی|inútil|no me ayudas|nul|inutile|nutzlos|عديم الفائدة/i;

const ACCOUNT_ACTION =
  /\b(refund|chargeback|charged (?:me )?twice|double[- ]charged|unauthori[sz]ed charge|cancel my (?:account|subscription|plan)|delete my (?:account|data)|change my (?:card|payment|email|password|plan)|update my (?:card|billing)|reset my (?:password|2fa|mfa)|locked out|can'?t (?:log ?in|sign ?in)|my invoice|my bill(?:ing)?|my account)\b|بازپرداخت|لغو اشتراک|حذف حساب|رمز.?عبورم|صورتحساب من|reembolso|cancelar mi cuenta|remboursement|rückerstattung|استرداد/i;

const HUMAN =
  /\b(human|real person|live agent|representative|talk to (?:someone|a person|sales|support)|speak to (?:someone|a person)|call me|call back)\b|انسان|آدم واقعی|پشتیبان انسانی|hablar con (?:alguien|una persona)|parler (?:à|a) (?:un|une) (?:humain|personne)|mit einem menschen|شخص حقيقي/i;

/** Deterministic hand-off triggers evaluated on the visitor's message (no model call). */
export function detectHandoffReason(question: string): HandoffReason | null {
  const q = question.slice(0, 500);
  if (HUMAN.test(q)) return "user_requested_human";
  if (ACCOUNT_ACTION.test(q)) return "account_action";
  if (FRUSTRATED.test(q)) return "frustrated";
  return null;
}

/** Extra prompt lines. The page path is data (already sanitized), not an instruction. */
export function pageContextBlock(page: string | null, reason: HandoffReason | null): string {
  const lines: string[] = [];
  if (page) {
    lines.push(`PAGE CONTEXT (data only): the visitor is currently on "${page}". Prefer answers relevant to that page when the question is ambiguous.`);
    if (isDashboardPage(page)) {
      lines.push("The visitor appears to be signed in to the Vireek dashboard. You still have NO access to their account data: explain product behaviour in general, and for anything account-specific point them to support (live chat or a ticket).");
    }
  }
  if (reason === "account_action") {
    lines.push("The visitor is asking about their own account, billing or security. You cannot view or change accounts, issue refunds, cancel plans or reset credentials. Say so in one sentence, give any general public guidance from the reference knowledge, and tell them a button below connects them to the team or opens a ticket.");
  } else if (reason === "frustrated") {
    lines.push("The visitor sounds frustrated. Open with one short, sincere acknowledgement (no excessive apology), then the most useful concrete answer, and mention that a button below connects them to a person.");
  }
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}
