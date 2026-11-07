// supabase/functions/_shared/fraud/signupRisk.ts
//
// Signup risk scoring. Pure: callers load the velocity counters and pass them in.
// A static disposable-domain list is weak on its own, so the caller can add the contents of the
// fraud_blocked_email_domains table via `extraBlockedDomains`.

export type RiskLevel = "allow" | "challenge" | "block";
export type IpReputation = "good" | "unknown" | "proxy" | "datacenter" | "abusive";

const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com", "10minutemail.com",
  "10minutemail.net", "tempmail.com", "temp-mail.org", "temp-mail.io", "yopmail.com", "yopmail.net", "throwawaymail.com",
  "getnada.com", "trashmail.com", "trashmail.net", "maildrop.cc", "dispostable.com", "fakeinbox.com", "mintemail.com",
  "mohmal.com", "emailondeck.com", "burnermail.io", "tempail.com", "moakt.com", "spamgourmet.com", "mailnesia.com",
  "mytemp.email", "tmpmail.org", "tmpmail.net", "discard.email", "mailcatch.com", "inboxkitten.com", "anonbox.net",
  "33mail.com", "mailpoof.com", "emailfake.com", "fakemail.net", "tempinbox.com", "spambox.us", "grr.la", "guerrillamailblock.com",
]);

/** Providers where "+tag" is delivered to the same mailbox. */
const PLUS_ALIAS_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "fastmail.com", "yahoo.com",
]);
const GMAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

export function splitEmail(email: string): { local: string; domain: string } | null {
  const trimmed = String(email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 1 || at === trimmed.length - 1 || trimmed.length > 254) return null;
  return { local: trimmed.slice(0, at), domain: trimmed.slice(at + 1) };
}

/** Collapses aliases so `a.b+x@gmail.com` and `ab@gmail.com` count as one mailbox. */
export function canonicalizeEmail(email: string): string | null {
  const parts = splitEmail(email);
  if (!parts) return null;
  let { local } = parts;
  const { domain } = parts;
  if (PLUS_ALIAS_DOMAINS.has(domain)) local = local.split("+")[0];
  if (GMAIL_DOMAINS.has(domain)) local = local.replace(/\./g, "");
  return local ? `${local}@${domain === "googlemail.com" ? "gmail.com" : domain}` : null;
}

export function isDisposableDomain(domain: string, extraBlockedDomains: Iterable<string> = []): boolean {
  const d = domain.toLowerCase();
  if (DISPOSABLE_DOMAINS.has(d)) return true;
  for (const x of extraBlockedDomains) if (x.toLowerCase() === d) return true;
  return false;
}

export interface SignupSignals {
  email: string;
  /** Signups from this IP (hashed by the caller) in the last hour / 24 hours. */
  ipSignups1h: number;
  ipSignups24h: number;
  /** Signups sharing the same device/browser id in the last 24 hours (0 if unknown). */
  deviceSignups24h: number;
  /** Signups whose canonical email domain matches, last 24 hours (cluster detection). */
  domainSignups24h: number;
  /** Signup attempts for the same CANONICAL mailbox (alias-collapsed) in the last 24 hours, including this one. */
  mailboxSignups24h: number;
  /** null = no challenge was presented. */
  challengePassed: boolean | null;
  ipReputation: IpReputation;
  extraBlockedDomains?: Iterable<string>;
}

export interface SignupRiskResult {
  score: number;
  level: RiskLevel;
  reasons: string[];
}

export const SIGNUP_THRESHOLDS = { challenge: 30, block: 70 } as const;

export function scoreSignup(s: SignupSignals): SignupRiskResult {
  const reasons: string[] = [];
  let score = 0;
  const add = (pts: number, why: string) => { score += pts; reasons.push(why); };

  const parts = splitEmail(s.email);
  if (!parts) return { score: 100, level: "block", reasons: ["invalid_email"] };

  if (isDisposableDomain(parts.domain, s.extraBlockedDomains)) add(80, "disposable_email_domain");
  if (s.mailboxSignups24h >= 3) add(75, "alias_farming");
  else if (s.mailboxSignups24h === 2) add(15, "mailbox_repeat");

  if (s.ipSignups1h >= 5) add(70, "ip_velocity_1h_extreme");
  else if (s.ipSignups1h >= 3) add(35, "ip_velocity_1h");
  if (s.ipSignups24h >= 10) add(60, "ip_velocity_24h_extreme");
  else if (s.ipSignups24h >= 5) add(25, "ip_velocity_24h");

  if (s.deviceSignups24h >= 3) add(60, "device_velocity");
  else if (s.deviceSignups24h === 2) add(20, "device_repeat");

  if (s.domainSignups24h >= 20 && !["gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "icloud.com"].includes(parts.domain)) {
    add(30, "email_domain_cluster");
  }

  switch (s.ipReputation) {
    case "abusive": add(80, "ip_reputation_abusive"); break;
    case "datacenter": add(25, "ip_datacenter"); break;
    case "proxy": add(20, "ip_proxy"); break;
    default: break;
  }

  if (s.challengePassed === false) add(80, "challenge_failed");

  score = Math.min(100, score);
  let level: RiskLevel = score >= SIGNUP_THRESHOLDS.block ? "block" : score >= SIGNUP_THRESHOLDS.challenge ? "challenge" : "allow";
  // Missing challenge: never "allow" a mid-risk signup without proof of humanity.
  if (level === "challenge" && s.challengePassed === true) level = "allow";
  return { score, level, reasons };
}
