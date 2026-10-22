/* ------------------------------------------------------------------ */
/*  Country-specific invoice requirements. Checks that the DATA an     */
/*  invoice carries satisfies the local mandatory-content rules; it    */
/*  does not render PDFs or e-invoice XML.                             */
/* ------------------------------------------------------------------ */
import { getCountry } from './packData';
import type { PackCode } from './packTypes';

export interface InvoiceParty { name?: string; address?: string; taxId?: string; qstNumber?: string }
export interface InvoiceDoc {
  number?: string;
  issueDate?: string;
  supplyDate?: string;
  title?: string;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: { description?: string }[];
  grossMinor: number;
  taxMinor: number;
  /** True when the document shows each tax rate and amount separately. */
  showsTaxBreakdown?: boolean;
  /** True when it states that the total includes GST (AU single-line statement). */
  statesTaxIncluded?: boolean;
  reverseCharge?: boolean;
  reverseChargeNote?: string;
  termsOfPayment?: string;
  /** Tax components actually charged, e.g. ['GST','QST']. */
  taxCodes?: readonly string[];
}

export interface DocIssue { field: string; message: string }
export interface DocCheck { valid: boolean; missing: DocIssue[]; notes: string[]; documentTitle: string }

export const REVERSE_CHARGE_WORDING: Readonly<Record<'EU' | 'GB', string>> = {
  EU: 'Reverse charge – VAT to be accounted for by the customer (Article 194, Directive 2006/112/EC).',
  GB: 'Reverse charge: customer to account to HMRC for the VAT.',
};

const has = (s: string | undefined) => !!s && s.trim().length > 0;

export function validateInvoiceDocument(country: string, doc: InvoiceDoc): DocCheck {
  const profile = getCountry(country);
  const pack: PackCode | null = profile?.pack ?? null;
  const missing: DocIssue[] = [];
  const notes: string[] = [];
  const need = (ok: boolean, field: string, message: string) => { if (!ok) missing.push({ field, message }); };
  const gross = Math.abs(doc.grossMinor);
  const taxed = doc.taxMinor !== 0;
  let documentTitle = 'Invoice';

  if (!pack) return { valid: false, missing: [{ field: 'country', message: 'No regional pack covers this country.' }], notes, documentTitle };

  need(has(doc.number), 'number', 'Invoice number is required.');
  need(has(doc.issueDate), 'issueDate', 'Invoice date is required.');
  need(has(doc.seller.name), 'seller.name', 'Seller name is required.');
  need(doc.lines.length > 0 && doc.lines.every((l) => has(l.description)), 'lines', 'Every line needs a description.');

  switch (pack) {
    case 'US':
      need(has(doc.buyer.name), 'buyer.name', 'Customer name is required.');
      if (taxed) need(!!doc.showsTaxBreakdown, 'tax', 'Show sales tax as a separate line (required in most states).');
      break;

    case 'CA': {
      // CRA information tiers: < $30, $30–$149.99, >= $150.
      if (gross >= 3000 && (taxed || doc.reverseCharge)) {
        need(has(doc.seller.taxId), 'seller.taxId', 'GST/HST registration number is required on invoices of $30 or more.');
        need(!!doc.showsTaxBreakdown, 'tax', 'Show the GST/HST amount (or the rate) on invoices of $30 or more.');
      }
      if (gross >= 15000) {
        need(has(doc.buyer.name), 'buyer.name', 'Customer name is required on invoices of $150 or more.');
        need(has(doc.termsOfPayment), 'termsOfPayment', 'Terms of payment are required on invoices of $150 or more.');
      }
      if (doc.taxCodes?.includes('QST')) need(has(doc.seller.qstNumber), 'seller.qstNumber', 'QST registration number is required when QST is charged.');
      notes.push('Provincial PST/RST registration numbers should also be shown where charged.');
      break;
    }

    case 'GB':
      documentTitle = taxed || doc.reverseCharge ? 'VAT Invoice' : 'Invoice';
      need(has(doc.seller.address), 'seller.address', 'Seller address is required on a VAT invoice.');
      need(has(doc.buyer.name) && has(doc.buyer.address), 'buyer', 'Customer name and address are required on a VAT invoice.');
      if (taxed || doc.reverseCharge) {
        need(has(doc.seller.taxId), 'seller.taxId', 'Your VAT registration number is required.');
        need(!!doc.showsTaxBreakdown, 'tax', 'Show net amount, VAT rate and VAT amount for each rate.');
      }
      if (doc.reverseCharge) need(has(doc.reverseChargeNote), 'reverseChargeNote', `Add the reverse-charge wording: “${REVERSE_CHARGE_WORDING.GB}”`);
      notes.push('A “modified” invoice is allowed for retail sales up to £250; this check applies the full VAT-invoice rules.');
      break;

    case 'EU':
      documentTitle = 'Invoice';
      need(has(doc.seller.address), 'seller.address', 'Seller address is required.');
      need(has(doc.buyer.name) && has(doc.buyer.address), 'buyer', 'Customer name and address are required.');
      need(has(doc.supplyDate) || has(doc.issueDate), 'supplyDate', 'Date of supply (or a statement that it equals the invoice date) is required.');
      if (taxed || doc.reverseCharge) {
        need(has(doc.seller.taxId), 'seller.taxId', 'Your VAT identification number is required.');
        need(!!doc.showsTaxBreakdown || !!doc.reverseCharge, 'tax', 'Show net amount, VAT rate and VAT amount for each rate.');
      }
      if (doc.reverseCharge) {
        need(has(doc.buyer.taxId), 'buyer.taxId', 'The customer’s VAT number is required for a reverse charge.');
        need(has(doc.reverseChargeNote), 'reverseChargeNote', `Add the reverse-charge mention: “${REVERSE_CHARGE_WORDING.EU}”`);
      }
      notes.push('Several member states require a structured e-invoice for B2B — see eInvoicingStatus().');
      break;

    case 'AU': {
      if (gross < 8250 && !has(doc.title)) {
        notes.push('A tax invoice is only required below A$82.50 if the customer asks for one.');
        break;
      }
      documentTitle = 'Tax Invoice';
      need((doc.title ?? '').toLowerCase().includes('tax invoice'), 'title', 'The document must be labelled “Tax Invoice”.');
      need(has(doc.seller.taxId), 'seller.taxId', 'Your ABN is required on a tax invoice.');
      need(!!doc.showsTaxBreakdown || !!doc.statesTaxIncluded, 'tax', 'Show the GST amount, or state that the total includes GST.');
      if (gross >= 100_000) need(has(doc.buyer.name) || has(doc.buyer.taxId), 'buyer', 'Invoices of A$1,000 or more must identify the customer or their ABN.');
      break;
    }
  }
  return { valid: missing.length === 0, missing, notes, documentTitle };
}

/* ----------------------------- e-invoicing -------------------------- */

export type EInvoiceStatus = 'none' | 'receive_only' | 'phasing_in' | 'mandatory_b2b';
export interface EInvoiceInfo { status: EInvoiceStatus; format?: string; note: string }

const EINVOICE: Readonly<Record<string, EInvoiceInfo>> = {
  IT: { status: 'mandatory_b2b', format: 'FatturaPA via SDI', note: 'Mandatory through the SDI exchange system.' },
  BE: { status: 'mandatory_b2b', format: 'Peppol BIS', note: 'B2B e-invoicing became mandatory in 2026.' },
  GR: { status: 'mandatory_b2b', format: 'myDATA / Peppol', note: 'Mandatory e-invoicing rolled out in 2026.' },
  PL: { status: 'phasing_in', format: 'KSeF (FA(3))', note: 'KSeF is being phased in during 2026.' },
  DE: { status: 'phasing_in', format: 'XRechnung / ZUGFeRD', note: 'All businesses must be able to receive e-invoices; issuing becomes mandatory in stages from 2027.' },
  FR: { status: 'phasing_in', format: 'Factur-X via a certified platform', note: 'Phased rollout of B2B e-invoicing from September 2026.' },
};

/** Informational only — Vireek does not generate e-invoice XML in this phase. Verify dates with your tax authority. */
export function eInvoicingStatus(country: string): EInvoiceInfo {
  return EINVOICE[country.toUpperCase()] ?? { status: 'none', note: 'No B2B e-invoicing mandate recorded for this country.' };
}
