// supabase/functions/_shared/compliance-rules/estimateDisclosureMatrix.ts
//
// COUNSEL WORKLIST, NOT LAW. One row per jurisdiction x requirement that counsel must decide for
// estimates/quotes. The rows say WHAT to decide and which engine rule kind will carry the answer.
// They never say what a state requires: that lives only in counsel-approved rule versions
// (compliance_rule_versions, status approved + legal reviewed), which the engine enforces.
//
// A row is "covered" when an approved, effective version of the matching kind exists for that
// jurisdiction (see matrixCoverage). Until then the quote PDF cannot add that clause and shows a
// "counsel review pending" warning instead.
//
// TODO(counsel): for every row confirm applicability, trade scope (`tradeScope` is null = not yet decided),
// thresholds and the exact customer-facing text; then author the rule version in Compliance -> Rule review.

import { selectEffective } from "./engine.ts";
import { US_STATES, STATE_NAMES } from "./jurisdiction.ts";
import type { RuleKind, RuleVersion, Surface } from "./types.ts";

export type EstimateRequirement = "written_estimate" | "cancellation_notice" | "license_on_contract";

export interface MatrixRow {
  jurisdiction: string; // "US-TX"
  requirement: EstimateRequirement;
  label: string;
  /** Engine rule kind that will carry counsel's answer. */
  engineKind: RuleKind;
  /** For required_notice rules: params.noticeId the rule must use. */
  noticeId: string | null;
  surfaces: Surface[];
  /** null = counsel has not decided which trades are in scope. */
  tradeScope: string[] | null;
  todo: string;
}

export const REQUIREMENT_DEFS: Record<EstimateRequirement, Pick<MatrixRow, "label" | "engineKind" | "noticeId" | "surfaces">> = {
  written_estimate: { label: "written estimate notice", engineKind: "required_notice", noticeId: "written-estimate", surfaces: ["quote"] },
  cancellation_notice: { label: "cancellation notice", engineKind: "rescission", noticeId: null, surfaces: ["quote", "contract"] },
  license_on_contract: { label: "license number display", engineKind: "license_display", noticeId: null, surfaces: ["quote", "contract"] },
};

export const REQUIREMENTS = Object.keys(REQUIREMENT_DEFS) as EstimateRequirement[];

function buildMatrix(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const st of [...US_STATES].sort()) {
    for (const requirement of REQUIREMENTS) {
      const d = REQUIREMENT_DEFS[requirement];
      rows.push({
        jurisdiction: `US-${st}`,
        requirement,
        ...d,
        tradeScope: null,
        todo: `TODO(counsel): ${STATE_NAMES[st] ?? st} - does a ${d.label} apply to estimates/contracts? Which trades, thresholds, exact text?`,
      });
    }
  }
  return rows;
}

export const ESTIMATE_DISCLOSURE_MATRIX: readonly MatrixRow[] = Object.freeze(buildMatrix());

export function rowsForJurisdiction(jurisdiction: string): MatrixRow[] {
  return ESTIMATE_DISCLOSURE_MATRIX.filter((r) => r.jurisdiction === jurisdiction);
}

export interface RowCoverage { row: MatrixRow; covered: boolean }

/** A row is covered only by an APPROVED, currently effective rule version of the right kind. */
export function matrixCoverage(versions: readonly RuleVersion[], dateKey: string, jurisdiction?: string): RowCoverage[] {
  const effective = selectEffective(versions, dateKey);
  const rows = jurisdiction ? rowsForJurisdiction(jurisdiction) : ESTIMATE_DISCLOSURE_MATRIX;
  return rows.map((row) => ({
    row,
    covered: effective.some((v) => {
      if (v.jurisdiction !== row.jurisdiction || v.kind !== row.engineKind) return false;
      if (!v.appliesTo.includes("quote")) return false;
      if (v.legalReviewed === false) return false;
      if (row.noticeId !== null) {
        const p = v.params as Record<string, unknown> | null;
        return !!p && p.noticeId === row.noticeId;
      }
      return true;
    }),
  }));
}
