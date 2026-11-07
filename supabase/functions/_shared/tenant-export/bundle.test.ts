// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildBundle, parseBundle, tarPack, tarUnpack, TABLES, type Row, type TableName } from "./bundle.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const src: Partial<Record<TableName, Row[]>> = {
  customers: [{ id: id(2), user_id: "u1", name: "Zed, \"Quoted\" ünï", notes: "line1\nline2", tags: ["a", "b"] }, { id: id(1), user_id: "u1", name: "Ann", api_key: "SECRET" }],
  jobs: [{ id: id(10), user_id: "u1", customer_id: id(1), status: "done", total: 120.5, meta: { z: 1, a: [1, { y: 2, x: 1 }] } }],
  invoices: [{ id: id(20), user_id: "u1", job_id: id(10), amount: 120.5 }],
  calls: [{ id: id(30), user_id: "u1", transcript: "Hello 👋\nمشتری: سلام" }],
  price_book_items: [{ id: id(40), user_id: "u1", sku: "X-1", price: 9.99 }],
  audit_log: [{ id: id(50), user_id: "u1", action: "login", target_id: null }],
};

describe("tenant bundle", () => {
  it("round trip: export -> tar -> untar -> parse -> export again is byte-identical", async () => {
    const f1 = await buildBundle(src, "2026-11-07T00:00:00Z");
    const tar = tarPack(f1);
    const f2 = tarUnpack(tar)!;
    expect(f2).not.toBeNull();
    const parsed = await parseBundle(f2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // importer re-attaches a (new) tenant id; export strips it again
    const reimported = Object.fromEntries(TABLES.map((t) => [t, parsed.rows[t].map((r) => ({ ...r, user_id: "u2" }))])) as Record<TableName, Row[]>;
    const f3 = await buildBundle(reimported, "2026-11-07T00:00:00Z");
    expect([...f3.entries()]).toEqual([...f1.entries()]);
    expect(parsed.rows.customers[0].name).toBe("Ann");
    expect(parsed.rows.calls[0].transcript).toBe("Hello 👋\nمشتری: سلام");
    expect(parsed.rows.customers.find((r) => r.id === id(1))!.api_key).toBeUndefined(); // credentials never exported
    expect(parsed.rows.jobs[0].user_id).toBeUndefined();
  });
  it("rejects tampering, wrong counts, duplicate ids, unknown tables, user_id smuggling", async () => {
    const f = await buildBundle(src, "t");
    const tamper = new Map(f); tamper.set("customers.ndjson", f.get("customers.ndjson")! + "\n");
    expect((await parseBundle(tamper))).toEqual({ ok: false, error: "checksum_mismatch:customers" });
    const nomf = new Map(f); nomf.delete("manifest.json");
    expect(await parseBundle(nomf)).toEqual({ ok: false, error: "manifest_missing" });
    const evil = new Map(f); const m = JSON.parse(f.get("manifest.json")!); m.tables[0].name = "auth.users"; evil.set("manifest.json", JSON.stringify(m));
    expect((await parseBundle(evil)).ok).toBe(false);
    const withUser = await buildBundle({ customers: [{ id: id(1), name: "x" }] }, "t");
    const body = JSON.stringify({ id: id(1), user_id: "victim" }) + "\n";
    const mm = JSON.parse(withUser.get("manifest.json")!); mm.tables[0].rows = 1;
    const { sha256Hex } = await import("./bundle.ts"); mm.tables[0].sha256 = await sha256Hex(body);
    const smuggled = new Map(withUser); smuggled.set("customers.ndjson", body); smuggled.set("manifest.json", JSON.stringify(mm));
    expect(await parseBundle(smuggled)).toEqual({ ok: false, error: "user_id_not_allowed:customers" });
  });
  it("tar reader refuses path traversal, links and truncated archives", () => {
    const good = tarPack(new Map([["a.txt", "hi"]]));
    expect(tarUnpack(good)!.get("a.txt")).toBe("hi");
    expect(() => tarPack(new Map([["../x", "no"]]))).toThrow("bad_name");
    expect(tarUnpack(good.subarray(0, 513))).toBeNull();
    const link = new Uint8Array(good); link[156] = "2".charCodeAt(0);
    expect(tarUnpack(link)).toBeNull();
  });
  it("deterministic: input row order does not change output", async () => {
    const a = await buildBundle(src, "t"); const rev = { ...src, customers: [...src.customers!].reverse() };
    expect([...(await buildBundle(rev, "t")).entries()]).toEqual([...a.entries()]);
  });
});
