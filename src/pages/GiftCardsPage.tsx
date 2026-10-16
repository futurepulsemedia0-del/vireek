import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Ban, Copy, Gift, Lock, Plus, ScanLine, SlidersHorizontal, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { formatCents } from '@/lib/invoices';
import {
  KIND_LABELS,
  STATUS_LABELS,
  STATUS_STYLES,
  adjustGiftCard,
  deriveStatus,
  fetchGiftCards,
  fetchOpenInvoices,
  fetchTransactions,
  formatCode,
  issueGiftCard,
  maxRedeemable,
  parseAmountToCents,
  redeemGiftCard,
  summarize,
  voidGiftCard,
  type GiftCard,
  type GiftCardKind,
  type GiftCardStatus,
  type GiftCardTransaction,
  type OpenInvoice,
} from '@/lib/giftCards';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';
const btnClass =
  'focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50';
const primaryBtn =
  'focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

type Filter = 'all' | GiftCardStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'depleted', label: 'Used up' },
  { key: 'expired', label: 'Expired' },
  { key: 'voided', label: 'Voided' },
];

type ModalState = { type: 'issue' } | { type: 'redeem'; code?: string } | { type: 'detail'; id: string } | null;

// ============================================================
// SHARED UI
// ============================================================

function Modal({ title, onClose, locked = false, children }: { title: string; onClose: () => void; locked?: boolean; children: ReactNode }) {
  const ref = useFocusTrap(!locked);
  useEscapeToClose(!locked, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={locked ? undefined : onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-secondary">{hint}</span>}
    </label>
  );
}

function StatusBadge({ status }: { status: GiftCardStatus }) {
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-bold text-text-primary sm:text-2xl">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

// ============================================================
// ISSUE
// ============================================================

function IssueModal({ onClose, onDone }: { onClose: () => void; onDone: (card: GiftCard) => void | Promise<void> }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<GiftCardKind>('gift_card');
  const [amount, setAmount] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [expires, setExpires] = useState('');
  const [saving, setSaving] = useState(false);

  const cents = parseAmountToCents(amount);
  const today = new Date().toISOString().slice(0, 10);

  const submit = async () => {
    if (cents === null) return toast('Enter an amount between $0.01 and $100,000.', 'error');
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) return toast('Enter a valid email address.', 'error');
    let expiresAt: string | undefined;
    if (expires) {
      const d = new Date(`${expires}T23:59:59`);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return toast('Expiry must be a future date.', 'error');
      expiresAt = d.toISOString();
    }
    setSaving(true);
    try {
      const card = await issueGiftCard({ kind, amountCents: cents, recipientName: name.trim(), recipientEmail: email.trim(), note: note.trim(), expiresAt });
      toast(`${KIND_LABELS[kind]} ${card.code} issued.`, 'success');
      await onDone(card);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not issue the card.', 'error');
      setSaving(false);
    }
  };

  return (
    <Modal title="Issue gift card" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Card type">
          {(['gift_card', 'store_credit'] as GiftCardKind[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={`focus-ring rounded-xl border px-3 py-2 text-sm font-medium ${kind === k ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <Field label="Amount (USD)">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50.00" className={inputClass} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Recipient name (optional)">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={inputClass} />
          </Field>
          <Field label="Recipient email (optional)">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} className={inputClass} />
          </Field>
        </div>
        <Field label="Expires (optional)" hint="Leave empty for a card that never expires.">
          <input type="date" min={today} value={expires} onChange={(e) => setExpires(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Internal note (optional)">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} className={inputClass} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btnClass} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} onClick={submit} disabled={saving || cents === null}>
          {saving ? 'Issuing…' : cents ? `Issue ${formatCents(cents)}` : 'Issue'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// REDEEM (checkout)
// ============================================================

function RedeemModal({ cards, initialCode, onClose, onDone }: { cards: GiftCard[]; initialCode?: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [code, setCode] = useState(initialCode ?? '');
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [invLoading, setInvLoading] = useState(true);
  const [invFailed, setInvFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchOpenInvoices()
      .then((v) => alive && setInvoices(v))
      .catch(() => alive && setInvFailed(true))
      .finally(() => alive && setInvLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const formatted = formatCode(code);
  const card = useMemo(() => (formatted ? cards.find((c) => c.code === formatted) ?? null : null), [cards, formatted]);
  const status = card ? deriveStatus(card) : null;
  const usable = !!card && status === 'active';
  const invoice = invoices.find((i) => i.id === invoiceId) ?? null;
  const cap = card ? maxRedeemable(card.balance_cents, invoice ? invoice.remainingCents : null) : 0;
  const typed = amount.trim() ? parseAmountToCents(amount) : null;
  const applying = amount.trim() ? typed : invoice ? cap : null;
  const amountError = amount.trim() && (typed === null || typed > cap) ? `Enter an amount up to ${formatCents(cap)}.` : null;
  const canSubmit = usable && !saving && applying !== null && applying > 0 && !amountError;

  const submit = async () => {
    if (!canSubmit || !formatted) return;
    setSaving(true);
    try {
      const r = await redeemGiftCard({ code: formatted, invoiceId: invoiceId || undefined, amountCents: typed ?? undefined });
      toast(
        r.invoice_paid
          ? `Applied ${formatCents(r.applied_cents)} — invoice marked paid.`
          : `Applied ${formatCents(r.applied_cents)}. Card balance ${formatCents(r.balance_cents)}.`,
        'success',
      );
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not redeem the card.', 'error');
      setSaving(false);
    }
  };

  return (
    <Modal title="Redeem at checkout" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Gift card code">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" className={`${inputClass} font-mono uppercase`} autoFocus autoCapitalize="characters" />
        </Field>
        {formatted && !card && <p className="text-sm text-danger">No card with this code on your account.</p>}
        {card && status && (
          <div className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-3">
            <div>
              <p className="text-xs text-text-secondary">{KIND_LABELS[card.kind]} balance</p>
              <p className="text-lg font-bold text-text-primary">{formatCents(card.balance_cents)}</p>
            </div>
            <StatusBadge status={status} />
          </div>
        )}
        {card && status && !usable && <p className="text-sm text-warning-500">This card can't be redeemed ({STATUS_LABELS[status].toLowerCase()}).</p>}

        <Field label="Apply to invoice (optional)" hint="Pick an unpaid invoice to settle it, or leave empty for an in-person redemption.">
          {invLoading ? (
            <div className="h-10 animate-pulse rounded-xl bg-bg-tertiary" />
          ) : invFailed ? (
            <p className="text-sm text-danger">Couldn't load invoices. You can still redeem an amount without one.</p>
          ) : (
            <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} className={inputClass}>
              <option value="">No invoice — redeem an amount</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoice_number} · {i.customer_name} · {formatCents(i.remainingCents)} due
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Amount (USD)" hint={invoice ? `Leave empty to apply the maximum (${formatCents(cap)}).` : undefined}>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={invoice ? formatCents(cap).slice(1) : '25.00'} className={inputClass} />
        </Field>
        {amountError && <p className="text-sm text-danger">{amountError}</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btnClass} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} onClick={submit} disabled={!canSubmit}>
          {saving ? 'Applying…' : applying ? `Apply ${formatCents(applying)}` : 'Apply'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// DETAIL + LEDGER
// ============================================================

const LEDGER_LABELS: Record<GiftCardTransaction['kind'], string> = { issue: 'Issued', redeem: 'Redeemed', adjust: 'Adjusted', void: 'Voided' };

function DetailModal({ card, onClose, onChanged, onRedeem }: { card: GiftCard; onClose: () => void; onChanged: () => void; onRedeem: () => void }) {
  const { toast } = useToast();
  const [tx, setTx] = useState<GiftCardTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [sign, setSign] = useState<1 | -1>(1);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const status = deriveStatus(card);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setTx(await fetchTransactions(card.id));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [card.id]);

  useEffect(() => {
    void load();
  }, [load, card.balance_cents, card.status]);

  const cents = parseAmountToCents(delta);
  const canAdjust = cents !== null && reason.trim().length > 0 && !saving;

  const doAdjust = async () => {
    if (!canAdjust || cents === null) return;
    setSaving(true);
    try {
      await adjustGiftCard(card.id, sign * cents, reason.trim());
      toast('Balance adjusted.', 'success');
      setAdjusting(false);
      setDelta('');
      setReason('');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not adjust the balance.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(card.code);
      toast('Code copied.', 'success');
    } catch {
      toast('Could not copy — select the code manually.', 'error');
    }
  };

  return (
    <>
    <Modal title={KIND_LABELS[card.kind]} onClose={onClose} locked={confirmVoid}>
      <div className="rounded-xl border border-border bg-bg-primary p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-all font-mono text-lg font-semibold tracking-wider text-text-primary">{card.code}</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {card.recipient_name || card.recipient_email || 'No recipient'} · Expires {fmtDate(card.expires_at)}
            </p>
          </div>
          <StatusBadge status={status} />
        </div>
        <div className="mt-3 flex items-end justify-between">
          <div>
            <p className="text-xs text-text-secondary">Balance</p>
            <p className="text-2xl font-bold text-text-primary">{formatCents(card.balance_cents)}</p>
          </div>
          <p className="text-xs text-text-secondary">of {formatCents(card.initial_cents)} issued</p>
        </div>
        {card.note && <p className="mt-2 text-sm text-text-secondary">{card.note}</p>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btnClass} onClick={copy}><Copy size={14} /> Copy code</button>
        {status === 'active' && <button type="button" className={primaryBtn} onClick={onRedeem}><ScanLine size={14} /> Redeem</button>}
        {card.status !== 'voided' && (
          <>
            <button type="button" className={btnClass} onClick={() => setAdjusting((v) => !v)} aria-expanded={adjusting}><SlidersHorizontal size={14} /> Adjust</button>
            <button type="button" className={`${btnClass} text-danger`} onClick={() => setConfirmVoid(true)}><Ban size={14} /> Void</button>
          </>
        )}
      </div>

      {adjusting && (
        <div className="mt-3 space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          <div className="grid grid-cols-2 gap-2">
            {([1, -1] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSign(s)} className={`focus-ring rounded-xl border px-3 py-2 text-sm font-medium ${sign === s ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
                {s === 1 ? 'Add funds' : 'Remove funds'}
              </button>
            ))}
          </div>
          <input inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="Amount, e.g. 10.00" className={inputClass} aria-label="Adjustment amount" />
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Reason (required, kept in the ledger)" className={inputClass} aria-label="Reason" />
          <div className="flex justify-end">
            <button type="button" className={primaryBtn} onClick={doAdjust} disabled={!canAdjust}>{saving ? 'Saving…' : 'Save adjustment'}</button>
          </div>
        </div>
      )}

      <h3 className="mb-2 mt-5 text-sm font-semibold text-text-primary">Balance ledger</h3>
      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-xl bg-bg-tertiary" />)}</div>
      ) : failed ? (
        <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-sm text-danger">
          Couldn't load the ledger. <button type="button" className="font-medium underline" onClick={load}>Retry</button>
        </div>
      ) : tx.length === 0 ? (
        <p className="text-sm text-text-secondary">No transactions yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {tx.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-text-primary">{LEDGER_LABELS[t.kind]}</p>
                <p className="truncate text-xs text-text-secondary">{new Date(t.created_at).toLocaleString()}{t.note ? ` · ${t.note}` : ''}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className={t.amount_cents < 0 ? 'font-semibold text-danger' : 'font-semibold text-success-500'}>
                  {t.amount_cents < 0 ? '−' : '+'}{formatCents(Math.abs(t.amount_cents))}
                </p>
                <p className="text-xs text-text-secondary">Bal. {formatCents(t.balance_after_cents)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

    </Modal>
    <ConfirmDialog
      open={confirmVoid}
      title="Void this card?"
      description={`The remaining ${formatCents(card.balance_cents)} will be removed and the card can no longer be used. The history is kept.`}
      confirmPhrase="void card"
      confirmLabel="Void card"
      onCancel={() => setConfirmVoid(false)}
      onConfirm={async () => {
        try {
          await voidGiftCard(card.id, 'Voided from dashboard');
          toast('Card voided.', 'success');
          setConfirmVoid(false);
          onChanged();
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Could not void the card.', 'error');
        }
      }}
    />
    </>
  );
}

// ============================================================
// PAGE
// ============================================================

export function GiftCardsPage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;

  const [cards, setCards] = useState<GiftCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!user || !canAccess) return;
      if (!silent) {
        setLoading(true);
        setFailed(false);
      }
      try {
        setCards(await fetchGiftCards());
      } catch {
        if (silent) toast('Could not refresh gift cards.', 'error');
        else setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [user, canAccess, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarize(cards), [cards]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => {
      if (filter !== 'all' && deriveStatus(c) !== filter) return false;
      if (!q) return true;
      return [c.code, c.recipient_name, c.recipient_email, c.note].some((v) => v?.toLowerCase().includes(q));
    });
  }, [cards, filter, query]);

  const detailCard = modal?.type === 'detail' ? cards.find((c) => c.id === modal.id) ?? null : null;

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Gift Cards">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Gift Cards">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Gift size={22} className="text-accent" /> Gift cards &amp; store credit
          </h1>
          <p className="text-sm text-text-secondary">Issue coded cards, track every balance change and redeem them at checkout.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnClass} onClick={() => setModal({ type: 'redeem' })}><ScanLine size={14} /> Redeem</button>
          <button type="button" className={primaryBtn} onClick={() => setModal({ type: 'issue' })}><Plus size={14} /> Issue card</button>
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : failed ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load gift cards" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      ) : cards.length === 0 ? (
        <EmptyState
          icon={Gift}
          title="No gift cards yet"
          description="Issue your first gift card or store credit — customers can use the code toward any unpaid invoice."
          action={{ label: 'Issue card', onClick: () => setModal({ type: 'issue' }) }}
        />
      ) : (
        <FadeIn>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Outstanding balance" value={formatCents(summary.outstandingCents)} hint={`${summary.activeCount} active`} />
            <Stat label="Total issued" value={formatCents(summary.issuedCents)} />
            <Stat label="Expiring in 30 days" value={String(summary.expiringSoonCount)} hint="active cards" />
            <Stat label="Expired balance" value={formatCents(summary.expiredCents)} />
          </div>

          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Filter by status">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search code, name, email…" aria-label="Search gift cards" className={`${inputClass} sm:max-w-xs`} />
          </div>

          {visible.length === 0 ? (
            <EmptyState icon={Gift} title="No matching cards" description="Try a different filter or search term." action={{ label: 'Clear filters', onClick: () => { setFilter('all'); setQuery(''); } }} />
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-2xl border border-border md:block">
                <table className="w-full text-left text-sm">
                  <thead className="bg-bg-secondary text-xs uppercase tracking-wide text-text-secondary">
                    <tr>
                      <th className="px-4 py-3">Code</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Recipient</th>
                      <th className="px-4 py-3 text-right">Balance</th>
                      <th className="px-4 py-3">Expires</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visible.map((c) => (
                      <tr key={c.id} className="cursor-pointer hover:bg-bg-secondary/60" onClick={() => setModal({ type: 'detail', id: c.id })}>
                        <td className="px-4 py-3">
                          <button type="button" className="focus-ring rounded font-mono font-medium text-text-primary" onClick={(e) => { e.stopPropagation(); setModal({ type: 'detail', id: c.id }); }}>{c.code}</button>
                        </td>
                        <td className="px-4 py-3 text-text-secondary">{KIND_LABELS[c.kind]}</td>
                        <td className="px-4 py-3 text-text-secondary">{c.recipient_name || c.recipient_email || '—'}</td>
                        <td className="px-4 py-3 text-right font-semibold text-text-primary">{formatCents(c.balance_cents)}<span className="font-normal text-text-secondary"> / {formatCents(c.initial_cents)}</span></td>
                        <td className="px-4 py-3 text-text-secondary">{fmtDate(c.expires_at)}</td>
                        <td className="px-4 py-3"><StatusBadge status={deriveStatus(c)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-3 md:hidden">
                {visible.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setModal({ type: 'detail', id: c.id })} className="focus-ring w-full rounded-2xl border border-border bg-bg-secondary p-4 text-left">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-mono text-sm font-semibold text-text-primary">{c.code}</span>
                        <StatusBadge status={deriveStatus(c)} />
                      </div>
                      <div className="mt-2 flex items-end justify-between">
                        <span className="text-lg font-bold text-text-primary">{formatCents(c.balance_cents)}</span>
                        <span className="text-xs text-text-secondary">{KIND_LABELS[c.kind]} · exp {fmtDate(c.expires_at)}</span>
                      </div>
                      {(c.recipient_name || c.recipient_email) && <p className="mt-1 truncate text-xs text-text-secondary">{c.recipient_name || c.recipient_email}</p>}
                    </button>
                  </li>
                ))}
              </ul>
              {cards.length >= 500 && <p className="mt-3 text-xs text-text-secondary">Showing your 500 most recent cards.</p>}
            </>
          )}
        </FadeIn>
      )}

      {modal?.type === 'issue' && (
        <IssueModal
          onClose={() => setModal(null)}
          onDone={async (card) => {
            await load(true);
            setModal({ type: 'detail', id: card.id });
          }}
        />
      )}
      {modal?.type === 'redeem' && (
        <RedeemModal
          cards={cards}
          initialCode={modal.code}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            void load(true);
          }}
        />
      )}
      {modal?.type === 'detail' && detailCard && (
        <DetailModal
          card={detailCard}
          onClose={() => setModal(null)}
          onChanged={() => void load(true)}
          onRedeem={() => setModal({ type: 'redeem', code: detailCard.code })}
        />
      )}
    </DashboardLayout>
  );
}
