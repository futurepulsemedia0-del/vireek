import { describe, it, expect } from "vitest";
import {
  DEFAULT_ASSISTANT_VOICE_ID,
  DEFAULT_VOICE,
  VOICE_MAP,
  resolveVapiVoice,
  voiceOverride,
} from "./voiceMap.ts";
import { buildAgentSquad } from "../ai-core/agentOrchestration.ts";

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Drift guard: the picker, the DB CHECK constraint and VOICE_MAP must list the same ids.
// Paths are relative to the repo root (vitest's cwd).
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const quotedIds = (block: string) => [...block.matchAll(/'([a-z]+-[a-z]+-[mf]-(?:us|uk))'/g)].map((m) => m[1]).sort();

describe("VOICE_MAP drift guard", () => {
  it("matches VOICE_OPTIONS in AssistantPersonaPage.tsx", () => {
    const src = read("src/pages/AssistantPersonaPage.tsx");
    const block = src.slice(src.indexOf("const VOICE_OPTIONS"), src.indexOf("const TONE_OPTIONS"));
    expect(quotedIds(block)).toEqual(Object.keys(VOICE_MAP).sort());
  });

  it("matches the assistant_voice CHECK constraint in the migration", () => {
    const sql = read("supabase/migrations/20260911060000_add_business_profile_assistant_persona.sql");
    const start = sql.indexOf("CHECK (assistant_voice IN (");
    const block = sql.slice(start, sql.indexOf("))", start));
    expect(quotedIds(block)).toEqual(Object.keys(VOICE_MAP).sort());
  });
});

// Must match VOICE_OPTIONS (src/pages/AssistantPersonaPage.tsx) and the DB CHECK constraint.
const PICKER_IDS = [
  "sarah-warm-f-us",
  "aria-friendly-f-us",
  "maya-calm-f-uk",
  "miles-confident-m-us",
  "jay-easygoing-m-us",
  "oliver-polished-m-uk",
];

describe("VOICE_MAP", () => {
  it("covers exactly the ids the dashboard picker / DB constraint allow", () => {
    expect(Object.keys(VOICE_MAP).sort()).toEqual([...PICKER_IDS].sort());
  });

  it("gives every id a complete Vapi config", () => {
    for (const id of PICKER_IDS) {
      const v = VOICE_MAP[id];
      expect(v.provider).toBe("vapi");
      expect(v.voiceId).toMatch(/^[A-Z][a-z]+$/);
      expect(v.version === undefined || v.version === 2).toBe(true);
    }
  });

  it("uses a different voice for each picker option", () => {
    const ids = PICKER_IDS.map((id) => VOICE_MAP[id].voiceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the documented gender/accent for the male options", () => {
    expect(VOICE_MAP["oliver-polished-m-uk"].voiceId).toBe("Dan"); // Vapi's British male voice
    expect(VOICE_MAP["oliver-polished-m-uk"].version).toBeUndefined(); // Dan has no V2
  });

  it("default matches the DB default id", () => {
    expect(DEFAULT_ASSISTANT_VOICE_ID).toBe("sarah-warm-f-us");
    expect(DEFAULT_VOICE).toEqual(VOICE_MAP[DEFAULT_ASSISTANT_VOICE_ID]);
  });
});

describe("resolveVapiVoice", () => {
  it("maps known ids", () => {
    expect(resolveVapiVoice("miles-confident-m-us")).toEqual(VOICE_MAP["miles-confident-m-us"]);
    expect(resolveVapiVoice("oliver-polished-m-uk")).toEqual({ provider: "vapi", voiceId: "Dan" });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["unknown id", "not-a-real-voice"],
    ["wrong case", "SARAH-WARM-F-US"],
    ["non-string", 42],
    ["object", {}],
    ["Object.prototype key", "constructor"],
    ["__proto__", "__proto__"],
  ])("falls back to the default for %s", (_label, input) => {
    expect(resolveVapiVoice(input)).toEqual(DEFAULT_VOICE);
  });

  it("returns a fresh object so callers cannot mutate the shared map", () => {
    const a = resolveVapiVoice("jay-easygoing-m-us");
    a.voiceId = "Tampered";
    expect(resolveVapiVoice("jay-easygoing-m-us").voiceId).toBe("Nico");
    expect(VOICE_MAP["jay-easygoing-m-us"].voiceId).toBe("Nico");
  });
});

describe("voiceOverride", () => {
  it("wraps the voice for spreading into assistantOverrides", () => {
    const overrides = { ...voiceOverride("aria-friendly-f-us"), variableValues: { a: "b" } };
    expect(overrides.voice).toEqual(VOICE_MAP["aria-friendly-f-us"]);
    expect(overrides.variableValues).toEqual({ a: "b" });
  });

  it("uses the default voice for null", () => {
    expect(voiceOverride(null)).toEqual({ voice: DEFAULT_VOICE });
  });
});

describe("buildAgentSquad voice", () => {
  const vars = { caller_context: "x" };

  it("adds the voice to every squad member when given", () => {
    const { members } = buildAgentSquad("asst_1", "Sarah", vars, resolveVapiVoice("maya-calm-f-uk"));
    expect(members.length).toBeGreaterThan(1);
    for (const m of members) {
      expect(m.assistantId).toBe("asst_1");
      expect(m.assistantOverrides.voice).toEqual(VOICE_MAP["maya-calm-f-uk"]);
    }
  });

  it("leaves the assistant's own voice untouched when omitted", () => {
    const { members } = buildAgentSquad("asst_1", "Sarah", vars);
    for (const m of members) expect("voice" in m.assistantOverrides).toBe(false);
  });
});
