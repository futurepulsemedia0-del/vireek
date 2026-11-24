// supabase/functions/_shared/agent-marketplace/vetting.ts
//
// Automated static vetting for marketplace agent versions. Pure functions only
// (no I/O, no Deno globals): the marketplace-vetting edge function gathers the
// inputs (agent row, scope catalog, peer agents, optional DNS answer) and this
// module turns them into a deterministic report. Every rule is unit tested in
// vetting.test.ts.
//
// What this DOES check: requested scopes, the data fields those scopes expose,
// the outbound endpoint Vireek will call, declared third-party domains, and
// look-alike / impersonation signals.
// What this CANNOT check: what the publisher's server really does with the data.
// Declared outbound domains are SELF-ATTESTED and are not enforced anywhere; a
// passing report is an input to human review, never a certification.

import { checkEndpointShape, fieldsExposedBy, isPrivateIp } from "./contract.ts";

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckCategory = "manifest" | "scopes" | "outbound" | "data" | "identity";
export type RiskTier = "low" | "medium" | "high";
export type Verdict = CheckStatus;

export interface VettingCheck {
  id: string;
  category: CheckCategory;
  status: CheckStatus;
  /** English fallback; the UI translates by `id` + `status`. */
  detail: string;
  evidence?: string[];
}

export interface ScopeInfo {
  slug: string;
  kind: "read" | "act";
  risk: "low" | "medium" | "high";
}

export type DnsAnswer = { ok: true; addresses: string[] } | { ok: false; error: string };

export interface VettingInput {
  agent: {
    slug: string;
    name: string;
    publisherName: string;
    publisherId: string | null;
    runtime: "builtin" | "webhook";
    endpointUrl: string | null;
  };
  manifest: unknown;
  scopeCatalog: readonly ScopeInfo[];
  peers: {
    /** Slugs of agents from OTHER publishers whose endpoint uses the same host. */
    hostMatches: readonly string[];
    /** Names of first-party (Vireek) agents. */
    firstPartyNames: readonly string[];
    /** Names of agents from other publishers. */
    otherAgentNames: readonly string[];
  };
  /** Result of resolving the endpoint host (A + AAAA). Omit when DNS was not checked. */
  dns?: DnsAnswer;
}

export interface DataExposure {
  classification: "none" | "operational" | "customer_profile" | "financial" | "contact_pii";
  jobFields: string[];
  customerFields: string[];
}

export interface VettingReport {
  verdict: Verdict;
  riskTier: RiskTier;
  checks: VettingCheck[];
  summary: { pass: number; warn: number; fail: number };
  dataExposure: DataExposure;
  /** Hosts Vireek data may reach: the endpoint host plus declared (self-attested) processors. */
  outboundDomains: string[];
}

export const VALID_TRIGGERS = ["manual", "schedule.daily", "job.scheduled", "job.completed", "invoice.overdue", "quote.declined"] as const;
export const REPORT_MAX_AGE_DAYS = 14;

// ---------------------------------------------------------------- helpers --

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function hostOf(endpointUrl: string | null): string | null {
  if (!endpointUrl) return null;
  const shape = checkEndpointShape(endpointUrl);
  return shape.ok ? shape.url.hostname.toLowerCase() : null;
}

interface NormalizedManifest {
  scopes: string[];
  triggers: string[];
  timeoutMs: number | null;
  maxActions: number | null;
  hasSystemPrompt: boolean;
  declaredDomains: unknown; // undefined = not declared
  errors: string[];
}

export function normalizeManifest(raw: unknown): NormalizedManifest {
  const out: NormalizedManifest = { scopes: [], triggers: [], timeoutMs: null, maxActions: null, hasSystemPrompt: false, declaredDomains: undefined, errors: [] };
  if (!isPlainObject(raw)) {
    out.errors.push("manifest is not a JSON object");
    return out;
  }
  const scopes = stringArray(raw.scopes);
  if (!scopes || scopes.length < 1 || scopes.length > 12) out.errors.push("scopes must be an array of 1-12 strings");
  else out.scopes = [...new Set(scopes)];

  const triggers = stringArray(raw.triggers);
  if (!triggers || triggers.length < 1 || triggers.length > 6) out.errors.push("triggers must be an array of 1-6 strings");
  else {
    out.triggers = triggers;
    for (const t of triggers) if (!(VALID_TRIGGERS as readonly string[]).includes(t)) out.errors.push(`unknown trigger: ${t}`);
  }

  if (raw.limits !== undefined) {
    if (!isPlainObject(raw.limits)) out.errors.push("limits must be an object");
    else {
      const { timeout_ms: t, max_actions: a } = raw.limits;
      if (t !== undefined) {
        if (typeof t !== "number" || !Number.isFinite(t) || t < 1000 || t > 15000) out.errors.push("limits.timeout_ms must be a number 1000-15000");
        else out.timeoutMs = t;
      }
      if (a !== undefined) {
        if (typeof a !== "number" || !Number.isFinite(a) || a < 1 || a > 10) out.errors.push("limits.max_actions must be a number 1-10");
        else out.maxActions = a;
      }
    }
  }
  out.hasSystemPrompt = raw.system_prompt !== undefined;
  out.declaredDomains = raw.outbound_domains;
  return out;
}

/** Validates the publisher's self-declared processor domains. */
export function parseDeclaredDomains(raw: unknown): { domains: string[]; errors: string[] } {
  if (raw === undefined) return { domains: [], errors: [] };
  const list = stringArray(raw);
  if (!list) return { domains: [], errors: ["outbound_domains must be an array of hostnames"] };
  if (list.length > 10) return { domains: [], errors: ["outbound_domains allows at most 10 hostnames"] };
  const domains: string[] = [];
  const errors: string[] = [];
  for (const entry of list) {
    const d = entry.trim().toLowerCase();
    const shape = checkEndpointShape(`https://${d}`);
    if (!d || !shape.ok || shape.url.hostname !== d) errors.push(`invalid hostname: ${entry.slice(0, 80)}`);
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, errors };
}

const status = (bad: boolean, severity: "warn" | "fail"): CheckStatus => (bad ? severity : "pass");

// ------------------------------------------------------------------ engine --

export function runStaticVetting(input: VettingInput): VettingReport {
  const { agent, scopeCatalog } = input;
  const m = normalizeManifest(input.manifest);
  const catalog = new Map(scopeCatalog.map((s) => [s.slug, s]));
  const unknownScopes = m.scopes.filter((s) => !catalog.has(s));
  const known = m.scopes.filter((s) => catalog.has(s));
  const has = (s: string) => known.includes(s);
  const checks: VettingCheck[] = [];
  const add = (c: VettingCheck) => checks.push(c);

  // ---- manifest ----------------------------------------------------------
  add({ id: "manifest.shape", category: "manifest", status: status(m.errors.length > 0, "fail"), detail: m.errors.length ? "Manifest is malformed." : "Manifest is well-formed.", evidence: m.errors.length ? m.errors : undefined });

  const limitWarn: string[] = [];
  if (m.timeoutMs !== null && m.timeoutMs > 10000) limitWarn.push(`timeout_ms ${m.timeoutMs} (> 10000)`);
  if (m.maxActions !== null && m.maxActions > 5) limitWarn.push(`max_actions ${m.maxActions} (> 5)`);
  add({ id: "manifest.limits", category: "manifest", status: status(limitWarn.length > 0, "warn"), detail: limitWarn.length ? "Limits are above the recommended ceiling." : "Limits are within the recommended range (or defaulted).", evidence: limitWarn.length ? limitWarn : undefined });

  add({ id: "manifest.prompt", category: "manifest", status: status(agent.runtime === "webhook" && m.hasSystemPrompt, "fail"), detail: agent.runtime === "webhook" && m.hasSystemPrompt ? "system_prompt is only valid for built-in agents." : "No system_prompt conflict." });

  // ---- scopes ------------------------------------------------------------
  add({ id: "scopes.known", category: "scopes", status: status(unknownScopes.length > 0, "fail"), detail: unknownScopes.length ? "Unknown scopes requested." : "All requested scopes exist in the catalog.", evidence: unknownScopes.length ? unknownScopes : undefined });

  const highRisk = known.filter((s) => catalog.get(s)?.risk === "high");
  add({ id: "scopes.risk", category: "scopes", status: status(highRisk.length > 0, "warn"), detail: highRisk.length ? "High-risk scopes requested: each needs written justification during review." : "No high-risk scopes requested.", evidence: highRisk.length ? highRisk : undefined });

  const coherence: string[] = [];
  if (has("act:send_sms") && !has("read:customers")) coherence.push("act:send_sms without read:customers (the agent never receives a customer id to message)");
  if (has("read:customer_contact") && !has("read:customers") && !has("read:jobs")) coherence.push("read:customer_contact without read:customers or read:jobs (grants nothing)");
  if (has("read:customer_contact") && !has("act:send_sms")) coherence.push("read:customer_contact without act:send_sms (personal data leaves Vireek with no messaging purpose)");
  if (has("read:job_financials") && !has("read:jobs")) coherence.push("read:job_financials without read:jobs (grants nothing)");
  if (has("read:customers") && !has("read:jobs") && !m.triggers.includes("manual") && !m.triggers.includes("schedule.daily")) coherence.push("read:customers without read:jobs on an event trigger (no customer context is built)");
  add({ id: "scopes.coherence", category: "scopes", status: status(coherence.length > 0, "warn"), detail: coherence.length ? "Some scopes look unnecessary or unusable." : "Scopes are coherent with each other.", evidence: coherence.length ? coherence : undefined });

  // ---- outbound ----------------------------------------------------------
  const endpoint = agent.endpointUrl ? checkEndpointShape(agent.endpointUrl) : null;
  const host = endpoint && endpoint.ok ? endpoint.url.hostname.toLowerCase() : null;
  if (agent.runtime === "webhook") {
    const bad = !agent.endpointUrl ? "No endpoint URL." : endpoint && !endpoint.ok ? endpoint.reason : null;
    add({ id: "outbound.endpoint", category: "outbound", status: status(Boolean(bad), "fail"), detail: bad ?? "Endpoint is an https public-domain URL on port 443.", evidence: bad ? [bad] : host ? [host] : undefined });
  } else {
    add({ id: "outbound.endpoint", category: "outbound", status: status(Boolean(agent.endpointUrl), "warn"), detail: agent.endpointUrl ? "Built-in agents should not have an endpoint URL." : "Built-in agent: no external endpoint." });
  }

  const hostNotes: string[] = [];
  if (host && host.split(".").some((l) => l.startsWith("xn--"))) hostNotes.push(`punycode label in ${host} (possible look-alike domain)`);
  if (host && input.peers.hostMatches.length) hostNotes.push(`same host used by other publishers: ${input.peers.hostMatches.join(", ")}`);
  add({ id: "outbound.host", category: "outbound", status: status(hostNotes.length > 0, "warn"), detail: hostNotes.length ? "Endpoint host needs a closer look." : "Endpoint host is unremarkable.", evidence: hostNotes.length ? hostNotes : undefined });

  if (agent.runtime !== "webhook") {
    add({ id: "outbound.dns", category: "outbound", status: "pass", detail: "Not applicable to built-in agents." });
  } else if (!input.dns) {
    add({ id: "outbound.dns", category: "outbound", status: "warn", detail: "DNS was not checked for this report." });
  } else if (!input.dns.ok) {
    add({ id: "outbound.dns", category: "outbound", status: "fail", detail: "Endpoint host does not resolve.", evidence: [input.dns.error.slice(0, 200)] });
  } else {
    const priv = input.dns.addresses.filter(isPrivateIp);
    const bad = input.dns.addresses.length === 0 || priv.length > 0;
    add({ id: "outbound.dns", category: "outbound", status: status(bad, "fail"), detail: priv.length ? "Endpoint resolves to a private address." : input.dns.addresses.length === 0 ? "Endpoint resolved to no addresses." : "Endpoint resolves to public addresses only.", evidence: priv.length ? priv : input.dns.addresses.slice(0, 8) });
  }

  const declared = parseDeclaredDomains(m.declaredDomains);
  const needsDeclaration = has("read:customer_contact") && m.declaredDomains === undefined;
  add({
    id: "outbound.declared",
    category: "outbound",
    status: declared.errors.length ? "fail" : needsDeclaration ? "warn" : "pass",
    detail: declared.errors.length ? "outbound_domains is invalid." : needsDeclaration ? "Contact data is requested but no processors were declared (use an empty list to state none). Self-attested." : "Declared processors (self-attested, not enforced).",
    evidence: declared.errors.length ? declared.errors : declared.domains.length ? declared.domains : undefined,
  });

  // ---- data --------------------------------------------------------------
  const exposure = fieldsExposedBy(known);
  const classification: DataExposure["classification"] = has("read:customer_contact") ? "contact_pii"
    : has("read:job_financials") ? "financial"
    : has("read:customers") ? "customer_profile"
    : has("read:jobs") ? "operational" : "none";
  add({
    id: "data.exposure",
    category: "data",
    status: status(classification === "contact_pii", "warn"),
    detail: classification === "contact_pii" ? "Personal contact data (phone, email, address) will leave Vireek." : `Data classification: ${classification}.`,
    evidence: [`jobs: ${exposure.jobs.join(", ") || "-"}`, `customers: ${exposure.customers.join(", ") || "-"}`],
  });
  add({ id: "data.messaging", category: "data", status: status(has("act:send_sms"), "warn"), detail: has("act:send_sms") ? "Agent can propose SMS to customers: A2P and opt-out review required." : "Agent cannot message customers." });

  // ---- identity ----------------------------------------------------------
  const impersonates = agent.publisherId !== null && (normalizeName(agent.publisherName).includes("vireek") || normalizeName(agent.name).includes("vireek"));
  add({ id: "identity.publisher", category: "identity", status: status(impersonates, "fail"), detail: impersonates ? "Third-party publisher or agent name uses the Vireek brand." : "No first-party impersonation signal." });

  const me = normalizeName(agent.name);
  const similar = [...input.peers.firstPartyNames, ...input.peers.otherAgentNames].filter((n) => {
    const other = normalizeName(n);
    return other === me || (me.length >= 6 && other.length >= 6 && levenshtein(me, other) <= 2);
  });
  add({ id: "identity.lookalike", category: "identity", status: status(similar.length > 0, "warn"), detail: similar.length ? "Agent name is identical or very close to an existing agent." : "Agent name is distinct.", evidence: similar.length ? [...new Set(similar)].slice(0, 5) : undefined });

  // ---- verdict -----------------------------------------------------------
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status] += 1;
  const verdict: Verdict = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  const risks = known.map((s) => catalog.get(s)?.risk);
  const riskTier: RiskTier = unknownScopes.length > 0 || risks.includes("high") ? "high" : risks.includes("medium") ? "medium" : "low";
  const outboundDomains = [...new Set([...(host ? [host] : []), ...declared.domains])];

  return { verdict, riskTier, checks, summary, dataExposure: { classification, jobFields: exposure.jobs, customerFields: exposure.customers }, outboundDomains };
}

/** A failed report can never support approval. Warnings require the human checklist, not this gate. */
export const reportAllowsApproval = (r: Pick<VettingReport, "verdict">): boolean => r.verdict !== "fail";

export function isReportFresh(ranAtIso: string, now: Date = new Date(), maxAgeDays = REPORT_MAX_AGE_DAYS): boolean {
  const ran = Date.parse(ranAtIso);
  if (!Number.isFinite(ran)) return false;
  const age = now.getTime() - ran;
  return age >= 0 && age <= maxAgeDays * 86_400_000;
}
