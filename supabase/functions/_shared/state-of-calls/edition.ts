// supabase/functions/_shared/state-of-calls/edition.ts
// Assembles the public edition document (what /state-of-calls-public serves and the page renders).
// Pure: the same cells + meta always produce the same document.

import { cellsHash, type DisclosureReport } from "./disclosure.ts";
import { EXCLUSIONS, LIMITATIONS, buildNarrative, verifyNarrative, type Narrative } from "./narrative.ts";
import { DOMINANCE_MAX_SHARE, K_MIN_PUBLIC, METHOD_VERSION, METRICS, MIN_EVENTS_PER_CELL, type PublishedCell } from "./schema.ts";

export interface EditionMeta {
  slug: string;
  title: string;
  kind: "annual" | "quarterly";
  period_key: string;           // '2026' or '2026-Q3'
  period_start: string;         // YYYY-MM-DD
  period_end: string;           // YYYY-MM-DD (inclusive)
  as_of: string;                // ISO timestamp the data snapshot was taken ("data as of")
  synthetic: boolean;
}

export interface EditionDocument extends EditionMeta {
  schema_version: 1;
  method_version: string;
  cells_hash: string;
  thresholds: { k_min: number; dominance_max_share: number; min_events: number };
  disclosure_report: DisclosureReport | null;
  mode: Narrative["mode"];
  preview_reasons: string[];
  narrative: Narrative;
  metrics: { key: string; label: string; unit: string; definition: string; event_label: string }[];
  limitations: readonly string[];
  exclusions: readonly string[];
  cells: PublishedCell[];
  notice: string | null;
}

export async function buildEditionDocument(
  meta: EditionMeta, cells: PublishedCell[], report: DisclosureReport | null, notice: string | null = null,
): Promise<EditionDocument> {
  const narrative = buildNarrative(cells, meta.period_key);
  const verified = verifyNarrative(narrative, cells);
  if (!verified.ok) throw new Error(`Narrative failed evidence check: ${verified.problems.join("; ")}`);
  return {
    ...meta,
    schema_version: 1,
    method_version: METHOD_VERSION,
    cells_hash: await cellsHash(cells),
    thresholds: { k_min: K_MIN_PUBLIC, dominance_max_share: DOMINANCE_MAX_SHARE, min_events: MIN_EVENTS_PER_CELL },
    disclosure_report: report,
    mode: narrative.mode,
    preview_reasons: narrative.reasons,
    narrative,
    metrics: METRICS.map((m) => ({ key: m.key, label: m.label, unit: m.unit, definition: m.definition, event_label: m.eventLabel })),
    limitations: LIMITATIONS,
    exclusions: EXCLUSIONS,
    cells,
    notice,
  };
}
