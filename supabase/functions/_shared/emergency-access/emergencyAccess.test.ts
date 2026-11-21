import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateCode, hashCode, normalizeCode } from "./codes.ts";
import { csvCell, toCsv, SCOPE_COLUMNS } from "./csv.ts";
import { renderNotice, esc, type NoticeCtx } from "./notices.ts";

const PEPPER = "p".repeat(40);

describe("verification codes", () => {
  it("generates 8 digits, zero-padded, and varies", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) { const c = generateCode(); expect(/^\d{8}$/.test(c)).toBe(true); seen.add(c); }
    expect(seen.size).toBeGreaterThan(190);
  });
  it("normalises user input and rejects anything else", () => {
    expect(normalizeCode("1234 5678")).toBe("12345678");
    expect(normalizeCode("1234-5678")).toBe("12345678");
    expect(normalizeCode("1234567")).toBeNull();
    expect(normalizeCode("123456789")).toBeNull();
    expect(normalizeCode("abcd1234")).toBeNull();
    expect(normalizeCode(12345678)).toBeNull();
  });
  it("hash is 64 hex, deterministic, and bound to request id, code and pepper", async () => {
    const h = await hashCode(PEPPER, "req-1", "12345678");
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
    expect(await hashCode(PEPPER, "req-1", "12345678")).toBe(h);
    expect(await hashCode(PEPPER, "req-2", "12345678")).not.toBe(h);
    expect(await hashCode(PEPPER, "req-1", "12345679")).not.toBe(h);
    expect(await hashCode("q".repeat(40), "req-1", "12345678")).not.toBe(h);
  });
  it("refuses a weak pepper (fail closed)", async () => {
    await expect(hashCode("short", "r", "12345678")).rejects.toMatchObject({ message: "pepper too short" });
  });
});

describe("CSV export", () => {
  it("neutralises formula injection in text cells", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
  });
  it("keeps real numbers numeric, including negatives", () => {
    expect(csvCell(-1250)).toBe("-1250");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(Number.NaN)).toBe("");
  });
  it("quotes commas, quotes and newlines; renders null as empty", () => {
    expect(csvCell("a,b")).toBe("\"a,b\"");
    expect(csvCell("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
    expect(csvCell("l1\nl2")).toBe("\"l1\nl2\"");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("emits a header and CRLF rows in the fixed column order, ignoring unexpected keys", () => {
    const out = toCsv(["id", "name"], [{ name: "Ann", id: "1", secret: "x" }]);
    expect(out).toBe("id,name\r\n1,Ann\r\n");
  });
  it("column lists match the whitelist in emergency_read() and expose no payment/bank/secret field", () => {
    const sql = readFileSync(new URL("../../../migrations/20290306000100_owner_emergency_access.sql", import.meta.url), "utf8");
    const fn = sql.slice(sql.indexOf("FUNCTION public.emergency_read"), sql.indexOf("FUNCTION public.emergency_log_export"));
    for (const [scope, cols] of Object.entries(SCOPE_COLUMNS)) {
      expect(fn.includes(`p_scope = '${scope}'`)).toBe(true);
      for (const c of cols) expect(fn.includes(c)).toBe(true);
      for (const bad of ["journal_entry_id", "access_token", "payment", "bank", "secret", "password", "notes"]) expect(cols.some((x) => x.includes(bad))).toBe(false);
    }
  });
});

const ctx = (over: Partial<NoticeCtx>): NoticeCtx => ({
  kind: "requested", recipient: "owner", ownerBusiness: "Acme HVAC", contactName: "Sam", requestReason: "Owner hospitalised",
  accessAvailableAt: "2026-11-21T10:00:00.000Z", accessExpiresAt: "2026-12-21T10:00:00.000Z", closedReason: null, waitHours: 72, scopes: ["customers"], ...over,
});

describe("notice e-mails", () => {
  it("escapes attacker-controlled text (reason, names) in HTML", () => {
    const n = renderNotice(ctx({ requestReason: "<script>alert(1)</script>", contactName: "\"><img src=x>" }), "https://app.test")!;
    expect(n.html.includes("<script>")).toBe(false);
    expect(n.html.includes("<img")).toBe(false);
    expect(n.html.includes("&lt;script&gt;")).toBe(true);
  });
  it("renders every owner and contact kind the database can emit", () => {
    for (const [recipient, kind] of [["owner", "requested"], ["owner", "verified"], ["owner", "reminder"], ["owner", "pre_grant"], ["owner", "granted"], ["owner", "first_access"], ["owner", "closed"], ["owner", "accepted"], ["contact", "invited"], ["contact", "granted"], ["contact", "closed"]] as const) {
      const n = renderNotice(ctx({ kind, recipient, closedReason: "denied_by_owner" }), "https://app.test");
      expect(n).toBeTruthy();
      expect(n!.subject.length).toBeGreaterThan(5);
      expect(n!.text.includes("https://app.test/dashboard/emergency-access")).toBe(true);
    }
  });
  it("returns null for unknown kinds so they are dropped rather than retried forever", () => {
    expect(renderNotice(ctx({ kind: "nope" }), "https://app.test")).toBeNull();
  });
  it("states the countdown time and that access is read-only", () => {
    const n = renderNotice(ctx({ kind: "verified" }), "https://app.test")!;
    expect(n.text.includes("2026-11-21 10:00 UTC")).toBe(true);
    expect(n.text.includes("cannot change records or move money")).toBe(true);
  });
  it("every kind inserted by the migration has a template", () => {
    const sql = readFileSync(new URL("../../../migrations/20290306000100_owner_emergency_access.sql", import.meta.url), "utf8");
    const kinds = new Set([...sql.matchAll(/_emergency_notice\([^;]*?'(owner|contact)', '([a-z_]+)'/g)].map((m) => `${m[1]}:${m[2]}`));
    expect(kinds.size).toBeGreaterThan(7);
    for (const k of kinds) {
      const [recipient, kind] = k.split(":") as ["owner" | "contact", string];
      expect(renderNotice(ctx({ kind, recipient }), "https://x.test")).toBeTruthy();
    }
  });
  it("esc handles all five characters", () => { expect(esc("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;"); });
});
