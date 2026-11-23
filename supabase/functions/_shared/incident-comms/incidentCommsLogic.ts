// supabase/functions/_shared/incident-comms/incidentCommsLogic.ts
//
// Pure logic (no Deno, no I/O) for customer incident communication: severity matrix, draft templates,
// the text linter and the "may this be sent now" guards. Unit-tested by Vitest; used by the
// `incident-comms` edge function. Source of truth for docs/runbooks/incident-comms.md (a test keeps them in sync).
//
// Drafts are TEMPLATE-based and deterministic on purpose: no model-written text goes to customers, and a draft
// only states facts that exist on the incident record (title, component, region, start time, phase).
// [COUNSEL] anything that touches personal data, security or contractual notification duties is out of scope:
// the linter blocks it and a human must handle it outside this tool.

export type Phase = "investigating" | "identified" | "monitoring" | "resolved";
export type Severity = "sev1" | "sev2" | "sev3" | "sev4";
export type Audience = "status_page" | "status_page_and_subscribers";

export const PHASES: Phase[] = ["investigating", "identified", "monitoring", "resolved"];
export const SEVERITIES: Severity[] = ["sev1", "sev2", "sev3", "sev4"];

export const LIMITS = { statusPost: 600, emailSubject: 150, emailBody: 4000 } as const;

export interface SeverityRule {
  label: string;
  /** Minutes between public updates while the incident is open (null = no public cadence). */
  updateEveryMinutes: number | null;
  statusPage: boolean;
  /** Email to status subscribers allowed at all. */
  email: boolean;
  /** A second person must approve (when the setting is on). */
  fourEyes: boolean;
  /** First public message target, minutes after the incident is declared. */
  firstPostWithinMinutes: number | null;
}

/** Mirrors docs/incident/incident-management.md (severity levels) and docs/runbooks/incident-comms.md. */
export const SEVERITY_MATRIX: Record<Severity, SeverityRule> = {
  sev1: { label: "SEV1", updateEveryMinutes: 30, statusPage: true, email: true, fourEyes: true, firstPostWithinMinutes: 15 },
  sev2: { label: "SEV2", updateEveryMinutes: 60, statusPage: true, email: true, fourEyes: true, firstPostWithinMinutes: 30 },
  sev3: { label: "SEV3", updateEveryMinutes: null, statusPage: true, email: false, fourEyes: false, firstPostWithinMinutes: null },
  sev4: { label: "SEV4", updateEveryMinutes: null, statusPage: false, email: false, fourEyes: false, firstPostWithinMinutes: null },
};

export const isPhase = (v: unknown): v is Phase => typeof v === "string" && (PHASES as string[]).includes(v);
export const isSeverity = (v: unknown): v is Severity => typeof v === "string" && (SEVERITIES as string[]).includes(v);

/** Audience a severity may use. SEV4 has no public message at all. */
export function allowedAudiences(sev: Severity): Audience[] {
  const r = SEVERITY_MATRIX[sev];
  if (!r.statusPage) return [];
  return r.email ? ["status_page", "status_page_and_subscribers"] : ["status_page"];
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export interface IncidentRecord {
  title: string;
  impact: "minor" | "major";
  componentId: string;
  region: string | null;
  startedAt: string;
}

export interface DraftInput {
  incident: IncidentRecord;
  phase: Phase;
  severity: Severity;
  audience: Audience;
  now: Date;
  /** What customers can do. Optional; empty = nothing to do. */
  customerAction?: string;
}

export interface Draft {
  templateId: string;
  statusPostText: string;
  emailSubject: string | null;
  emailBody: string | null;
  nextUpdateAt: Date | null;
}

/** Friendly, provider-free names for status components. Unknown ids fall back to a neutral phrase. */
const COMPONENT_NAMES: Record<string, string> = {
  voice: "the AI receptionist",
  voice_ai: "the AI receptionist",
  telephony: "phone call handling",
  dashboard: "the Vireek dashboard",
  api: "the Vireek API",
  booking: "appointment booking",
  messaging: "text and email notifications",
  billing: "billing and payments",
};

export function componentName(id: string): string {
  return COMPONENT_NAMES[id.trim().toLowerCase()] ?? "part of the Vireek service";
}

export function formatUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function nextUpdateAt(sev: Severity, phase: Phase, now: Date): Date | null {
  const every = SEVERITY_MATRIX[sev].updateEveryMinutes;
  if (phase === "resolved" || every === null) return null;
  return new Date(now.getTime() + every * 60_000);
}

const STATUS_URL = "https://vireek.com/status";

export function templateId(phase: Phase, impact: "minor" | "major"): string {
  return `${phase}.${impact}`;
}

export const TEMPLATE_IDS: string[] = PHASES.flatMap((p) => (["minor", "major"] as const).map((i) => templateId(p, i)));

/** What went wrong, in customer terms: never a cause, a metric, a provider or a customer. */
function symptom(i: IncidentRecord): string {
  const what = componentName(i.componentId);
  const where = i.region ? ` in ${i.region}` : "";
  return i.impact === "major" ? `${what} is unavailable or badly degraded${where}` : `${what} is running slower or less reliably than usual${where}`;
}

export function generateDraft(input: DraftInput): Draft {
  const { incident, phase, severity, audience, now } = input;
  const next = nextUpdateAt(severity, phase, now);
  const nextLine = next ? ` We will post another update by ${formatUtc(next)}.` : "";
  const started = `Started ${formatUtc(new Date(incident.startedAt))}.`;
  const action = (input.customerAction ?? "").trim();
  const actionLine = action ? ` What you can do: ${action}` : phase === "resolved" ? " You do not need to do anything." : "";

  let status: string;
  let lead: string;
  switch (phase) {
    case "investigating":
      status = `We are investigating a problem: ${symptom(incident)}. ${started}${nextLine}`;
      lead = `We are looking into a problem with ${componentName(incident.componentId)}.`;
      break;
    case "identified":
      status = `We have identified the problem affecting ${componentName(incident.componentId)} and are working on a fix.${nextLine}`;
      lead = `We know what is wrong with ${componentName(incident.componentId)} and are working on the fix.`;
      break;
    case "monitoring":
      status = `A fix has been applied for ${componentName(incident.componentId)}. We are monitoring to confirm it holds.${nextLine}`;
      lead = `A fix is in place for ${componentName(incident.componentId)} and we are watching it to be sure it holds.`;
      break;
    default:
      status = `Resolved at ${formatUtc(now)}. ${componentName(incident.componentId)} is working normally again.${actionLine}`;
      lead = `The problem with ${componentName(incident.componentId)} is resolved as of ${formatUtc(now)}.`;
  }
  status = status.replace(/\s+/g, " ").trim();

  if (audience === "status_page") {
    return { templateId: templateId(phase, incident.impact), statusPostText: status, emailSubject: null, emailBody: null, nextUpdateAt: next };
  }

  const subject =
    phase === "resolved" ? `Resolved: ${incident.title}` : phase === "monitoring" ? `Fix applied: ${incident.title}` : `${incident.title}`;
  const parts = [
    `Hello,`,
    lead,
    phase === "resolved" ? `` : `What you may notice: ${symptom(incident)}.`,
    phase === "resolved" ? actionLine.trim() : action ? `What you can do: ${action}` : `You do not need to do anything right now.`,
    next ? `We will post the next update by ${formatUtc(next)} at ${STATUS_URL}.` : `Live status: ${STATUS_URL}`,
    `We are sorry for the disruption.`,
    `The Vireek team`,
  ].filter((p) => p.length > 0);

  return {
    templateId: templateId(phase, incident.impact),
    statusPostText: status,
    emailSubject: subject.slice(0, LIMITS.emailSubject),
    emailBody: parts.join("\n\n"),
    nextUpdateAt: next,
  };
}

// ---------------------------------------------------------------------------
// Linter
// ---------------------------------------------------------------------------

export interface LintIssue {
  code: string;
  /** block = cannot be submitted or approved until fixed; warn = shown to the approver. */
  level: "block" | "warn";
  message: string;
}

const PROVIDERS = /\b(stripe|twilio|vapi|elevenlabs|eleven labs|supabase|vercel|resend|openai|anthropic|aws|amazon web services|cloudflare|google cloud|gcp|azure|sentry|pagerduty|postgres|postgresql)\b/i;
const DATA_INCIDENT = /\b(breach(?:ed)?|data (?:leak|exposure|loss)|exposed|unauthori[sz]ed (?:access|party)|compromised|stolen|exfiltrat\w*|ransom\w*|personal data|pii)\b/i;
const DATA_CLAIM = /\bno (?:customer |personal |user )?(?:data|information)\b.{0,40}\b(?:accessed|exposed|lost|affected|compromised|impacted)\b/i;
const CAUSE = /\b(caused by|due to|root cause|because of|the cause (?:is|was))\b/i;
const PROMISE = /\b(guarantee[sd]?|will never|100%|completely safe|fully secure|no further issues|won'?t happen again)\b/i;

/** Patterns that must never be published, whatever the phase. */
export function lintDraft(text: { statusPost: string; emailSubject?: string | null; emailBody?: string | null }, phase: Phase): LintIssue[] {
  const issues: LintIssue[] = [];
  const parts: [string, string][] = [
    ["status post", text.statusPost ?? ""],
    ["email subject", text.emailSubject ?? ""],
    ["email body", text.emailBody ?? ""],
  ];
  const add = (code: string, level: LintIssue["level"], message: string) => {
    if (!issues.some((i) => i.code === code)) issues.push({ code, level, message });
  };

  if (!text.statusPost.trim()) add("empty_status_post", "block", "The status post is empty.");
  if (text.statusPost.length > LIMITS.statusPost) add("status_post_too_long", "block", `The status post is longer than ${LIMITS.statusPost} characters.`);
  if ((text.emailSubject ?? "").length > LIMITS.emailSubject) add("subject_too_long", "block", `The email subject is longer than ${LIMITS.emailSubject} characters.`);
  if ((text.emailBody ?? "").length > LIMITS.emailBody) add("body_too_long", "block", `The email body is longer than ${LIMITS.emailBody} characters.`);

  for (const [where, t] of parts) {
    if (!t) continue;
    if (/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/i.test(t)) add("email_address", "block", `The ${where} contains an email address.`);
    if (/\+?\d(?:[\s().-]*\d){8,}/.test(t.replace(/\d{4}-\d{2}-\d{2}/g, " "))) add("phone_number", "block", `The ${where} contains something that looks like a phone number.`);
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t)) add("identifier", "block", `The ${where} contains an internal identifier.`);
    if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(t)) add("ip_address", "block", `The ${where} contains an IP address.`);
    for (const m of t.matchAll(/https?:\/\/[^\s)]+/gi)) {
      if (!m[0].toLowerCase().startsWith(STATUS_URL)) add("external_url", "block", `The ${where} links somewhere other than ${STATUS_URL}.`);
    }
    if (PROVIDERS.test(t)) add("provider_name", "block", `The ${where} names an infrastructure or vendor provider. Describe the customer-visible effect instead.`);
    if (DATA_INCIDENT.test(t) || DATA_CLAIM.test(t)) {
      add("data_incident_wording", "block", `The ${where} talks about data exposure, a breach or data safety. That is a security/privacy notification: handle it outside this tool with counsel. [COUNSEL]`);
    }
    if (/\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:ms|seconds?|errors?|req(?:uests)?\/s)\b/i.test(t)) add("metric_value", "warn", `The ${where} contains a metric-like number. Public messages should not quote internal metrics.`);
    if (PROMISE.test(t)) add("absolute_promise", "warn", `The ${where} makes an absolute promise. Avoid guarantees.`);
    if (phase !== "resolved" && CAUSE.test(t)) add("speculative_cause", "warn", `The ${where} states a cause before the incident is resolved. Say what customers see, not why, until the cause is confirmed.`);
  }

  if (phase !== "resolved" && !/\bupdate by\b|\bnext update\b|\blive status\b/i.test(`${text.statusPost} ${text.emailBody ?? ""}`)) {
    add("no_next_update", "warn", "There is no promised time for the next update.");
  }
  return issues;
}

export const hasBlockingIssue = (issues: LintIssue[]): boolean => issues.some((i) => i.level === "block");

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Returns a reason code when this audience is not allowed for the severity. */
export function audienceProblem(sev: Severity, audience: Audience): "no_public_message" | "email_not_allowed" | null {
  if (!SEVERITY_MATRIX[sev].statusPage) return "no_public_message";
  if (audience === "status_page_and_subscribers" && !SEVERITY_MATRIX[sev].email) return "email_not_allowed";
  return null;
}

/** True when the draft promised an update time that has already passed (same rule as the database). */
export function isStale(phase: Phase, nextUpdate: string | null, now: Date, alreadyPosted = false): boolean {
  if (phase === "resolved" || !nextUpdate || alreadyPosted) return false;
  const t = Date.parse(nextUpdate);
  return Number.isFinite(t) && t < now.getTime();
}

/** Plain-text paragraphs -> email-safe HTML paragraphs (escaped). */
export function paragraphsHtml(text: string, escape: (s: string) => string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;">${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
