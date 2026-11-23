import { describe, expect, it } from "vitest";
import {
  ERASURE_EXEMPTIONS,
  ERASURE_EXEMPTION_CATEGORIES,
  ERASURE_RPC_EXCLUDED,
  OWNED_TABLES,
  TENANT_KEYED_OWNED_TABLES,
  erasureExemptionFor,
} from "./ownedTables.ts";

describe("erasure registry integrity", () => {
  it("has no duplicate tables across OWNED / TENANT_KEYED / EXEMPTIONS", () => {
    const all = [
      ...OWNED_TABLES.map((t) => t.table),
      ...TENANT_KEYED_OWNED_TABLES.map((t) => t.table),
      ...ERASURE_EXEMPTIONS.map((t) => t.table),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("every exemption uses a known category and has a reason of at least 20 characters", () => {
    const ids = new Set(ERASURE_EXEMPTION_CATEGORIES.map((c) => c.id));
    for (const e of ERASURE_EXEMPTIONS) {
      expect(ids.has(e.category), e.table).toBe(true);
      expect((erasureExemptionFor(e.table)?.reason ?? "").length, e.table).toBeGreaterThanOrEqual(20);
    }
  });

  it("every needs_remediation entry explains the open problem", () => {
    for (const e of ERASURE_EXEMPTIONS.filter((x) => x.category === "needs_remediation")) {
      expect((e.note ?? "").length).toBeGreaterThanOrEqual(20);
    }
  });

  it("tenant owner columns are known tenant columns and children precede parents", () => {
    const known = new Set(["account_id", "tenant_id", "owner_id", "account_owner_id", "owner_user_id"]);
    for (const t of TENANT_KEYED_OWNED_TABLES) expect(known.has(t.ownerColumn), t.table).toBe(true);
    const order = TENANT_KEYED_OWNED_TABLES.map((t) => t.table);
    expect(order.indexOf("authz_approval_requests")).toBeLessThan(order.indexOf("authz_approval_policies"));
  });

  it("erase_user_rows exclusions are all registered as exemptions", () => {
    for (const t of ERASURE_RPC_EXCLUDED) expect(erasureExemptionFor(t), t).toBeDefined();
  });
});
