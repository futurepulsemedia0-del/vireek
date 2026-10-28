// Pure, dependency-free logic for job-board syndication (unit-tested in engine.test.ts).
// Imported by the `job-feeds` edge function AND by the Hiring dashboard (readiness checks).
//
// One XML feed per board. Indeed and ZipRecruiter share the classic <source><job> layout;
// LinkedIn's "Basic Jobs" feed has its own element names. Verify element names against each
// board's current spec during onboarding: every board-specific detail lives in this file.

export type FeedBoard = "indeed" | "ziprecruiter" | "linkedin";
export const FEED_BOARDS: readonly FeedBoard[] = ["indeed", "ziprecruiter", "linkedin"];
export const BOARD_LABELS: Record<FeedBoard, string> = {
  indeed: "Indeed",
  ziprecruiter: "ZipRecruiter",
  linkedin: "LinkedIn",
};

export function isFeedBoard(v: unknown): v is FeedBoard {
  return typeof v === "string" && (FEED_BOARDS as readonly string[]).includes(v);
}

export interface FeedPosting {
  id: string;
  slug: string;
  title: string;
  department: string;
  location: string;
  location_type: "remote" | "hybrid" | "onsite";
  employment_type: "full_time" | "part_time" | "contract" | "internship";
  summary: string;
  description: string;
  responsibilities: string[];
  requirements: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_period: "year" | "hour";
  status: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  city: string | null;
  region: string | null;
  country: string | null;
  postal_code: string | null;
}

export interface FeedOptions {
  companyName: string;
  siteUrl: string;
  /** LinkedIn numeric company id (from the Page admin URL). */
  linkedinCompanyId: string | null;
  /** Required by LinkedIn's feed schema for every job. */
  posterEmail: string | null;
  /** Deterministic build date (latest posting update) so ETags stay stable between crawls. */
  buildDate: Date;
}

export interface FeedIssues {
  blocking: string[];
  warnings: string[];
}

export interface SkippedJob {
  id: string;
  title: string;
  reasons: string[];
}

export interface BuiltFeed {
  xml: string;
  included: number;
  skipped: SkippedJob[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMPANY_ID_RE = /^[0-9]{1,20}$/;

// ---------- Text helpers ----------

// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function xmlText(input: string): string {
  return input
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CDATA that cannot be broken out of: a literal "]]>" is split across two sections. */
export function cdata(input: string): string {
  return `<![CDATA[${input.replace(INVALID_XML_CHARS, "").replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function htmlEscape(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function rfc822(date: Date | string): string {
  return new Date(date).toUTCString();
}

/** Description as raw HTML (boards expect HTML inside CDATA). Only <p>, <h3>, <ul>, <li> are emitted. */
export function descriptionHtml(p: FeedPosting): string {
  const paragraphs = [p.summary, ...p.description.split(/\n{2,}/)]
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `<p>${htmlEscape(s).replace(/\n/g, "<br/>")}</p>`);
  const list = (heading: string, items: string[]) =>
    items.length ? [`<h3>${heading}</h3>`, `<ul>${items.map((i) => `<li>${htmlEscape(i)}</li>`).join("")}</ul>`] : [];
  return [...paragraphs, ...list("Responsibilities", p.responsibilities), ...list("Requirements", p.requirements)].join("");
}

export function plainLength(p: FeedPosting): number {
  return [p.summary, p.description, ...p.responsibilities, ...p.requirements].join(" ").trim().length;
}

export function salaryText(p: FeedPosting): string | null {
  if (p.salary_min === null || p.salary_max === null) return null;
  let fmt: Intl.NumberFormat;
  try {
    fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: p.salary_currency, maximumFractionDigits: 0 });
  } catch {
    return null;
  }
  return `${fmt.format(p.salary_min)} - ${fmt.format(p.salary_max)} per ${p.salary_period === "year" ? "year" : "hour"}`;
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const JOB_TYPE: Record<FeedBoard, Record<FeedPosting["employment_type"], string>> = {
  indeed: { full_time: "fulltime", part_time: "parttime", contract: "contract", internship: "internship" },
  ziprecruiter: { full_time: "fulltime", part_time: "parttime", contract: "contract", internship: "internship" },
  linkedin: { full_time: "FULL_TIME", part_time: "PART_TIME", contract: "CONTRACT", internship: "INTERNSHIP" },
};
const WORKPLACE: Record<FeedPosting["location_type"], string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };

export function jobUrl(p: FeedPosting, board: FeedBoard, siteUrl: string): string {
  return `${siteUrl}/careers/${p.slug}?utm_source=${board}&utm_medium=job_board&utm_campaign=syndication`;
}

// ---------- Readiness ----------

export function validateBoardSettings(s: { companyId: string; posterEmail: string }): { companyId?: string; posterEmail?: string } {
  const e: { companyId?: string; posterEmail?: string } = {};
  if (s.companyId.trim() && !COMPANY_ID_RE.test(s.companyId.trim())) e.companyId = "Use the numeric company ID from your LinkedIn Page admin URL.";
  const mail = s.posterEmail.trim();
  if (mail && (mail.length > 254 || !EMAIL_RE.test(mail))) e.posterEmail = "Enter a valid email address.";
  return e;
}

/** Account-level problems that make a whole board feed unusable. */
export function boardConfigIssues(board: FeedBoard, cfg: { linkedinCompanyId: string | null; posterEmail: string | null }): string[] {
  if (board !== "linkedin") return [];
  const out: string[] = [];
  if (!cfg.linkedinCompanyId) out.push("Add your LinkedIn company ID.");
  if (!cfg.posterEmail) out.push("Add a job-poster email (LinkedIn requires one per job).");
  return out;
}

/** Per-posting problems. `blocking` jobs are left out of that board's feed; `warnings` only cost reach. */
export function postingFeedIssues(p: FeedPosting, board: FeedBoard): FeedIssues {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const country = (p.country ?? "").trim();
  const city = (p.city ?? "").trim();

  if (p.location_type === "remote") {
    if (!country) (board === "linkedin" ? blocking : warnings).push("Add the country candidates must live in.");
  } else {
    if (!city) blocking.push("Add the job's city.");
    if (!country) blocking.push("Add the job's country.");
    if (city && country && !(p.region ?? "").trim() && (country === "US" || country === "CA")) warnings.push("Add the state/province.");
  }
  if (board === "linkedin" && plainLength(p) < 100) blocking.push("Write at least 100 characters of description.");
  if (p.salary_min === null || p.salary_max === null) warnings.push("Add a pay range (more clicks, and required by some pay-transparency laws).");
  return { blocking, warnings };
}

// ---------- Feed building ----------

function tag(name: string, value: string | null | undefined): string {
  return value ? `    <${name}>${cdata(value)}</${name}>\n` : "";
}

function locationString(p: FeedPosting): string {
  const parts = [p.city, p.region, p.country ? countryName(p.country) : null].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : p.location;
}

function classicJob(p: FeedPosting, board: FeedBoard, o: FeedOptions): string {
  const salary = salaryText(p);
  return (
    "  <job>\n" +
    tag("title", p.title) +
    tag("date", rfc822(p.published_at ?? p.created_at)) +
    tag("referencenumber", p.id) +
    tag("url", jobUrl(p, board, o.siteUrl)) +
    tag("company", o.companyName) +
    tag("city", p.city) +
    tag("state", p.region) +
    tag("country", p.country) +
    tag("postalcode", p.postal_code) +
    tag("description", descriptionHtml(p)) +
    tag("salary", salary) +
    tag("jobtype", JOB_TYPE[board][p.employment_type]) +
    tag("category", p.department) +
    "  </job>\n"
  );
}

function linkedinJob(p: FeedPosting, o: FeedOptions): string {
  return (
    "  <job>\n" +
    tag("partnerJobId", p.id) +
    tag("company", o.companyName) +
    (o.linkedinCompanyId ? `    <companyId>${xmlText(o.linkedinCompanyId)}</companyId>\n` : "") +
    tag("title", p.title) +
    tag("description", descriptionHtml(p)) +
    tag("location", locationString(p)) +
    tag("applyUrl", jobUrl(p, "linkedin", o.siteUrl)) +
    `    <jobtype>${JOB_TYPE.linkedin[p.employment_type]}</jobtype>\n` +
    `    <workplaceTypes>${WORKPLACE[p.location_type]}</workplaceTypes>\n` +
    (o.posterEmail ? `    <posterEmail>${xmlText(o.posterEmail)}</posterEmail>\n` : "")  +
    "  </job>\n"
  );
}

export function buildFeed(board: FeedBoard, postings: FeedPosting[], o: FeedOptions): BuiltFeed {
  const included: FeedPosting[] = [];
  const skipped: SkippedJob[] = [];
  for (const p of postings) {
    if (p.status !== "open") continue;
    const { blocking } = postingFeedIssues(p, board);
    if (blocking.length) skipped.push({ id: p.id, title: p.title, reasons: blocking });
    else included.push(p);
  }

  const head =
    `<?xml version="1.0" encoding="utf-8"?>\n<source>\n` +
    `  <publisher>${xmlText(o.companyName)}</publisher>\n` +
    (board === "linkedin"
      ? `  <publisherUrl>${xmlText(o.siteUrl)}</publisherUrl>\n  <lastBuildDate>${rfc822(o.buildDate)}</lastBuildDate>\n  <expectedJobCount>${included.length}</expectedJobCount>\n`
      : `  <publisherurl>${xmlText(o.siteUrl)}</publisherurl>\n  <lastBuildDate>${rfc822(o.buildDate)}</lastBuildDate>\n`);

  const jobs = included.map((p) => (board === "linkedin" ? linkedinJob(p, o) : classicJob(p, board, o))).join("");
  return { xml: `${head}${jobs}</source>\n`, included: included.length, skipped };
}
