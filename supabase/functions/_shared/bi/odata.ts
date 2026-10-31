// supabase/functions/_shared/bi/odata.ts
//
// A strict, read-only OData v4 subset: exactly what Power BI, Excel and Tableau "OData feed" connectors
// send. Everything is whitelisted against the Data Platform catalog, so a query can never reach a column,
// table or operator that was not explicitly exposed.
//
//   $select   catalog columns            $top / $skip   bounded integers
//   $filter   timestamp/date columns with eq ge gt le lt, joined by "and" (incremental refresh)
//   $orderby  ONE non-personal column    $count=true    exact row count
//   $skiptoken  opaque keyset cursor (server-driven paging; the default and the fast path)
//
// Anything else ($expand, $search, $apply, functions, "or", "not") is rejected with a clear message.
// Pure: no network, no database.

import { DATASETS, DATASET_KEYS, type ColumnDef, type ColumnType, type DatasetKey } from "../data-platform/catalog.ts";
import { b64url, b64urlDecode } from "../data-platform/secrets.ts";

export const PAGE_DEFAULT = 2000;
export const PAGE_MAX = 5000;
export const SKIP_MAX = 100_000;
export const TOP_MAX = 1_000_000;
export const MAX_FILTERS = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUSE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s+(eq|ge|gt|le|lt)\s+(\S+)$/i;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type FilterOp = "eq" | "ge" | "gt" | "le" | "lt";
export interface Filter { column: string; op: FilterOp; value: string }

export interface SkipToken { ts: string; id: string; remaining: number | null }

export interface ODataPlan {
  select: string[] | null;
  filters: Filter[];
  orderBy: { column: string; asc: boolean } | null;
  top: number | null;
  skip: number;
  count: boolean;
  skiptoken: SkipToken | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

// ---------------- names ----------------

export const entitySetName = (key: DatasetKey): string => key.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

export function datasetFromEntitySet(name: string, allowed: readonly DatasetKey[]): DatasetKey | null {
  return allowed.find((k) => entitySetName(k) === name) ?? null;
}

export const EDM_TYPE: Record<ColumnType, string> = {
  uuid: "Edm.Guid",
  text: "Edm.String",
  integer: "Edm.Int64",
  number: "Edm.Double",
  boolean: "Edm.Boolean",
  timestamp: "Edm.DateTimeOffset",
  date: "Edm.Date",
  json: "Edm.String",
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function metadataXml(keys: readonly DatasetKey[]): string {
  const types = keys.map((k) => {
    const props = DATASETS[k].columns
      .map((c) => `<Property Name="${xml(c.name)}" Type="${EDM_TYPE[c.type]}"${c.name === "id" ? ' Nullable="false"' : ""}/>`)
      .join("");
    return `<EntityType Name="${entitySetName(k)}Record"><Key><PropertyRef Name="id"/></Key>${props}</EntityType>`;
  });
  const sets = keys.map((k) => `<EntitySet Name="${entitySetName(k)}" EntityType="Vireek.${entitySetName(k)}Record"/>`);
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>` +
    `<Schema Namespace="Vireek" xmlns="http://docs.oasis-open.org/odata/ns/edm">${types.join("")}` +
    `<EntityContainer Name="Container">${sets.join("")}</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`
  );
}

/** JSON value as OData expects it for a catalog column type. */
export function odataValue(type: ColumnType, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  return type === "json" && typeof v !== "string" ? JSON.stringify(v) : v;
}

// ---------------- skiptoken ----------------

export function encodeSkipToken(t: SkipToken): string {
  return b64url(new TextEncoder().encode(JSON.stringify([t.ts, t.id, t.remaining])));
}

export function decodeSkipToken(raw: string): SkipToken | null {
  try {
    const [ts, id, remaining] = JSON.parse(new TextDecoder().decode(b64urlDecode(raw)));
    if (typeof ts !== "string" || !Number.isFinite(Date.parse(ts)) || typeof id !== "string" || !UUID_RE.test(id)) return null;
    if (remaining !== null && (!Number.isInteger(remaining) || remaining < 0)) return null;
    return { ts, id, remaining };
  } catch {
    return null;
  }
}

// ---------------- query parsing ----------------

const SUPPORTED = new Set(["$select", "$filter", "$top", "$skip", "$orderby", "$count", "$skiptoken", "$format"]);
const fail = (message: string): Parsed<never> => ({ ok: false, message });
const colMap = (dataset: DatasetKey) => new Map<string, ColumnDef>(DATASETS[dataset].columns.map((c) => [c.name, c]));

/** ISO timestamp for a timestamp/date literal, or null. Date-only literals mean 00:00:00Z. */
export function normalizeLiteral(type: ColumnType, value: string): string | null {
  const v = value.replace(/^'(.*)'$/, "$1");
  if (type === "date") return DATE_RE.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
  if (DATE_RE.test(v)) return Number.isFinite(Date.parse(v)) ? `${v}T00:00:00.000Z` : null;
  if (!TS_RE.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function parseFilter(dataset: DatasetKey, raw: string): Parsed<Filter[]> {
  const cols = colMap(dataset);
  const text = raw.replace(/[()]/g, " ").trim();
  if (!text) return { ok: true, value: [] };
  const clauses = text.split(/\s+and\s+/i).map((c) => c.trim());
  if (clauses.length > MAX_FILTERS) return fail(`Use at most ${MAX_FILTERS} filter conditions.`);
  const out: Filter[] = [];
  for (const clause of clauses) {
    const m = CLAUSE_RE.exec(clause);
    if (!m) return fail("Unsupported $filter. Use conditions like  updated_at ge 2027-01-01T00:00:00Z  joined with “and”.");
    const col = cols.get(m[1]);
    if (!col || (col.type !== "timestamp" && col.type !== "date")) return fail(`$filter supports date and timestamp columns only (“${m[1]}” is not one).`);
    const value = normalizeLiteral(col.type, m[3]);
    if (!value) return fail(`“${m[3]}” is not a valid ${col.type} value for ${m[1]}.`);
    out.push({ column: col.name, op: m[2].toLowerCase() as FilterOp, value });
  }
  return { ok: true, value: out };
}

export function parseODataQuery(dataset: DatasetKey, params: URLSearchParams): Parsed<ODataPlan> {
  for (const key of params.keys()) {
    if (key.startsWith("$") && !SUPPORTED.has(key)) return fail(`${key} is not supported. Supported options: ${[...SUPPORTED].filter((k) => k !== "$format").join(", ")}.`);
  }
  const fmt = params.get("$format");
  if (fmt && !/^(json|application\/json)/i.test(fmt)) return fail("Only JSON is supported ($format=json).");
  const cols = colMap(dataset);

  let select: string[] | null = null;
  const selRaw = params.get("$select");
  if (selRaw && selRaw.trim() !== "*") {
    const names = [...new Set(selRaw.split(",").map((s) => s.trim()).filter(Boolean))];
    const bad = names.find((n) => !cols.has(n));
    if (bad) return fail(`Unknown column “${bad}” in $select.`);
    select = names;
  }

  const filterRaw = params.get("$filter");
  const filters = filterRaw ? parseFilter(dataset, filterRaw) : ({ ok: true, value: [] } as Parsed<Filter[]>);
  if (!filters.ok) return filters;

  let orderBy: ODataPlan["orderBy"] = null;
  const ordRaw = params.get("$orderby");
  if (ordRaw) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+(asc|desc))?\s*$/i.exec(ordRaw);
    const col = m ? cols.get(m[1]) : undefined;
    if (!m || !col) return fail("$orderby supports a single catalog column, optionally followed by asc or desc.");
    if (col.type === "json" || col.pii) return fail(`Sorting by “${col.name}” is not supported.`);
    orderBy = { column: col.name, asc: (m[2] ?? "asc").toLowerCase() === "asc" };
  }

  const num = (name: string, max: number): Parsed<number | null> => {
    const v = params.get(name);
    if (v === null) return { ok: true, value: null };
    if (!/^\d{1,9}$/.test(v) || Number(v) > max) return fail(`${name} must be a whole number between 0 and ${max.toLocaleString("en-US")}.`);
    return { ok: true, value: Number(v) };
  };
  const top = num("$top", TOP_MAX);
  if (!top.ok) return top;
  const skip = num("$skip", SKIP_MAX);
  if (!skip.ok) return skip;

  const countRaw = params.get("$count");
  if (countRaw !== null && countRaw !== "true" && countRaw !== "false") return fail("$count must be true or false.");

  let skiptoken: SkipToken | null = null;
  const tok = params.get("$skiptoken");
  if (tok) {
    skiptoken = decodeSkipToken(tok);
    if (!skiptoken) return fail("The $skiptoken is invalid. Start again without it.");
    if (orderBy || skip.value) return fail("$skiptoken cannot be combined with $orderby or $skip.");
  }

  return { ok: true, value: { select, filters: filters.value, orderBy, top: top.value, skip: skip.value ?? 0, count: countRaw === "true", skiptoken } };
}

/**
 * Rows to fetch for this page and rows still owed to the client afterwards.
 * `$top` smaller than a page is honoured exactly (no nextLink); a larger `$top` is served page by page.
 */
export function pageBudget(plan: Pick<ODataPlan, "top" | "skiptoken">): { limit: number; remainingAfter: number | null } {
  const owed = plan.skiptoken?.remaining ?? plan.top;
  if (owed === null || owed === undefined) return { limit: PAGE_DEFAULT, remainingAfter: null };
  const limit = Math.min(owed, PAGE_MAX);
  return { limit, remainingAfter: owed - limit };
}

export { DATASET_KEYS };
