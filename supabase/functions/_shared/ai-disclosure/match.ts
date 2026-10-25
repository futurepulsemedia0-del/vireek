// supabase/functions/_shared/ai-disclosure/match.ts
//
// Pure (no Deno / DB / browser APIs): finds the spoken AI disclosure inside a
// call transcript and decides the proof status. Imported by the Edge Functions
// and unit-tested by vitest.

export type TurnRole = "assistant" | "caller" | "other";

export interface TranscriptTurn {
  role: TurnRole;
  text: string;
  /** Seconds from call start when this turn began (null when unknown). */
  secondsFromStart: number | null;
  /** Character offset inside the plain-text transcript (null when built from a message array). */
  charStart: number | null;
}

export type ProofStatus = "delivered" | "late" | "partial" | "missing" | "no_transcript" | "not_applicable";

/** >= this similarity counts as the disclosure having been spoken in full. */
export const FULL_MATCH_THRESHOLD = 0.9;
/** >= this (but below FULL) means it was started/altered/cut off. */
export const PARTIAL_MATCH_THRESHOLD = 0.55;
/** The disclosure must appear within the first N assistant turns... */
export const OPENING_MAX_ASSISTANT_TURNS = 2;
/** ...or within the first N seconds of the call. */
export const OPENING_MAX_SECONDS = 20;
const MIN_CONNECTED_SECONDS = 5;
const EXCERPT_MAX = 400;

const CJK_RE = /[぀-ヿ㐀-鿿]/;

/** Language-agnostic normalisation used on BOTH sides of every comparison. */
export function normalizeForMatch(input: string): string {
  return (input ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[​-‏‪-‮⁠﻿]/g, "") // zero-width + bidi marks, incl. ZWNJ
    .replace(/[ً-ٰٟـ]/g, "") // Arabic/Persian diacritics + tatweel
    .replace(/ي/g, "ی") // Arabic yeh -> Persian yeh
    .replace(/ك/g, "ک") // Arabic kaf -> Persian kaf
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(normalized: string): string[] {
  if (!normalized) return [];
  if (CJK_RE.test(normalized)) return Array.from(normalized.replace(/\s/g, ""));
  return normalized.split(" ");
}

/** LCS length of `needle` inside the best window of `hay`, as a fraction of needle length. */
export function bestWindowSimilarity(needle: string[], hay: string[]): number {
  const n = needle.length;
  if (n === 0 || hay.length === 0) return 0;
  const win = Math.min(hay.length, Math.ceil(n * 1.4) + 2);
  let best = 0;
  for (let start = 0; start <= hay.length - Math.min(win, hay.length); start += 1) {
    const slice = hay.slice(start, start + win);
    // classic LCS, O(n * win)
    let prev = new Array<number>(slice.length + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      const cur = new Array<number>(slice.length + 1).fill(0);
      for (let j = 1; j <= slice.length; j += 1) {
        cur[j] = needle[i - 1] === slice[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    best = Math.max(best, prev[slice.length] / n);
    if (best === 1) break;
  }
  return best;
}

function roleOf(raw: unknown): TurnRole {
  const r = String(raw ?? "").toLowerCase();
  if (r === "bot" || r === "assistant" || r === "ai") return "assistant";
  if (r === "user" || r === "customer" || r === "caller") return "caller";
  return "other";
}

/** Vapi `artifact.messages` / `messages` -> turns. Tolerant: junk entries are skipped. */
export function turnsFromVapiMessages(messages: unknown, callStartedAtMs?: number | null): TranscriptTurn[] {
  if (!Array.isArray(messages)) return [];
  const turns: TranscriptTurn[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = roleOf(rec.role);
    if (role === "other") continue; // system prompts, tool calls, tool results
    const text = typeof rec.message === "string" ? rec.message : typeof rec.content === "string" ? rec.content : "";
    if (!text.trim()) continue;
    let seconds: number | null = null;
    if (typeof rec.secondsFromStart === "number" && Number.isFinite(rec.secondsFromStart)) {
      seconds = Math.max(0, rec.secondsFromStart);
    } else if (typeof rec.time === "number" && callStartedAtMs && Number.isFinite(rec.time)) {
      seconds = Math.max(0, (rec.time - callStartedAtMs) / 1000);
    }
    turns.push({ role, text, secondsFromStart: seconds, charStart: null });
  }
  return turns;
}

/** "AI: ...\nUser: ..." plain transcript -> turns with exact character offsets. */
export function turnsFromTranscript(transcript: string | null | undefined): TranscriptTurn[] {
  if (!transcript) return [];
  const turns: TranscriptTurn[] = [];
  const re = /^(AI|Assistant|Bot|User|Caller|Customer)\s*:\s*/i;
  let offset = 0;
  for (const line of transcript.split("\n")) {
    const m = re.exec(line);
    if (m) {
      turns.push({ role: roleOf(m[1]), text: line.slice(m[0].length), secondsFromStart: null, charStart: offset + m[0].length });
    } else if (turns.length > 0 && line.trim()) {
      turns[turns.length - 1].text += ` ${line.trim()}`;
    }
    offset += line.length + 1;
  }
  return turns;
}

export interface DisclosureCandidate {
  key: string;
  text: string;
}

export interface DisclosureMatch {
  found: boolean;
  candidateKey: string | null;
  score: number;
  turnIndex: number | null;
  assistantTurnNumber: number | null;
  secondsFromStart: number | null;
  charOffset: number | null;
  excerpt: string | null;
}

const NO_MATCH: DisclosureMatch = {
  found: false, candidateKey: null, score: 0, turnIndex: null, assistantTurnNumber: null,
  secondsFromStart: null, charOffset: null, excerpt: null,
};

/** Best match of ANY candidate wording against the assistant's turns. */
export function findDisclosure(turns: TranscriptTurn[], candidates: DisclosureCandidate[]): DisclosureMatch {
  let best: DisclosureMatch = NO_MATCH;
  const assistantIdx: number[] = [];
  turns.forEach((t, i) => { if (t.role === "assistant") assistantIdx.push(i); });

  for (const cand of candidates) {
    const needle = tokenize(normalizeForMatch(cand.text));
    if (needle.length === 0) continue;
    const singles = assistantIdx.map((i) => bestWindowSimilarity(needle, tokenize(normalizeForMatch(turns[i].text))));
    for (let a = 0; a < assistantIdx.length; a += 1) {
      const i = assistantIdx[a];
      let score = singles[a];
      // A sentence can be split over two consecutive assistant messages. That only counts
      // when the pair matches better than either turn alone, and it is attributed to the
      // turn where the sentence STARTS.
      const next = assistantIdx[a + 1];
      if (next !== undefined && score < 1) {
        const joined = bestWindowSimilarity(needle, tokenize(normalizeForMatch(`${turns[i].text} ${turns[next].text}`)));
        if (joined > Math.max(score, singles[a + 1])) score = joined;
      }
      if (score > best.score) {
        const t = turns[i];
        best = {
          found: score >= PARTIAL_MATCH_THRESHOLD,
          candidateKey: cand.key,
          score: Number(score.toFixed(3)),
          turnIndex: i,
          assistantTurnNumber: a + 1,
          secondsFromStart: t.secondsFromStart,
          charOffset: t.charStart,
          excerpt: t.text.length > EXCERPT_MAX ? `${t.text.slice(0, EXCERPT_MAX - 1)}…` : t.text,
        };
      }
      if (best.score === 1) return best;
    }
  }
  return best;
}

export interface EvaluateInput {
  turns: TranscriptTurn[];
  candidates: DisclosureCandidate[];
  durationSeconds: number | null;
}

export interface Evaluation {
  status: ProofStatus;
  match: DisclosureMatch;
}

export function evaluateDisclosure(input: EvaluateInput): Evaluation {
  const { turns, candidates, durationSeconds } = input;
  const shortCall = durationSeconds !== null && durationSeconds < MIN_CONNECTED_SECONDS;

  if (turns.length === 0) {
    return { status: shortCall ? "not_applicable" : "no_transcript", match: NO_MATCH };
  }
  if (!turns.some((t) => t.role === "assistant")) {
    return { status: shortCall ? "not_applicable" : "missing", match: NO_MATCH };
  }

  const match = findDisclosure(turns, candidates);
  if (match.score >= FULL_MATCH_THRESHOLD) {
    const early =
      (match.assistantTurnNumber !== null && match.assistantTurnNumber <= OPENING_MAX_ASSISTANT_TURNS) ||
      (match.secondsFromStart !== null && match.secondsFromStart <= OPENING_MAX_SECONDS);
    return { status: early ? "delivered" : "late", match };
  }
  if (match.score >= PARTIAL_MATCH_THRESHOLD) return { status: "partial", match };
  return { status: "missing", match };
}
