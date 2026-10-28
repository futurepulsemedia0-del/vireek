import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SelectField } from '@/components/vehicles/shared';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney as formatCurrency } from '@/lib/currency';
import {
  centsToInput, dollarsToCents, ensureDefaultCategories, fetchCategories, receiptHashExists, removeReceipt, runReceiptOcr, sha256Hex,
  uploadReceipt, validateReceiptFile, type ExpenseCategory, type ReceiptExtraction,
} from '@/lib/expenses';
import { amountsCompatible, dateCompatible, pickCategoryId, type CardTransaction } from '@/lib/cardFeed';
import { submitReceipt } from '@/lib/cardFeedApi';

interface Props {
  txn: CardTransaction;
  ownerId: string;
  uid: string;
  onClose: () => void;
  onDone: () => void;
}

// Capture a receipt for one card purchase: upload -> existing expense OCR -> category -> file.
export function CardReceiptDialog({ txn, ownerId, uid, onClose, onDone }: Props) {
  const { currency } = useCurrency();
  const money = (cents: number) => formatCurrency(cents / 100, currency);
  const fileRef = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [receipt, setReceipt] = useState<{ path: string; mime: string; hash: string | null } | null>(null);
  const [ocr, setOcr] = useState<{ status: 'none' | 'done' | 'failed'; data: ReceiptExtraction | null }>({ status: 'none', data: null });
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState(centsToInput(txn.amount_cents));
  const [tax, setTax] = useState('');
  const [date, setDate] = useState(txn.transaction_at.slice(0, 10));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<'upload' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saved = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await ensureDefaultCategories();
        const list = await fetchCategories(ownerId);
        if (!live) return;
        setCategories(list);
        setCategoryId((c) => c || pickCategoryId(txn.kind, null, list));
      } catch {
        if (live) setError('Could not load expense categories.');
      }
    })();
    return () => { live = false; };
  }, [ownerId, txn.kind]);

  // An uploaded file that was never filed must not linger in storage.
  useEffect(() => () => { if (receipt && !saved.current) void removeReceipt(receipt.path); }, [receipt]);

  const amountCents = dollarsToCents(amount);
  const mismatch = amountCents != null && !amountsCompatible(amountCents, txn.amount_cents);
  const dateOff = /^\d{4}-\d{2}-\d{2}$/.test(date) && !dateCompatible(date, txn.transaction_at);
  const activeCategories = useMemo(() => categories.filter((c) => c.active), [categories]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setNotice(null);
    const invalid = validateReceiptFile(file);
    if (invalid) { setError(invalid); return; }
    setBusy('upload');
    try {
      const hash = await sha256Hex(file).catch(() => null);
      if (hash && (await receiptHashExists(ownerId, hash))) throw new Error('This receipt was already filed on another expense.');
      if (receipt) await removeReceipt(receipt.path);
      const up = await uploadReceipt(ownerId, uid, file);
      setReceipt({ ...up, hash });
      try {
        const ex = await runReceiptOcr(up.path);
        setOcr({ status: 'done', data: ex });
        if (!ex.is_receipt) setNotice('This does not look like a receipt. Please check the photo.');
        else {
          const cat = pickCategoryId(txn.kind, ex.suggested_category, categories);
          if (cat) setCategoryId(cat);
          if (ex.tax_cents) setTax(centsToInput(ex.tax_cents));
          if (ex.expense_date) setDate(ex.expense_date);
          // The card charge stays the amount of record; show what the receipt says.
          if (ex.total_cents && !amountsCompatible(ex.total_cents, txn.amount_cents)) {
            setNotice(`The receipt total (${money(ex.total_cents)}) is different from the card charge (${money(txn.amount_cents)}).`);
          }
        }
      } catch (e) {
        setOcr({ status: 'failed', data: null });
        setNotice(e instanceof Error ? e.message : 'We could not read that receipt. Choose the category by hand.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload the receipt.');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    setError(null);
    const tc = tax.trim() === '' ? 0 : dollarsToCents(tax);
    if (!receipt) return setError('Add a photo or PDF of the receipt first.');
    if (amountCents == null || amountCents <= 0) return setError('Enter a valid amount.');
    if (tc == null) return setError('Enter a valid tax amount.');
    if (!categoryId) return setError('Choose a category.');
    if (mismatch) return setError('The amount must be close to the card charge. Check the receipt or ask a manager.');
    setBusy('save');
    try {
      await submitReceipt({
        txnId: txn.id, vendor: txn.merchant ?? 'Card purchase', expenseDate: date, amountCents, taxCents: tc, categoryId, notes,
        receipt, ocr,
      });
      saved.current = true;
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't save the receipt.");
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Add receipt">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-bg-primary p-5 shadow-xl sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Add receipt</h2>
            <p className="text-sm text-text-secondary">{txn.merchant ?? 'Card purchase'} · {money(txn.amount_cents)} · {txn.transaction_at.slice(0, 10)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>

        {txn.expense?.status === 'rejected' && (
          <div role="alert" className="mb-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            Rejected{txn.expense.review_note ? `: ${txn.expense.review_note}` : '.'} Add a clearer receipt and resubmit.
          </div>
        )}

        <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Receipt photo or PDF" />
        <Button type="button" variant="secondary" className="w-full" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
          {busy === 'upload' ? <><Loader2 size={16} className="animate-spin" /> Reading receipt…</> : <><Camera size={16} /> {receipt ? 'Replace receipt' : 'Take photo or choose file'}</>}
        </Button>
        {receipt && ocr.status === 'done' && <p className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary"><Sparkles size={14} /> Category suggested from the receipt. You can change it.</p>}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Input label="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={mismatch ? `Card charge is ${money(txn.amount_cents)}` : undefined} />
          <Input label="Tax (optional)" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />
          <Input label="Receipt date" type="date" value={date} onChange={(e) => setDate(e.target.value)} error={dateOff ? 'Far from the purchase date' : undefined} />
          <SelectField label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            {activeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectField>
        </div>
        <div className="mt-3"><Input label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></div>

        {notice && <p role="status" className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-text-primary">{notice}</p>}
        {error && <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy === 'save'}>Cancel</Button>
          <Button type="button" onClick={() => void save()} disabled={busy !== null || !receipt}>{busy === 'save' ? 'Submitting…' : 'Submit for review'}</Button>
        </div>
      </div>
    </div>
  );
}
