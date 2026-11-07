// supabase/functions/_shared/economics/loopDetector.ts
//
// Runaway-loop detection: the same (tool|prompt) key repeated more than `maxRepeats` times inside one run
// within `windowMs`. Pure and import-free. A tripped loop should feed the agent run limits (stop the run,
// hand off); it must NEVER be applied to emergency handling (callers pass isEmergency).

export interface LoopConfig { maxRepeats: number; windowMs: number }
export interface LoopVerdict { tripped: boolean; key: string; count: number; reason: "ok" | "repeat_limit" | "emergency_exempt" }

export class LoopDetector {
  private seen = new Map<string, number[]>();
  private cfg: LoopConfig;
  constructor(cfg: LoopConfig) {
    if (!(cfg.maxRepeats >= 1) || !(cfg.windowMs > 0)) throw new RangeError("invalid loop config");
    this.cfg = cfg;
  }
  record(runId: string, key: string, nowMs: number, isEmergency = false): LoopVerdict {
    const k = `${runId}\u0000${key}`;
    const arr = (this.seen.get(k) ?? []).filter((t) => nowMs - t <= this.cfg.windowMs);
    arr.push(nowMs);
    this.seen.set(k, arr);
    if (isEmergency) return { tripped: false, key, count: arr.length, reason: "emergency_exempt" };
    return arr.length > this.cfg.maxRepeats
      ? { tripped: true, key, count: arr.length, reason: "repeat_limit" }
      : { tripped: false, key, count: arr.length, reason: "ok" };
  }
  clearRun(runId: string): void {
    for (const k of this.seen.keys()) if (k.startsWith(`${runId}\u0000`)) this.seen.delete(k);
  }
}
