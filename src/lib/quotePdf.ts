import type { Quote } from '@/lib/supabase';
import {
  depositCentsFor, headlineOption, lineItemsSubtotalCents, optionTotalCents, withTaxCents, type SnapshotOption,
} from '@/lib/quoteWorkspace';
import { exportFilename } from '@/lib/documents/exportFile';
import { buildDocEnv } from '@/lib/documents/docEnv';
import { renderQuoteDocument, type QuoteDocGroup, type QuoteDocInput } from '@/lib/documents/quoteDocument';
import type { DocLabels } from '@/lib/documents/locale';

export type QuotePdfSource = Pick<
  Quote,
  | 'id' | 'customer_name' | 'customer_phone' | 'customer_email' | 'line_items' | 'options' | 'recommended_option_id'
  | 'selected_option_id' | 'accepted_total_cents' | 'tax_percent' | 'tax_exempt' | 'deposit_percent' | 'presentation_note'
  | 'service_address' | 'status' | 'valid_until' | 'sent_at' | 'created_at'
>;

/** Quotes have no sequential number; derive a short stable reference from the id. */
export const quoteReference = (id: string): string => `Q-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

export function quotePdfFilename(q: Pick<QuotePdfSource, 'id' | 'customer_name'>, businessName: string | null, date = new Date()): string {
  return exportFilename({ business: businessName, kind: 'quote', ext: 'pdf', detail: q.customer_name || quoteReference(q.id), date });
}

/** Builds the document model from a quote using the SAME pricing helpers the screen uses. */
export function buildQuoteDocInput(q: QuotePdfSource, businessName: string | null, labels: Pick<DocLabels, 'recommended' | 'selected'>): QuoteDocInput {
  const options = (q.options ?? []) as SnapshotOption[];
  const tax = q.tax_percent;
  const mkGroup = (items: SnapshotOption['line_items'], total: number, over: Partial<QuoteDocGroup> = {}): QuoteDocGroup => {
    const subtotal = lineItemsSubtotalCents(items);
    return { tags: [], items, subtotalCents: subtotal, taxCents: total - subtotal, totalCents: total, depositCents: depositCentsFor(total, q.deposit_percent), ...over };
  };

  let groups: QuoteDocGroup[];
  if (options.length > 0) {
    const headline = headlineOption({ options, recommended_option_id: q.recommended_option_id });
    const chosen = options.find((o) => o.id === q.selected_option_id) ?? null;
    const shown = q.status === 'accepted' && chosen ? [chosen] : options;
    groups = shown.map((o) => {
      const computed = optionTotalCents(o, tax);
      const useAccepted = q.status === 'accepted' && chosen?.id === o.id && q.accepted_total_cents != null;
      const total = useAccepted ? (q.accepted_total_cents as number) : computed;
      return mkGroup(o.line_items, total, {
        title: `${o.tier ? `${o.tier} \u2014 ` : ''}${o.name}`.trim(),
        subtitle: o.summary || null,
        warranty: o.warranty_label,
        tags: [o.id === headline?.id ? labels.recommended : null, chosen?.id === o.id ? labels.selected : null].filter((t): t is string => Boolean(t)),
        totalOnly: useAccepted && total !== computed,
      });
    });
  } else {
    const items = q.line_items;
    const computed = withTaxCents(lineItemsSubtotalCents(items), tax);
    const useAccepted = q.status === 'accepted' && q.accepted_total_cents != null;
    const total = useAccepted ? (q.accepted_total_cents as number) : computed;
    groups = [mkGroup(items, total, { totalOnly: useAccepted && total !== computed })];
  }

  return {
    businessName,
    number: quoteReference(q.id),
    customerName: q.customer_name,
    contact: [q.customer_phone, q.customer_email].filter((c): c is string => Boolean(c)),
    serviceAddress: q.service_address ? [q.service_address.line1, q.service_address.city, q.service_address.state, q.service_address.postal_code].filter(Boolean).join(', ') : null,
    issuedAt: q.sent_at ?? q.created_at,
    validUntil: q.valid_until,
    status: q.status,
    taxPercent: tax,
    taxExempt: q.tax_exempt,
    depositPercent: q.deposit_percent,
    note: q.presentation_note,
    groups,
  };
}

export async function downloadQuotePdf(q: QuotePdfSource, businessName: string | null): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const env = await buildDocEnv();
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  renderQuoteDocument(doc as unknown as Parameters<typeof renderQuoteDocument>[0], buildQuoteDocInput(q, businessName, env.labels), env);
  doc.save(quotePdfFilename(q, businessName));
}
