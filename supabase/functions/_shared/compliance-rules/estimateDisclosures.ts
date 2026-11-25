// supabase/functions/_shared/compliance-rules/estimateDisclosures.ts
//
// Pure: builds the required clauses, license lines and missing-field warnings for a quote/estimate
// from the SAME engine and the SAME counsel-approved rule versions the rest of Vireek enforces.
// Invents no legal text: a clause is rendered only if an approved rule supplies customer-facing text,
// and placeholder text ("TODO(...)") is never rendered.
//
// NOT LEGAL ADVICE.

import { evaluate } from "./engine.ts";
import { STATE_NAMES, normalizeState, resolveCounterpartyState, type ResolvedState } from "./jurisdiction.ts";
import { matrixCoverage } from "./estimateDisclosureMatrix.ts";
import type { BusinessLicense, RuleVersion, SaleLocation } from "./types.ts";

export interface QuoteDisclosureInput {
  rules: readonly RuleVersion[];
  businessState: string | null;
  licenses: BusinessLicense[];
  serviceAddress: { line1?: string | null; city?: string | null; state?: string | null; postal_code?: string | null } | null;
  customerPhone: string | null;
  /** Largest option total (conservative for thresholds). undefined = unknown. */
  totalCents?: number;
  depositCents?: number;
  saleLocation?: SaleLocation;
  at?: Date;
}

export interface DisclosureClause { id: string; title: string; text: string; sources: string[] }

export type DisclosureWarningCode =
  | "service_state_unknown"
  | "service_state_from_phone"
  | "business_state_missing"
  | "license_missing"
  | "license_expired"
  | "counsel_review_pending"
  | "rule_text_missing"
  | "rule_text_placeholder"
  | "deposit_limit"
  | "sale_location_assumed"
  | "rules_unavailable";

export interface DisclosureWarning { code: DisclosureWarningCode; message: string }

export interface QuoteDisclosures {
  jurisdiction: string | null;
  stateBasis: ResolvedState["basis"];
  clauses: DisclosureClause[];
  licenseLines: string[];
  warnings: DisclosureWarning[];
  appliedVersionIds: string[];
  evaluatedAt: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const PLACEHOLDER = /TODO\s*\(/i;

/** Same match the engine's license_display rule uses (state + non-empty number + optional trade filter). */
function matchingLicense(licenses: BusinessLicense[], state: string, trades: string[] | null): BusinessLicense | undefined {
  return licenses.find(
    (l) => normalizeState(l.state) === state && l.number.trim() && (!trades || (l.trade && trades.includes(l.trade))),
  );
}

export function unavailableDisclosures(message: string, at: Date = new Date()): QuoteDisclosures {
  return {
    jurisdiction: null, stateBasis: "unknown", clauses: [], licenseLines: [],
    warnings: [{ code: "rules_unavailable", message }], appliedVersionIds: [], evaluatedAt: at.toISOString(),
  };
}

export function buildQuoteDisclosures(input: QuoteDisclosureInput): QuoteDisclosures {
  const at = input.at ?? new Date();
  const warnings: DisclosureWarning[] = [];
  const clauses: DisclosureClause[] = [];
  const licenseLines: string[] = [];
  const seen = new Set<string>();
  const byId = new Map(input.rules.map((v) => [v.id, v]));

  const addr = input.serviceAddress;
  const addressText = addr ? [addr.line1, addr.city, addr.state, addr.postal_code].filter(Boolean).join(", ") : null;
  const resolved = resolveCounterpartyState({ explicitState: addr?.state ?? null, address: addressText, phone: input.customerPhone });
  const business = normalizeState(input.businessState);

  if (resolved.state === null) {
    warnings.push({ code: "service_state_unknown", message: "Job state unknown: add a service address with a state so state-specific notices can be added to this quote." });
  } else if (resolved.basis === "phone") {
    warnings.push({ code: "service_state_from_phone", message: `Job state (${resolved.state}) was guessed from the phone area code and may be wrong: confirm the service address.` });
  }
  if (business === null) {
    warnings.push({ code: "business_state_missing", message: "Business state not set: set it in Compliance → Business profile." });
  }

  const result = evaluate(
    {
      surface: "quote",
      at,
      businessState: business,
      counterpartyState: resolved.state,
      counterpartyStateBasis: resolved.basis,
      licenses: input.licenses,
      document: {
        totalCents: input.totalCents,
        depositCents: input.depositCents,
        saleLocation: input.saleLocation,
        licenseNumberShown: false,
        cancellationNoticePresent: false,
        noticesPresent: [],
      },
    },
    input.rules,
  );

  // 1) Customer-facing clauses: only text that an approved rule explicitly supplies.
  for (const a of result.actions) {
    if (a.type !== "add_notice") continue;
    const v = byId.get(a.versionId);
    if (!v) continue;
    const p = v.params as Record<string, unknown>;
    const text = v.kind === "required_notice" ? str(p.text) : v.kind === "rescission" ? str(p.noticeText) : null;
    if (!text) {
      warnings.push({ code: "rule_text_missing", message: `Rule "${v.title}" (${v.jurisdiction}) has no customer-facing notice text, so nothing was added. Ask compliance to add it.` });
      continue;
    }
    if (PLACEHOLDER.test(text)) {
      warnings.push({ code: "rule_text_placeholder", message: `Rule "${v.title}" (${v.jurisdiction}) still contains placeholder text, so it was not added. Counsel must supply the final wording.` });
      continue;
    }
    const id = str(p.noticeId) ?? `${v.ruleKey}@${v.jurisdiction}`;
    if (seen.has(id)) continue;
    seen.add(id);
    clauses.push({ id, title: v.title, text, sources: v.sourceRefs.map((s) => s.citation).filter(Boolean) });
  }

  // 2) License lines + license warnings.
  for (const f of result.findings) {
    if (f.kind !== "license_display") continue;
    const v = byId.get(f.versionId);
    if (!v) continue;
    const st = normalizeState(v.jurisdiction.replace(/^US-/, ""));
    if (!st) continue;
    const p = v.params as Record<string, unknown>;
    const trades = Array.isArray(p.trades) ? (p.trades as unknown[]).filter((t): t is string => typeof t === "string") : null;
    const label = str(p.licenseLabel) ?? "License";
    if (f.status === "fail") {
      const anyLicense = matchingLicense(input.licenses, st, trades);
      warnings.push(anyLicense
        ? { code: "license_expired", message: `The ${STATE_NAMES[st] ?? st} ${label} on file is expired: renew it and update your business profile.` }
        : { code: "license_missing", message: `No ${STATE_NAMES[st] ?? st} ${label} on file: add it in Compliance → Business profile so it can appear on this quote.` });
      continue;
    }
    const lic = matchingLicense(input.licenses, st, trades);
    if (lic && (f.status === "pass" || f.status === "action")) {
      const line = `${label} ${lic.number.trim()}`;
      if (!licenseLines.includes(line)) licenseLines.push(line);
    }
  }

  // 3) Other advisory findings worth surfacing on a quote.
  for (const f of result.findings) {
    if (f.kind === "deposit_limit" && (f.status === "fail" || f.status === "action")) warnings.push({ code: "deposit_limit", message: f.message });
  }
  for (const a of result.assumptions) {
    if (a.startsWith("Sale location")) warnings.push({ code: "sale_location_assumed", message: "Sale location not set: cancellation-notice rules were applied conservatively (assumed they apply)." });
  }

  // 4) Counsel coverage: what we could not add automatically because no approved rule exists yet.
  if (resolved.state !== null) {
    const dateKey = result.effectiveDate;
    const missing = matrixCoverage(input.rules, dateKey, `US-${resolved.state}`).filter((c) => !c.covered).map((c) => c.row.label);
    if (missing.length > 0) {
      warnings.push({
        code: "counsel_review_pending",
        message: `No counsel-approved rule yet for ${STATE_NAMES[resolved.state] ?? resolved.state}: ${missing.join(", ")}. Required notices for this state cannot be added automatically.`,
      });
    }
  }

  return {
    jurisdiction: resolved.state ? `US-${resolved.state}` : null,
    stateBasis: resolved.basis,
    clauses, licenseLines, warnings,
    appliedVersionIds: result.appliedVersionIds,
    evaluatedAt: result.evaluatedAt,
  };
}
