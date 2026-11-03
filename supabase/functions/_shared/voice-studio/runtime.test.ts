import { describe, expect, it } from "vitest";
import { resolveVoiceOverride } from "./runtime.ts";
import { parseArms, buildArms } from "./experiment.ts";
import { parseVoiceMap } from "./catalog.ts";

type Row = Record<string, unknown>;
function fakeAdmin(tables: Record<string, Row[]>, opts: { throwOn?: string } = {}) {
  return {
    from(name: string) {
      if (opts.throwOn === name) throw new Error("boom");
      let rows = tables[name] ?? (tables[name] = []);
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return b; },
        is: (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return b; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        insert: async (row: Row) => {
          const all = tables[name];
          if (name === "voice_experiment_assignments" && all.some((r) => r.experiment_id === row.experiment_id && r.call_id === row.call_id)) {
            return { error: { code: "23505" } };
          }
          all.push(row);
          return { error: null };
        },
      };
      return b;
    },
  };
}

const MAP = JSON.stringify({ "sarah-warm-f-us": "vid-sarah", "miles-confident-m-us": "vid-miles" });
const env = (over: Record<string, string> = {}) => (k: string) => ({ VOICE_STUDIO_RUNTIME: "on", VOICE_STUDIO_VOICE_MAP: MAP, ...over } as Record<string, string>)[k];
const base = () => ({
  business_profile: [{ user_id: "u1", custom_voice_status: "none", custom_voice_id: null }],
  voice_studio_profiles: [{ user_id: "u1", location_id: null, scenario: "default", voice_key: "sarah-warm-f-us", tuning: { speed: 1.1 } }],
  voice_experiments: [] as Row[],
  voice_experiment_assignments: [] as Row[],
});
const running = (): Row => ({
  id: "e1", user_id: "u1", location_id: null, status: "running",
  arms: [{ key: "a", weight: 1, voiceKey: "sarah-warm-f-us" }, { key: "b", weight: 1, voiceKey: "miles-confident-m-us" }],
});

describe("runtime voice override", () => {
  it("is inert unless the flag is on", async () => {
    expect(await resolveVoiceOverride(fakeAdmin(base()), "u1", "c1", env({ VOICE_STUDIO_RUNTIME: "off" }))).toBe(null);
  });
  it("uses the saved Standard voice and tuning", async () => {
    const r = await resolveVoiceOverride(fakeAdmin(base()), "u1", "c1", env());
    expect(r?.voice.voiceId).toBe("vid-sarah");
    expect(r?.voice.speed).toBe(1.1);
    expect(r?.experiment).toBeUndefined();
  });
  it("returns null with no saved profile or unmapped voice", async () => {
    const t = base(); t.voice_studio_profiles = [];
    expect(await resolveVoiceOverride(fakeAdmin(t), "u1", "c1", env())).toBe(null);
    expect(await resolveVoiceOverride(fakeAdmin(base()), "u1", "c1", env({ VOICE_STUDIO_VOICE_MAP: "{}" }))).toBe(null);
  });
  it("never overrides a ready cloned voice", async () => {
    const t = base(); t.business_profile = [{ user_id: "u1", custom_voice_status: "ready", custom_voice_id: "clone1" }];
    expect(await resolveVoiceOverride(fakeAdmin(t), "u1", "c1", env())).toBe(null);
  });
  it("assigns experiment arms stickily and records one row per call", async () => {
    const t = base(); t.voice_experiments = [running()];
    const admin = fakeAdmin(t);
    const first = await resolveVoiceOverride(admin, "u1", "call-42", env());
    const again = await resolveVoiceOverride(admin, "u1", "call-42", env());
    expect(first?.experiment?.arm).toBe(again?.experiment?.arm);
    expect(t.voice_experiment_assignments.length).toBe(1);
  });
  it("uses both arms across many calls and maps arm to voice", async () => {
    const t = base(); t.voice_experiments = [running()];
    const admin = fakeAdmin(t);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const r = await resolveVoiceOverride(admin, "u1", `c${i}`, env());
      seen.add(`${r?.experiment?.arm}:${r?.voice.voiceId}`);
    }
    expect(seen).toEqual(new Set(["a:vid-sarah", "b:vid-miles"]));
  });
  it("ignores another tenant's experiment and malformed arms", async () => {
    const t = base(); t.voice_experiments = [{ ...running(), user_id: "u2" }];
    expect((await resolveVoiceOverride(fakeAdmin(t), "u1", "c1", env()))?.experiment).toBeUndefined();
    const t2 = base(); t2.voice_experiments = [{ ...running(), arms: [{ key: "a", weight: 1, voiceKey: "nope" }] }];
    expect((await resolveVoiceOverride(fakeAdmin(t2), "u1", "c1", env()))?.voice.voiceId).toBe("vid-sarah");
  });
  it("fails open when the database throws", async () => {
    expect(await resolveVoiceOverride(fakeAdmin(base(), { throwOn: "voice_studio_profiles" }), "u1", "c1", env())).toBe(null);
  });
});

describe("arm + map parsing", () => {
  it("accepts valid arms and rejects duplicates, bad voices, bad counts", () => {
    expect(parseArms(running().arms)?.length).toBe(2);
    expect(parseArms([{ key: "a", weight: 1, voiceKey: "sarah-warm-f-us" }, { key: "b", weight: 1, voiceKey: "sarah-warm-f-us" }])).toBe(null);
    expect(parseArms([{ key: "a", weight: 1, voiceKey: "sarah-warm-f-us" }])).toBe(null);
    expect(parseArms("x")).toBe(null);
  });
  it("buildArms generates keys and defaults weights", () => {
    expect(buildArms([{ voiceKey: "sarah-warm-f-us" }, { voiceKey: "miles-confident-m-us" }])?.map((a) => a.key)).toEqual(["a", "b"]);
    expect(buildArms([{ voiceKey: "sarah-warm-f-us" }])).toBe(null);
  });
  it("parseVoiceMap ignores junk", () => {
    expect(parseVoiceMap("not json")).toEqual({});
    expect(parseVoiceMap('{"sarah-warm-f-us":" x ","evil":"y"}')).toEqual({ "sarah-warm-f-us": "x" });
  });
});
