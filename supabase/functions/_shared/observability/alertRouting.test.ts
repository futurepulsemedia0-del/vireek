// supabase/functions/_shared/observability/alertRouting.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, EMPTY_STATE, buildNotifications, evaluateRule, type AlertRule, type Decision, type RoutedNotification, type Severity } from "./alertRules.ts";
import {
  DEFAULT_ROUTING, buildRequests, enforceEngineDecision, isSafeUrl, parseRoutingOverride, selectDestinations, validateRouting, type RoutingConfig,
} from "./alertRouting.ts";

const NOW = new Date("2030-01-01T00:00:00Z");
const ruleByKey = (k: string): AlertRule => DEFAULT_RULES.find((r) => r.key === k)!;

/** Drive the real state machine until the rule opens, then return the real notifications it produces. */
function notificationsFor(ruleKey: string, scopes = ["eu"], pagesLastHour = 0): RoutedNotification[] {
  const rule = ruleByKey(ruleKey);
  const bad = rule.comparator === "gt" ? rule.threshold * 2 : rule.threshold / 2;
  const decisions: Decision[] = scopes.map((scopeKey) => {
    let state = { ...EMPTY_STATE };
    let d!: Decision;
    for (let i = 0; i < rule.confirmations; i++) {
      d = evaluateRule(rule, { metric: rule.metric, scopeKey, value: bad, samples: rule.minSamples + 5 }, state, { now: NOW });
      state = d.next;
    }
    return d;
  });
  return buildNotifications(decisions, pagesLastHour);
}

const ENV_ALL: Record<string, string> = {
  PAGERDUTY_ROUTING_KEY: "pd-key", ALERT_PAGER_WEBHOOK_URL: "https://pager.example.test/hook",
  ALERT_SLACK_WEBHOOK_URL: "https://chat.example.test/hook", ALERT_TICKET_WEBHOOK_URL: "https://tickets.example.test/hook",
};
const envOf = (m: Record<string, string>) => (n: string) => m[n];
const send = (n: RoutedNotification, env: Record<string, string>, cfg: RoutingConfig = DEFAULT_ROUTING) => buildRequests(n, cfg, envOf(env), "https://runbooks.example.test/", "vireek-voice");

describe("default routing config", () => {
  it("is valid", () => { expect(validateRouting(DEFAULT_ROUTING)).toEqual([]); });
  it("routes SEV1 and SEV2 to paging destinations", () => {
    for (const sev of ["SEV1", "SEV2"] as Severity[]) {
      const names = selectDestinations({ severity: sev, kind: "trigger", dedupKey: "obs:x", summary: "s", runbook: "r", channel: "pagerduty", decisions: [] }, DEFAULT_ROUTING).map((d) => d.name);
      expect(names).toContain("pager");
      expect(names).toContain("pager-webhook");
      expect(names).toContain("chat");
    }
  });
  it("routes SEV3 to chat only and SEV4 to ticket only", () => {
    const base = { kind: "trigger" as const, dedupKey: "obs:x", summary: "s", runbook: "r", decisions: [] };
    expect(selectDestinations({ ...base, severity: "SEV3", channel: "slack" }, DEFAULT_ROUTING).map((d) => d.name)).toEqual(["chat"]);
    expect(selectDestinations({ ...base, severity: "SEV4", channel: "ticket" }, DEFAULT_ROUTING).map((d) => d.name)).toEqual(["ticket"]);
  });
});

describe("validateRouting", () => {
  const ok: RoutingConfig = { destinations: [{ name: "p", format: "generic", urlEnv: "PAGE_URL", isPaging: true }], rules: [{ severities: ["SEV1"], to: ["p"] }] };
  it("accepts a minimal valid config", () => { expect(validateRouting(ok)).toEqual([]); });
  it("rejects SEV1 that reaches no paging destination", () => {
    const cfg: RoutingConfig = { destinations: [{ name: "c", format: "slack", urlEnv: "CHAT_URL" }], rules: [{ severities: ["SEV1", "SEV2"], to: ["c"] }] };
    expect(validateRouting(cfg).join("|")).toContain("SEV1 is not routed to any paging destination");
  });
  it("rejects unknown destination, duplicate names, bad env names and a URL where an env name belongs", () => {
    const cfg: RoutingConfig = {
      destinations: [
        { name: "p", format: "generic", urlEnv: "https://hooks.example.test/secret", isPaging: true },
        { name: "p", format: "generic", urlEnv: "OK_URL", isPaging: true },
      ],
      rules: [{ severities: ["SEV1"], to: ["p", "ghost"] }],
    };
    const e = validateRouting(cfg).join("|");
    expect(e).toContain("duplicate destination");
    expect(e).toContain("urlEnv must be an env var NAME");
    expect(e).toContain("unknown destination ghost");
  });
  it("rejects pagerduty-v2 without routingKeyEnv and routingKeyEnv on other formats", () => {
    expect(validateRouting({ ...ok, destinations: [{ name: "p", format: "pagerduty-v2", urlEnv: "U_URL", isPaging: true }] }).join("|")).toContain("needs routingKeyEnv");
    expect(validateRouting({ ...ok, destinations: [{ name: "p", format: "generic", urlEnv: "U_URL", routingKeyEnv: "K_KEY", isPaging: true }] }).join("|")).toContain("only valid for pagerduty-v2");
  });
  it("rejects fallback loops and chains longer than one hop", () => {
    const cfg: RoutingConfig = {
      destinations: [
        { name: "a", format: "generic", urlEnv: "A_URL", isPaging: true, fallback: "b" },
        { name: "b", format: "generic", urlEnv: "B_URL", fallback: "c" },
        { name: "c", format: "generic", urlEnv: "C_URL" },
      ],
      rules: [{ severities: ["SEV1"], to: ["a"] }],
    };
    expect(validateRouting(cfg).join("|")).toContain("longer than one hop");
    expect(validateRouting({ ...cfg, destinations: [{ name: "a", format: "generic", urlEnv: "A_URL", isPaging: true, fallback: "a" }] }).join("|")).toContain("fallback cannot be itself");
  });
});

describe("parseRoutingOverride (a typo must never silence alerting)", () => {
  it("returns the default when unset or blank", () => {
    expect(parseRoutingOverride(undefined)).toMatchObject({ overridden: false, errors: [] });
    expect(parseRoutingOverride("  ").config).toBe(DEFAULT_ROUTING);
  });
  it("falls back to the default on invalid JSON, wrong shape, oversized input and unsafe config", () => {
    for (const raw of ["{nope", "[]", JSON.stringify({ destinations: [], rules: [] }), "x".repeat(9000)]) {
      const r = parseRoutingOverride(raw);
      expect(r.config).toBe(DEFAULT_ROUTING);
      expect(r.overridden).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });
  it("accepts a valid override", () => {
    const cfg: RoutingConfig = { destinations: [{ name: "oncall", format: "generic", urlEnv: "ONCALL_URL", isPaging: true }], rules: [{ severities: ["SEV1", "SEV2", "SEV3"], to: ["oncall"] }] };
    const r = parseRoutingOverride(JSON.stringify(cfg));
    expect(r.overridden).toBe(true);
    expect(r.config).toEqual(cfg);
  });
});

describe("ruleKeys filtering and sendResolves", () => {
  const cfg: RoutingConfig = {
    destinations: [{ name: "p", format: "generic", urlEnv: "P_URL", isPaging: true }, { name: "c", format: "slack", urlEnv: "C_URL" }],
    rules: [{ severities: ["SEV1", "SEV2", "SEV3", "SEV4"], to: ["c"] }, { severities: ["SEV2"], ruleKeys: ["webhook_5xx_high"], to: ["p"], sendResolves: false }],
  };
  const n = (dedupKey: string, kind: "trigger" | "resolve"): RoutedNotification => ({ severity: "SEV2", kind, dedupKey, summary: "s", runbook: "r", channel: "pagerduty", decisions: [] });
  it("sends the extra destination only for the named rule", () => {
    expect(selectDestinations(n("obs:webhook_5xx_high", "trigger"), cfg).map((d) => d.name)).toEqual(["c", "p"]);
    expect(selectDestinations(n("obs:provider_error_high", "trigger"), cfg).map((d) => d.name)).toEqual(["c"]);
  });
  it("matches burn-rate dedup keys by slo key", () => {
    const c2: RoutingConfig = { ...cfg, rules: [{ severities: ["SEV2"], ruleKeys: ["answer"], to: ["p"] }] };
    expect(selectDestinations(n("obs:burn:answer", "trigger"), c2).map((d) => d.name)).toEqual(["p"]);
  });
  it("skips destinations with sendResolves=false on resolve only", () => {
    expect(selectDestinations(n("obs:webhook_5xx_high", "resolve"), cfg).map((d) => d.name)).toEqual(["c"]);
  });
  it("does not duplicate a destination matched by two rules", () => {
    const c2: RoutingConfig = { ...cfg, rules: [{ severities: ["SEV2"], to: ["p"] }, { severities: ["SEV2"], to: ["p", "c"] }] };
    expect(selectDestinations(n("obs:x", "trigger"), c2).map((d) => d.name)).toEqual(["p", "c"]);
  });
});

describe("integration with the real alert engine", () => {
  it("SEV1 answer_rate_critical pages every configured paging destination and mirrors to chat", () => {
    const notes = notificationsFor("answer_rate_critical");
    const page = notes.find((x) => x.channel === "pagerduty")!;
    const { requests } = send(page, ENV_ALL);
    expect(requests.map((r) => r.destination).sort()).toEqual(["chat", "pager", "pager-webhook"].sort());
    expect(requests.filter((r) => r.paging)).toHaveLength(2);
    const generic = requests.find((r) => r.destination === "pager-webhook")!.body as { schema: string; severity: string; runbook_url: string; dedup_key: string };
    expect(generic.schema).toBe("vireek.alert.v1");
    expect(generic.severity).toBe("SEV1");
    expect(generic.dedup_key).toBe("obs:answer_rate_critical");
    expect(generic.runbook_url.startsWith("https://runbooks.example.test/docs/runbooks/")).toBe(true);
  });
  it("SEV3 never reaches a paging destination even if one is configured", () => {
    const notes = notificationsFor("tool_failure_high");
    expect(notes.every((x) => x.channel !== "pagerduty")).toBe(true);
    for (const x of notes) expect(send(x, ENV_ALL).requests.some((r) => r.paging)).toBe(false);
  });
  it("page budget overflow for SEV2 degrades to chat and is NOT sent to paging destinations", () => {
    const notes = notificationsFor("webhook_5xx_high", ["global"], 6);
    expect(notes.every((x) => x.channel === "slack")).toBe(true);
    for (const x of notes) expect(send(x, ENV_ALL).requests.some((r) => r.paging)).toBe(false);
  });
  it("SEV1 is still paged when the page budget is exhausted", () => {
    const notes = notificationsFor("answer_rate_critical", ["eu"], 6);
    const page = notes.find((x) => x.channel === "pagerduty")!;
    expect(send(page, ENV_ALL).requests.some((r) => r.paging)).toBe(true);
  });
  it("SEV4 digest goes to the ticket webhook", () => {
    const notes = notificationsFor("asr_confidence_low", ["global"]);
    const { requests } = send(notes[0], ENV_ALL);
    expect(requests.map((r) => r.destination)).toEqual(["ticket"]);
    expect(requests[0].url).toBe(ENV_ALL.ALERT_TICKET_WEBHOOK_URL);
  });
  it("resolves are routed like triggers", () => {
    const page: RoutedNotification = { severity: "SEV1", kind: "resolve", dedupKey: "obs:answer_rate_critical", summary: "s", runbook: "r", channel: "pagerduty", decisions: [] };
    expect(send(page, ENV_ALL).requests.length).toBe(3);
  });
});

describe("delivery configuration", () => {
  const page: RoutedNotification = { severity: "SEV1", kind: "trigger", dedupKey: "obs:answer_rate_critical", summary: "s", runbook: "r", channel: "pagerduty", decisions: [] };
  it("sends to nothing and reports every destination when nothing is configured", () => {
    const r = send(page, {});
    expect(r.requests).toEqual([]);
    expect(r.unconfigured.sort()).toEqual(["chat", "pager", "pager-webhook"].sort());
  });
  it("works with ONLY the vendor-neutral webhook (no PagerDuty key)", () => {
    const r = send(page, { ALERT_PAGER_WEBHOOK_URL: "https://pager.example.test/hook" });
    expect(r.requests.map((x) => x.destination)).toEqual(["pager-webhook"]);
    expect(r.requests[0].paging).toBe(true);
  });
  it("sends the PagerDuty v2 body only when a routing key exists, and never leaks the key into other bodies", () => {
    const r = send(page, ENV_ALL);
    const pd = r.requests.find((x) => x.destination === "pager")!;
    expect((pd.body as { routing_key: string; event_action: string }).routing_key).toBe("pd-key");
    expect((pd.body as { event_action: string }).event_action).toBe("trigger");
    expect(pd.url).toBe("https://events.pagerduty.com/v2/enqueue");
    for (const x of r.requests.filter((y) => y.destination !== "pager")) expect(JSON.stringify(x.body)).not.toContain("pd-key");
  });
  it("ticket falls back to chat when the ticket webhook is missing (previous behaviour)", () => {
    const sev4: RoutedNotification = { severity: "SEV4", kind: "digest", dedupKey: "obs:asr_confidence_low", summary: "s", runbook: "r", channel: "ticket", decisions: [] };
    const r = send(sev4, { ALERT_SLACK_WEBHOOK_URL: "https://chat.example.test/hook" });
    expect(r.requests.map((x) => x.destination)).toEqual(["chat"]);
  });
  it("refuses non-https and malformed URLs but allows http://localhost", () => {
    expect(isSafeUrl("http://evil.example.test/x")).toBe(false);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("not a url")).toBe(false);
    expect(isSafeUrl("http://localhost:9000/x")).toBe(true);
    expect(isSafeUrl("https://ok.example.test/x")).toBe(true);
    const r = send(page, { ALERT_PAGER_WEBHOOK_URL: "http://evil.example.test/x" });
    expect(r.requests).toEqual([]);
    expect(r.unconfigured).toContain("pager-webhook");
  });
  it("sends one request per distinct URL", () => {
    const cfg: RoutingConfig = {
      destinations: [{ name: "a", format: "generic", urlEnv: "SAME_URL", isPaging: true }, { name: "b", format: "slack", urlEnv: "SAME_URL" }],
      rules: [{ severities: ["SEV1"], to: ["a", "b"] }],
    };
    expect(send(page, { SAME_URL: "https://x.example.test/h" }, cfg).requests).toHaveLength(1);
  });
  it("enforceEngineDecision strips paging destinations from non-page notifications", () => {
    const dests = DEFAULT_ROUTING.destinations;
    expect(enforceEngineDecision({ ...page, channel: "slack" }, dests).some((d) => d.isPaging)).toBe(false);
    expect(enforceEngineDecision(page, dests)).toEqual(dests);
  });
  it("generic payload carries no customer data fields", () => {
    const r = send(page, ENV_ALL);
    const raw = JSON.stringify(r.requests.find((x) => x.destination === "pager-webhook")!.body);
    expect(raw).not.toMatch(/phone|email|transcript|customer/i);
  });
});
