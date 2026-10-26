import { describe, it, expect } from "vitest";
import { classifyKeyword, helpText, isStopKeyword, optInAckText, optOutAckText, STOP_WORDS } from "./optOut.ts";

describe("classifyKeyword", () => {
  it("keeps exactly the STOP list sms-webhook has always used", () => {
    expect([...STOP_WORDS].sort()).toEqual(["CANCEL", "END", "QUIT", "STOP", "STOPALL", "UNSUBSCRIBE"]);
  });

  it.each(["STOP", "stop", " Stop ", "stop.", "STOP!", "Unsubscribe", "stopall", "QUIT", "cancel", "END", "​STOP​", "ＳＴＯＰ"])(
    "%j is a stop",
    (w) => expect(classifyKeyword(w)).toBe("stop"),
  );

  it.each(["START", "start", "Unstop"])("%j is a start", (w) => expect(classifyKeyword(w)).toBe("start"));
  it.each(["HELP", "help?", "info"])("%j is help", (w) => expect(classifyKeyword(w)).toBe("help"));

  it.each(["please stop by", "don't stop", "stop it now", "stopping", "I want to cancel my appointment", "yes", "", "   ", null, undefined])(
    "%j is not a keyword",
    (w) => expect(classifyKeyword(w as string)).toBeNull(),
  );

  it("isStopKeyword is a convenience over classifyKeyword", () => {
    expect(isStopKeyword("STOP")).toBe(true);
    expect(isStopKeyword("START")).toBe(false);
  });

  it("acknowledgement copy names the brand and the way back in/out", () => {
    expect(optOutAckText("Acme")).toContain("Reply START");
    expect(optInAckText("Acme")).toContain("Reply STOP");
    expect(helpText("Acme", "+15551112222")).toContain("+15551112222");
    expect(helpText("Acme")).not.toContain("call");
  });
});
