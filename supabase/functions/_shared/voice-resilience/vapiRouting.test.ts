import { describe, expect, it } from "vitest";
import { ladderResponse } from "./vapiRouting.ts";

const r = { reducedAssistantId: "asst_reduced_1", forwardTarget: "+15551230001", language: "en" as const };
describe("ladderResponse", () => {
  it("L0 proceeds normally", () => expect(ladderResponse(0, r)).toBeNull());
  it("L1 uses the reduced assistant", () => expect(ladderResponse(1, r, "ctx")).toEqual({ assistantId: "asst_reduced_1", assistantOverrides: { variableValues: { caller_context: "ctx" } } }));
  it("L2-L4 forward to a human when a target exists", () => {
    for (const l of [2, 3, 4] as const) expect(ladderResponse(l, r)).toMatchObject({ destination: { type: "number", number: "+15551230001" } });
  });
  it("L2+ without a target falls back to the reduced assistant", () => expect(ladderResponse(3, { ...r, forwardTarget: null })).toHaveProperty("assistantId", "asst_reduced_1"));
  it("nothing configured: never drops the call, keeps the full assistant", () => expect(ladderResponse(2, { ...r, forwardTarget: null, reducedAssistantId: null })).toBeNull());
  it("Spanish message", () => expect(JSON.stringify(ladderResponse(2, { ...r, language: "es" }))).toContain("asistente"));
});
