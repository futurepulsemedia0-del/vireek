// src/lib/soundIdentity.ts
//
// Vireek sonic logo + UI sounds, synthesized with Web Audio (no samples → no
// licensing exposure). OFF by default. Every sound has a visual/aria equivalent
// (delivered through `announce`, ALWAYS called) and a text caption for demos.

export const SOUND_EVENTS = ["logo", "incoming_call", "call_answered", "job_booked", "payment_received", "error"] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

export interface Note { freq: number; start: number; dur: number; gain: number; type: OscillatorType }

/** Raw motifs (gains are relative; normalized below so all events have equal RMS loudness). */
const RAW: Record<SoundEvent, Note[]> = {
  logo: [
    { freq: 659.25, start: 0.0, dur: 0.5, gain: 1, type: "sine" },
    { freq: 880.0, start: 0.28, dur: 0.5, gain: 1, type: "sine" },
    { freq: 1318.5, start: 0.56, dur: 0.85, gain: 1, type: "sine" },
  ],
  incoming_call: [
    { freq: 784, start: 0.0, dur: 0.3, gain: 1, type: "triangle" },
    { freq: 988, start: 0.35, dur: 0.3, gain: 1, type: "triangle" },
    { freq: 784, start: 0.9, dur: 0.3, gain: 1, type: "triangle" },
    { freq: 988, start: 1.25, dur: 0.3, gain: 1, type: "triangle" },
  ],
  call_answered: [
    { freq: 659.25, start: 0.0, dur: 0.18, gain: 1, type: "sine" },
    { freq: 880.0, start: 0.14, dur: 0.3, gain: 1, type: "sine" },
  ],
  job_booked: [
    { freq: 523.25, start: 0.0, dur: 0.2, gain: 1, type: "sine" },
    { freq: 659.25, start: 0.14, dur: 0.2, gain: 1, type: "sine" },
    { freq: 783.99, start: 0.28, dur: 0.45, gain: 1, type: "sine" },
  ],
  payment_received: [
    { freq: 1046.5, start: 0.0, dur: 0.12, gain: 1, type: "sine" },
    { freq: 1568.0, start: 0.1, dur: 0.5, gain: 1, type: "sine" },
  ],
  error: [
    { freq: 392, start: 0.0, dur: 0.18, gain: 1, type: "triangle" },
    { freq: 330, start: 0.2, dur: 0.3, gain: 1, type: "triangle" },
  ],
};

export const TARGET_RMS = 0.12;
export const MAX_DURATION_S: Record<SoundEvent, number> = { logo: 2, incoming_call: 2, call_answered: 1.2, job_booked: 1.2, payment_received: 1.2, error: 1.2 };

export interface SoundCue { event: SoundEvent; label: string; tone: "info" | "success" | "error"; caption: string }

export const SOUND_CUES: Record<SoundEvent, SoundCue> = {
  logo: { event: "logo", label: "Vireek", tone: "info", caption: "[Soft rising three-note chime, about 1.4 seconds]" },
  incoming_call: { event: "incoming_call", label: "Incoming call", tone: "info", caption: "[Two-tone ring pattern, repeated twice]" },
  call_answered: { event: "call_answered", label: "Call answered", tone: "success", caption: "[Short two-note rising blip]" },
  job_booked: { event: "job_booked", label: "Job booked", tone: "success", caption: "[Three quick rising notes]" },
  payment_received: { event: "payment_received", label: "Payment received", tone: "success", caption: "[Bright two-note chime]" },
  error: { event: "error", label: "Something went wrong", tone: "error", caption: "[Two descending low notes]" },
};

function rmsOf(notes: Note[], totalDur: number): number {
  // Mean-square of sine-ish partials with unit-amplitude = gain²/2 over its duration.
  const ms = notes.reduce((s, n) => s + ((n.gain * n.gain) / 2) * n.dur, 0) / totalDur;
  return Math.sqrt(ms);
}

/** Pure: notes for an event with gains scaled so every event hits TARGET_RMS. */
export function scheduleFor(event: SoundEvent): Note[] {
  const raw = RAW[event];
  const total = Math.max(...raw.map((n) => n.start + n.dur));
  const k = TARGET_RMS / rmsOf(raw, total);
  return raw.map((n) => ({ ...n, gain: n.gain * k }));
}

export function eventDuration(event: SoundEvent): number {
  return Math.max(...RAW[event].map((n) => n.start + n.dur));
}

export function eventRms(event: SoundEvent): number {
  return rmsOf(scheduleFor(event), eventDuration(event));
}

// ---------- Preferences (off by default) ----------

export interface SoundPrefs { enabled: boolean; volume: number; events: Record<SoundEvent, boolean> }

export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  enabled: false,
  volume: 0.4,
  // The logo is never played automatically; it only plays from an explicit "Preview" button.
  events: { logo: false, incoming_call: true, call_answered: true, job_booked: true, payment_received: true, error: false },
};

const KEY = "vireek.sound.prefs.v1";

export function sanitizePrefs(raw: unknown): SoundPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SoundPrefs>;
  const vol = typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : DEFAULT_SOUND_PREFS.volume;
  const events = { ...DEFAULT_SOUND_PREFS.events };
  for (const e of SOUND_EVENTS) if (typeof r.events?.[e] === "boolean") events[e] = r.events[e];
  return { enabled: r.enabled === true, volume: vol, events };
}

export function loadSoundPrefs(): SoundPrefs {
  try { return sanitizePrefs(JSON.parse(localStorage.getItem(KEY) ?? "null")); } catch { return { ...DEFAULT_SOUND_PREFS }; }
}
export function saveSoundPrefs(p: SoundPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(sanitizePrefs(p))); } catch { /* storage unavailable: ignore */ }
}

/** Sounds are only allowed inside the authenticated app — never on marketing/public pages. */
export function isSoundAllowedOnRoute(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

export interface PlayOptions {
  prefs: SoundPrefs;
  pathname: string;
  /** Visual / aria-live equivalent. ALWAYS called, even when sound is off or blocked. */
  announce: (cue: SoundCue) => void;
  /** true only for explicit "Preview" buttons: bypasses enabled/route/event gates but not volume. */
  preview?: boolean;
}

export type PlayResult = "played" | "muted" | "blocked_route" | "unsupported" | "hidden";

let ctx: AudioContext | null = null;

export async function playSoundEvent(event: SoundEvent, o: PlayOptions): Promise<PlayResult> {
  o.announce(SOUND_CUES[event]);
  if (!o.preview) {
    if (!o.prefs.enabled || !o.prefs.events[event] || o.prefs.volume <= 0) return "muted";
    if (!isSoundAllowedOnRoute(o.pathname)) return "blocked_route";
    if (typeof document !== "undefined" && document.visibilityState === "hidden" && event !== "incoming_call") return "hidden";
  }
  const AC: typeof AudioContext | undefined = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
  if (!AC) return "unsupported";
  try {
    // Safari: "ambient" respects the hardware silent switch (best-effort; browsers cannot read OS Focus/DND).
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = "ambient";
    ctx = ctx ?? new AC();
    if (ctx.state === "suspended") await ctx.resume();
    if (ctx.state !== "running") return "unsupported";
    const master = ctx.createGain();
    master.gain.value = Math.min(1, Math.max(0, o.prefs.volume));
    const limiter = ctx.createDynamicsCompressor();
    master.connect(limiter);
    limiter.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.02;
    for (const n of scheduleFor(event)) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      g.gain.setValueAtTime(0, t0 + n.start);
      g.gain.linearRampToValueAtTime(n.gain, t0 + n.start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t0 + n.start);
      osc.stop(t0 + n.start + n.dur + 0.05);
    }
    return "played";
  } catch {
    return "unsupported";
  }
}
