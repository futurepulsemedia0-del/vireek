// Decimal-safe invoice totals that match the database function public.invoice_total_cents() exactly:
//   sub   = SUM(quantity * unit_price_cents)            (exact decimal, no per-line rounding)
//   tax   = round_half_away(sub * tax_percent / 100)
//   total = round_half_away(sub + tax)  =  round(sub) + tax
// Why: quotes.calculateQuoteTotals() keeps fractional cents for fractional quantities (e.g. 1.25 x 1 cent = 1.25),
// so the browser could show "partial" for an invoice the database already considers paid.
import { divRound, parseDecimal } from '@/lib/regionConfig/money';

export interface InvoiceLineLike {
  quantity: number;
  unit_price_cents: number;
}

export interface InvoiceAmounts {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function invoiceTotalsSqlParity(items: readonly InvoiceLineLike[], taxPercent: number): InvoiceAmounts {
  const parts = items.map((li) => {
    const q = parseDecimal(Number(li.quantity) || 0);
    const u = parseDecimal(Number(li.unit_price_cents) || 0);
    return { int: q.int * u.int, scale: q.scale + u.scale };
  });
  const scale = parts.reduce((m, p) => Math.max(m, p.scale), 0);
  const pow = (n: number) => 10n ** BigInt(n);
  const subInt = parts.reduce((s, p) => s + p.int * pow(scale - p.scale), 0n); // sub * 10^scale

  const tp = parseDecimal(Number(taxPercent) || 0);
  const taxCents = divRound(subInt * tp.int, 100n * pow(scale + tp.scale), 'half_away_from_zero');
  const subtotalCents = divRound(subInt, pow(scale), 'half_away_from_zero');

  return {
    subtotalCents: Number(subtotalCents),
    taxCents: Number(taxCents),
    totalCents: Number(subtotalCents + taxCents),
  };
}
