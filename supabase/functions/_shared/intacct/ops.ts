// supabase/functions/_shared/intacct/ops.ts
//
// Idempotent Sage Intacct operations on top of IntacctClient. The edge function and the tests use the
// same code, so what the mock tests cover is what runs in production (modulo the VERIFY items in engine.ts).
//
// Idempotency contract for every create:
//   1. FIND by a deterministic key (customer id VK-<uuid16>, invoice PO reference, payment document
//      number VK-P-<uuid>). Found -> return it, nothing is written.
//   2. CREATE. An "already exists" fault (a replay that raced step 1) counts as success and the record is
//      read back. A transport error with unknown outcome propagates; the next run's step 1 finds the record
//      if it was applied, so a lost response can never create a duplicate.
//   3. READ BACK the record, so callers never depend on the shape of a create response.

import {
  IA_PAGE, IA_OBJECTS, classifyFault, faultText, field, fnCreateAccount, fnCreateCustomer, fnCreateInvoice, fnCreatePayment, fnFind, fnLinesFor,
  fnPull, fnQuery, fnUpdateAccount, fnUpdateCustomer, fnUpdateInvoiceDue, iaCustomerId, iaInvoiceDoc, iaPaymentDoc, isRecordNo,
  type Canon, type IaDefaults, type IaEntity, type IaResult, type RawRecord, type VireekAccountType, type VireekInvoiceInput, type VireekPaymentMethod,
} from './engine.ts';
import { IaOpError, type IntacctClient } from './client.ts';

export interface PullPage { records: RawRecord[]; more: boolean; maxRecordNo: number }
export interface Created { record: RawRecord; created: boolean }

const must = (r: IaResult, what: string, c: IntacctClient): IaResult => {
  if (!r.ok) throw new IaOpError(`${what}: ${faultText(r.errors)}`, classifyFault(r.errors), c.lastControlId);
  return r;
};

export async function pullPage(c: IntacctClient, entity: IaEntity, p: { since: number | null; afterRecordNo: number; pageSize?: number }): Promise<PullPage> {
  const size = p.pageSize ?? IA_PAGE;
  const r = must(await c.single(fnPull({ controlId: 'pull', entity, since: p.since, afterRecordNo: p.afterRecordNo, pageSize: size })), `Could not read ${entity} records`, c);
  const nums = r.records.map((x) => Number(field(x, 'RECORDNO') ?? NaN)).filter((n) => Number.isFinite(n));
  return { records: r.records, more: r.records.length >= size || r.numRemaining > 0, maxRecordNo: nums.length ? Math.max(...nums) : p.afterRecordNo };
}

export async function findRecords(c: IntacctClient, entity: IaEntity, fieldName: string, value: string): Promise<RawRecord[]> {
  return must(await c.single(fnFind({ controlId: 'find', entity, field: fieldName, value })), `Could not look up ${entity}`, c).records;
}
export async function getRecord(c: IntacctClient, entity: IaEntity, recordNo: string): Promise<RawRecord | null> {
  if (!isRecordNo(recordNo)) throw new Error('Invalid record number.');
  return (await findRecords(c, entity, 'RECORDNO', recordNo))[0] ?? null;
}

/** Invoice or payment lines for many headers in as few requests as possible. */
export async function fetchLines(c: IntacctClient, kind: 'invoiceLine' | 'paymentLine', keys: string[]): Promise<Map<string, RawRecord[]>> {
  const out = new Map<string, RawRecord[]>();
  const keyField = kind === 'invoiceLine' ? 'RECORDKEY' : 'PAYMENTKEY';
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    const r = must(await c.single(fnLinesFor({ controlId: 'lines', kind, keys: chunk })), 'Could not read line items', c);
    for (const l of r.records) {
      const k = field(l, keyField);
      if (k) out.set(k, [...(out.get(k) ?? []), l]);
    }
  }
  return out;
}

async function writeOnce(c: IntacctClient, fn: ReturnType<typeof fnCreateCustomer>, what: string): Promise<'created' | 'duplicate'> {
  const r = await c.single(fn, true);
  if (r.ok) return 'created';
  const kind = classifyFault(r.errors);
  if (kind === 'duplicate') return 'duplicate';
  throw new IaOpError(`${what}: ${faultText(r.errors)}`, kind, c.lastControlId);
}

// ---- customers -------------------------------------------------------------
export async function ensureCustomer(c: IntacctClient, p: { vireekId: string; values: Canon }): Promise<Created> {
  const id = iaCustomerId(p.vireekId);
  const existing = (await findRecords(c, 'customer', 'CUSTOMERID', id))[0];
  if (existing) return { record: existing, created: false };
  const out = await writeOnce(c, fnCreateCustomer('create', id, p.values), 'Could not create the customer');
  const rec = (await findRecords(c, 'customer', 'CUSTOMERID', id))[0];
  if (!rec) throw new IaOpError('Customer was created but could not be read back.', 'error', c.lastControlId);
  return { record: rec, created: out === 'created' };
}
export async function updateCustomer(c: IntacctClient, raw: RawRecord, values: Canon): Promise<RawRecord> {
  const id = field(raw, 'CUSTOMERID');
  if (!id) throw new IaOpError('Customer has no id.', 'error', null);
  must(await c.single(fnUpdateCustomer('update', id, values), true), 'Sage Intacct rejected the customer update', c);
  return (await getRecord(c, 'customer', field(raw, 'RECORDNO') ?? ''))!;
}

// ---- accounts --------------------------------------------------------------
export async function ensureAccount(c: IntacctClient, p: { values: Canon; type: VireekAccountType }): Promise<Created> {
  const code = String(p.values.code ?? '');
  const existing = (await findRecords(c, 'account', 'ACCOUNTNO', code))[0];
  if (existing) return { record: existing, created: false };
  const out = await writeOnce(c, fnCreateAccount('create', p.values, p.type), 'Could not create the GL account');
  const rec = (await findRecords(c, 'account', 'ACCOUNTNO', code))[0];
  if (!rec) throw new IaOpError('Account was created but could not be read back.', 'error', c.lastControlId);
  return { record: rec, created: out === 'created' };
}
export async function updateAccount(c: IntacctClient, raw: RawRecord, values: Canon): Promise<RawRecord> {
  const no = field(raw, 'ACCOUNTNO');
  if (!no) throw new IaOpError('Account has no number.', 'error', null);
  must(await c.single(fnUpdateAccount('update', no, values), true), 'Sage Intacct rejected the account update', c);
  return (await getRecord(c, 'account', field(raw, 'RECORDNO') ?? ''))!;
}

// ---- invoices --------------------------------------------------------------
export async function findInvoice(c: IntacctClient, number: string): Promise<RawRecord[]> {
  return findRecords(c, 'invoice', 'RECORDID', number);
}
export async function ensureInvoice(c: IntacctClient, p: { vireekId: string; customerId: string; inv: VireekInvoiceInput; defaults: Pick<IaDefaults, 'taxAccountNo' | 'sendInvoiceNumber'> }): Promise<Created | { error: string }> {
  const ref = iaInvoiceDoc(p.vireekId);
  const number = p.defaults.sendInvoiceNumber ? p.inv.invoiceNumber.slice(0, 40) : ref;
  const own = (rs: RawRecord[]) => rs.find((r) => field(r, 'CUSTOMERID') === p.customerId);
  const existing = own(await findInvoice(c, number));
  if (existing) return { record: existing, created: false };
  const fn = fnCreateInvoice('create', p.inv, p.customerId, p.defaults, ref);
  if ('error' in fn) return fn;
  const out = await writeOnce(c, fn, 'Could not create the invoice');
  const rec = own(await findInvoice(c, number));
  if (!rec) throw new IaOpError('Invoice was created but could not be read back.', 'error', c.lastControlId);
  return { record: rec, created: out === 'created' };
}
export async function updateInvoiceDue(c: IntacctClient, recordNo: string, dueDate: string): Promise<RawRecord> {
  must(await c.single(fnUpdateInvoiceDue('update', recordNo, dueDate), true), 'Sage Intacct rejected the due date', c);
  return (await getRecord(c, 'invoice', recordNo))!;
}

// ---- payments --------------------------------------------------------------
export async function ensurePayment(c: IntacctClient, p: { vireekId: string; customerId: string; invoiceNo: string; amountCents: number; date: string; bankAccountId: string; method: VireekPaymentMethod; memo: string }): Promise<Created> {
  const ref = iaPaymentDoc(p.vireekId);
  const existing = (await findRecords(c, 'payment', 'DOCNUMBER', ref))[0];
  if (existing) return { record: existing, created: false };
  const out = await writeOnce(c, fnCreatePayment('create', { ...p, docRef: ref }), 'Could not create the payment');
  const rec = (await findRecords(c, 'payment', 'DOCNUMBER', ref))[0];
  if (!rec) throw new IaOpError('Payment was created but could not be read back.', 'error', c.lastControlId);
  return { record: rec, created: out === 'created' };
}

// ---- mapping-UI lists ------------------------------------------------------
export async function listOptions(c: IntacctClient): Promise<{ accounts: { id: string; name: string; type: string }[]; banks: { id: string; name: string }[] }> {
  const acc = must(await c.single(fnQuery({ controlId: 'acc', object: 'account', filter: { op: 'eq', field: 'STATUS', value: 'active' }, orderBy: 'RECORDNO', pageSize: 1000, select: ['RECORDNO', 'ACCOUNTNO', 'TITLE', 'ACCOUNTTYPE'] })), 'Could not load accounts', c);
  let banks: { id: string; name: string }[] = [];
  const b = await c.single(fnQuery({ controlId: 'bank', object: 'bank', filter: { op: 'eq', field: 'STATUS', value: 'active' }, pageSize: 500 }));
  if (b.ok) banks = b.records.map((x) => ({ id: field(x, 'BANKACCOUNTID') ?? '', name: field(x, 'BANKNAME') ?? field(x, 'BANKACCOUNTID') ?? '' })).filter((x) => x.id);
  void IA_OBJECTS;
  return { accounts: acc.records.map((x) => ({ id: field(x, 'ACCOUNTNO') ?? '', name: field(x, 'TITLE') ?? '', type: field(x, 'ACCOUNTTYPE') ?? '' })).filter((x) => x.id), banks };
}
