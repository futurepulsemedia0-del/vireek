import { describe, expect, it } from "vitest";
import {
  OUTBOUND_COMPLIANCE_LANGUAGES, OUTBOUND_FALLBACK_LANGUAGE, RECORDING_SCRIPT_LANGUAGES, SERVER_AI_DISCLOSURE_KEY,
  SERVER_RECORDING_CONSENT_KEY, isOutboundComplianceLanguage, outboundComplianceBlockers, outboundComplianceKeys,
  outboundComplianceLanguage, serverComplianceKeys,
} from "./outboundCompliance.ts";
import { CONSENT_SCRIPTS } from "../compliance/recordingProfiles.ts";
import { SUPPORTED_LANGUAGES } from "./languages.ts";

describe("outbound compliance language gate", () => {
  it("ships with English only until a reviewer signs other languages off", () => {
    expect([...OUTBOUND_COMPLIANCE_LANGUAGES]).toEqual(["en"]);
  });
  it("English is always allowed; unknown / empty / non-string values never are", () => {
    expect(isOutboundComplianceLanguage("en", [])).toBe(true);
    for (const v of [null, undefined, "", "xx", "ES", 5 as unknown as string]) expect(isOutboundComplianceLanguage(v, ["en"])).toBe(false);
  });
  it("serves the requested language only when it is cleared, otherwise English", () => {
    expect(outboundComplianceLanguage("es", ["en"])).toBe(OUTBOUND_FALLBACK_LANGUAGE);
    expect(outboundComplianceLanguage("es", ["en", "es"])).toBe("es");
    expect(outboundComplianceLanguage(null)).toBe("en");
  });
  it("only languages that have a recording-consent script need it reviewed (others use English)", () => {
    expect(serverComplianceKeys("es")).toEqual([SERVER_AI_DISCLOSURE_KEY, SERVER_RECORDING_CONSENT_KEY]);
    expect(serverComplianceKeys("ja")).toEqual([SERVER_AI_DISCLOSURE_KEY]);
    expect(serverComplianceKeys("en")).toEqual([]);
  });
  it("RECORDING_SCRIPT_LANGUAGES matches the scripts recordingProfiles.ts actually ships", () => {
    expect([...RECORDING_SCRIPT_LANGUAGES].sort()).toEqual(Object.keys(CONSENT_SCRIPTS).sort());
  });
  it("lists blockers until every required id is in the reviewed manifest; English never blocks", () => {
    const ids = ["common.aiDisclosure.chatNotice", "voiceLog.recording"];
    expect(outboundComplianceBlockers("en", ids, undefined)).toEqual([]);
    expect(outboundComplianceBlockers("es", ids, undefined)).toEqual(outboundComplianceKeys("es", ids));
    expect(outboundComplianceBlockers("es", ids, [...ids, SERVER_AI_DISCLOSURE_KEY])).toEqual([SERVER_RECORDING_CONSENT_KEY]);
    expect(outboundComplianceBlockers("es", ids, [...ids, SERVER_AI_DISCLOSURE_KEY, SERVER_RECORDING_CONSENT_KEY])).toEqual([]);
    expect(outboundComplianceBlockers("ja", ids, [...ids, SERVER_AI_DISCLOSURE_KEY])).toEqual([]);
  });
  it("every enabled language is a supported customer language", () => {
    for (const l of OUTBOUND_COMPLIANCE_LANGUAGES) expect(SUPPORTED_LANGUAGES as readonly string[]).toContain(l);
  });
});
