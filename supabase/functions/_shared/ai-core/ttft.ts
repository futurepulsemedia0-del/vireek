// supabase/functions/_shared/ai-core/ttft.ts
// Time-to-first-token tracking for streamed LLM responses. Pure and clock-injectable so it is unit-testable.

export interface TtftTracker {
  /** Call for every streamed delta. Returns true only for the first NON-EMPTY delta. */
  markDelta(delta: string): boolean;
  readonly firstTokenMs: number | undefined;
  readonly sentAnything: boolean;
}

export function createTtftTracker(startMs: number, now: () => number = Date.now): TtftTracker {
  let first: number | undefined;
  return {
    markDelta(delta: string): boolean {
      if (!delta || first !== undefined) return false;
      first = Math.max(0, now() - startMs);
      return true;
    },
    get firstTokenMs() { return first; },
    get sentAnything() { return first !== undefined; },
  };
}
