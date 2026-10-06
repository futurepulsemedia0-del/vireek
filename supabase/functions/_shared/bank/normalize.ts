// supabase/functions/_shared/bank/normalize.ts
// Pure helpers: merchant normalization, PII masking, name similarity, date math.

const NOISE = new Set([
  "pos", "purchase", "debit", "credit", "card", "ach", "withdrawal", "deposit", "payment", "pmt", "online",
  "recurring", "ppd", "ccd", "web", "id", "ref", "tst", "sq", "the", "and", "inc", "llc", "corp", "co", "ltd",
  "transfer", "from", "to", "check", "chk", "wire", "zelle", "bill", "pay", "mobile", "checkcard", "visa", "purch",
  "autopay", "epayment", "ebill", "dda", "pymt", "payroll", "orig", "name", "desc", "date", "ach_debit",
]);

function tokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Stable key for "same merchant" regardless of store numbers / reference ids. Null if unusable. */
export function merchantKey(name: string | null | undefined, merchantName?: string | null): string | null {
  const source = (merchantName && merchantName.trim()) || name || "";
  const toks = tokens(source).filter((t) => !NOISE.has(t) && !/\d/.test(t) && t.length >= 2);
  const key = toks.slice(0, 3).join(" ").trim();
  return key.length >= 3 ? key : null;
}

/** Remove account-number-like digit runs before anything leaves our servers (e.g. to an AI provider). */
export function maskPii(text: string): string {
  return text
    .replace(/\b\d{6,}\b/g, "#")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** 0..1 — how much of the (shorter) party-name token set appears in the bank description. */
export function nameSimilarity(bankText: string, partyName: string | null | undefined): number {
  if (!partyName) return 0;
  const a = tokens(bankText).filter((t) => !NOISE.has(t) && t.length >= 3);
  const b = tokens(partyName).filter((t) => !NOISE.has(t) && t.length >= 3);
  if (a.length === 0 || b.length === 0) return 0;
  let hit = 0;
  for (const pb of b) {
    if (a.some((pa) => pa === pb || (pa.length >= 4 && pb.length >= 4 && (pa.startsWith(pb) || pb.startsWith(pa))))) hit++;
  }
  const first = b[0];
  const firstHit = first.length >= 5 && a.some((pa) => pa === first || (pa.length >= 5 && (pa.startsWith(first) || first.startsWith(pa))));
  return Math.max(hit / b.length, firstHit ? 0.7 : 0);
}

export function daysBetween(a: string, b: string): number {
  const da = Date.parse(a.slice(0, 10) + "T00:00:00Z");
  const db = Date.parse(b.slice(0, 10) + "T00:00:00Z");
  return Math.round((da - db) / 86400000);
}

export function addDays(date: string, n: number): string {
  const d = new Date(Date.parse(date.slice(0, 10) + "T00:00:00Z") + n * 86400000);
  return d.toISOString().slice(0, 10);
}

export function isProcessorPayout(name: string, key: string | null): boolean {
  return /\b(stripe|square|paypal|intuit|quickbooks payments|clover|shopify payments|payment processing|merchant services|worldpay|authorize\.?net)\b/i.test(
    `${name} ${key ?? ""}`,
  );
}

export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
