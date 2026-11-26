// supabase/functions/_shared/portal/cxmlAdapter.ts
// Generic cXML-style adapter, written against SPEC FIXTURES ONLY. [VERIFY] Ariba/Coupa/etc. endpoints, auth (shared secret / mTLS),
// payload profile and acknowledgement semantics against each vendor's current documentation before any real use.
// The transport is injected so tests never touch a network and so a deployment can add SSRF-safe egress rules.
import { baseValidate, type AdapterCapabilities, type PortalAdapter, type PortalPacket, type StatusResult, type SubmitResult } from "./adapter.ts";
import { parseRemittanceText } from "./remittanceParser.ts";

export interface CxmlTransport { post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> }
export interface CxmlConfig { endpoint: string; fromIdentity: string; toIdentity: string; senderSecret: string; payloadIdPrefix: string; now: () => Date }

export function xmlEscape(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Only https endpoints, no credentials in URL, no IP-literal / localhost targets (basic SSRF guard; add egress allow-list in infra). */
export function isSafeEndpoint(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return false;
    return true;
  } catch { return false; }
}

export function buildInvoiceEnvelope(p: PortalPacket, c: CxmlConfig, idempotencyKey: string): string {
  const ts = c.now().toISOString();
  const money = (cents: number) => (cents / 100).toFixed(2);
  const lines = p.lines.map((l, i) =>
    `<InvoiceDetailItem invoiceLineNumber="${i + 1}" quantity="${xmlEscape(String(l.quantity))}"><UnitOfMeasure>EA</UnitOfMeasure>` +
    `<UnitPrice><Money currency="${xmlEscape(p.currency)}">${money(l.unit_cents)}</Money></UnitPrice>` +
    `<InvoiceDetailItemReference lineNumber="${i + 1}"><Description xml:lang="en">${xmlEscape(l.description)}</Description></InvoiceDetailItemReference></InvoiceDetailItem>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><cXML payloadID="${xmlEscape(c.payloadIdPrefix + idempotencyKey.slice(0, 32))}" timestamp="${xmlEscape(ts)}">` +
    `<Header><From><Credential domain="NetworkID"><Identity>${xmlEscape(c.fromIdentity)}</Identity></Credential></From>` +
    `<To><Credential domain="NetworkID"><Identity>${xmlEscape(c.toIdentity)}</Identity></Credential></To>` +
    `<Sender><Credential domain="NetworkID"><Identity>${xmlEscape(c.fromIdentity)}</Identity><SharedSecret>${xmlEscape(c.senderSecret)}</SharedSecret></Credential><UserAgent>Vireek</UserAgent></Sender></Header>` +
    `<Request><InvoiceDetailRequest><InvoiceDetailRequestHeader invoiceID="${xmlEscape(p.invoice_number)}" purpose="standard" operation="new" invoiceDate="${xmlEscape(p.issue_date)}">` +
    `${p.po_number ? `<InvoiceDetailOrderInfo><OrderReference orderID="${xmlEscape(p.po_number)}"/></InvoiceDetailOrderInfo>` : ""}</InvoiceDetailRequestHeader>` +
    `<InvoiceDetailOrder>${lines}</InvoiceDetailOrder></InvoiceDetailRequest></Request></cXML>`;
}

export function parseCxmlResponse(xml: string): { code: number; text: string } | null {
  const m = /<Status\b[^>]*\bcode="(\d{3})"[^>]*>([^<]*)<\/Status>/.exec(xml) ?? /<Status\b[^>]*\bcode="(\d{3})"[^>]*\/>/.exec(xml);
  return m ? { code: Number(m[1]), text: (m[2] ?? "").trim() } : null;
}

export class GenericCxmlAdapter implements PortalAdapter {
  private cfg: CxmlConfig;
  private transport: CxmlTransport;
  private statuses: (ref: string) => Promise<{ raw: string; reason?: string } | null>;
  constructor(cfg: CxmlConfig, transport: CxmlTransport, statuses: (ref: string) => Promise<{ raw: string; reason?: string } | null>) {
    this.cfg = cfg; this.transport = transport; this.statuses = statuses;
  }
  capabilities(): AdapterCapabilities { return { id: "generic_cxml", submit: true, status: "webhook", remittance: true, verified_against_vendor: false }; }
  validate(p: PortalPacket) {
    const out = baseValidate(p);
    if (!isSafeEndpoint(this.cfg.endpoint)) out.push({ field: "endpoint", code: "unsafe_endpoint", message: "Endpoint must be a public https URL." });
    return out;
  }
  async submit(p: PortalPacket, key: string): Promise<SubmitResult> {
    if (this.validate(p).length) return { ok: false, retryable: false, error: "validation_failed" };
    try {
      const res = await this.transport.post(this.cfg.endpoint, buildInvoiceEnvelope(p, this.cfg, key), { "Content-Type": "text/xml; charset=UTF-8", "Idempotency-Key": key });
      const st = parseCxmlResponse(res.text);
      if (res.status >= 500) return { ok: false, retryable: true, error: `http_${res.status}` };
      if (res.status >= 400 || !st) return { ok: false, retryable: false, error: `http_${res.status}` };
      if (st.code >= 200 && st.code < 300) return { ok: true, reference: key.slice(0, 32), retryable: false };
      return { ok: false, retryable: st.code >= 500, error: `cxml_${st.code}` };
    } catch { return { ok: false, retryable: true, error: "transport_error" }; }
  }
  async getStatus(ref: string): Promise<StatusResult> {
    const s = await this.statuses(ref);   // webhook-fed store; this adapter never polls a vendor endpoint it has not verified
    return s ? { ok: true, rawStatus: s.raw, rejectionReason: s.reason, retryable: false } : { ok: true, retryable: false };
  }
  parseRemittance(doc: string) { return parseRemittanceText(doc); }
}
