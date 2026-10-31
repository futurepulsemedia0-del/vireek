// src/lib/importLedgerProfiles.ts
//
// Import profiles for the incumbent ledger data: invoices, invoice line items, payments,
// equipment. Same philosophy as importPresets.ts: aliases are HINTS that pre-fill the column
// mapping from headers the platforms commonly export; the user always confirms or corrects it,
// and the confirmed mapping is saved per source + type (importSavedMappings.ts).
//
// The header lists below come from platform documentation/typical report layouts and have NOT
// been verified against live exports — treat a miss as "user maps it once, we remember".
//
// This file has no runtime imports on purpose (importPresets.ts imports it).

export type LedgerImportType = 'invoices' | 'line_items' | 'payments' | 'equipment';
type SourceId = 'service_titan' | 'jobber' | 'housecall_pro' | 'csv';

interface LedgerFieldDef { key: string; label: string; hint?: string; aliases: string[] }

export const LEDGER_IMPORT_TYPES: LedgerImportType[] = ['invoices', 'line_items', 'payments', 'equipment'];
export const isLedgerImportType = (t: string): t is LedgerImportType => (LEDGER_IMPORT_TYPES as string[]).includes(t);

export const LEDGER_TYPE_LABELS: Record<LedgerImportType, string> = {
  invoices: 'Invoices', line_items: 'Invoice lines (parts & labor)', payments: 'Payments', equipment: 'Equipment',
};

export const LEDGER_FIELD_DEFS: Record<LedgerImportType, LedgerFieldDef[]> = {
  invoices: [
    { key: 'external_id', label: 'Invoice ID', hint: 'The incumbent’s internal ID — makes re-imports safe', aliases: ['invoiceid', 'id', 'internalid'] },
    { key: 'invoice_number', label: 'Invoice number', aliases: ['invoicenumber', 'invoiceno', 'invoice', 'invoicenum', 'number', 'docnumber'] },
    { key: 'customer_external_id', label: 'Customer ID', hint: 'Must match the customer ID you imported', aliases: ['customerid', 'clientid', 'customerno', 'accountid'] },
    { key: 'customer_name', label: 'Customer name', hint: 'Display only', aliases: ['customername', 'clientname', 'customer', 'client', 'billto'] },
    { key: 'job_external_id', label: 'Job ID / number', aliases: ['jobnumber', 'jobid', 'job', 'jobno', 'workorder'] },
    { key: 'status', label: 'Status', aliases: ['status', 'invoicestatus', 'paymentstatus'] },
    { key: 'issued_on', label: 'Invoice date', aliases: ['invoicedate', 'issueddate', 'issued', 'date', 'createddate', 'sentdate'] },
    { key: 'due_on', label: 'Due date', aliases: ['duedate', 'due', 'paymentdue'] },
    { key: 'paid_on', label: 'Paid date', aliases: ['paiddate', 'markedpaiddate', 'datepaid', 'paidon'] },
    { key: 'subtotal', label: 'Subtotal', aliases: ['subtotal', 'subtotalamount', 'netamount'] },
    { key: 'tax', label: 'Tax', aliases: ['tax', 'taxamount', 'salestax', 'totaltax'] },
    { key: 'total', label: 'Total', aliases: ['total', 'invoicetotal', 'totalamount', 'amount', 'grandtotal'] },
    { key: 'balance', label: 'Balance due', aliases: ['balance', 'balancedue', 'amountdue', 'outstanding', 'openbalance'] },
  ],
  line_items: [
    { key: 'external_id', label: 'Line ID', hint: 'Optional — without it lines are matched by invoice + position', aliases: ['lineid', 'itemid', 'invoiceitemid'] },
    { key: 'invoice_external_id', label: 'Invoice ID / number', hint: 'Must match the invoice ID (or number) you imported', aliases: ['invoiceid', 'invoicenumber', 'invoiceno', 'invoice', 'invoicenum'] },
    { key: 'kind', label: 'Type (part / labor)', aliases: ['type', 'itemtype', 'linetype', 'category', 'kind'] },
    { key: 'description', label: 'Description', aliases: ['description', 'itemdescription', 'name', 'itemname', 'item', 'service', 'product'] },
    { key: 'sku', label: 'SKU / code', aliases: ['sku', 'code', 'itemcode', 'partnumber', 'itemsku'] },
    { key: 'quantity', label: 'Quantity', aliases: ['quantity', 'qty', 'hours', 'units'] },
    { key: 'unit_price', label: 'Unit price', aliases: ['unitprice', 'price', 'rate', 'unitcost', 'cost'] },
    { key: 'total', label: 'Line total', aliases: ['total', 'linetotal', 'amount', 'extendedprice', 'lineamount'] },
  ],
  payments: [
    { key: 'external_id', label: 'Payment ID', hint: 'Optional — without it payments are matched by invoice + date + amount', aliases: ['paymentid', 'id', 'transactionid', 'receiptid'] },
    { key: 'invoice_external_id', label: 'Invoice ID / number', aliases: ['invoiceid', 'invoicenumber', 'invoiceno', 'invoice', 'invoicenum', 'appliedto'] },
    { key: 'amount', label: 'Amount', aliases: ['amount', 'paymentamount', 'total', 'paid', 'amountpaid'] },
    { key: 'method', label: 'Method', aliases: ['method', 'paymentmethod', 'type', 'paymenttype', 'tender'] },
    { key: 'paid_on', label: 'Payment date', aliases: ['paymentdate', 'date', 'paiddate', 'receiveddate', 'transactiondate', 'datepaid'] },
    { key: 'reference', label: 'Reference / memo', aliases: ['reference', 'memo', 'checknumber', 'referencenumber', 'notes', 'transactionreference'] },
  ],
  equipment: [
    { key: 'external_id', label: 'Equipment ID', hint: 'Optional — serial number is used when missing', aliases: ['equipmentid', 'id', 'assetid', 'installedequipmentid'] },
    { key: 'customer_external_id', label: 'Customer ID', hint: 'Must match the customer ID you imported', aliases: ['customerid', 'clientid', 'customerno', 'accountid'] },
    { key: 'equipment_type', label: 'Equipment type', aliases: ['equipmenttype', 'type', 'category', 'equipment', 'equipmentname', 'name', 'assettype'] },
    { key: 'make', label: 'Make / manufacturer', aliases: ['manufacturer', 'make', 'brand'] },
    { key: 'model', label: 'Model', aliases: ['model', 'modelnumber', 'modelno'] },
    { key: 'serial_number', label: 'Serial number', aliases: ['serialnumber', 'serial', 'serialno', 'serialnum'] },
    { key: 'install_date', label: 'Install date', aliases: ['installdate', 'installedon', 'installed', 'dateinstalled', 'warrantystart', 'startdate'] },
    { key: 'notes', label: 'Notes', aliases: ['notes', 'comments', 'memo'] },
  ],
};

export const LEDGER_REQUIRED_ANY: Record<LedgerImportType, { keys: string[]; message: string }> = {
  invoices: { keys: ['total'], message: 'Map an invoice total column, plus an invoice ID or invoice number.' },
  line_items: { keys: ['invoice_external_id'], message: 'Map the invoice reference column, plus a line total (or quantity and unit price).' },
  payments: { keys: ['amount'], message: 'Map a payment amount column.' },
  equipment: { keys: ['customer_external_id'], message: 'Map the customer ID column, plus a serial number or equipment type.' },
};

/**
 * Stricter than REQUIRED_ANY (which only needs one key to show a hint): the server requires the
 * full combination below, so the wizard blocks "Continue" with the same rule.
 */
export function isLedgerMappingComplete(type: LedgerImportType, m: Record<string, string>): boolean {
  switch (type) {
    case 'invoices': return Boolean((m.external_id || m.invoice_number) && m.total);
    case 'line_items': return Boolean(m.invoice_external_id && (m.total || (m.quantity && m.unit_price)));
    case 'payments': return Boolean(m.amount);
    case 'equipment': return Boolean(m.customer_external_id && (m.external_id || m.serial_number || m.equipment_type));
  }
}

/** Platform-specific header hints (tried before the generic aliases above). */
export const LEDGER_PRESET_ALIASES: Record<SourceId, Partial<Record<LedgerImportType, Record<string, string[]>>>> = {
  service_titan: {
    invoices: { external_id: ['invoiceid'], invoice_number: ['invoice', 'invoicenumber', 'invoiceno'], customer_external_id: ['customerid'], customer_name: ['customername', 'customer'], job_external_id: ['jobnumber', 'jobid'], issued_on: ['invoicedate', 'date'], total: ['invoicetotal', 'total'], balance: ['balance', 'balancedue'] },
    line_items: { invoice_external_id: ['invoiceid', 'invoicenumber'], kind: ['itemtype', 'type'], description: ['itemdescription', 'description', 'itemname'], sku: ['sku', 'itemcode', 'code'], quantity: ['quantity', 'qty'], unit_price: ['price', 'unitprice'], total: ['total', 'amount'] },
    payments: { invoice_external_id: ['invoicenumber', 'invoiceid', 'invoice'], method: ['paymenttype', 'type'], paid_on: ['paymentdate', 'date'], reference: ['memo', 'checknumber', 'referencenumber'] },
    equipment: { customer_external_id: ['customerid'], equipment_type: ['equipmenttype', 'type', 'name'], make: ['manufacturer'], model: ['model'], serial_number: ['serialnumber'], install_date: ['installeddate', 'installdate', 'installedon'] },
  },
  jobber: {
    invoices: { invoice_number: ['invoice', 'invoicenumber'], customer_name: ['clientname', 'client'], customer_external_id: ['clientid'], job_external_id: ['job', 'jobnumber'], issued_on: ['issueddate', 'createddate'], paid_on: ['markedpaiddate'], subtotal: ['subtotal'], total: ['total'], balance: ['balance', 'balancedue'] },
    line_items: { invoice_external_id: ['invoice', 'invoicenumber'], description: ['name', 'description'], quantity: ['qty', 'quantity'], unit_price: ['unitprice', 'unitcost', 'price'], total: ['total', 'linetotal'] },
    payments: { invoice_external_id: ['invoice', 'invoicenumber'], method: ['paymentmethod', 'method'], paid_on: ['paymentdate', 'date'], reference: ['reference', 'transactionreference'] },
    equipment: {},
  },
  housecall_pro: {
    invoices: { invoice_number: ['invoice', 'invoicenumber'], customer_name: ['customername', 'customer'], customer_external_id: ['customerid'], job_external_id: ['jobnumber', 'jobid'], issued_on: ['invoicedate', 'date'], paid_on: ['paiddate', 'datepaid'], total: ['total', 'amount', 'invoicetotal'], balance: ['amountdue', 'balance'] },
    line_items: { invoice_external_id: ['invoicenumber', 'invoice'], kind: ['type', 'category'], description: ['itemname', 'description', 'name'], sku: ['sku'], quantity: ['quantity', 'qty'], unit_price: ['unitprice', 'price'], total: ['total', 'amount'] },
    payments: { invoice_external_id: ['invoicenumber', 'invoice'], method: ['paymentmethod', 'method'], paid_on: ['paymentdate', 'date'], reference: ['reference', 'memo'] },
    equipment: { customer_external_id: ['customerid'], equipment_type: ['equipmenttype', 'type', 'name'], make: ['brand', 'manufacturer'], model: ['model'], serial_number: ['serialnumber', 'serial'], install_date: ['installdate'] },
  },
  csv: {},
};

const TIP = 'Keep the ID columns in the export — they let Vireek recognize the same record next time, so importing again never creates duplicates.';
const ORDER = 'Import order matters: customers → jobs → invoices → invoice lines → payments → equipment.';
const READONLY = 'Imported invoices, lines and payments are read-only history; Vireek never changes your ServiceTitan/Jobber/Housecall Pro data and never bills from them.';

export const LEDGER_HOW_TO_EXPORT: Record<SourceId, Record<LedgerImportType, string[]>> = {
  service_titan: {
    invoices: ['In ServiceTitan, run an Invoices (or Sales) report for the date range you want.', 'Include invoice ID, invoice number, customer ID, totals, tax and balance columns.', 'Export to CSV.', TIP, ORDER, READONLY],
    line_items: ['In ServiceTitan, run an Invoice Items (or Invoice Detail) report.', 'Include the invoice reference, item type, description, quantity, price and total.', 'Export to CSV.', TIP, ORDER],
    payments: ['In ServiceTitan, run a Payments report for the date range.', 'Include invoice number, payment date, type and amount.', 'Export to CSV.', TIP, ORDER],
    equipment: ['In ServiceTitan, run an Installed Equipment report.', 'Include customer ID, type, manufacturer, model, serial number and install date.', 'Export to CSV.', TIP, ORDER],
  },
  jobber: {
    invoices: ['In Jobber, open Reports → Invoices (or Invoices list) and export the CSV for the date range.', TIP, ORDER, READONLY],
    line_items: ['In Jobber, export the invoice line items report (or the Invoices export that includes line items).', TIP, ORDER],
    payments: ['In Jobber, open Reports → Payments (Transactions) and export the CSV.', TIP, ORDER],
    equipment: ['Jobber has no equipment export — use “Other CSV / Excel” with your own equipment sheet.', ORDER],
  },
  housecall_pro: {
    invoices: ['In Housecall Pro, open Reports (or Invoices) and export the invoice list for the date range.', TIP, ORDER, READONLY],
    line_items: ['In Housecall Pro, export the invoice/job line items report.', TIP, ORDER],
    payments: ['In Housecall Pro, open Reports → Payments and export the CSV.', TIP, ORDER],
    equipment: ['In Housecall Pro, export the customer equipment list if your plan includes it.', TIP, ORDER],
  },
  csv: {
    invoices: ['One row per invoice, with a header row.', 'Needs an invoice ID or number and a total (in dollars).', ORDER],
    line_items: ['One row per invoice line, with a header row.', 'Needs the invoice ID/number and a line total (or quantity × unit price).', ORDER],
    payments: ['One row per payment, with a header row.', 'Needs an amount; an invoice reference links it to an invoice.', ORDER],
    equipment: ['One row per piece of equipment, with a header row.', 'Needs the customer ID and a serial number or equipment type.', ORDER],
  },
};
