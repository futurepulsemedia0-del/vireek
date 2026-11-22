// supabase/functions/_shared/breach/notice.ts
//
// Draft renderers for the breach scoping tool: a per-tenant customer notice and an internal scoping summary.
// Pure and deterministic. NOTHING here sends anything, and nothing here makes a legal statement:
//   * everything legal is a visible placeholder   [COUNSEL: ...]
//   * every fact the scan cannot know is a placeholder   [TO CONFIRM: ...]
// A draft with any placeholder left is reported as `complete: false` and must not be sent.
// Customer-notice content follows the public Incident Response & Data Breach Policy (src/lib/legalDocs/incidentResponse.ts):
// nature of the breach, categories and approximate volume, likely consequences, measures taken.

import { CATEGORIES, type CategoryId } from "./registry.ts";
import type { ScanMode, ScanSummary, TenantImpact } from "./scan.ts";

export interface IncidentInput {
  /** Internal incident reference, e.g. INC-2029-014. */
  reference: string;
  title: string;
  /** ISO timestamp: when Vireek became aware (the clock for many deadlines starts here [COUNSEL]). */
  discoveredAt: string;
  windowFrom: string;
  windowTo: string;
  mode: ScanMode;
  whatHappened: string;
  containment: string;
  /** What is known about misuse / likely consequences. Leave empty if unknown: a placeholder is inserted. */
  consequences: string;
  contactName: string;
  contactEmail: string;
}

export interface TenantContact { tenantId: string; companyName: string | null; fullName: string | null; email: string | null }

export interface NoticeDraft {
  tenantId: string;
  to: string | null;
  subject: string;
  body: string;
  placeholders: string[];
  warnings: string[];
  /** true only when no placeholder remains and the recipient address is known. Still requires counsel approval [COUNSEL]. */
  complete: boolean;
}

const PLACEHOLDER = /\[(?:COUNSEL|TO CONFIRM)[^\]\n]*\]/g;
export const findPlaceholders = (text: string): string[] => [...new Set(text.match(PLACEHOLDER) ?? [])];

/** Plain text only: strip control characters and cap length so pasted content cannot break the layout or a mail header. */
export function clean(input: string, max: number): string {
  return String(input ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}
const oneLine = (s: string, max: number) => clean(s, max).replace(/\s*\n\s*/g, " ");

function fmtUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z").replace(/:00Z$/, "Z") : "[TO CONFIRM: valid timestamp]";
}

const approx = (n: number) => (n < 1000 ? String(n) : `${Math.round(n / 100) / 10}k`);
const modeNote = (mode: ScanMode) =>
  mode === "existing_at_end"
    ? "Record counts are approximate and count records that existed in your account when the window closed. They show what could have been exposed, not what was confirmed as accessed."
    : "Record counts are approximate and count records created during the window. They show what could have been exposed, not what was confirmed as accessed.";

export function renderTenantNotice(incident: IncidentInput, tenant: TenantContact, impact: TenantImpact): NoticeDraft {
  const warnings: string[] = [];
  const who = clean(tenant.fullName ?? "", 120) || clean(tenant.companyName ?? "", 120);
  const to = tenant.email && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(tenant.email) ? tenant.email : null;
  if (!to) warnings.push("No valid recipient email on file for this tenant.");
  if (!who) warnings.push("No contact name on file for this tenant.");

  const text = (value: string, max: number, placeholder: string) => clean(value, max) || placeholder;
  const lines: string[] = [];
  const secrets = impact.categories.some((c) => CATEGORIES[c].secrets);

  lines.push(`Hello ${who || "[TO CONFIRM: contact name]"},`, "");
  lines.push("We are writing to tell you about a security incident that involved data Vireek processes on your behalf.", "");
  lines.push("What happened", text(incident.whatHappened, 2000, "[TO CONFIRM: plain-language description of what happened]"), "");
  lines.push("When", `The affected period was ${fmtUtc(incident.windowFrom)} to ${fmtUtc(incident.windowTo)} (UTC). We became aware of the incident on ${fmtUtc(incident.discoveredAt)} (UTC).`, "");
  lines.push("What information may have been involved");
  lines.push("Based on our review, your account holds the following kinds of information that could have been involved:");
  for (const c of impact.categories) {
    const cat = CATEGORIES[c];
    const n = impact.categoryRows[c] ?? 0;
    lines.push(`- ${cat.label}: ${cat.description} (approximately ${approx(n)} ${n === 1 ? "record" : "records"})`);
  }
  lines.push("", modeNote(incident.mode), "");
  lines.push("What we are doing", text(incident.containment, 2000, "[TO CONFIRM: containment and remediation steps taken]"), "");
  lines.push("What this may mean for you", text(incident.consequences, 2000, "[TO CONFIRM: known or likely consequences, including whether misuse has been observed]"), "");
  lines.push("What you can do");
  lines.push("- Review recent activity on your account and tell us about anything unfamiliar.");
  if (secrets) lines.push("- Rotate any API keys and reconnect your integrations (accounting, payroll, bank and other connected services), because this incident may have involved connection records.");
  lines.push("- Be alert to unexpected calls, messages or emails that refer to your business or your customers.", "");
  lines.push("Your own notification obligations", "[COUNSEL: statement on the customer's own notification duties as controller, and the information Vireek will provide to support them]", "");
  lines.push("Contact", `${text(incident.contactName, 120, "[TO CONFIRM: contact name]")} <${text(incident.contactEmail, 200, "[TO CONFIRM: contact email]")}> (reference ${text(oneLine(incident.reference, 60), 60, "[TO CONFIRM: incident reference]")})`, "");
  lines.push("Vireek");

  const subjectRef = oneLine(incident.reference, 60);
  const subject = `Security incident affecting your Vireek account${subjectRef ? ` (${subjectRef})` : ""}`;
  const body = lines.join("\n");
  const placeholders = findPlaceholders(`${subject}\n${body}`);
  return { tenantId: impact.tenantId, to, subject, body, placeholders, warnings, complete: placeholders.length === 0 && warnings.length === 0 };
}

export function renderInternalSummary(incident: IncidentInput, summary: ScanSummary, tableLabels: Record<string, string>): string {
  const L: string[] = [];
  L.push(`# Breach scoping summary: ${oneLine(incident.title, 160) || "[TO CONFIRM: title]"}`, "");
  L.push(`Reference: ${oneLine(incident.reference, 60) || "[TO CONFIRM: reference]"}`);
  L.push(`Window (UTC): ${fmtUtc(incident.windowFrom)} to ${fmtUtc(incident.windowTo)}`);
  L.push(`Aware at (UTC): ${fmtUtc(incident.discoveredAt)}  [COUNSEL: confirm the moment of awareness; several deadlines run from it]`);
  L.push(`Scan mode: ${incident.mode === "existing_at_end" ? "records existing when the window closed" : "records created inside the window"}`, "");
  if (!summary.complete) {
    L.push("> **INCOMPLETE SCAN.** At least one table failed or was truncated. The tenant list below may be missing tenants. Do not conclude that other tenants are unaffected.", "");
  }
  L.push(`Tenants with in-scope data: **${summary.tenants.length}**`, "");
  L.push("## Data categories", "", "| Category | Tenants |", "|---|---|");
  for (const [id, n] of Object.entries(summary.categoryTenantCounts).sort((a, b) => b[1]! - a[1]!)) {
    L.push(`| ${CATEGORIES[id as CategoryId].label} | ${n} |`);
  }
  L.push("", "## Tables scanned", "", "| Table | Tenants | Rows | Status |", "|---|---|---|---|");
  for (const t of summary.tableResults) {
    L.push(`| ${tableLabels[t.table] ?? t.table} | ${t.tenants} | ${t.rows} | ${t.error ? `ERROR (${oneLine(t.error, 80)})` : t.truncated ? "TRUNCATED" : "ok"} |`);
  }
  L.push("", "## Limits of this scan", "",
    "- It lists tenants that HAD data in the selected tables; it does not show what was accessed or exfiltrated.",
    "- Rows deleted before the scan, rows only updated in the window, and tables that are not in the registry are not seen.",
    "- Tables without a direct tenant column (for example SMS message logs) need a manual query.",
    "- Tenant country / residency is not stored per tenant, so the applicable jurisdictions must be worked out by hand: see docs/runbooks/breach-notification.md section 3. [COUNSEL]", "");
  return L.join("\n");
}
