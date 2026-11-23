import { describe, expect, it } from "vitest";
import {
  buildCallStartPlan, classifyAnswer, decideStorage, inferConsentOutcome, noticeInFirstAssistantTurn,
  parseGateMode, turnsFromProviderMessages, planOverrides, applyPlanToSquad, type CallStartInput,
} from "./callStartPlan";

const DISC = "This call is answered by an AI voice assistant, not a live person.";
const base = (o: Partial<CallStartInput> = {}): CallStartInput => ({
  aiDisclosureText: DISC, language: "en", callerNumber: "+12145550100", businessCountry: "US", greeting: "Thanks for calling Acme.", gateMode: "enforce", ...o,
});

describe("parseGateMode", () => {
  it("defaults to shadow and only enforces on an explicit value", () => {
    expect(parseGateMode(undefined)).toBe("shadow");
    expect(parseGateMode("")).toBe("shadow");
    expect(parseGateMode("garbage")).toBe("shadow");
    expect(parseGateMode(" ENFORCE ")).toBe("enforce");
  });
});

describe("first message order: AI disclosure -> recording notice/ask -> greeting", () => {
  const cases: Array<[string, Partial<CallStartInput>]> = [
    ["US notice enforce", {}],
    ["US notice shadow", { gateMode: "shadow" }],
    ["DE enforce", { businessCountry: "DE", language: "de" }],
    ["DE shadow", { businessCountry: "DE", language: "de", gateMode: "shadow" }],
    ["FR enforce", { businessCountry: "FR", language: "fr" }],
    ["GB enforce", { businessCountry: "GB" }],
    ["US business, CA caller", { callerNumber: "+14155550100" }],
    ["unknown country", { businessCountry: "ZZ" }],
  ];
  for (const [name, o] of cases) {
    it(name, () => {
      const p = buildCallStartPlan(base(o));
      const m = p.firstMessage;
      expect(m.startsWith(p.aiDisclosure)).toBe(true);
      const iAi = m.indexOf(p.aiDisclosure);
      const iNotice = p.spokenText ? m.indexOf(p.spokenText) : -1;
      const iGreet = m.indexOf((o.greeting ?? "Thanks for calling Acme."));
      expect(iAi).toBe(0);
      if (p.spokenText) {
        expect(iNotice).toBeGreaterThan(iAi);
        expect(iGreet).toBeGreaterThan(iNotice);
      }
    });
  }
  it("the AI disclosure can never be missing", () => {
    for (const d of [null, undefined, "", "   "]) {
      const p = buildCallStartPlan(base({ aiDisclosureText: d }));
      expect(p.firstMessage).toContain("AI voice assistant");
    }
  });
  it("uses a neutral invitation when there is no greeting", () => {
    expect(buildCallStartPlan(base({ greeting: null })).firstMessage.endsWith("How can I help you today?")).toBe(true);
  });
});

describe("recording decision", () => {
  it("US business, non all-party caller: notice, recording allowed", () => {
    const p = buildCallStartPlan(base());
    expect(p.effectiveMode).toBe("notice");
    expect(p.decision).toBe("record_after_notice");
    expect(p.recordingEnabled).toBe(true);
    expect(p.spokenKind).toBe("recording_notice");
    expect(p.spokenText).toContain("recorded");
    expect(p.callerState).toBeNull();
  });
  it("all-party caller state raises a notice profile to opt_in (strictest wins)", () => {
    const p = buildCallStartPlan(base({ callerNumber: "+14155550100" }));
    expect(p.callerState).toBe("CA");
    expect(p.callerStateSource).toBe("area_code_heuristic");
    expect(p.effectiveMode).toBe("opt_in");
    expect(p.recordingEnabled).toBe(false);
    expect(p.decision).toBe("no_recording_consent_gate");
  });
  it("Germany blocks audio recording in enforce mode and asks about a transcript", () => {
    const p = buildCallStartPlan(base({ businessCountry: "DE", language: "de" }));
    expect(p.effectiveMode).toBe("opt_in_strict");
    expect(p.recordingEnabled).toBe(false);
    expect(p.applyProviderOverride).toBe(true);
    expect(p.spokenKind).toBe("transcript_consent_ask");
    expect(p.spokenText).toContain("Tonaufnahme");
    expect(p.promptContext).toContain("NOT audio-recorded");
  });
  it("shadow mode changes nothing at the provider but still speaks the truthful notice and flags wouldBlock", () => {
    const p = buildCallStartPlan(base({ businessCountry: "DE", language: "de", gateMode: "shadow" }));
    expect(p.wouldBlock).toBe(true);
    expect(p.recordingEnabled).toBe(true);
    expect(p.applyProviderOverride).toBe(false);
    expect(p.spokenKind).toBe("recording_notice");
    expect(p.spokenText).toContain("aufgezeichnet");
  });
  it("UK is notice mode", () => {
    const p = buildCallStartPlan(base({ businessCountry: "GB" }));
    expect(p.decision).toBe("record_after_notice");
    expect(p.wouldBlock).toBe(false);
  });
  it("unknown country fails closed (opt_in), never off", () => {
    const p = buildCallStartPlan(base({ businessCountry: null }));
    // null country -> resolveRecordingProfile treats it as UNKNOWN -> opt_in
    expect(p.gated).toBe(true);
    expect(p.recordingEnabled).toBe(false);
  });
  it("a language without a reviewed notice cannot be recorded in enforce mode", () => {
    const p = buildCallStartPlan(base({ language: "ja", aiDisclosureText: "この通話はAI音声アシスタントが対応しています。" }));
    expect(p.languageSupported).toBe(false);
    expect(p.decision).toBe("no_recording_language_unsupported");
    expect(p.recordingEnabled).toBe(false);
    expect(p.spokenKind).toBe("none");
    expect(p.firstMessage.startsWith("この通話")).toBe(true);
  });
  it("only enforce mode asks the webhook to send a provider override", () => {
    expect(buildCallStartPlan(base({ gateMode: "shadow" })).applyProviderOverride).toBe(false);
    expect(buildCallStartPlan(base({ gateMode: "enforce" })).applyProviderOverride).toBe(true);
  });
});

describe("classifyAnswer", () => {
  it("english", () => {
    expect(classifyAnswer("Yeah, that's fine.", "en")).toBe("yes");
    expect(classifyAnswer("No problem", "en")).toBe("yes");
    expect(classifyAnswer("no recording please", "en")).toBe("no");
    expect(classifyAnswer("No.", "en")).toBe("no");
    expect(classifyAnswer("I'd rather not", "en")).toBe("no");
    expect(classifyAnswer("I don't know, my AC stopped working last night and it's really hot in here", "en")).toBe("unclear");
    expect(classifyAnswer("", "en")).toBe("unclear");
  });
  it("german, french, spanish", () => {
    expect(classifyAnswer("Ja, gerne", "de")).toBe("yes");
    expect(classifyAnswer("Nein, lieber nicht", "de")).toBe("no");
    expect(classifyAnswer("Oui, d'accord", "fr")).toBe("yes");
    expect(classifyAnswer("Non merci", "fr")).toBe("no");
    expect(classifyAnswer("Sí, claro", "es")).toBe("yes");
    expect(classifyAnswer("No, prefiero que no", "es")).toBe("no");
  });
  it("a long story that merely contains a yes word is not consent", () => {
    expect(classifyAnswer("my neighbor said that it would be ok to call but the thermostat is broken since monday morning", "en")).toBe("unclear");
  });
});

describe("inferConsentOutcome", () => {
  const bot = (t: string) => ({ role: "assistant" as const, text: t });
  const usr = (t: string) => ({ role: "user" as const, text: t });
  it("granted", () => expect(inferConsentOutcome([bot("hi"), usr("yes")], "en", "recording_notice").outcome).toBe("granted"));
  it("declined beats granted", () => expect(inferConsentOutcome([bot("hi"), usr("yes"), usr("actually no recording")], "en", "transcript_consent_ask").outcome).toBe("declined"));
  it("silence or story is unclear", () => {
    expect(inferConsentOutcome([bot("hi")], "en", "recording_notice").outcome).toBe("unclear");
    expect(inferConsentOutcome([bot("hi"), usr("my pipe burst and water is everywhere in the kitchen right now")], "en", "recording_notice").outcome).toBe("unclear");
  });
  it("nothing was asked when no notice was spoken", () => {
    expect(inferConsentOutcome([bot("hi"), usr("yes")], "en", "none").outcome).toBe("not_asked");
  });
});

describe("notice delivery evidence", () => {
  const plan = buildCallStartPlan(base());
  it("true when the notice is inside the first assistant turn", () => {
    expect(noticeInFirstAssistantTurn([{ role: "assistant", text: plan.firstMessage }, { role: "user", text: "yes" }], plan.spokenText)).toBe(true);
  });
  it("false when the first assistant turn lacks it", () => {
    expect(noticeInFirstAssistantTurn([{ role: "assistant", text: DISC }, { role: "assistant", text: plan.spokenText }], plan.spokenText)).toBe(false);
  });
  it("null when nothing was spoken", () => expect(noticeInFirstAssistantTurn([], "")).toBeNull());
});

describe("turnsFromProviderMessages", () => {
  it("maps bot/assistant/user and ignores system, tool and empty messages", () => {
    const t = turnsFromProviderMessages([
      { role: "system", message: "x" }, { role: "bot", message: "hello" }, { role: "user", message: "hi" },
      { role: "assistant", content: "ok" }, { role: "tool", message: "r" }, { role: "user", message: "  " }, null, 5,
    ]);
    expect(t.map((x) => x.role)).toEqual(["assistant", "user", "assistant"]);
    expect(turnsFromProviderMessages(undefined)).toEqual([]);
  });
});

describe("decideStorage", () => {
  const shadowGate = { decision: "record_after_notice", gateMode: "shadow", recordingEnabled: true, spokenKind: "recording_notice" } as const;
  const enforceGate = { decision: "no_recording_consent_gate", gateMode: "enforce", recordingEnabled: false, spokenKind: "transcript_consent_ask" } as const;
  const enforceNotice = { decision: "record_after_notice", gateMode: "enforce", recordingEnabled: true, spokenKind: "recording_notice" } as const;
  it("explicit refusal is honoured in every mode and flags provider deletion when a recording may exist", () => {
    for (const p of [shadowGate, enforceNotice]) {
      const d = decideStorage(p, "declined");
      expect(d.storeRecording).toBe(false);
      expect(d.storeTranscript).toBe(false);
      expect(d.providerDeletionRequired).toBe(true);
    }
    expect(decideStorage(enforceGate, "declined").providerDeletionRequired).toBe(false);
  });
  it("enforce + consent gate keeps nothing unless the caller said yes, and never keeps audio", () => {
    for (const o of ["unclear", "not_asked", "pending"] as const) {
      const d = decideStorage(enforceGate, o);
      expect(d.storeRecording).toBe(false);
      expect(d.storeTranscript).toBe(false);
    }
    const g = decideStorage(enforceGate, "granted");
    expect(g.storeRecording).toBe(false);
    expect(g.storeTranscript).toBe(true);
  });
  it("shadow mode leaves unclear outcomes untouched", () => {
    const d = decideStorage(shadowGate, "unclear");
    expect(d.storeRecording).toBe(true);
    expect(d.storeTranscript).toBe(true);
  });
});

describe("provider payload", () => {
  it("shadow mode never sends artifactPlan; enforce sends the fail-closed flag", () => {
    expect(planOverrides(buildCallStartPlan(base({ gateMode: "shadow" })))).not.toHaveProperty("artifactPlan");
    const e = planOverrides(buildCallStartPlan(base({ businessCountry: "DE", language: "de" })));
    expect(e).toHaveProperty("artifactPlan");
    expect((e.artifactPlan as { recordingEnabled: boolean }).recordingEnabled).toBe(false);
    expect(typeof e.firstMessage).toBe("string");
  });
  it("squad: only the first member gets the first message, every member gets the recording flag", () => {
    const squad = { members: [{ assistantId: "a", assistantOverrides: { name: "m0" } }, { assistantId: "a", assistantOverrides: { name: "m1" } }] };
    const plan = buildCallStartPlan(base({ businessCountry: "DE", language: "de" }));
    const out = applyPlanToSquad(squad, plan);
    expect(out.members[0].assistantOverrides.firstMessage).toBe(plan.firstMessage);
    expect(out.members[1].assistantOverrides).not.toHaveProperty("firstMessage");
    for (const m of out.members) expect((m.assistantOverrides.artifactPlan as { recordingEnabled: boolean }).recordingEnabled).toBe(false);
    expect(squad.members[0].assistantOverrides).not.toHaveProperty("artifactPlan"); // input untouched
  });
});
