import { describe, expect, it } from "vitest";
import { VapiEngine } from "./vapiEngine.ts";
import { dialTwiml } from "../call-bridge/logic.ts";

function engine(): { e: VapiEngine; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const e = new VapiEngine({ apiKey: "k", fetchImpl: async (_u, i) => { bodies.push(JSON.parse(String(i?.body))); return new Response(JSON.stringify({ id: "call_1" }), { status: 201 }); } });
  return { e, bodies };
}
const base = { ownerId: "o", assistantId: "a", phoneNumberId: "p", customerNumber: "+12125550123", variableValues: { customer_name: "Ann" } };

describe("duration cap in the provider payload", () => {
  it("Vapi: maxDurationSeconds is sent in assistantOverrides when provided", async () => {
    const { e, bodies } = engine();
    await e.startCall({ ...base, maxDurationSeconds: 900 });
    expect((bodies[0].assistantOverrides as { maxDurationSeconds: number }).maxDurationSeconds).toBe(900);
    expect((bodies[0].assistantOverrides as { variableValues: unknown }).variableValues).toEqual({ customer_name: "Ann" });
  });
  it("Vapi: without a cap the request is byte-identical to the legacy body", async () => {
    const { e, bodies } = engine();
    await e.startCall(base);
    expect(JSON.stringify(bodies[0])).toBe(JSON.stringify({ assistantId: "a", phoneNumberId: "p", customer: { number: "+12125550123" }, assistantOverrides: { variableValues: { customer_name: "Ann" } } }));
  });
  it("Twilio <Dial>: timeLimit attribute is present only when requested and is clamped", () => {
    const args = { callerId: "+12125550100", number: "+12125550123", action: "https://x.test/a" };
    expect(dialTwiml(args)).not.toContain("timeLimit");
    expect(dialTwiml({ ...args, timeLimit: 900 })).toContain('timeLimit="900"');
    expect(dialTwiml({ ...args, timeLimit: 3 })).toContain('timeLimit="10"');
  });
});
