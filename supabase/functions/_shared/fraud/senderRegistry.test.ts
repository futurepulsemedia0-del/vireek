import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_PATTERNS, SENDER_REGISTRY } from "./senderRegistry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // supabase/functions
const SELF = ["_shared/fraud/senderRegistry.ts"]; // contains the patterns as strings

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(relative(ROOT, p).split("\\").join("/"));
  }
  return out;
}

const files = walk(ROOT);
const byPath = new Map(SENDER_REGISTRY.map((e) => [e.path, e]));

describe("outbound sender coverage (no customer-driven sender reaches Twilio/Vapi without the guard)", () => {
  it("every file that can reach a provider is classified in SENDER_REGISTRY", () => {
    const unclassified = files.filter((f) => !SELF.includes(f) && !byPath.has(f) && PROVIDER_PATTERNS.some((re) => re.test(readFileSync(join(ROOT, f), "utf8"))));
    expect(unclassified).toEqual([]);
  });

  it("every registry path exists (no stale entries) and has a unique entry", () => {
    const missing = SENDER_REGISTRY.filter((e) => !files.includes(e.path)).map((e) => e.path);
    expect(missing).toEqual([]);
    expect(new Set(SENDER_REGISTRY.map((e) => e.path)).size).toBe(SENDER_REGISTRY.length);
  });

  it("every customer_outbound (and guarded adapter) file contains its guard marker", () => {
    const lacking = SENDER_REGISTRY.filter((e) => e.guard && !readFileSync(join(ROOT, e.path), "utf8").includes(e.guard)).map((e) => `${e.path} -> ${e.guard}`);
    expect(lacking).toEqual([]);
    expect(SENDER_REGISTRY.filter((e) => e.class === "customer_outbound" && !e.guard)).toEqual([]);
  });

  it("every exemption states why it is exempt", () => {
    for (const e of SENDER_REGISTRY.filter((x) => x.class !== "customer_outbound")) expect(e.reason.length).toBeGreaterThan(10);
  });

  it("no customer-driven sender calls the raw deliver.ts sendSms/sendVoiceCall on a customer number", () => {
    // Raw calls are only allowed in files classified as system_internal / provider_adapter / in_call_helper, or in the few
    // customer_outbound files that ALSO send staff alerts (each of those uses sendGuardedSms for customers).
    // first-call-start texts a "your number is ready" notice to the number the owner typed, behind gateDestinationOnly.
    const mixedStaffAndCustomer = new Set(["self-healing-orchestrator/index.ts", "emergency-ops-broadcast/index.ts", "first-call-start/index.ts"]);
    const offenders = SENDER_REGISTRY.filter((e) => e.class === "customer_outbound" && !mixedStaffAndCustomer.has(e.path))
      .filter((e) => /await\s+(?:sendSms|sendVoiceCall)\(/.test(readFileSync(join(ROOT, e.path), "utf8")))
      .map((e) => e.path);
    expect(offenders).toEqual([]);
  });

  it("both files that mix staff and customer traffic route the customer side through sendGuardedSms", () => {
    for (const p of ["self-healing-orchestrator/index.ts", "emergency-ops-broadcast/index.ts"]) {
      expect(readFileSync(join(ROOT, p), "utf8")).toContain("sendGuardedSms(");
    }
  });

  it("every Vapi /call request body in a guarded sender carries maxDurationSeconds", () => {
    const vapiCallers = SENDER_REGISTRY.filter((e) => e.class === "customer_outbound" || e.path.endsWith("vapiEngine.ts"))
      .filter((e) => /api\.vapi\.ai\/call|VAPI_CALL_URL/.test(readFileSync(join(ROOT, e.path), "utf8")));
    expect(vapiCallers.length).toBeGreaterThan(3);
    for (const e of vapiCallers) expect(readFileSync(join(ROOT, e.path), "utf8")).toContain("maxDurationSeconds");
  });
});
