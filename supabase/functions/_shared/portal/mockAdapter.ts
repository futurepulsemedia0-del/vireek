// supabase/functions/_shared/portal/mockAdapter.ts
// Deterministic in-memory portal for tests and demos. Never talks to a network.
import { baseValidate, type AdapterCapabilities, type PortalAdapter, type PortalPacket, type StatusResult, type SubmitResult } from "./adapter.ts";
import { parseRemittanceText } from "./remittanceParser.ts";

export class MockPortalAdapter implements PortalAdapter {
  private refs = new Map<string, { status: string; reason?: string; key: string }>();
  private byKey = new Map<string, string>();
  submitCalls = 0;
  failNextSubmit: "transient" | "permanent" | null = null;

  capabilities(): AdapterCapabilities { return { id: "mock", submit: true, status: "poll", remittance: true, verified_against_vendor: false }; }
  validate(p: PortalPacket) { return baseValidate(p); }

  async submit(p: PortalPacket, key: string): Promise<SubmitResult> {
    this.submitCalls++;
    if (this.failNextSubmit) {
      const t = this.failNextSubmit; this.failNextSubmit = null;
      return { ok: false, retryable: t === "transient", error: t === "transient" ? "mock_unavailable" : "mock_rejected_input" };
    }
    const existing = this.byKey.get(key);           // the portal itself de-duplicates on the idempotency key
    if (existing) return { ok: true, reference: existing, retryable: false };
    const ref = `MOCK-${p.invoice_number}-${this.refs.size + 1}`;
    this.refs.set(ref, { status: "Received", key });
    this.byKey.set(key, ref);
    return { ok: true, reference: ref, retryable: false };
  }

  /** Test control: move a mock invoice to a portal status. */
  setStatus(ref: string, status: string, reason?: string) { const r = this.refs.get(ref); if (r) { r.status = status; r.reason = reason; } }

  async getStatus(ref: string): Promise<StatusResult> {
    const r = this.refs.get(ref);
    if (!r) return { ok: false, retryable: false, error: "unknown_reference" };
    return { ok: true, rawStatus: r.status, rejectionReason: r.reason, retryable: false };
  }
  parseRemittance(doc: string) { return parseRemittanceText(doc); }
}
