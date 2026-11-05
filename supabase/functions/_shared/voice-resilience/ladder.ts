// Degradation ladder. Pure.
//   L0 full AI -> L1 reduced AI -> L2 voicemail-to-text + instant alert -> L3 forward to a human -> L4 static message
// A call is never dropped silently: every level has a defined next level (see degradeFrom).
// Transitions use hysteresis: quick to get worse, slow to recover, one level at a time.

export type Level = 0 | 1 | 2 | 3 | 4;
export type Health = "healthy" | "degraded" | "down";

/** Component health as derived from breaker scores (see healthFromScore). */
export interface ComponentHealth {
  /** Voice engine incl. its ASR/TTS/LLM (one external vendor from our side). */
  engine: Health;
  /** Tools the full AI needs: CRM/calendar/booking/price lookups. */
  tools: Health;
  /** Our own voicemail path: Twilio <Record> + storage. */
  voicemail: Health;
  /** Owner alerting by SMS. "down" when every observed SMS provider is down (push/in-app are not instant enough). */
  notify: Health;
  /** A forwarding target exists and the carrier can dial out. */
  forward: Health;
}

export const ALL_HEALTHY: ComponentHealth = { engine: "healthy", tools: "healthy", voicemail: "healthy", notify: "healthy", forward: "healthy" };

export function healthFromScore(score: number | null | undefined, degradedBelow = 80, downBelow = 40): Health {
  if (score == null || !Number.isFinite(score)) return "healthy"; // no data is covered by the synthetic probe, not guessed down
  if (score < downBelow) return "down";
  if (score < degradedBelow) return "degraded";
  return "healthy";
}

/** Worst level the CURRENT component health justifies (before hysteresis). */
export function targetLevel(h: ComponentHealth): Level {
  if (h.engine === "healthy" && h.tools === "healthy") return 0;
  if (h.engine !== "down") return 1; // engine usable (maybe degraded) but tools unhealthy, or engine degraded: short prompt, no tools
  if (h.voicemail !== "down" && h.notify !== "down") return 2;
  if (h.forward !== "down") return 3;
  if (h.voicemail !== "down") return 2; // human not alertable, nobody to forward to: still capture the message
  return 4;
}

export interface LadderConfig {
  /** Worse target must persist this long before we step down (ms). 0 = immediate. */
  escalateAfterMs: number;
  /** Better target must persist this long before we recover ONE level (ms). */
  recoverAfterMs: number;
  /** Minimum time on a level before any recovery. */
  minDwellMs: number;
  /** Flap guard: after this many transitions in the last hour, recoveries are frozen (escalations never are). */
  maxTransitionsPerHour: number;
}

export const DEFAULT_LADDER: LadderConfig = { escalateAfterMs: 60_000, recoverAfterMs: 3 * 60_000, minDwellMs: 60_000, maxTransitionsPerHour: 6 };

export interface LadderState {
  level: Level;
  since: number;
  /** Candidate level currently being timed (worse or better than `level`). */
  pending: Level | null;
  pendingSince: number | null;
  /** Epoch ms of recent transitions (kept to 1h). */
  recent: number[];
  /** Operator pin. While set and unexpired, automation never changes the level. */
  pin: { level: Level; until: number; by: string } | null;
}

export const initialLadder = (now: number): LadderState => ({ level: 0, since: now, pending: null, pendingSince: null, recent: [], pin: null });

export interface LadderStep {
  state: LadderState;
  changed: boolean;
  from: Level;
  to: Level;
  reason: string;
}

export function stepLadder(prev: LadderState, target: Level, now: number, cfg: LadderConfig = DEFAULT_LADDER): LadderStep {
  const recent = prev.recent.filter((t) => t > now - 3_600_000);
  const base: LadderState = { ...prev, recent };
  const done = (state: LadderState, reason: string): LadderStep => ({
    state, changed: state.level !== prev.level, from: prev.level, to: state.level, reason,
  });
  const move = (level: Level, reason: string): LadderStep =>
    done({ ...base, level, since: now, pending: null, pendingSince: null, recent: [...recent, now] }, reason);

  if (prev.pin && prev.pin.until > now) return done({ ...base, level: prev.pin.level, pending: null, pendingSince: null }, `pinned by ${prev.pin.by}`);
  const expiredPin = prev.pin && prev.pin.until <= now ? { ...base, pin: null } : base;
  const cur = expiredPin;

  if (target === cur.level) return done({ ...cur, pending: null, pendingSince: null }, "stable");

  if (target > cur.level) {
    // Getting worse: act fast. The ladder jumps straight to the target (a dead engine must not walk L1 -> L2 over minutes).
    const since = cur.pending === target && cur.pendingSince != null ? cur.pendingSince : now;
    if (now - since >= cfg.escalateAfterMs) return move(target, `escalate to L${target}`);
    return done({ ...cur, pending: target, pendingSince: since }, `escalation to L${target} pending`);
  }

  // Recovering: one level at a time, after sustained health and minimum dwell, unless flapping.
  const next = (cur.level - 1) as Level;
  const goal = Math.max(target, next) as Level;
  const since = cur.pending === goal && cur.pendingSince != null ? cur.pendingSince : now;
  if (now - cur.since < cfg.minDwellMs) return done({ ...cur, pending: goal, pendingSince: since }, "min dwell");
  if (recent.length >= cfg.maxTransitionsPerHour) return done({ ...cur, pending: goal, pendingSince: since }, "flap guard: recovery frozen");
  if (now - since >= cfg.recoverAfterMs) return move(goal, `recover to L${goal}`);
  return done({ ...cur, pending: goal, pendingSince: since }, `recovery to L${goal} pending`);
}

/**
 * Per-call degrade: when a handler fails mid-call (e.g. engine dial returned failed/no-answer), the next level
 * to try for THAT call, independent of the org-wide level. Always strictly worse than `level` (until L4).
 */
export function degradeFrom(level: Level, h?: ComponentHealth): Level {
  if (level >= 4) return 4;
  const next = (level + 1) as Level;
  if (!h) return next;
  // Skip levels whose own dependency is known down.
  if (next === 2 && (h.voicemail === "down")) return h.forward !== "down" ? 3 : 4;
  if (next === 3 && h.forward === "down") return 4; // never step back up the ladder
  return next;
}

export const LEVEL_NAMES: Record<Level, string> = {
  0: "full_ai",
  1: "reduced_ai",
  2: "voicemail_alert",
  3: "forward_to_human",
  4: "static_message",
};

/**
 * Single source of truth for score -> component health (used by voice-health-tick AND the game-day simulation).
 * `scores` is keyed "provider|capability". Missing key = no data = healthy (the synthetic probe covers silence).
 */
export function componentsFromScores(scores: Record<string, number | undefined>): ComponentHealth {
  const hs = (k: string): Health => healthFromScore(scores[k]);
  const sms = Object.keys(scores).filter((k) => k.endsWith("|sms"));
  return {
    engine: hs("vapi|voice_engine"),
    tools: hs("tools|tools"),
    voicemail: hs("twilio|carrier"),
    // Owner alerting is "down" when EVERY observed SMS provider is down. A secondary with no data is not counted as
    // healthy-by-assumption: if only one provider is observed and it is down, a human must be reached by forwarding (L3).
    notify: sms.length > 0 && sms.every((k) => hs(k) === "down") ? "down" : "healthy",
    forward: hs("twilio|carrier"),
  };
}
