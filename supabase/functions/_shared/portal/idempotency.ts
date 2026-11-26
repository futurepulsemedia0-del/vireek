// supabase/functions/_shared/portal/idempotency.ts
// Deterministic packet hashing, request idempotency keys and the e-mail subject. No Deno/DOM globals beyond WebCrypto.

const enc = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical JSON: sorted keys, no whitespace -> the same packet always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export interface PacketManifest {
  invoice_id: string;
  invoice_number: string;
  total_cents: number;
  currency: string;
  po_number: string | null;
  attachments: { name: string; sha256: string; bytes: number }[];
  fields: Record<string, string>;
}

export async function packetHash(m: PacketManifest): Promise<string> {
  const sorted = { ...m, attachments: [...m.attachments].sort((a, b) => a.name.localeCompare(b.name)) };
  return sha256Hex(canonicalJson(sorted));
}

/** Natural key used by retries of the SAME request: (account, invoice, packet content, channel, client request id). */
export async function idempotencyKey(userId: string, invoiceId: string, hash: string, channel: string, requestId: string): Promise<string> {
  return sha256Hex(["portal", userId, invoiceId, hash, channel, requestId].join("|"));
}

const CTRL = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/** Header-injection-safe single-line text. */
export function oneLine(s: string, max = 120): string {
  return s.replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Deterministic subject: same inputs -> same subject, so AP can filter/auto-match and replays are recognisable. */
export function buildSubject(p: { invoiceNumber: string; poNumber?: string | null; company: string }): string {
  const po = p.poNumber ? ` | PO ${oneLine(p.poNumber, 40)}` : "";
  return `Invoice ${oneLine(p.invoiceNumber, 40)}${po} | ${oneLine(p.company, 60)}`;
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export function isSafeEmail(s: string): boolean {
  return s.length <= 254 && EMAIL_RE.test(s);
}
