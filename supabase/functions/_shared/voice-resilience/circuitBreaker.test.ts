import { describe, expect, it } from "vitest";
import { DEFAULT_BREAKER, INITIAL_BREAKER, allowRequest, canaryBucket, cooldownMs, evaluateBreaker, healthScore, windowStats, type Outcome } from "./circuitBreaker.ts";

const T = 10_000_000;
const outs = (n: number, failEvery: number, at = T, lat = 200): Outcome[] => Array.from({ length: n }, (_, i) => ({ at: at - (n - i) * 1000, ok: failEvery === 0 ? true : (i + 1) % failEvery !== 0, latencyMs: lat }));

describe("circuit breaker", () => {
  it("stays closed under the sample floor even at 100% errors", () => {
    expect(evaluateBreaker(INITIAL_BREAKER, outs(4, 1), T).snapshot.state).toBe("closed");
  });
  it("opens on error rate", () => {
    const r = evaluateBreaker(INITIAL_BREAKER, outs(10, 2), T); // 50% errors
    expect(r.snapshot.state).toBe("open"); expect(r.score).toBe(0); expect(r.reason).toMatch(/error_rate/);
  });
  it("opens on p95 latency with zero errors", () => {
    const r = evaluateBreaker(INITIAL_BREAKER, outs(10, 0, T, 6000), T);
    expect(r.snapshot.state).toBe("open"); expect(r.reason).toMatch(/p95/);
  });
  it("stays open during cool-down, then half-opens", () => {
    const open = evaluateBreaker(INITIAL_BREAKER, outs(10, 2), T).snapshot;
    expect(evaluateBreaker(open, [], T + 1000).snapshot.state).toBe("open");
    expect(evaluateBreaker(open, [], T + DEFAULT_BREAKER.baseCooldownMs).snapshot.state).toBe("half_open");
  });
  it("closes after enough successful probes, ignoring stale pre-open failures", () => {
    const open = evaluateBreaker(INITIAL_BREAKER, outs(10, 2), T).snapshot;
    const half = evaluateBreaker(open, [], T + 40_000).snapshot;
    const stale = outs(10, 2); // old failures still inside the window
    const probes: Outcome[] = [1, 2, 3].map((i) => ({ at: half.halfOpenAt! + i * 1000, ok: true, latencyMs: 100 }));
    expect(evaluateBreaker(half, [...stale, ...probes], half.halfOpenAt! + 5000).snapshot.state).toBe("closed");
  });
  it("a failed probe re-opens with a longer cool-down", () => {
    const open = evaluateBreaker(INITIAL_BREAKER, outs(10, 2), T).snapshot;
    const half = evaluateBreaker(open, [], T + 40_000).snapshot;
    const re = evaluateBreaker(half, [{ at: half.halfOpenAt! + 1, ok: false }], half.halfOpenAt! + 2).snapshot;
    expect(re.state).toBe("open"); expect(re.consecutiveOpens).toBe(2);
    expect(cooldownMs(2, DEFAULT_BREAKER)).toBe(60_000);
    expect(cooldownMs(50, DEFAULT_BREAKER)).toBe(DEFAULT_BREAKER.maxCooldownMs);
  });
  it("score falls with errors and latency; half_open is capped", () => {
    const s = windowStats(outs(10, 5), T, DEFAULT_BREAKER.windowMs);
    expect(healthScore("closed", s)).toBeLessThan(100);
    expect(healthScore("half_open", windowStats([], T, 1))).toBeLessThanOrEqual(50);
    expect(healthScore("closed", windowStats([], T, 1))).toBe(100);
  });
  it("canary routing is deterministic and roughly proportional", () => {
    expect(canaryBucket("abc")).toBe(canaryBucket("abc"));
    const n = Array.from({ length: 2000 }, (_, i) => allowRequest("half_open", `call-${i}`, 10)).filter(Boolean).length;
    expect(n).toBeGreaterThan(120); expect(n).toBeLessThan(280);
    expect(allowRequest("open", "x", 100)).toBe(false); expect(allowRequest("closed", "x", 0)).toBe(true);
  });
});
