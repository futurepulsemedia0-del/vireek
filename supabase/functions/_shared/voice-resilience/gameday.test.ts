// In-process game-day simulation: a simulated clock drives the REAL breaker + component mapping + ladder code
// with scripted fault outcomes, the same functions voice-health-tick runs. It proves the control logic and measures
// detect / mitigate / recover times in SIMULATED minutes (tick = 60 s, like the cron). It does NOT exercise vendors,
// Twilio or Postgres: those drills are scripted in docs/runbooks/voice-resilience.md and must be run in staging.

import { describe, expect, it } from "vitest";
import { DEFAULT_BREAKER, INITIAL_BREAKER, evaluateBreaker, type BreakerSnapshot, type Outcome } from "./circuitBreaker.ts";
import { componentsFromScores, DEFAULT_LADDER, initialLadder, stepLadder, targetLevel, type Level } from "./ladder.ts";

type Fault = { key: string; ok: boolean; latencyMs: number };
interface Result { levels: Level[]; firstWorse: number | null; firstRecovered: number | null; maxLevel: Level }

function drill(opts: { faults: Fault[]; faultMinutes: number; totalMinutes: number; healthyKeys?: string[] }): Result {
  const keys = ["vapi|voice_engine", "twilio|carrier", "twilio|sms", "telnyx|sms", "tools|tools", ...(opts.healthyKeys ?? [])];
  const snaps = new Map<string, BreakerSnapshot>(keys.map((k) => [k, INITIAL_BREAKER]));
  const history = new Map<string, Outcome[]>(keys.map((k) => [k, []]));
  let ladder = initialLadder(0);
  const levels: Level[] = [];
  let firstWorse: number | null = null, firstRecovered: number | null = null;

  for (let m = 1; m <= opts.totalMinutes; m++) {
    const now = m * 60_000;
    for (const k of keys) {
      const f = opts.faults.find((x) => x.key === k);
      const faulty = !!f && m <= opts.faultMinutes;
      // 6 probe samples per tick (health probe + real traffic)
      for (let i = 0; i < 6; i++) history.get(k)!.push({ at: now - i * 5000, ok: faulty ? f!.ok : true, latencyMs: faulty ? f!.latencyMs : 150 });
    }
    const scores: Record<string, number> = {};
    for (const k of keys) {
      const r = evaluateBreaker(snaps.get(k)!, history.get(k)!, now, DEFAULT_BREAKER);
      snaps.set(k, r.snapshot); scores[k] = r.score;
    }
    const step = stepLadder(ladder, targetLevel(componentsFromScores(scores)), now, DEFAULT_LADDER);
    ladder = step.state; levels.push(ladder.level);
    if (firstWorse === null && ladder.level > 0) firstWorse = m;
    if (firstWorse !== null && firstRecovered === null && m > opts.faultMinutes && ladder.level === 0) firstRecovered = m;
  }
  return { levels, firstWorse, firstRecovered, maxLevel: Math.max(...levels) as Level };
}

describe("game-day drills (simulated clock)", () => {
  it("Drill 1 - kill the engine webhook/API: mitigated to L2 within 3 min, never silent, recovers one level at a time", () => {
    const r = drill({ faults: [{ key: "vapi|voice_engine", ok: false, latencyMs: 50 }], faultMinutes: 10, totalMinutes: 40 });
    expect(r.firstWorse).not.toBeNull(); expect(r.firstWorse!).toBeLessThanOrEqual(3);
    expect(r.maxLevel).toBe(2);
    expect(r.firstRecovered).not.toBeNull(); expect(r.firstRecovered!).toBeLessThanOrEqual(30);
    // recovery never skips a level downwards
    for (let i = 1; i < r.levels.length; i++) expect(r.levels[i - 1] - r.levels[i]).toBeLessThanOrEqual(1);
  });
  it("Drill 2 - engine latency spike (9 s p95): treated as unhealthy via breaker latency rule", () => {
    const r = drill({ faults: [{ key: "vapi|voice_engine", ok: true, latencyMs: 9000 }], faultMinutes: 8, totalMinutes: 40 });
    expect(r.maxLevel).toBeGreaterThanOrEqual(1);
    expect(r.firstRecovered).not.toBeNull();
  });
  it("Drill 3 - expired engine key (every call 401): same as engine down", () => {
    const r = drill({ faults: [{ key: "vapi|voice_engine", ok: false, latencyMs: 80 }], faultMinutes: 6, totalMinutes: 30 });
    expect(r.maxLevel).toBe(2);
  });
  it("Drill 4 - tools/DB slow or failing: reduced AI (L1), not voicemail", () => {
    const r = drill({ faults: [{ key: "tools|tools", ok: false, latencyMs: 100 }], faultMinutes: 8, totalMinutes: 40 });
    expect(r.maxLevel).toBe(1);
    expect(r.firstRecovered).not.toBeNull();
  });
  it("Drill 5 - primary SMS down: owner alerting survives via the secondary; ladder stays at L0", () => {
    const r = drill({ faults: [{ key: "twilio|sms", ok: false, latencyMs: 50 }], faultMinutes: 10, totalMinutes: 20 });
    expect(r.maxLevel).toBe(0);
  });
  it("Drill 6 - ALL SMS down plus engine down: forward to a human (L3) because nobody can be texted", () => {
    const r = drill({ faults: [{ key: "vapi|voice_engine", ok: false, latencyMs: 50 }, { key: "twilio|sms", ok: false, latencyMs: 50 }, { key: "telnyx|sms", ok: false, latencyMs: 50 }], faultMinutes: 10, totalMinutes: 40 });
    expect(r.maxLevel).toBe(3);
  });
  it("Drill 7 - carrier API down plus engine down: L4 static message", () => {
    const r = drill({ faults: [{ key: "vapi|voice_engine", ok: false, latencyMs: 50 }, { key: "twilio|carrier", ok: false, latencyMs: 50 }], faultMinutes: 10, totalMinutes: 50 });
    expect(r.maxLevel).toBe(4);
  });
  it("A 1-minute outage causes one bounded excursion, not flapping", () => {
    const r = drill({ faults: [{ key: "vapi|voice_engine", ok: false, latencyMs: 50 }], faultMinutes: 1, totalMinutes: 30 });
    const transitions = r.levels.filter((l, i) => i > 0 && l !== r.levels[i - 1]).length;
    const degradedMinutes = r.levels.filter((l) => l > 0).length;
    expect(transitions).toBeLessThanOrEqual(3); // 0 -> 2 -> 1 -> 0
    expect(degradedMinutes).toBeLessThanOrEqual(15); // honest cost of hysteresis: ~10 min of reduced service after a 1 min outage
    expect(r.levels[r.levels.length - 1]).toBe(0);
  });
});
