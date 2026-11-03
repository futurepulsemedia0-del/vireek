// supabase/functions/_shared/interpreter/pipeline.ts
//
// One interpreted call = one InterpreterSession. It is the single place where
// the safety rules run, in a fixed order, for every utterance:
//
//   emergency  ->  pending read-back answer  ->  switch command  ->
//   confidence / critical-field policy  ->  translate (+ one strict retry)  ->
//   verify  ->  relay  ->  read-back  ->  latency accounting
//
// Provider calls (speech-to-text, translation, text-to-speech) are injected as
// `Ports`, so this file is runtime-neutral: the bridge worker (Node) and the
// Edge Function (Deno) pass real adapters, the tests pass in-memory ones.
// The session never does network I/O itself and never throws on bad input.

import { buildReadback, confirmation, type CriticalEntity, uniqueCritical } from "./critical.ts";
import { decideTurn, effectiveMode, isInterpreted, LatencyBudget, THRESHOLDS, type InterpMode, type TurnAction } from "./governor.ts";
import { fill, INTERP_META, PHRASES, type InterpLang } from "./languages.ts";
import { detectSwitchCommand } from "./langid.ts";
import { mustContainFrom, verifyTranslation, type Party, type TranslateRequest, type TranslateResult } from "./mt.ts";
import { detectEmergency, safetyLines, type EmergencyKind } from "./safety.ts";

export interface Ports {
  translate(req: TranslateRequest, signal: AbortSignal): Promise<TranslateResult | null>;
  /**
   * Plays `text` to `party` in `lang`. Resolves when the FIRST audio has been
   * sent (that instant ends the latency measurement). Must stop quickly when
   * `signal` aborts (barge-in). Absent in captions-only sessions.
   */
  speak?(text: string, lang: InterpLang, party: Party, signal: AbortSignal): Promise<void>;
  now(): number;
  emit(event: SessionEvent): void;
}

export interface TurnRecord {
  seq: number;
  speaker: Party;
  from: InterpLang;
  to: InterpLang;
  original: string;
  translated: string | null;
  asrConfidence: number | null;
  mtConfidence: number | null;
  action: TurnAction | "emergency" | "switch" | "readback_answer" | "passthrough";
  reason: string;
  critical: { values: CriticalEntity[]; ok: boolean; missing: CriticalEntity[]; extra: CriticalEntity[] };
  glossaryMisses: string[];
  emergency: EmergencyKind[];
  addedMs: number | null;
  mode: InterpMode;
  flags: string[];
}

export type SessionEvent =
  | { type: "turn"; turn: TurnRecord }
  | { type: "emergency"; kinds: EmergencyKind[]; speaker: Party; text: string }
  | { type: "language"; from: InterpLang; to: InterpLang; by: Party }
  | { type: "mode"; mode: InterpMode; reason: string }
  | { type: "handoff"; reason: string }
  | { type: "readback"; party: Party; text: string; confirmed: boolean | null };

export interface SessionConfig {
  callerLang: InterpLang;
  /** Language staff speak. Always English for now; kept explicit so it can become configurable. */
  staffLang?: InterpLang;
  mode: InterpMode;
  enabled: readonly InterpLang[];
  glossaryOverrides?: TranslateRequest["glossaryOverrides"];
}

export interface Utterance {
  speaker: Party;
  text: string;
  /** ASR confidence 0..1 or null when the provider gave none. */
  asrConfidence: number | null;
}

const MAX_UTTERANCE = 2000;

interface Pending {
  party: Party;
  entities: CriticalEntity[];
  /** Language of the party who must confirm. */
  lang: InterpLang;
  listener: Party;
  listenerLang: InterpLang;
  asked: number;
}

export class InterpreterSession {
  callerLang: InterpLang;
  readonly staffLang: InterpLang;
  mode: InterpMode;
  readonly budget = new LatencyBudget();
  readonly turns: TurnRecord[] = [];

  private seq = 0;
  private pending: Pending | null = null;
  private reasks: Record<Party, number> = { caller: 0, staff: 0 };
  private playing: Partial<Record<Party, AbortController>> = {};
  private lastTtsMs = 250;
  private requestedMode: InterpMode;

  private readonly cfg: SessionConfig;
  private readonly ports: Ports;

  constructor(cfg: SessionConfig, ports: Ports) {
    this.cfg = cfg;
    this.ports = ports;
    this.callerLang = cfg.callerLang;
    this.staffLang = cfg.staffLang ?? "en";
    this.mode = cfg.mode;
    this.requestedMode = cfg.mode;
  }

  /** The other party started talking: cut the audio currently playing to them. */
  bargeIn(party: Party): void {
    this.playing[party]?.abort();
    delete this.playing[party];
  }

  /** Whether translated speech should be produced (false => captions only). */
  private get speaking(): boolean {
    return this.mode !== "captions" && typeof this.ports.speak === "function";
  }

  private async say(text: string, lang: InterpLang, party: Party): Promise<void> {
    if (!this.speaking || !text) return;
    this.bargeIn(party);
    const ctl = new AbortController();
    this.playing[party] = ctl;
    try {
      await this.ports.speak!(text, lang, party, ctl.signal);
    } catch {
      /* an aborted or failed playback must never break the turn */
    }
  }

  private record(t: Omit<TurnRecord, "seq" | "mode" | "flags"> & { flags?: string[] }): TurnRecord {
    const turn: TurnRecord = { ...t, seq: ++this.seq, mode: this.mode, flags: t.flags ?? [] };
    this.turns.push(turn);
    this.ports.emit({ type: "turn", turn });
    return turn;
  }

  private emptyCritical = { values: [] as CriticalEntity[], ok: true, missing: [] as CriticalEntity[], extra: [] as CriticalEntity[] };

  async handle(u: Utterance): Promise<TurnRecord> {
    const t0 = this.ports.now();
    const speaker = u.speaker;
    const text = (typeof u.text === "string" ? u.text : "").slice(0, MAX_UTTERANCE).trim();
    const speakerLang = speaker === "caller" ? this.callerLang : this.staffLang;
    const listener: Party = speaker === "caller" ? "staff" : "caller";
    const listenerLang = speaker === "caller" ? this.staffLang : this.callerLang;
    const base = { speaker, from: speakerLang, to: listenerLang, original: text, translated: null as string | null, asrConfidence: u.asrConfidence, mtConfidence: null as number | null, critical: this.emptyCritical, glossaryMisses: [] as string[], emergency: [] as EmergencyKind[], addedMs: null as number | null };

    // 1. Emergency: before anything else, in every language, regardless of confidence.
    const emergency = detectEmergency(text);
    if (emergency.isEmergency) {
      this.ports.emit({ type: "emergency", kinds: emergency.kinds, speaker, text });
      if (speaker === "caller") {
        for (const line of safetyLines(emergency.kinds, speakerLang)) await this.say(line, speakerLang, "caller");
      }
    }

    // 2. Answer to a pending read-back.
    if (this.pending && this.pending.party === speaker && !emergency.isEmergency) {
      return this.answerReadback(u, text, base);
    }

    // 3. Spoken language switch (caller only).
    if (speaker === "caller" && !emergency.isEmergency) {
      const want = detectSwitchCommand(text);
      if (want && want !== this.callerLang && (want === "en" || this.cfg.enabled.includes(want))) {
        const from = this.callerLang;
        this.callerLang = want;
        this.reasks = { caller: 0, staff: 0 };
        this.ports.emit({ type: "language", from, to: want, by: "caller" });
        await this.say(fill(PHRASES[want].switchedTo, { language: INTERP_META[want].nativeName }), want, "caller");
        return this.record({ ...base, action: "switch", reason: `caller_switched_${want}` });
      }
    }

    // 4. Nothing to interpret.
    if (!isInterpreted(this.callerLang)) {
      return this.record({ ...base, to: speakerLang, translated: text, action: "passthrough", reason: "same_language", emergency: emergency.kinds });
    }

    // 5. Translate (+ strict retry on critical mismatch).
    const safetyRelevant = emergency.isEmergency || (speaker === "staff" && /\b(shut ?off|turn off|switch off|leave|evacuate|911|don'?t touch|do not (?:use|touch)|stay out)\b/i.test(text));
    const pre = verifyTranslation(text, speakerLang, text, speakerLang); // source-side critical values only
    const preDecision = decideTurn({
      asrConfidence: u.asrConfidence, mtConfidence: null, hasCritical: pre.hasCritical, criticalOk: true,
      unparsedNumerals: pre.unparsedNumerals, safetyRelevant, emergency: emergency.isEmergency,
      reasks: this.reasks[speaker], textEmpty: text.length === 0,
    });
    if (preDecision.action === "reask" || preDecision.action === "handoff") {
      return this.refuse(speaker, speakerLang, preDecision.action, preDecision.reason, base, emergency.kinds);
    }

    const ctl = new AbortController();
    const mt0 = this.ports.now();
    let result = await this.translate({ text, from: speakerLang, to: listenerLang, speaker, glossaryOverrides: this.cfg.glossaryOverrides }, ctl.signal);
    let v = result ? verifyTranslation(text, speakerLang, result.text, listenerLang, this.cfg.glossaryOverrides) : null;
    const flags: string[] = [];
    if (result && v && !v.criticalOk) {
      flags.push("retried_critical");
      const retry = await this.translate({ text, from: speakerLang, to: listenerLang, speaker, mustContain: mustContainFrom(v), glossaryOverrides: this.cfg.glossaryOverrides }, ctl.signal);
      if (retry) {
        const v2 = verifyTranslation(text, speakerLang, retry.text, listenerLang, this.cfg.glossaryOverrides);
        if (v2.diff.missing.length + v2.diff.extra.length <= v.diff.missing.length + v.diff.extra.length) {
          result = retry;
          v = v2;
        }
      }
    }
    const mtMs = this.ports.now() - mt0;

    if (!result || !v || !result.text || !v.lengthOk) {
      const d = decideTurn({ asrConfidence: u.asrConfidence, mtConfidence: 0, hasCritical: pre.hasCritical, criticalOk: false, unparsedNumerals: false, safetyRelevant, emergency: emergency.isEmergency, reasks: this.reasks[speaker], textEmpty: false });
      return this.refuse(speaker, speakerLang, d.action === "handoff" ? "handoff" : "reask", result ? "translation_unusable" : "translation_failed", base, emergency.kinds);
    }

    const decision = decideTurn({
      asrConfidence: u.asrConfidence, mtConfidence: result.confidence, hasCritical: v.hasCritical, criticalOk: v.criticalOk,
      unparsedNumerals: v.unparsedNumerals, safetyRelevant, emergency: emergency.isEmergency,
      reasks: this.reasks[speaker], textEmpty: false,
    });
    const critical = { values: v.src, ok: v.criticalOk, missing: v.diff.missing, extra: v.diff.extra };
    if (decision.action === "reask" || decision.action === "handoff") {
      return this.refuse(speaker, speakerLang, decision.action, decision.reason, { ...base, critical, translated: result.text, mtConfidence: result.confidence }, emergency.kinds);
    }

    // 6. Relay.
    this.reasks[speaker] = 0;
    if (v.glossaryMisses.length) flags.push("glossary_miss");
    if (u.asrConfidence !== null && u.asrConfidence < THRESHOLDS.asrTrusted) flags.push("asr_medium");
    if (emergency.isEmergency) flags.push("emergency");
    if (safetyRelevant && !emergency.isEmergency) flags.push("safety_relevant");
    const speakingNow = this.speaking;
    if (speakingNow) this.bargeIn(listener);
    await this.say(result.text, listenerLang, listener);
    const spoke = speakingNow && this.mode !== "captions";
    const addedMs = spoke ? this.ports.now() - t0 : mtMs + this.lastTtsMs;
    if (spoke) this.lastTtsMs = Math.max(80, Math.round(this.ports.now() - t0 - mtMs));
    this.observeLatency(addedMs);

    const turn = this.record({
      ...base, translated: result.text, mtConfidence: result.confidence, critical,
      glossaryMisses: v.glossaryMisses.map((h) => h.id), emergency: emergency.kinds, addedMs: Math.round(addedMs),
      action: decision.action, reason: decision.reason, flags,
    });

    // 7. Read-back of critical values to the speaker, in the speaker's language.
    if (decision.action === "relay_with_readback" && this.speaking) {
      const entities = uniqueCritical(v.src);
      const rb = buildReadback(entities, speakerLang);
      if (rb) {
        this.pending = { party: speaker, entities, lang: speakerLang, listener, listenerLang, asked: 1 };
        this.ports.emit({ type: "readback", party: speaker, text: rb, confirmed: null });
        await this.say(rb, speakerLang, speaker);
      }
    }
    return turn;
  }

  private async translate(req: TranslateRequest, signal: AbortSignal): Promise<TranslateResult | null> {
    try {
      return await this.ports.translate(req, signal);
    } catch {
      return null;
    }
  }

  private observeLatency(addedMs: number): void {
    const before = this.mode;
    const status = this.budget.record(addedMs);
    const next = effectiveMode(this.requestedMode, status, this.budget.p95());
    if (next !== before) {
      this.mode = next;
      this.ports.emit({ type: "mode", mode: next, reason: status === "degraded" ? `p50 ${Math.round(this.budget.p50())}ms over ${THRESHOLDS.p50BudgetMs}ms budget` : "latency recovered" });
    }
  }

  private async refuse(
    speaker: Party, speakerLang: InterpLang, action: "reask" | "handoff", reason: string,
    base: Omit<TurnRecord, "seq" | "action" | "reason" | "mode" | "flags">, emergencyKinds: EmergencyKind[],
  ): Promise<TurnRecord> {
    if (action === "reask") {
      this.reasks[speaker]++;
      await this.say(PHRASES[speakerLang].askRepeat, speakerLang, speaker);
    } else {
      this.ports.emit({ type: "handoff", reason });
      if (this.mode !== "captions") {
        this.mode = "captions";
        this.ports.emit({ type: "mode", mode: "captions", reason: `handoff: ${reason}` });
      }
      await this.say(PHRASES[speakerLang].handoff, speakerLang, speaker);
    }
    return this.record({ ...base, emergency: emergencyKinds, action, reason });
  }

  private async answerReadback(u: Utterance, text: string, base: Omit<TurnRecord, "seq" | "action" | "reason" | "mode" | "flags">): Promise<TurnRecord> {
    const p = this.pending as Pending;
    const answer = confirmation(text, p.lang);
    if (answer === "yes") {
      this.pending = null;
      const confirmedText = buildReadback(p.entities, p.listenerLang).replace(PHRASES[p.listenerLang].readbackAsk, "").trim();
      this.ports.emit({ type: "readback", party: p.party, text: confirmedText, confirmed: true });
      await this.say(confirmedText, p.listenerLang, p.listener);
      return this.record({ ...base, action: "readback_answer", reason: "confirmed", critical: { values: p.entities, ok: true, missing: [], extra: [] } });
    }
    if (answer === "no") {
      this.pending = null;
      this.ports.emit({ type: "readback", party: p.party, text, confirmed: false });
      this.reasks[p.party]++;
      await this.say(PHRASES[p.lang].askRepeat, p.lang, p.party);
      return this.record({ ...base, action: "readback_answer", reason: "rejected_ask_again" });
    }
    // Unclear: ask once more, then stop live interpretation rather than guess.
    if (p.asked >= 2) {
      this.pending = null;
      return this.refuse(p.party, p.lang, "handoff", "readback_unconfirmed", base, []);
    }
    p.asked++;
    const rb = buildReadback(p.entities, p.lang);
    await this.say(rb, p.lang, p.party);
    return this.record({ ...base, action: "readback_answer", reason: "unclear_asked_again" });
  }
}
