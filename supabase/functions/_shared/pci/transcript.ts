// supabase/functions/_shared/pci/transcript.ts
//
// Transcript redaction for calls that involve (or might involve) card data.
//   - redactCallTranscript: the final transcript stored on `calls`
//   - redactLiveLine:       each streamed utterance stored in `live_call_lines`
//   - redactTranscriptMessages: time-window redaction for structured transcripts
//     (everything spoken/typed inside a secure-capture window is replaced wholesale,
//     even if it does not look like a card number)

import { redactCardData } from "./cardData.ts";

export const CAPTURE_REDACTION_MARKER = "[SECURE PAYMENT CAPTURE — REDACTED]";
export const CAPTURE_NOTICE = "[Secure payment capture took place on this call. Keypad entry was not recorded or transcribed.]";

export interface TranscriptRedaction {
  text: string | null;
  /** How many card-data fragments were removed. */
  redactions: number;
  /** True when a caller/agent actually SPOKE a card number: the AUDIO may contain it too and should be purged. */
  spokenCardDetected: boolean;
}

export function redactCallTranscript(text: string | null | undefined, opts: { hadCapture?: boolean } = {}): TranscriptRedaction {
  if (typeof text !== "string" || text.length === 0) {
    return { text: opts.hadCapture ? CAPTURE_NOTICE : (text ?? null), redactions: 0, spokenCardDetected: false };
  }
  const r = redactCardData(text, { strict: true });
  const out = opts.hadCapture ? `${r.text}\n${CAPTURE_NOTICE}` : r.text;
  return { text: out, redactions: r.findings.length, spokenCardDetected: r.findings.some((f) => f.kind === "pan") };
}

export function redactLiveLine(text: string): string {
  return redactCardData(text, { strict: true }).text;
}

export interface CaptureWindow {
  startMs: number;
  endMs: number;
}

export interface TimedMessage {
  /** epoch ms */
  time?: number;
  secondsFromStart?: number;
  message?: string;
  content?: string;
  [k: string]: unknown;
}

/**
 * Replaces the text of every message that overlaps a capture window and ALSO scrubs card-like text in the rest.
 * Fails closed: a message with no usable timestamp is treated as inside the window whenever any window exists.
 */
export function redactTranscriptMessages<T extends TimedMessage>(messages: T[], windows: CaptureWindow[], callStartMs?: number): T[] {
  return messages.map((m) => {
    const t = typeof m.time === "number" ? m.time : typeof m.secondsFromStart === "number" && callStartMs !== undefined ? callStartMs + m.secondsFromStart * 1000 : null;
    const inWindow = windows.length > 0 && (t === null || windows.some((w) => t >= w.startMs - 2000 && t <= w.endMs + 2000));
    const out: TimedMessage = { ...m };
    for (const key of ["message", "content"] as const) {
      if (typeof out[key] === "string") out[key] = inWindow ? CAPTURE_REDACTION_MARKER : redactCardData(out[key] as string, { strict: true }).text;
    }
    return out as T;
  });
}
