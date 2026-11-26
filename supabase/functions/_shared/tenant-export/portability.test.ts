// Data-portability completeness (CI). Compares the export lists with the account-owned table registry (OWNED_TABLES),
// the migrations, and the public claims. Run: npx vitest run supabase/functions/_shared/tenant-export/portability.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNED_TABLES } from "../compliance/ownedTables.ts";
import { TABLES, toExportRow } from "./bundle.ts";
import { SUPPLEMENTARY_TABLES, exclusionFor } from "./coverage.ts";
import { EXPORT_PARTS_LIVE, KNOWN_BEARER_TOKEN_COLUMNS, PORTABILITY_CATEGORIES, PORTABILITY_EXEMPTIONS } from "./portability.ts";
// @ts-expect-error plain ESM script without type declarations
import { ROOT, scanSchema } from "../../../../scripts/compliance/export-coverage.mjs";
// @ts-expect-error plain ESM script without type declarations
import { SECRET_KEY_RE, buildSchema } from "../../../../scripts/compliance/gen-export-schema.mjs";

const core = new Set<string>(TABLES);
const supplement = new Set<string>(SUPPLEMENTARY_TABLES);
const exempt = new Map(PORTABILITY_EXEMPTIONS.map((e) => [e.table, e]));
const ownedNames = OWNED_TABLES.map((t) => t.table);

describe("every account-owned table has an explicit portability decision", () => {
  it("is exported (core or supplement) or exempted with a reason, for every OWNED_TABLES entry", () => {
    const undecided = ownedNames.filter((t) => !core.has(t) && !supplement.has(t) && !exempt.has(t) && !exclusionFor(t));
    expect(undecided, `Decide these in coverage.ts (export) or portability.ts (exempt): ${undecided.join(", ")}`).toEqual([]);
  });

  it("never lists a table as both exported and exempt", () => {
    for (const e of PORTABILITY_EXEMPTIONS) expect(core.has(e.table) || supplement.has(e.table), e.table).toBe(false);
  });

  it("has exemptions that name real owned tables, a reason of 20+ characters and no duplicates", () => {
    expect(new Set(PORTABILITY_EXEMPTIONS.map((e) => e.table)).size).toBe(PORTABILITY_EXEMPTIONS.length);
    for (const e of PORTABILITY_EXEMPTIONS) {
      expect(ownedNames, `${e.table} is not in OWNED_TABLES`).toContain(e.table);
      expect(e.reason.length, e.table).toBeGreaterThanOrEqual(20);
    }
  });

  it("only exports owned tables that the migrations define with id and user_id (the export pages by id, filters by user_id)", () => {
    const schema = scanSchema(ROOT) as Map<string, { user_id: boolean; id: boolean }>;
    for (const t of ownedNames.filter((n) => core.has(n) || supplement.has(n))) {
      const s = schema.get(t);
      expect(s, `${t} has no CREATE TABLE in migrations`).toBeDefined();
      expect(s?.user_id, `${t} has no user_id`).toBe(true);
      expect(s?.id, `${t} has no id`).toBe(true);
    }
  });

  it("explains why an exempt table cannot simply be exported (no_id_column really has no id column)", () => {
    const schema = scanSchema(ROOT) as Map<string, { user_id: boolean; id: boolean }>;
    for (const e of PORTABILITY_EXEMPTIONS.filter((x) => x.category === "no_id_column")) expect(schema.get(e.table)?.id, e.table).toBe(false);
  });
});

describe("credentials in the files", () => {
  const schema = buildSchema(ROOT) as { tables: { name: string; part: string; columns: { name: string }[]; omitted: string[] }[] };
  const CREDENTIAL_LIKE = /secret|token|password|passwd|credential|api_?key|private_?key|signing|bearer/i;

  it("matches the export key filter in bundle.ts (the generator and the export drop the same keys)", () => {
    const sample = { id: "x", user_id: "u", api_key: "k", token: "t", Password: "p", recording_url: "https://example.invalid/r", name: "n" };
    const out = toExportRow(sample);
    expect(Object.keys(out).sort()).toEqual(["id", "name", "recording_url"]);
    for (const k of Object.keys(sample)) expect(Object.hasOwn(out, k), k).toBe(!(k === "user_id" || SECRET_KEY_RE.test(k)));
  });

  it("exports no credential-like column that is not on the reviewed list", () => {
    const found = schema.tables.flatMap((t) => t.columns.filter((c) => CREDENTIAL_LIKE.test(c.name)).map((c) => `${t.name}.${c.name}`)).sort();
    const known = [...KNOWN_BEARER_TOKEN_COLUMNS].sort();
    expect(found, "A credential-like column is now exported. Strip it in bundle.ts or add it to KNOWN_BEARER_TOKEN_COLUMNS with a decision.").toEqual(known);
  });

  it("never exports a table the exclusion rules treat as secret", () => {
    for (const t of [...core, ...supplement]) expect(exclusionFor(t), t).toBeNull();
  });
});

describe("public claims are backed by the export", () => {
  it("maps every claimed category to tables that are really exported", () => {
    for (const c of PORTABILITY_CATEGORIES) for (const t of c.tables) expect(core.has(t) || supplement.has(t), `${c.id}: ${t}`).toBe(true);
  });

  it("claims recording links only if the calls table really has that column and the key filter keeps it", () => {
    const schema = buildSchema(ROOT) as { tables: { name: string; columns: { name: string }[] }[] };
    for (const c of PORTABILITY_CATEGORIES.filter((x) => x.column)) {
      const t = schema.tables.find((x) => x.name === c.column?.table);
      expect(t?.columns.map((x) => x.name), c.id).toContain(c.column?.name);
    }
  });

  it("does not mark the supplement as live unless the function reads it", () => {
    if (!EXPORT_PARTS_LIVE.supplement) return;
    const fn = readFileSync(join(ROOT, "supabase/functions/tenant-export/index.ts"), "utf8") + readFileSync(join(ROOT, "supabase/functions/_shared/tenant-export/handler.ts"), "utf8");
    expect(fn).toMatch(/SUPPLEMENTARY_TABLES|buildSupplementBundle/);
  });

  it("keeps the supplement list free of duplicates and of core tables", () => {
    expect(supplement.size).toBe(SUPPLEMENTARY_TABLES.length);
    for (const t of supplement) expect(core.has(t), t).toBe(false);
  });
});
