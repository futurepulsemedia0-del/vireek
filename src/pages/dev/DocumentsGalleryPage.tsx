import { useCallback, useEffect, useState } from 'react';
import { renderInvoiceDocument, type InvoiceDocEnv, type InvoiceDocInput } from '@/lib/documents/invoiceDocument';
import { docLabels, isRtlLang, pdfLocaleTag } from '@/lib/documents/locale';
import { renderQuoteDocument, type QuoteDocGroup } from '@/lib/documents/quoteDocument';
import { renderReceiptDocument } from '@/lib/documents/receiptDocument';
import type { DocBrandLike } from '@/lib/documents/pdfKit';

/** Dev-only preview gallery for generated documents (route is registered only when import.meta.env.DEV). */

const VIREEK: DocBrandLike = { wordmark: 'Vireek', primary: [32, 58, 216], accent: [214, 88, 42], logo: null, attribution: 'Generated with Vireek' };
const WHITE_LABEL: DocBrandLike = { wordmark: 'Acme HVAC', primary: [21, 128, 61], accent: [101, 163, 13], logo: null, attribution: null };
const PALE: DocBrandLike = { wordmark: 'Sunny Plumbing', primary: [250, 220, 40], accent: [250, 220, 40], logo: null, attribution: 'Generated with Vireek' };

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ description: `Service line ${i + 1} — diagnostic, labour and parts`, quantity: 1 + (i % 3), unit_price_cents: 12500 + i * 350 }));

function fixture(lines: number, status: 'sent' | 'void' = 'sent'): InvoiceDocInput {
  const li = items(lines);
  const subtotal = li.reduce((s, x) => s + x.quantity * x.unit_price_cents, 0);
  const tax = Math.round(subtotal * 0.0825);
  return {
    businessName: 'Acme HVAC',
    invoice: { invoice_number: 'INV-1042', customer_name: 'Jane Doe', customer_email: 'jane@example.com', customer_phone: '+1 555 0100', line_items: li, tax_percent: 8.25, status, due_date: '2026-11-15', sent_at: '2026-10-30T10:00:00Z', created_at: '2026-10-29T10:00:00Z', notes: 'Thank you for your business. Payment is due within 15 days.' } as unknown as InvoiceDocInput['invoice'],
    ledger: { subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax, paidCents: 10000, refundedCents: 0, netPaidCents: 10000, balanceCents: subtotal + tax - 10000, state: 'partial' } as InvoiceDocInput['ledger'],
    payments: [{ id: 'p1', amount_cents: 10000, method: 'card', reference: 'ch_demo', paid_at: '2026-10-31T00:00:00Z' }] as unknown as InvoiceDocInput['payments'],
    refunds: [],
  };
}

type Kind = 'invoice' | 'quote' | 'receipt';
const CASES: { id: string; kind?: Kind; title: string; brand: DocBrandLike; lang: string; lines: number; status?: 'sent' | 'void' }[] = [
  { id: 'short', title: 'Invoice — Vireek brand, short', brand: VIREEK, lang: 'en', lines: 3 },
  { id: 'long', title: 'Invoice — 60 lines (repeating header, x of y)', brand: VIREEK, lang: 'en', lines: 60 },
  { id: 'wl', title: 'Invoice — white-label (no attribution)', brand: WHITE_LABEL, lang: 'en', lines: 5 },
  { id: 'pale', title: 'Invoice — pale brand colour (contrast guard)', brand: PALE, lang: 'en', lines: 5 },
  { id: 'de', title: 'Invoice — German labels', brand: VIREEK, lang: 'de', lines: 5 },
  { id: 'void', title: 'Invoice — void', brand: VIREEK, lang: 'en', lines: 3, status: 'void' },
  { id: 'quote', kind: 'quote', title: 'Quote — three options with deposit', brand: VIREEK, lang: 'en', lines: 4 },
  { id: 'quote-wl', kind: 'quote', title: 'Quote — white-label, French', brand: WHITE_LABEL, lang: 'fr', lines: 3 },
  { id: 'receipt', kind: 'receipt', title: 'Receipt — partial payment', brand: VIREEK, lang: 'en', lines: 0 },
];

function quoteGroups(n: number): QuoteDocGroup[] {
  return ['Good', 'Better', 'Best'].map((tier, i) => {
    const li = items(n + i);
    const subtotal = li.reduce((s, x) => s + x.quantity * x.unit_price_cents, 0);
    const tax = Math.round(subtotal * 0.0825);
    return { title: `${tier} \u2014 ${tier} plan`, subtitle: `${tier} comfort package with parts and labour.`, warranty: `${i + 1} year`, tags: i === 1 ? ['Recommended'] : [], items: li, subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax, depositCents: Math.round((subtotal + tax) * 0.25) };
  });
}

async function build(c: (typeof CASES)[number]): Promise<{ url: string; bytes: number }> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const tag = pdfLocaleTag('en-US');
  const money = new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD' });
  const env: InvoiceDocEnv = {
    brand: c.brand, labels: docLabels(c.lang), localeTag: tag, lang: c.lang, rtl: isRtlLang(c.lang),
    money: (cents) => money.format(cents / 100), paymentMethodLabel: (m) => m,
    legalLine: 'Demo legal line: payment terms, late-fee policy and company registration details appear here.',
  };
  const target = doc as unknown as Parameters<typeof renderInvoiceDocument>[0];
  if (c.kind === 'quote') {
    renderQuoteDocument(target, {
      businessName: 'Acme HVAC', number: 'Q-1A2B3C4D', customerName: 'Jane Doe', contact: ['jane@example.com'], serviceAddress: '1 Main St, Austin, TX, 78701',
      issuedAt: '2026-10-30T10:00:00Z', validUntil: '2026-11-30', status: 'sent', taxPercent: 8.25, taxExempt: false, depositPercent: 25,
      note: 'Prices valid for 30 days. Final price confirmed on site.', groups: quoteGroups(c.lines),
    }, env);
  } else if (c.kind === 'receipt') {
    renderReceiptDocument(target, {
      businessName: 'Acme HVAC', number: 'RCT-1A2B3C4D', invoiceNumber: 'INV-1042', customerName: 'Jane Doe', contact: ['jane@example.com'],
      paidAt: '2026-10-31T00:00:00Z', methodLabel: 'Card', reference: 'ch_demo', note: null,
      amountCents: 10000, refundedCents: 0, invoiceTotalCents: 33000, totalPaidCents: 10000, balanceCents: 23000,
    }, env);
  } else {
    renderInvoiceDocument(target, fixture(c.lines, c.status), env);
  }
  const blob = doc.output('blob') as Blob;
  return { url: URL.createObjectURL(blob), bytes: blob.size };
}

export default function DocumentsGalleryPage() {
  const [out, setOut] = useState<Record<string, { url: string; bytes: number } | string>>({});

  const run = useCallback(async () => {
    const next: typeof out = {};
    for (const c of CASES) {
      try { next[c.id] = await build(c); } catch (e) { next[c.id] = e instanceof Error ? e.message : 'failed'; }
    }
    setOut(next);
  }, []);

  useEffect(() => {
    void run();
    return () => { Object.values(out).forEach((v) => typeof v !== 'string' && URL.revokeObjectURL(v.url)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="mx-auto max-w-7xl p-6">
      <h1 className="text-2xl font-bold text-text-primary">Document gallery (dev only)</h1>
      <p className="mb-6 text-sm text-text-secondary">Every case is rendered live by the shared document design system. Budget: 100 KB per invoice.</p>
      <div className="grid gap-6 md:grid-cols-2">
        {CASES.map((c) => {
          const r = out[c.id];
          return (
            <section key={c.id} className="rounded-xl border border-border p-3">
              <h2 className="mb-2 text-sm font-semibold text-text-primary">{c.title}</h2>
              {!r && <p className="text-sm text-text-secondary">Rendering…</p>}
              {typeof r === 'string' && <p role="alert" className="text-sm text-red-600">{r}</p>}
              {r && typeof r !== 'string' && (
                <>
                  <p className="mb-2 text-xs text-text-secondary">{(r.bytes / 1024).toFixed(1)} KB {r.bytes > 100 * 1024 ? '— OVER BUDGET' : ''}</p>
                  <iframe title={c.title} src={r.url} className="h-[640px] w-full rounded border border-border" />
                </>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
