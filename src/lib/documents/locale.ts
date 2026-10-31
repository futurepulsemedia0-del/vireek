/**
 * Document locale rules. Pure module (only Intl).
 *
 * Why this exists: the standard PDF fonts (Helvetica) only cover Latin-1.
 * Persian/Arabic-Indic digits or CJK glyphs would be printed as garbage, so
 * until a font covering the script is embedded, documents use Latin digits and
 * fall back to English labels for scripts we cannot draw.
 */

export const RTL_LANGS: ReadonlySet<string> = new Set(['ar', 'fa', 'he', 'ur']);
/** Languages whose full label set can be drawn with the standard Latin-1 fonts. */
export const LATIN1_LANGS: ReadonlySet<string> = new Set(['en', 'es', 'fr', 'de']);

export function baseLang(lang: string | null | undefined): string {
  const b = (lang ?? 'en').trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(b) ? b : 'en';
}

export const isRtlLang = (lang: string | null | undefined): boolean => RTL_LANGS.has(baseLang(lang));

/** Language we can actually render with the fonts currently embedded. */
export function renderableLang(lang: string | null | undefined, embedded: ReadonlySet<string> = new Set()): string {
  const b = baseLang(lang);
  return LATIN1_LANGS.has(b) || embedded.has(b) ? b : 'en';
}

/** Forces Latin digits (`nu-latn`) and Gregorian calendar unless the script's font is embedded. */
export function pdfLocaleTag(regionalLocale: string | null | undefined, embeddedScripts: ReadonlySet<string> = new Set()): string {
  let tag = 'en-US';
  try {
    if (regionalLocale) tag = Intl.getCanonicalLocales(regionalLocale)[0] ?? 'en-US';
  } catch {
    tag = 'en-US';
  }
  const base = tag.split('-')[0]!.toLowerCase();
  const stripped = tag.replace(/-u-.*$/i, '');
  return embeddedScripts.has(base) ? tag : `${stripped}-u-ca-gregory-nu-latn`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date-only strings (`2026-03-01`, e.g. a due date) are calendar dates and are
 * formatted in UTC so they never shift a day; timestamps use the viewer's zone.
 */
export function formatDocDate(value: string | Date | null | undefined, localeTag: string): string {
  if (!value) return '\u2014';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '\u2014';
  const dateOnly = typeof value === 'string' && DATE_ONLY.test(value);
  try {
    return new Intl.DateTimeFormat(localeTag, {
      year: 'numeric', month: 'long', day: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}),
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export interface DocLabels {
  invoice: string; billTo: string; issued: string; due: string;
  description: string; qty: string; unit: string; amount: string;
  subtotal: string; tax: string; total: string; paymentsReceived: string; refunded: string; balanceDue: string;
  paymentHistory: string; notes: string; page: string; of: string;
  paid: string; partiallyPaid: string; void: string;
  quote: string; preparedFor: string; validUntil: string; serviceAddress: string; recommended: string; selected: string;
  accepted: string; declined: string; expired: string; deposit: string; taxExempt: string; warranty: string;
  receipt: string; receivedFrom: string; datePaid: string; paymentMethod: string; reference: string; forInvoice: string;
  amountPaid: string; totalPaidToDate: string; balanceRemaining: string;
}

const EN: DocLabels = {
  invoice: 'Invoice', billTo: 'Bill to', issued: 'Issued', due: 'Due',
  description: 'Description', qty: 'Qty', unit: 'Unit price', amount: 'Amount',
  subtotal: 'Subtotal', tax: 'Tax', total: 'Total', paymentsReceived: 'Payments received', refunded: 'Refunded', balanceDue: 'Balance due',
  paymentHistory: 'Payment history', notes: 'Notes', page: 'Page', of: 'of',
  paid: 'Paid', partiallyPaid: 'Partially paid', void: 'Void',
  quote: 'Quote', preparedFor: 'Prepared for', validUntil: 'Valid until', serviceAddress: 'Service address', recommended: 'Recommended', selected: 'Selected',
  accepted: 'Accepted', declined: 'Declined', expired: 'Expired', deposit: 'Deposit due on acceptance', taxExempt: 'Tax exempt', warranty: 'Warranty',
  receipt: 'Receipt', receivedFrom: 'Received from', datePaid: 'Date paid', paymentMethod: 'Payment method', reference: 'Reference', forInvoice: 'For invoice',
  amountPaid: 'Amount paid', totalPaidToDate: 'Total paid to date', balanceRemaining: 'Balance remaining',
};

// NOTE: es/fr/de strings are machine-drafted — have a native speaker review before release.
const LABELS: Record<string, DocLabels> = {
  en: EN,
  es: {
    invoice: 'Factura', billTo: 'Facturar a', issued: 'Emitida', due: 'Vencimiento',
    description: 'Descripción', qty: 'Cant.', unit: 'Precio unit.', amount: 'Importe',
    subtotal: 'Subtotal', tax: 'Impuesto', total: 'Total', paymentsReceived: 'Pagos recibidos', refunded: 'Reembolsado', balanceDue: 'Saldo pendiente',
    paymentHistory: 'Historial de pagos', notes: 'Notas', page: 'Página', of: 'de',
    paid: 'Pagada', partiallyPaid: 'Pago parcial', void: 'Anulada',
    quote: 'Presupuesto', preparedFor: 'Preparado para', validUntil: 'Válido hasta', serviceAddress: 'Dirección del servicio', recommended: 'Recomendada', selected: 'Seleccionada',
    accepted: 'Aceptado', declined: 'Rechazado', expired: 'Vencido', deposit: 'Depósito al aceptar', taxExempt: 'Exento de impuestos', warranty: 'Garantía',
    receipt: 'Recibo', receivedFrom: 'Recibido de', datePaid: 'Fecha de pago', paymentMethod: 'Método de pago', reference: 'Referencia', forInvoice: 'Por la factura',
    amountPaid: 'Importe pagado', totalPaidToDate: 'Total pagado hasta la fecha', balanceRemaining: 'Saldo restante',
  },
  fr: {
    invoice: 'Facture', billTo: 'Facturé à', issued: 'Émise le', due: 'Échéance',
    description: 'Description', qty: 'Qté', unit: 'Prix unit.', amount: 'Montant',
    subtotal: 'Sous-total', tax: 'Taxe', total: 'Total', paymentsReceived: 'Paiements reçus', refunded: 'Remboursé', balanceDue: 'Solde dû',
    paymentHistory: 'Historique des paiements', notes: 'Remarques', page: 'Page', of: 'sur',
    paid: 'Payée', partiallyPaid: 'Partiellement payée', void: 'Annulée',
    quote: 'Devis', preparedFor: 'Préparé pour', validUntil: 'Valable jusqu\'au', serviceAddress: 'Adresse d\'intervention', recommended: 'Recommandée', selected: 'Choisie',
    accepted: 'Accepté', declined: 'Refusé', expired: 'Expiré', deposit: 'Acompte à l\'acceptation', taxExempt: 'Exonéré de taxes', warranty: 'Garantie',
    receipt: 'Reçu', receivedFrom: 'Reçu de', datePaid: 'Date de paiement', paymentMethod: 'Mode de paiement', reference: 'Référence', forInvoice: 'Pour la facture',
    amountPaid: 'Montant payé', totalPaidToDate: 'Total payé à ce jour', balanceRemaining: 'Solde restant',
  },
  de: {
    invoice: 'Rechnung', billTo: 'Rechnung an', issued: 'Datum', due: 'Fällig',
    description: 'Beschreibung', qty: 'Menge', unit: 'Einzelpreis', amount: 'Betrag',
    subtotal: 'Zwischensumme', tax: 'Steuer', total: 'Gesamt', paymentsReceived: 'Erhaltene Zahlungen', refunded: 'Erstattet', balanceDue: 'Offener Betrag',
    paymentHistory: 'Zahlungsverlauf', notes: 'Hinweise', page: 'Seite', of: 'von',
    paid: 'Bezahlt', partiallyPaid: 'Teilweise bezahlt', void: 'Storniert',
    quote: 'Angebot', preparedFor: 'Erstellt für', validUntil: 'Gültig bis', serviceAddress: 'Einsatzadresse', recommended: 'Empfohlen', selected: 'Gewählt',
    accepted: 'Angenommen', declined: 'Abgelehnt', expired: 'Abgelaufen', deposit: 'Anzahlung bei Annahme', taxExempt: 'Steuerbefreit', warranty: 'Garantie',
    receipt: 'Quittung', receivedFrom: 'Erhalten von', datePaid: 'Zahlungsdatum', paymentMethod: 'Zahlungsart', reference: 'Referenz', forInvoice: 'Für Rechnung',
    amountPaid: 'Gezahlter Betrag', totalPaidToDate: 'Bisher gezahlt', balanceRemaining: 'Restbetrag',
  },
};

export function docLabels(lang: string | null | undefined, embedded: ReadonlySet<string> = new Set()): DocLabels {
  return LABELS[renderableLang(lang, embedded)] ?? EN;
}
