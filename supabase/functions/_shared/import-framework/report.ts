// supabase/functions/_shared/import-framework/report.ts
// Builds the validation / run report. Samples are capped and carry NO source values (PII minimisation).

import type { Counters, EntityCounters, Issue, Values } from "./types.ts";

export interface SampleIssue { entity: string; position: number; sourceKey: string | null; severity: Issue["severity"]; code: string; field?: string; message: string }
export interface EntityReport extends EntityCounters {
  issueCounts: Record<string, number>;
  sums: Record<string, number>;
}
export interface ValidationReport {
  schemaVersion: 1;
  generatedAt: string;
  adapter: { id: string; version: string };
  scopeKey: string;
  sourceFingerprint: string;
  mappingHash: string;
  mode: "dry_run" | "commit";
  complete: boolean;
  mappingIssues: Issue[];
  entities: Record<string, EntityReport>;
  totals: EntityCounters;
  samples: SampleIssue[];
  samplesTruncated: boolean;
  canCommit: boolean;
  blockers: string[];
}

export const emptyCounters = (): EntityCounters => ({ rows: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, warnings: 0 });

export class ReportBuilder {
  readonly counters: Counters;
  private issueCounts: Record<string, Record<string, number>> = {};
  private sums: Record<string, Record<string, number>> = {};
  readonly samples: SampleIssue[] = [];
  samplesTruncated = false;
  constructor(initial: Counters, private readonly limit: number) {
    this.counters = JSON.parse(JSON.stringify(initial)) as Counters;
  }
  private c(entity: string): EntityCounters { return (this.counters[entity] ??= emptyCounters()); }
  row(entity: string, outcome: "created" | "updated" | "unchanged" | "skipped" | "errors", position: number, key: string | null, issues: Issue[], values?: Values, summable?: string[]): void {
    const c = this.c(entity);
    c.rows++; c[outcome]++;
    if (issues.some((i) => i.severity === "warning")) c.warnings++;
    const counts = (this.issueCounts[entity] ??= {});
    for (const i of issues) {
      counts[i.code] = (counts[i.code] ?? 0) + 1;
      if (i.severity === "info") continue;
      if (this.samples.length < this.limit) this.samples.push({ entity, position, sourceKey: key, severity: i.severity, code: i.code, ...(i.field ? { field: i.field } : {}), message: i.message });
      else this.samplesTruncated = true;
    }
    if (values && summable && outcome !== "errors" && outcome !== "skipped") {
      const s = (this.sums[entity] ??= {});
      for (const f of summable) if (typeof values[f] === "number") s[f] = (s[f] ?? 0) + (values[f] as number);
    }
  }
  totals(): EntityCounters {
    const t = emptyCounters();
    for (const c of Object.values(this.counters)) for (const k of Object.keys(t) as (keyof EntityCounters)[]) t[k] += c[k];
    return t;
  }
  entityReports(): Record<string, EntityReport> {
    const out: Record<string, EntityReport> = {};
    for (const [e, c] of Object.entries(this.counters)) {
      const sums: Record<string, number> = {};
      for (const [f, v] of Object.entries(this.sums[e] ?? {})) sums[f] = Math.round(v * 100) / 100;
      out[e] = { ...c, issueCounts: this.issueCounts[e] ?? {}, sums };
    }
    return out;
  }
}
