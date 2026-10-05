// supabase/functions/_shared/verification-network/socrata.ts
//
// Generic primary-source adapter for any licensing board that publishes its roll through a
// Socrata (SODA) open-data portal. Which board / dataset / columns to use is DATA, stored in
// verification_sources.config - nothing about a specific state is hard-coded here.
//
// config = {
//   domain: "data.example.gov", dataset_id: "abcd-1234",
//   fields: { license_number, holder_name, status, expires_on?, classification?, disciplinary? },
//   status_map: { active: ["Active"], expired: [...], suspended: [...], revoked: [...], inactive: [...] },
//   disciplinary_truthy?: ["yes","y","true","1"]
// }

import { parseDate, type NormalizedRecord, type StatusMap } from "./engine.ts";

export interface SocrataConfig {
  domain: string;
  dataset_id: string;
  fields: {
    license_number: string; holder_name: string; status: string;
    expires_on?: string; classification?: string; disciplinary?: string;
  };
  status_map: StatusMap;
  disciplinary_truthy?: string[];
}

const DOMAIN_RE = /^(?=.{4,100}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;
const DATASET_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
const FIELD_RE = /^[a-z_][a-z0-9_]{0,62}$/i;
const MAX_BODY_CHARS = 1_000_000;

export function validateSocrataConfig(raw: unknown): { ok: true; config: SocrataConfig } | { ok: false; error: string } {
  const c = raw as Partial<SocrataConfig> | null;
  if (!c || typeof c !== "object") return { ok: false, error: "config missing" };
  if (typeof c.domain !== "string" || !DOMAIN_RE.test(c.domain)) return { ok: false, error: "invalid domain" };
  if (typeof c.dataset_id !== "string" || !DATASET_RE.test(c.dataset_id)) return { ok: false, error: "invalid dataset_id" };
  const f = c.fields;
  if (!f || typeof f !== "object") return { ok: false, error: "fields missing" };
  for (const key of ["license_number", "holder_name", "status"] as const) {
    if (typeof f[key] !== "string" || !FIELD_RE.test(f[key])) return { ok: false, error: `fields.${key} invalid` };
  }
  for (const key of ["expires_on", "classification", "disciplinary"] as const) {
    if (f[key] !== undefined && (typeof f[key] !== "string" || !FIELD_RE.test(f[key] as string))) {
      return { ok: false, error: `fields.${key} invalid` };
    }
  }
  if (!c.status_map || typeof c.status_map !== "object" || !c.status_map.active?.length) {
    return { ok: false, error: "status_map.active required" };
  }
  return { ok: true, config: c as SocrataConfig };
}

export function buildSocrataUrl(cfg: SocrataConfig, candidates: string[]): string {
  const list = candidates.map((c) => `'${c.replace(/'/g, "''")}'`).join(",");
  const params = new URLSearchParams({
    $where: `upper(${cfg.fields.license_number}) in (${list})`,
    $limit: "10",
  });
  return `https://${cfg.domain}/resource/${cfg.dataset_id}.json?${params.toString()}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null;
}

export function normalizeSocrataRow(row: Record<string, unknown>, cfg: SocrataConfig): NormalizedRecord {
  const truthy = (cfg.disciplinary_truthy ?? ["yes", "y", "true", "1"]).map((x) => x.toLowerCase());
  const disc = cfg.fields.disciplinary ? str(row[cfg.fields.disciplinary]) : null;
  return {
    licenseNumber: str(row[cfg.fields.license_number]),
    holderName: str(row[cfg.fields.holder_name]),
    rawStatus: str(row[cfg.fields.status]),
    expiresOn: cfg.fields.expires_on ? parseDate(row[cfg.fields.expires_on]) : null,
    classification: cfg.fields.classification ? str(row[cfg.fields.classification]) : null,
    disciplinary: cfg.fields.disciplinary ? (disc === null ? null : truthy.includes(disc.toLowerCase())) : null,
  };
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>;
}>;

export async function querySocrata(
  cfg: SocrataConfig, candidates: string[], fetchImpl: FetchLike, appToken?: string,
): Promise<NormalizedRecord[]> {
  if (candidates.length === 0) return [];
  const headers: Record<string, string> = { Accept: "application/json" };
  if (appToken) headers["X-App-Token"] = appToken;
  const res = await fetchImpl(buildSocrataUrl(cfg, candidates), { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`source responded ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_BODY_CHARS) throw new Error("source response too large");
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("unexpected source response");
  return parsed
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => normalizeSocrataRow(r, cfg));
}
