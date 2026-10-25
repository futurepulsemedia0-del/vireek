import { describe, expect, it } from "vitest";
import { compareDisclosureToFirstMessage } from "./drift.ts";

const D = "This call is answered by an AI voice assistant, not a live person.";

describe("compareDisclosureToFirstMessage", () => {
  it("in sync: first message starts with the disclosure", () => {
    expect(compareDisclosureToFirstMessage(D, `${D} Thanks for calling Acme.`).status).toBe("in_sync");
  });
  it("in sync despite punctuation / case differences", () => {
    expect(compareDisclosureToFirstMessage(D, "this call is answered by an AI voice assistant not a live person - hi!").status).toBe("in_sync");
  });
  it("in sync when the first message uses {{ai_disclosure}} at the start", () => {
    const r = compareDisclosureToFirstMessage(D, "{{ ai_disclosure }} Thanks for calling Acme.");
    expect(r).toMatchObject({ status: "in_sync", reason: "uses_dynamic_variable" });
  });
  it("drift: disclosure removed from the live message", () => {
    expect(compareDisclosureToFirstMessage(D, "Hi, thanks for calling Acme Heating, how can I help?")).toMatchObject({ status: "drift", reason: "disclosure_missing" });
  });
  it("drift: wording edited in the script but not in Vapi", () => {
    const r = compareDisclosureToFirstMessage("Please note you are speaking with an AI assistant.", D);
    expect(r.status).toBe("drift");
  });
  it("drift: disclosure buried after a long greeting", () => {
    const long = `Hello and welcome to Acme Heating and Cooling, serving the whole valley since nineteen eighty five. ${D}`;
    expect(compareDisclosureToFirstMessage(D, long)).toMatchObject({ status: "drift", reason: "disclosure_not_at_start" });
  });
  it("no first message", () => {
    expect(compareDisclosureToFirstMessage(D, null).status).toBe("no_first_message");
    expect(compareDisclosureToFirstMessage(D, "   ").status).toBe("no_first_message");
  });
});
