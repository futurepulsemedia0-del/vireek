// @vitest-environment node
// Lifecycle registry: validation, banner selection and the api-v1 header wiring.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_BANNERS, MIN_NOTICE_DAYS, URGENT_DAYS, apiDeprecationList, daysUntilSunset, deprecationPhase, isSafeAppRoute,
  isSafeHttpsUrl, isUrgent, localizedCopy, matchesRoute, parseIsoDate, selectBannerEntries, validateRegistry,
  type DeprecationEntry,
} from "./deprecations.ts";
import { DEPRECATION_REGISTRY } from "./registry.ts";
import { RESOURCES, checkEdgeFunctionSource, deprecationHeaders } from "../../api-v1/contract.ts";

const NOW = Date.UTC(2026, 10, 19); // 2026-11-19
const day = (iso: string) => parseIsoDate(iso) as number;
const KNOWN = RESOURCES.map((r) => r.name as string);
const check = (entries: readonly DeprecationEntry[], todayMs = NOW) => validateRegistry(entries, { todayMs, knownApiResources: KNOWN });

function entry(over: Partial<DeprecationEntry> = {}): DeprecationEntry {
  return {
    id: "legacy-export",
    kind: "feature",
    noticeClass: "stable",
    title: "Legacy export",
    summary: "Use the new export instead.",
    owner: "compliance",
    announcedAt: "2026-11-01",
    sunsetAt: "2027-03-01",
    dataExport: { holdsCustomerData: true, exportRoute: "/dashboard/exports" },
    ...over,
  };
}
const apiEntry = (over: Partial<DeprecationEntry> = {}) =>
  entry({ id: "api-jobs", kind: "api_resource", api: { resource: "jobs" }, migrationUrl: "https://vireek.com/docs/migrate/jobs", dataExport: { holdsCustomerData: false }, ...over });

describe("the real registry", () => {
  it("is valid (real dates, notice periods, https links, export plans, known api resources)", () =>
    expect(check(DEPRECATION_REGISTRY, Date.now())).toEqual([]));
  it("is wired into api-v1: index.ts passes it to deprecationHeaders and the source check passes", () => {
    const source = readFileSync(new URL("../../api-v1/index.ts", import.meta.url), "utf8");
    expect(source).toContain("apiDeprecationList(DEPRECATION_REGISTRY)");
    expect(checkEdgeFunctionSource(source)).toEqual([]);
    const without = source.replace("apiDeprecationList(DEPRECATION_REGISTRY)", "[]");
    expect(checkEdgeFunctionSource(without).join(" ")).toMatch(/lifecycle registry/);
  });
});

describe("helpers", () => {
  it("parseIsoDate accepts only real YYYY-MM-DD dates", () => {
    expect(parseIsoDate("2026-11-19")).toBe(NOW);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "2026-11-19T00:00:00Z", "", null, 5, undefined]) expect(parseIsoDate(bad)).toBeNull();
    expect(parseIsoDate("2028-02-29")).not.toBeNull(); // leap day
    expect(parseIsoDate("2027-02-29")).toBeNull();
  });
  it("isSafeHttpsUrl: https only, nothing that could break a header or an href", () => {
    expect(isSafeHttpsUrl("https://vireek.com/docs/migrate?x=1#a")).toBe(true);
    for (const bad of ["http://vireek.com", "javascript:alert(1)", "https://a.com/x y", "https://a.com/\r\nSet-Cookie: x=1", "https://a.com/>; rel=x", "https://user:pw@a.com", "//a.com", "", "https://a.com/\"x"]) expect(isSafeHttpsUrl(bad)).toBe(false);
  });
  it("isSafeAppRoute: a single leading slash only", () => {
    expect(isSafeAppRoute("/dashboard/exports")).toBe(true);
    for (const bad of ["//evil.com", "https://x.com", "dashboard", "/a b", "/a\\b", "javascript:1", ""]) expect(isSafeAppRoute(bad)).toBe(false);
  });
  it("phase, days until sunset and urgency", () => {
    const e = entry({ sunsetAt: "2026-12-01" });
    expect(deprecationPhase(e, NOW)).toBe("deprecated");
    expect(deprecationPhase(e, day("2026-12-01"))).toBe("sunset_due");
    expect(deprecationPhase({ ...e, removedAt: "2026-12-02" }, NOW)).toBe("removed");
    expect(daysUntilSunset(e, NOW)).toBe(12);
    expect(daysUntilSunset(e, day("2026-12-01"))).toBe(0);
    expect(daysUntilSunset(e, day("2026-12-05"))).toBe(-4);
    expect(URGENT_DAYS).toBe(14);
    expect(isUrgent(e, day("2026-11-17"))).toBe(true); // 14 days left
    expect(isUrgent(e, day("2026-11-16"))).toBe(false); // 15 days left
    expect(isUrgent(entry({ sunsetAt: "2027-03-01" }), NOW)).toBe(false);
  });
  it("localizedCopy: exact language, base language, then English", () => {
    const e = entry({ messages: { es: { title: "Exportación antigua", summary: "Usa la nueva." }, "pt-br": { title: "Antigo", summary: "Use o novo." } } });
    expect(localizedCopy(e, "es").title).toBe("Exportación antigua");
    expect(localizedCopy(e, "es-MX").title).toBe("Exportación antigua");
    expect(localizedCopy(e, "PT-BR").title).toBe("Antigo");
    expect(localizedCopy(e, "fr")).toEqual({ title: "Legacy export", summary: "Use the new export instead." });
    expect(localizedCopy(e, undefined).title).toBe("Legacy export");
    expect(localizedCopy(entry({ messages: { es: { title: " ", summary: "x" } } }), "es").title).toBe("Legacy export");
  });
  it("matchesRoute: exact or child path, never a sibling with the same prefix", () => {
    expect(matchesRoute("/dashboard/billing", ["/dashboard/billing"])).toBe(true);
    expect(matchesRoute("/dashboard/billing/plans", ["/dashboard/billing"])).toBe(true);
    expect(matchesRoute("/dashboard/billing/", ["/dashboard/billing/"])).toBe(true);
    expect(matchesRoute("/dashboard/billing-x", ["/dashboard/billing"])).toBe(false);
    expect(matchesRoute("/dashboard/jobs", undefined)).toBe(true);
    expect(matchesRoute("/dashboard/jobs", [])).toBe(true);
    expect(matchesRoute("/anything", ["/"])).toBe(true);
  });
});

describe("validateRegistry", () => {
  it("accepts a complete entry", () => expect(check([entry(), apiEntry()])).toEqual([]));

  it("notice period per class: exactly the minimum passes, one day less fails", () => {
    const base = day("2026-11-01");
    const sunset = (days: number) => new Date(base + days * 86_400_000).toISOString().slice(0, 10);
    for (const cls of ["stable", "beta", "integration"] as const) {
      const min = MIN_NOTICE_DAYS[cls];
      expect(check([entry({ noticeClass: cls, sunsetAt: sunset(min) })])).toEqual([]);
      expect(check([entry({ noticeClass: cls, sunsetAt: sunset(min - 1) })]).join(" ")).toMatch(new RegExp(`needs at least ${min}`));
    }
    expect(MIN_NOTICE_DAYS.stable).toBeGreaterThanOrEqual(90); // never below the published API policy
  });
  it("forced: needs a reason, still needs sunset after announcement", () => {
    expect(check([entry({ noticeClass: "forced", sunsetAt: "2026-11-05" })]).join(" ")).toMatch(/forcedReason is required/);
    expect(check([entry({ noticeClass: "forced", sunsetAt: "2026-11-05", forcedReason: "Vendor ends its API on 2026-11-05" })])).toEqual([]);
    expect(check([entry({ noticeClass: "forced", sunsetAt: "2026-11-01", forcedReason: "x" })]).join(" ")).toMatch(/sunsetAt must be after announcedAt/);
  });
  it("dates: real, not announced in the future, nothing removed before its sunset or in the future", () => {
    expect(check([entry({ announcedAt: "2026-02-30" })]).join(" ")).toMatch(/announcedAt must be a real date/);
    expect(check([entry({ sunsetAt: "soon" })]).join(" ")).toMatch(/sunsetAt must be a real date/);
    expect(check([entry({ announcedAt: "2026-11-20", sunsetAt: "2027-03-01" })]).join(" ")).toMatch(/announcedAt is in the future/);
    expect(check([entry({ removedAt: "2027-02-01" })], day("2027-06-01")).join(" ")).toMatch(/removedAt is before sunsetAt/);
    expect(check([entry({ removedAt: "2027-03-01" })], day("2027-06-01"))).toEqual([]);
    expect(check([entry({ removedAt: "2027-03-01" })], day("2027-02-01")).join(" ")).toMatch(/removedAt is in the future/);
  });
  it("ids: kebab-case and unique", () => {
    expect(check([entry({ id: "Legacy_Export" })]).join(" ")).toMatch(/kebab-case/);
    expect(check([entry(), entry()]).join(" ")).toMatch(/duplicate id/);
  });
  it("text fields are required and bounded", () => {
    const out = check([entry({ title: " ", summary: "x".repeat(241), owner: "" })]).join(" | ");
    expect(out).toMatch(/title is required/);
    expect(out).toMatch(/summary is required/);
    expect(out).toMatch(/owner is required/);
    expect(check([entry({ messages: { es: { title: "", summary: "x" } } })]).join(" ")).toMatch(/messages.es needs/);
    expect(check([entry({ messages: { "not a lang": { title: "a", summary: "b" } } })]).join(" ")).toMatch(/not a language code/);
  });
  it("links: https only for migration and replacement; routes are in-app paths", () => {
    expect(check([apiEntry({ migrationUrl: "http://vireek.com/x" })]).join(" ")).toMatch(/migrationUrl must be a plain https URL/);
    expect(check([entry({ replacement: { label: "New", route: "//evil.com" } })]).join(" ")).toMatch(/replacement.route/);
    expect(check([entry({ replacement: { label: "New", url: "javascript:alert(1)" } })]).join(" ")).toMatch(/replacement.url/);
    expect(check([entry({ replacement: { label: "New" } })]).join(" ")).toMatch(/needs a route or a url/);
    expect(check([entry({ replacement: { label: "New", route: "/dashboard/exports", url: "https://vireek.com/docs" } })])).toEqual([]);
  });
  it("data export: decided explicitly; customer data needs a route or a written way out", () => {
    expect(check([entry({ dataExport: undefined as never })]).join(" ")).toMatch(/holdsCustomerData must be true or false/);
    expect(check([entry({ dataExport: { holdsCustomerData: true } })]).join(" ")).toMatch(/customers keep data here/);
    expect(check([entry({ dataExport: { holdsCustomerData: true, note: "Support exports it on request within 5 days" } })])).toEqual([]);
    expect(check([entry({ dataExport: { holdsCustomerData: true, exportRoute: "https://x.com" } })]).join(" ")).toMatch(/exportRoute must be an in-app path/);
    expect(check([entry({ dataExport: { holdsCustomerData: false } })])).toEqual([]);
  });
  it("api entries: known resource or '*', migration url required, one live entry per target", () => {
    expect(check([apiEntry({ api: { resource: "job" } })]).join(" ")).toMatch(/not an api-v1 resource/);
    expect(check([apiEntry({ api: undefined })]).join(" ")).toMatch(/api.resource is required/);
    expect(check([apiEntry({ migrationUrl: undefined })]).join(" ")).toMatch(/migrationUrl is required for api_\* kinds/);
    expect(check([apiEntry({ kind: "api_version", api: { resource: "jobs" } })]).join(" ")).toMatch(/targets api.resource "\*"/);
    expect(check([apiEntry({ kind: "api_version", api: { resource: "*" } })])).toEqual([]);
    expect(check([entry({ api: { resource: "jobs" } })]).join(" ")).toMatch(/api is only allowed/);
    const twice = check([apiEntry(), apiEntry({ id: "api-jobs-2" })]).join(" ");
    expect(twice).toMatch(/already deprecated by \[api-jobs\]/);
    expect(check([apiEntry({ removedAt: "2027-03-01" }), apiEntry({ id: "api-jobs-2" })], day("2027-06-01"))).toEqual([]); // removed entries are history
  });
  it("banner config is bounded", () => {
    expect(check([entry({ banner: { enabled: true, showFromDaysBeforeSunset: 0 } })]).join(" ")).toMatch(/1-365/);
    expect(check([entry({ banner: { enabled: true, routePrefixes: ["dashboard"] } })]).join(" ")).toMatch(/routePrefixes entry/);
    expect(check([entry({ banner: { enabled: true, audience: "everyone" as never } })]).join(" ")).toMatch(/audience/);
    expect(check([entry({ banner: { enabled: true, showFromDaysBeforeSunset: 60, routePrefixes: ["/dashboard/exports"], audience: "owner" } })])).toEqual([]);
  });
});

describe("selectBannerEntries", () => {
  const on = { enabled: true };
  const ctx = { nowMs: NOW, pathname: "/dashboard", isOwner: false };
  const ids = (es: DeprecationEntry[]) => es.map((e) => e.id);

  it("shows only enabled, announced, not-removed entries; most urgent first; capped", () => {
    const list = [
      entry({ id: "later", sunsetAt: "2027-06-01", banner: on }),
      entry({ id: "soon", sunsetAt: "2026-12-10", banner: on }),
      entry({ id: "off", banner: { enabled: false } }),
      entry({ id: "none" }),
      entry({ id: "gone", sunsetAt: "2026-12-01", removedAt: "2026-12-02", banner: on }),
      entry({ id: "future", announcedAt: "2026-12-01", sunsetAt: "2027-06-01", banner: on }),
      entry({ id: "middle", sunsetAt: "2027-02-01", banner: on }),
    ];
    expect(ids(selectBannerEntries(list, ctx))).toEqual(["soon", "middle"]);
    expect(MAX_BANNERS).toBe(2);
    expect(ids(selectBannerEntries(list, ctx, 10))).toEqual(["soon", "middle", "later"]);
    expect(selectBannerEntries(list, ctx, 0)).toEqual([]);
  });
  it("an entry past its sunset but not yet removed keeps showing until removedAt is set", () => {
    const e = entry({ sunsetAt: "2026-11-10", noticeClass: "forced", forcedReason: "x", banner: on });
    expect(ids(selectBannerEntries([e], ctx))).toEqual(["legacy-export"]);
  });
  it("audience: owner-only entries are hidden from non-owners", () => {
    const e = entry({ banner: { enabled: true, audience: "owner" } });
    expect(selectBannerEntries([e], ctx)).toEqual([]);
    expect(selectBannerEntries([e], { ...ctx, isOwner: true })).toHaveLength(1);
  });
  it("route prefixes limit where the banner appears", () => {
    const e = entry({ banner: { enabled: true, routePrefixes: ["/dashboard/exports"] } });
    expect(selectBannerEntries([e], ctx)).toEqual([]);
    expect(selectBannerEntries([e], { ...ctx, pathname: "/dashboard/exports/new" })).toHaveLength(1);
  });
  it("showFromDaysBeforeSunset delays the banner until the window opens", () => {
    const e = entry({ sunsetAt: "2027-03-01", banner: { enabled: true, showFromDaysBeforeSunset: 30 } });
    expect(selectBannerEntries([e], ctx)).toEqual([]);
    expect(selectBannerEntries([e], { ...ctx, nowMs: day("2027-01-30") })).toHaveLength(1);
    expect(selectBannerEntries([e], { ...ctx, nowMs: day("2027-01-29") })).toEqual([]); // 31 days left
  });
  it("fails closed on corrupt dates instead of throwing", () => {
    const e = entry({ sunsetAt: "garbage", banner: on });
    expect(selectBannerEntries([e], ctx)).toEqual([]);
  });
});

describe("api-v1 headers from the registry", () => {
  it("apiDeprecationList keeps live api entries only", () => {
    const list = apiDeprecationList([apiEntry(), entry(), apiEntry({ id: "old", api: { resource: "leads" }, removedAt: "2027-03-01" })]);
    expect(list).toEqual([{ resource: "jobs", deprecatedAt: "2026-11-01T00:00:00Z", sunsetAt: "2027-03-01T00:00:00Z", link: "https://vireek.com/docs/migrate/jobs" }]);
  });
  it("sends Deprecation, Sunset and Link for the deprecated resource only", () => {
    const list = apiDeprecationList([apiEntry()]);
    expect(deprecationHeaders("jobs", list)).toEqual({
      Deprecation: `@${Date.UTC(2026, 10, 1) / 1000}`,
      Sunset: "Mon, 01 Mar 2027 00:00:00 GMT",
      Link: '<https://vireek.com/docs/migrate/jobs>; rel="deprecation"',
    });
    expect(deprecationHeaders("calls", list)).toEqual({});
    expect(deprecationHeaders(null, list)).toEqual({});
  });
  it("a version-wide '*' entry covers every resource and unresolved routes; a resource entry wins", () => {
    const list = apiDeprecationList([
      apiEntry({ id: "all", kind: "api_version", api: { resource: "*" }, sunsetAt: "2027-06-01", migrationUrl: "https://vireek.com/docs/v2" }),
      apiEntry(),
    ]);
    expect(deprecationHeaders("calls", list).Sunset).toBe("Tue, 01 Jun 2027 00:00:00 GMT");
    expect(deprecationHeaders(null, list).Sunset).toBe("Tue, 01 Jun 2027 00:00:00 GMT");
    expect(deprecationHeaders("jobs", list).Sunset).toBe("Mon, 01 Mar 2027 00:00:00 GMT");
  });
  it("fails safe: malformed dates give no headers, an unsafe link is dropped, nothing throws", () => {
    const rec = { resource: "jobs", deprecatedAt: "2026-11-01T00:00:00Z", sunsetAt: "2027-03-01T00:00:00Z", link: "https://vireek.com/docs" };
    expect(deprecationHeaders("jobs", [{ ...rec, sunsetAt: "never" }])).toEqual({});
    expect(deprecationHeaders("jobs", [{ ...rec, deprecatedAt: "" }])).toEqual({});
    expect(deprecationHeaders("jobs", [{ ...rec, sunsetAt: "2026-10-01T00:00:00Z" }])).toEqual({});
    for (const link of ["", "http://x.com", "https://x.com/a\r\nX: y", "https://x.com/>; rel=sunset", "javascript:1"]) {
      const h = deprecationHeaders("jobs", [{ ...rec, link }]);
      expect(Object.keys(h).sort()).toEqual(["Deprecation", "Sunset"]);
    }
  });
});
