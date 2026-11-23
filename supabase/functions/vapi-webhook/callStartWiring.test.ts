// Static regression guard for the call-start / recording wiring in vapi-webhook/index.ts.
// It cannot prove provider timing (see docs/compliance/call-recording-vendor-capability.md section 5), but it fails
// if someone removes or reorders the pieces that make the disclosure + recording notice precede everything else.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "supabase/functions/vapi-webhook/index.ts"), "utf8");

function between(start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a, `missing: ${start}`).toBeGreaterThan(-1);
  const b = src.indexOf(end, a);
  expect(b, `missing: ${end}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("assistant-request: disclosure and recording plan", () => {
  const body = between("async function handleAssistantRequest(", "// Surge Mode");

  it("builds the plan from the AI disclosure plan before any response is returned", () => {
    const plan = body.indexOf("buildCallStartPlan(");
    const disclosure = body.indexOf("planDisclosure(");
    const firstReturn = body.indexOf("return jsonResponse({\n    assistantId");
    expect(disclosure).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(disclosure);
    expect(firstReturn).toBeGreaterThan(plan);
    expect(body).toContain("aiDisclosureText: disclosurePlan?.text");
  });

  it("writes the consent ledger row for the call", () => {
    expect(body).toContain("recordCallStartPlan(admin");
  });

  it("single-assistant response takes the first message and recording flag from the plan", () => {
    expect(body).toContain("...planOverrides(callStart)");
    expect(body).not.toMatch(/firstMessage:\s*disclosurePlan\s*\?/);
  });

  it("squad response also takes them from the plan", () => {
    expect(body).toContain("applyPlanToSquad(buildAgentSquad(");
  });

  it("the prompt variable comes from the plan, not from the legacy area-code notice", () => {
    expect(body).toContain("recording_consent_context: callStart.promptContext");
    expect(src).not.toContain("buildRecordingConsentNotice(");
  });

  it("recording mode comes from CALL_RECORDING_GATE_MODE and defaults to shadow", () => {
    expect(body).toContain('parseGateMode(Deno.env.get("CALL_RECORDING_GATE_MODE"))');
  });
});

describe("end-of-call-report: nothing refused is stored", () => {
  it("finalizes the consent outcome before the call row is assembled", () => {
    const fin = src.indexOf("finalizeCallRecording(admin");
    const assign = src.indexOf("transcript: keepTranscript ? transcript : null");
    expect(fin).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(fin);
  });
  it("suppresses recording_url and transcript from the decision", () => {
    expect(src).toContain("recording_url: pci.spokenCardDetected || !keepRecording ? null : recordingUrl");
    expect(src).toContain("transcript: keepTranscript ? transcript : null");
  });
});
