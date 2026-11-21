import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONSENT_TEXTS, CONSENT_TEXT_V1, CONSENT_TEXT_V2, CURRENT_CONSENT_TEXT, CURRENT_CONSENT_VERSION,
  consentTextFor, isKnownConsentVersion, sha256Hex,
} from "./consent.ts";

const MIGRATION = "supabase/migrations/20290306000000_voice_clone_retention_consent_versions.sql";
const dollar = (sql: string, tag: string) => new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(sql)?.[1];

describe("versioned consent text", () => {
  it("v1 is frozen (its hash must never change: old records point at it)", async () => {
    expect(await sha256Hex(CONSENT_TEXT_V1)).toBe(await sha256Hex(CONSENT_TEXTS.v1));
    expect(CONSENT_TEXT_V1.startsWith("I confirm that the voice in the sample I upload is my own")).toBe(true);
    expect(CONSENT_TEXT_V1).not.toContain("retention");
  });
  it("v2 states retention and automatic deletion; current is v2", () => {
    expect(CURRENT_CONSENT_VERSION).toBe("v2");
    expect(CURRENT_CONSENT_TEXT).toBe(CONSENT_TEXT_V2);
    expect(CONSENT_TEXT_V2).toContain("retention period I choose");
    expect(CONSENT_TEXT_V2).toContain("deleted automatically");
    expect(CONSENT_TEXT_V2).toContain("AI");
  });
  it("texts differ, so their hashes differ", async () => {
    expect(await sha256Hex(CONSENT_TEXT_V1)).not.toBe(await sha256Hex(CONSENT_TEXT_V2));
  });
  it("only own, known versions resolve", () => {
    expect(isKnownConsentVersion("v1")).toBe(true);
    expect(isKnownConsentVersion("v2")).toBe(true);
    for (const bad of ["v3", "", "toString", "__proto__", null, 2, undefined]) expect(isKnownConsentVersion(bad)).toBe(false);
    expect(consentTextFor("v2")).toBe(CONSENT_TEXT_V2);
    expect(consentTextFor("nope")).toBeNull();
  });
  it("the migration seeds exactly these texts (TS and SQL cannot drift)", () => {
    const sql = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
    expect(dollar(sql, "voice_v1")).toBe(CONSENT_TEXT_V1);
    expect(dollar(sql, "voice_v2")).toBe(CONSENT_TEXT_V2);
  });
});
