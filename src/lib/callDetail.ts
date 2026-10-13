/**
 * Pure logic for the Call Detail page (/dashboard/calls/:id).
 *
 * The stored transcript is plain text ("Speaker: words" per line) with no
 * per-turn timestamps or sentiment. Everything derived here — speaker turns,
 * approximate audio positions, the sentiment timeline — is computed from that
 * real text and is labelled as an estimate in the UI.
 */

export { isUuid, formatDateTime, formatTimeAgo, formatDuration } from './leadDetail';

// ============================================================
// TYPES
// ============================================================

export type SpeakerRole = 'caller' | 'agent' | 'unknown';
export type SentimentLabel = 'positive' | 'neutral' | 'negative';

export interface TranscriptTurn {
  index: number;
  speaker: string;
  role: SpeakerRole;
  text: string;
  /** Estimated audio position in seconds; null when the call duration is unknown. */
  approxStartSec: number | null;
}

export interface SentimentPoint {
  turnIndex: number;
  atSec: number | null;
  score: number; // -1..1
  label: SentimentLabel;
}

export interface SentimentSummary {
  points: SentimentPoint[];
  average: number | null;
  trend: 'improving' | 'declining' | 'steady' | null;
  lowest: SentimentPoint | null;
}

// ============================================================
// TRANSCRIPT PARSING
// ============================================================

const CALLER_LABELS = new Set(['caller', 'user', 'customer', 'client', 'human', 'homeowner', 'guest', 'patient', 'prospect', 'lead']);
const AGENT_LABELS = new Set(['ai', 'assistant', 'bot', 'agent', 'receptionist', 'system', 'vireek', 'operator', 'dispatcher']);
const FIELD_WORDS = new Set(['address', 'phone', 'name', 'email', 'date', 'time', 'zip', 'city', 'issue', 'problem', 'note', 'notes', 'total', 'price', 'quote', 'service', 'location', 'reason']);
const LABEL_RE = /^\s*([A-Za-z][A-Za-z0-9 .'_-]{0,30}?)\s*:\s*(.*)$/;

/**
 * Splits a transcript into speaker turns. A "Label:" prefix only starts a new
 * turn when the label is a known role word, matches the caller, repeats, or
 * opens the transcript — so a line like "Address: 12 Oak St" inside someone's
 * sentence is not mistaken for a speaker change.
 */
export function parseTranscript(transcript: string | null, durationSeconds: number | null, callerName: string | null = null): TranscriptTurn[] {
  if (!transcript || !transcript.trim()) return [];
  const lines = transcript.replace(/\r\n?/g, '\n').split('\n');
  const caller = callerName?.trim().toLowerCase() || null;
  const callerFirst = caller?.split(/\s+/)[0] ?? null;

  const counts = new Map<string, number>();
  let firstLabel: string | null = null;
  for (const line of lines) {
    const m = LABEL_RE.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (firstLabel === null && line.trim() !== '') firstLabel = key;
  }
  const accepted = new Set<string>();
  for (const key of counts.keys()) {
    if (CALLER_LABELS.has(key) || AGENT_LABELS.has(key) || key === caller || key === callerFirst || key === firstLabel || (counts.get(key) ?? 0) >= 2) accepted.add(key);
  }
  // A one-turn speaker (e.g. a named agent who only speaks once) would otherwise be merged into the previous turn.
  if (accepted.size < 2) {
    for (const key of counts.keys()) {
      if (!accepted.has(key) && !FIELD_WORDS.has(key) && !/\d/.test(key) && key.split(' ').length <= 2) {
        accepted.add(key);
        break;
      }
    }
  }
  const isSpeaker = (key: string) => accepted.has(key);

  const raw: { speaker: string; text: string }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = LABEL_RE.exec(line);
    if (m && isSpeaker(m[1].trim().toLowerCase())) {
      raw.push({ speaker: m[1].trim(), text: m[2].trim() });
    } else if (raw.length > 0) {
      raw[raw.length - 1].text = `${raw[raw.length - 1].text} ${line.trim()}`.trim();
    } else {
      raw.push({ speaker: 'Transcript', text: line.trim() });
    }
  }

  const roleOf = (speaker: string): SpeakerRole => {
    const key = speaker.toLowerCase();
    if (key === 'transcript') return 'unknown';
    if (CALLER_LABELS.has(key) || key === caller || key === callerFirst) return 'caller';
    return 'agent';
  };

  const weights = raw.map((t) => t.text.length + 12);
  const total = weights.reduce((a, b) => a + b, 0);
  let before = 0;
  return raw.map((t, index) => {
    const approxStartSec = durationSeconds && durationSeconds > 0 && total > 0 ? Math.round((before / total) * durationSeconds * 10) / 10 : null;
    before += weights[index];
    return { index, speaker: t.speaker, role: roleOf(t.speaker), text: t.text, approxStartSec };
  });
}

/** Index of the turn being spoken at `currentSec`, based on the estimated positions. */
export function activeTurnIndex(turns: TranscriptTurn[], currentSec: number): number {
  let active = -1;
  for (const t of turns) {
    if (t.approxStartSec === null) return -1;
    if (t.approxStartSec <= currentSec) active = t.index;
    else break;
  }
  return active;
}

// ============================================================
// SEARCH
// ============================================================

export interface TurnMatch {
  turnIndex: number;
  count: number;
}

const countOccurrences = (haystack: string, needle: string) => {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
};

export function findMatches(turns: TranscriptTurn[], query: string): TurnMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: TurnMatch[] = [];
  for (const t of turns) {
    const count = countOccurrences(t.text.toLowerCase(), q);
    if (count > 0) out.push({ turnIndex: t.index, count });
  }
  return out;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Splits text into plain/match segments without regexes, so user input can never break the pattern. */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(q, from);
    if (at === -1) break;
    if (at > from) segments.push({ text: text.slice(from, at), match: false });
    segments.push({ text: text.slice(at, at + q.length), match: true });
    from = at + q.length;
  }
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments.length ? segments : [{ text, match: false }];
}

// ============================================================
// SENTIMENT (estimated from wording)
// ============================================================

const WORD_WEIGHTS: Record<string, number> = {
  thank: 1, thanks: 1, appreciate: 2, great: 2, perfect: 2, awesome: 2, wonderful: 2, excellent: 2, fantastic: 2,
  good: 1, happy: 2, glad: 1, helpful: 2, love: 2, relieved: 2, satisfied: 2, pleased: 2, nice: 1, wonderful_: 0,
  angry: -3, furious: -3, frustrated: -2, upset: -2, terrible: -3, awful: -3, horrible: -3, worst: -3, ridiculous: -2,
  unacceptable: -3, cancel: -2, complain: -2, disappointed: -2, annoyed: -2, hate: -3, waste: -2, scam: -3,
  waiting: -1, broken: -1, problem: -1, worried: -1, scared: -2, panic: -2, stressed: -1, stress: -1,
  flooding: -1, flooded: -1, leaking: -1, burst: -1, emergency: -1, urgent: -1,
};
const PHRASES: [string, number][] = [
  ['sounds good', 2], ['works for me', 2], ['that works', 1], ['so much', 0], ['too much', -2], ['too expensive', -2],
  ['still not', -2], ['never again', -3], ['no one', -1], ['nobody', -1], ["doesn't work", -2], ["won't stop", -2], ['hours ago', -1],
];
const NEGATORS = new Set(['not', 'no', 'never', "don't", "didn't", "isn't", "wasn't", "won't", "can't", 'cannot', 'hardly']);

export function estimateSentiment(text: string): { score: number; label: SentimentLabel } {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z']+/g) ?? [];
  let sum = 0;
  tokens.forEach((tok, i) => {
    const stem = WORD_WEIGHTS[tok] !== undefined ? tok : tok.replace(/(ing|ed|s)$/, '');
    const w = WORD_WEIGHTS[tok] ?? WORD_WEIGHTS[stem];
    if (!w) return;
    const negated = tokens.slice(Math.max(0, i - 2), i).some((p) => NEGATORS.has(p));
    sum += negated ? -w * (w < 0 ? 0.5 : 1) : w;
  });
  for (const [phrase, w] of PHRASES) if (lower.includes(phrase)) sum += w;
  const score = Math.round(Math.tanh(sum / 3) * 100) / 100;
  return { score, label: score > 0.25 ? 'positive' : score < -0.25 ? 'negative' : 'neutral' };
}

export function buildSentimentTimeline(turns: TranscriptTurn[]): SentimentSummary {
  const points: SentimentPoint[] = turns
    .filter((t) => t.role === 'caller')
    .map((t) => ({ turnIndex: t.index, atSec: t.approxStartSec, ...estimateSentiment(t.text) }));
  if (points.length === 0) return { points, average: null, trend: null, lowest: null };

  const avg = (xs: SentimentPoint[]) => xs.reduce((s, p) => s + p.score, 0) / xs.length;
  const average = Math.round(avg(points) * 100) / 100;
  let trend: SentimentSummary['trend'] = null;
  if (points.length >= 2) {
    const mid = Math.floor(points.length / 2);
    const delta = avg(points.slice(points.length - Math.max(1, mid))) - avg(points.slice(0, Math.max(1, mid)));
    trend = delta > 0.25 ? 'improving' : delta < -0.25 ? 'declining' : 'steady';
  }
  const lowest = points.reduce((min, p) => (p.score < min.score ? p : min), points[0]);
  return { points, average, trend, lowest: lowest.score < -0.25 ? lowest : null };
}

export function formatClock(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
