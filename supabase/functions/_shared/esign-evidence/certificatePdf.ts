// Renders a sealed evidence certificate as a PDF. Layout only: every fact comes from the sealed JSON.
import { jsPDF } from "npm:jspdf@2.5.2";
import type { SealedCertificate } from "./evidence.ts";

const MARGIN = 48;
const LINE = 13;

export function buildCertificatePdf(env: SealedCertificate): Uint8Array {
  const c = env.certificate;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const width = pageW - MARGIN * 2;
  let y = MARGIN;

  const room = (h: number) => { if (y + h > pageH - MARGIN) { doc.addPage(); y = MARGIN; } };
  const text = (s: string, o: { size?: number; bold?: boolean; mono?: boolean; gap?: number } = {}) => {
    doc.setFont(o.mono ? "courier" : "helvetica", o.bold ? "bold" : "normal");
    doc.setFontSize(o.size ?? 10);
    for (const l of doc.splitTextToSize(s || "—", width) as string[]) { room(LINE); doc.text(l, MARGIN, y); y += LINE; }
    y += o.gap ?? 2;
  };
  const heading = (s: string) => { y += 6; room(24); text(s, { size: 12, bold: true, gap: 4 }); };
  const kv = (k: string, v: string | null | undefined, mono = false) => text(`${k}: ${v ?? "—"}`, { mono });

  text("Certificate of Completion — Electronic Signature Evidence", { size: 16, bold: true, gap: 6 });
  kv("Document", c.request.title);
  kv("Sent by", c.request.business_name);
  kv("Request ID", c.request.id, true);
  kv("Status", c.request.status);
  kv("Sent", c.request.sent_at);
  kv("Completed", c.request.completed_at);
  kv("Certificate issued", c.issued_at);
  kv("Evidence level", c.evidence_level);
  kv("Integrity checks", c.integrity.all_ok ? "all passed when issued" : "FAILED");

  heading("Document fingerprint");
  kv("SHA-256 of signed snapshot", c.request.document_sha256, true);
  kv("SHA-256 of consent text", c.request.consent_text_sha256, true);
  kv("Consent version", c.request.consent_version);
  kv("Sender-supplied file SHA-256", c.request.document_file_sha256 ?? "not supplied");
  text("Consent text shown to signers:", { bold: true });
  text(c.request.consent_text);

  heading("Signers");
  for (const s of c.signers) {
    const consent = c.consents.find((x) => x.signer_id === s.id);
    text(`${s.signing_order}. ${s.name} (${s.role}) — ${s.status}`, { bold: true, gap: 0 });
    kv("  Contact", [s.email, s.phone].filter(Boolean).join(" · "));
    kv("  Signed as", s.signed_name);
    kv("  Signature type", s.signature_type);
    kv("  Signature SHA-256", s.signature_sha256, true);
    kv("  Consent recorded", consent ? `${consent.consented_at} (${consent.method})` : "no record");
    kv("  Consent IP", consent?.ip_address);
    kv("  Signed at", s.signed_at);
    kv("  Signing IP", s.ip_address);
    kv("  User agent", s.user_agent);
    y += 4;
  }

  heading(`Audit trail (${c.events.length} events)`);
  for (const e of c.events) {
    const who = c.signers.find((s) => s.id === e.signer_id)?.name ?? "system";
    text(`#${e.seq ?? "legacy"}  ${e.created_at}  ${e.event_type}  ${who}  ${e.ip_address ?? ""}`, { mono: true, size: 8, gap: 0 });
    if (e.event_hash) text(`    ${e.event_hash}`, { mono: true, size: 7, gap: 1 });
  }
  kv("Chain head", c.integrity.chain.head, true);
  if (c.integrity.chain.legacy > 0) text(`${c.integrity.chain.legacy} earlier event(s) predate the tamper-evident chain and are not chained.`);

  heading("Seal");
  kv("Certificate SHA-256", env.certificate_sha256, true);
  kv("Seal", `${env.seal.algorithm}, key ${env.seal.key_id}`);
  kv("Seal value", env.seal.hmac, true);
  text("How to check: each audit event stores the exact text that was hashed and the hash of the previous event. Recompute SHA-256 of that text to check a link. The seal can only be verified by Vireek, because it uses a secret key. The JSON version of this certificate contains every value shown here.");

  heading("Limitations");
  for (const l of c.limitations) text(`• ${l}`);

  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}
