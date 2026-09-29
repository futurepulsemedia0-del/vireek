import { describe, expect, it } from "vitest";
import { evaluateJob, classifyWorkTypes, permitLikelihoodFor } from "./engine.ts";
import { parseJurisdiction } from "./jurisdiction.ts";
import type { JobFacts } from "./types.ts";

const base: JobFacts = {
  serviceType: null, dispatchNote: null, diagnosisNote: null, address: "12 Oak St, Austin, TX 78701",
  countryHint: null, customerType: "residential", isEmergency: false, isRework: false, tags: [], equipmentType: null,
};
const job = (over: Partial<JobFacts>): JobFacts => ({ ...base, ...over });
const keys = (f: JobFacts) => evaluateJob(f).items.map((i) => i.key);

describe("parseJurisdiction", () => {
  it("parses city/state/zip", () => {
    const j = parseJurisdiction("12 Oak St, Austin, TX 78701");
    expect(j).toMatchObject({ state: "TX", zip: "78701", city: "Austin", country: "US", basis: "address" });
  });
  it("parses state without zip and full state name", () => {
    expect(parseJurisdiction("5 Elm Ave, Denver, CO").state).toBe("CO");
    expect(parseJurisdiction("5 Elm Ave, Portland, Oregon 97201").state).toBe("OR");
  });
  it("does not invent a state from ordinary words", () => {
    expect(parseJurisdiction("Apt OR 5, Main Street").state).toBeNull();
    expect(parseJurisdiction(null).basis).toBe("unknown");
  });
  it("falls back to country hint", () => {
    expect(parseJurisdiction("10 Downing St", "uk")).toMatchObject({ country: "GB", basis: "country_only" });
  });
});

describe("classifyWorkTypes", () => {
  it("lets bigger scopes supersede like-for-like", () => {
    expect(classifyWorkTypes("replace electrical panel 200 amp")).toEqual(["electrical_service"]);
  });
  it("detects multiple independent scopes", () => {
    const t = classifyWorkTypes("water heater replacement and gas line");
    expect(t).toContain("water_heater");
    expect(t).toContain("gas_work");
  });
  it("returns empty for empty input", () => expect(classifyWorkTypes("")).toEqual([]));
});

describe("evaluateJob", () => {
  it("flags panel upgrade as permit + inspection", () => {
    const r = evaluateJob(job({ serviceType: "Electrical panel upgrade" }));
    expect(r.permitLikelihood).toBe("likely_required");
    expect(r.items.map((i) => i.key)).toEqual(expect.arrayContaining(["permit.electrical_service", "inspection.electrical_service", "safety.lockout_tagout"]));
    expect(r.items[0].severity).toBe("blocker");
  });
  it("requires EPA 608 for refrigerant work", () => {
    expect(keys(job({ serviceType: "AC recharge - low refrigerant" }))).toContain("licensing.epa_608");
  });
  it("makes 811 a blocker when excavation is mentioned", () => {
    const r = evaluateJob(job({ serviceType: "Sewer line replacement", dispatchNote: "trench across yard" }));
    expect(r.items.find((i) => i.key === "safety.call_811")?.severity).toBe("blocker");
  });
  it("adds California-specific notes only in CA", () => {
    const ca = keys(job({ serviceType: "Water heater replacement", address: "1 Pine St, San Diego, CA 92101" }));
    const tx = keys(job({ serviceType: "Water heater replacement" }));
    expect(ca).toContain("state.ca.wh_strapping");
    expect(tx).not.toContain("state.ca.wh_strapping");
  });
  it("keeps routine maintenance quiet", () => {
    const r = evaluateJob(job({ serviceType: "Seasonal AC tune-up" }));
    expect(r.permitLikelihood).toBe("unlikely");
    expect(r.items.some((i) => i.severity === "blocker")).toBe(false);
  });
  it("applies UK rules for a GB address", () => {
    const r = evaluateJob(job({ serviceType: "Boiler replacement", address: "10 High St, London SW1A 1AA", countryHint: "GB" }));
    expect(r.items.map((i) => i.key)).toContain("gb.gas_safe");
    expect(r.items.some((i) => i.key.startsWith("permit.water_heater"))).toBe(false);
  });
  it("never reports all-clear for an unknown country on regulated work", () => {
    const r = evaluateJob(job({ serviceType: "Panel upgrade", address: "Calle 5, Madrid", countryHint: "ES" }));
    expect(r.items.map((i) => i.key)).toContain("generic.verify_local");
  });
  it("adds commercial and emergency items", () => {
    const k = keys(job({ serviceType: "Furnace replacement", customerType: "commercial", isEmergency: true }));
    expect(k).toEqual(expect.arrayContaining(["documentation.commercial_access_coi", "permit.emergency_work"]));
  });
  it("is deterministic", () => {
    const f = job({ serviceType: "EV charger install" });
    expect(evaluateJob(f)).toEqual(evaluateJob(f));
  });
  it("permitLikelihoodFor takes the strictest", () => {
    expect(permitLikelihoodFor(["maintenance", "gas_work"])).toBe("likely_required");
    expect(permitLikelihoodFor([])).toBe("unknown");
  });
});
