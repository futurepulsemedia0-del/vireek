import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Award, Lock, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  DEFAULT_PROGRAM,
  LEDGER_LABELS,
  MAX_POINTS,
  RULE_LABELS,
  adjustPoints,
  fetchAccounts,
  fetchLedger,
  fetchProgram,
  fetchRules,
  newIdempotencyKey,
  parsePoints,
  saveProgram,
  saveRule,
  searchCustomers,
  summarizeAccounts,
  type EarnRule,
  type EarnRuleKind,
  type LedgerEntry,
  type LoyaltyAccount,
  type LoyaltyProgram,
} from '@/lib/pointsLedger';

type Program = Omit<LoyaltyProgram, 'account_owner_id'>;

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';
const btnClass =
  'focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50';
const primaryBtn =
  'focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');
const fmtPts = (n: number) => n.toLocaleString();

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
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
// ADJUST / GRANT
// ============================================================

function AdjustModal({ preset, onClose, onDone }: { preset: { id: string; name: string } | null; onClose: () => void; onDone: () => void | Promise<void> }) {
  const { toast } = useToast();
  const [customer, setCustomer] = useState(preset);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; name: string; email: string | null }[]>([]);
  const [sign, setSign] = useState<1 | -1>(1);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(newIdempotencyKey);

  useEffect(() => {
    if (customer) return;
    let live = true;
    const t = setTimeout(() => {
      searchCustomers(q).then((r) => live && setResults(r)).catch(() => live && setResults([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, customer]);

  const submit = async () => {
    if (!customer) return toast('Choose a customer.', 'error');
    const pts = parsePoints(amount);
    if (pts === null) return toast(`Enter a whole number of points up to ${fmtPts(MAX_POINTS)}.`, 'error');
    if (!note.trim()) return toast('A reason is required for the audit trail.', 'error');
    setBusy(true);
    try {
      await adjustPoints({ customerId: customer.id, points: sign * pts, note: note.trim(), idempotencyKey: key });
      toast('Points updated.', 'success');
      await onDone();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update points.', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title="Add or remove points" onClose={onClose}>
      <div className="space-y-4">
        {customer ? (
          <div className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm">
            <span className="font-medium text-text-primary">{customer.name}</span>
            {!preset && <button type="button" className="text-xs text-accent" onClick={() => setCustomer(null)}>Change</button>}
          </div>
        ) : (
          <Field label="Customer">
            <input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" autoFocus />
            {results.length > 0 && (
              <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
                {results.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="focus-ring w-full px-4 py-2 text-left text-sm hover:bg-bg-tertiary" onClick={() => setCustomer({ id: r.id, name: r.name })}>
                      {r.name} <span className="text-text-secondary">{r.email ?? ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}
        <div className="flex gap-2" role="radiogroup" aria-label="Direction">
          {([1, -1] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={sign === s} onClick={() => setSign(s)} className={`${btnClass} flex-1 ${sign === s ? 'border-accent text-accent' : ''}`}>
              {s === 1 ? 'Add points' : 'Remove points'}
            </button>
          ))}
        </div>
        <Field label="Points">
          <input className={inputClass} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 250" />
        </Field>
        <Field label="Reason" hint="Saved permanently in the ledger.">
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Goodwill credit after a callback" />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnClass} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// MEMBER DETAIL (ledger)
// ============================================================

function DetailModal({ account, onClose, onAdjust }: { account: LoyaltyAccount; onClose: () => void; onAdjust: () => void }) {
  const [rows, setRows] = useState<LedgerEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetchLedger(account.id).then((r) => live && setRows(r)).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [account.id]);

  return (
    <Modal title={account.customers?.name ?? 'Customer'} onClose={onClose}>
      <div className="mb-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-bg-primary p-3"><p className="text-lg font-bold text-text-primary">{fmtPts(account.balance_points)}</p><p className="text-xs text-text-secondary">Balance</p></div>
        <div className="rounded-xl bg-bg-primary p-3"><p className="text-lg font-bold text-text-primary">{fmtPts(account.lifetime_earned)}</p><p className="text-xs text-text-secondary">Earned</p></div>
        <div className="rounded-xl bg-bg-primary p-3"><p className="text-lg font-bold text-text-primary">{fmtPts(account.lifetime_redeemed)}</p><p className="text-xs text-text-secondary">Redeemed</p></div>
      </div>
      <button type="button" className={`${btnClass} mb-4 w-full`} onClick={onAdjust}><SlidersHorizontal size={14} /> Add or remove points</button>
      {failed ? (
        <p className="text-sm text-danger">Could not load the ledger.</p>
      ) : rows === null ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-secondary">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div>
                <p className="font-medium text-text-primary">{LEDGER_LABELS[r.kind]}{r.note ? ` · ${r.note}` : ''}</p>
                <p className="text-xs text-text-secondary">{fmtDate(r.created_at)}{r.expires_at ? ` · expires ${fmtDate(r.expires_at)}` : ''}</p>
              </div>
              <div className="text-right">
                <p className={`font-semibold ${r.points > 0 ? 'text-success-500' : 'text-text-primary'}`}>{r.points > 0 ? '+' : ''}{fmtPts(r.points)}</p>
                <p className="text-xs text-text-secondary">bal {fmtPts(r.balance_after)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ============================================================
// RULES
// ============================================================

function RuleModal({ rule, onClose, onDone }: { rule: EarnRule | null; onClose: () => void; onDone: () => void | Promise<void> }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<EarnRuleKind>(rule?.kind ?? 'invoice_paid');
  const [label, setLabel] = useState(rule?.label ?? '');
  const [ppd, setPpd] = useState(String(rule?.points_per_dollar ?? 1));
  const [flat, setFlat] = useState(String(rule?.flat_points ?? 0));
  const [promo, setPromo] = useState(rule?.promo_code ?? '');
  const [minDollars, setMinDollars] = useState(String((rule?.min_invoice_cents ?? 0) / 100));
  const [active, setActive] = useState(rule?.active ?? true);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const perDollar = kind === 'job_completed' ? 0 : Number(ppd);
    const flatPts = Number(flat);
    const min = Math.round(Number(minDollars) * 100);
    if (!label.trim()) return toast('Give the rule a name.', 'error');
    if (!Number.isFinite(perDollar) || perDollar < 0 || perDollar > 1000) return toast('Points per dollar must be 0–1,000.', 'error');
    if (!Number.isInteger(flatPts) || flatPts < 0 || flatPts > MAX_POINTS) return toast('Bonus points must be a whole number.', 'error');
    if (perDollar === 0 && flatPts === 0) return toast('Award points per dollar, a flat bonus, or both.', 'error');
    if (kind === 'promo_bonus' && !promo.trim()) return toast('Enter the promo code.', 'error');
    if (!Number.isFinite(min) || min < 0) return toast('Minimum invoice must be 0 or more.', 'error');
    setBusy(true);
    try {
      await saveRule({ id: rule?.id, kind, label: label.trim(), pointsPerDollar: perDollar, flatPoints: flatPts, promoCode: kind === 'promo_bonus' ? promo.trim() : null, minInvoiceCents: kind === 'job_completed' ? 0 : min, active });
      toast('Rule saved.', 'success');
      await onDone();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the rule.', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title={rule ? 'Edit earn rule' : 'New earn rule'} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Earn on">
          <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as EarnRuleKind)}>
            {(Object.keys(RULE_LABELS) as EarnRuleKind[]).map((k) => <option key={k} value={k}>{RULE_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Name"><input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="e.g. Points on every payment" /></Field>
        {kind !== 'job_completed' && <Field label="Points per $1 paid"><input className={inputClass} inputMode="decimal" value={ppd} onChange={(e) => setPpd(e.target.value)} /></Field>}
        <Field label={kind === 'job_completed' ? 'Points per completed job' : 'Flat bonus points'}><input className={inputClass} inputMode="numeric" value={flat} onChange={(e) => setFlat(e.target.value)} /></Field>
        {kind === 'promo_bonus' && <Field label="Promo code" hint="Bonus applies when the paid invoice carries this code."><input className={inputClass} value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="SPRING25" /></Field>}
        {kind !== 'job_completed' && <Field label="Minimum invoice ($)"><input className={inputClass} inputMode="decimal" value={minDollars} onChange={(e) => setMinDollars(e.target.value)} /></Field>}
        <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnClass} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save rule'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// SETTINGS
// ============================================================

function SettingsTab({ program, onSaved }: { program: Program; onSaved: () => void | Promise<void> }) {
  const { toast } = useToast();
  const [p, setP] = useState(program);
  const [expires, setExpires] = useState(program.expiry_months !== null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setP(program); setExpires(program.expiry_months !== null); }, [program]);

  const num = (v: string, fallback: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fallback : Number(v));
  const save = async () => {
    if (!Number.isInteger(p.redeem_points_per_dollar) || p.redeem_points_per_dollar < 1) return toast('Redeem rate must be a whole number of at least 1.', 'error');
    if (!Number.isInteger(p.min_redeem_points) || p.min_redeem_points < 1) return toast('Minimum redemption must be at least 1 point.', 'error');
    if (!Number.isInteger(p.max_redeem_pct) || p.max_redeem_pct < 1 || p.max_redeem_pct > 100) return toast('Maximum share must be 1–100%.', 'error');
    if (expires && (!p.expiry_months || !Number.isInteger(p.expiry_months) || p.expiry_months < 1 || p.expiry_months > 120)) return toast('Expiry must be 1–120 months.', 'error');
    if (p.member_multiplier < 1 || p.member_multiplier > 10) return toast('Member multiplier must be between 1 and 10.', 'error');
    setBusy(true);
    try {
      await saveProgram({ ...p, expiry_months: expires ? p.expiry_months : null });
      toast('Loyalty settings saved.', 'success');
      await onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save settings.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-5 p-5">
      <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} /> Loyalty program enabled
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Points worth $1 when redeemed" hint="100 means 100 points = $1.00."><input className={inputClass} inputMode="numeric" value={p.redeem_points_per_dollar} onChange={(e) => setP({ ...p, redeem_points_per_dollar: num(e.target.value, 0) })} /></Field>
        <Field label="Minimum points per redemption"><input className={inputClass} inputMode="numeric" value={p.min_redeem_points} onChange={(e) => setP({ ...p, min_redeem_points: num(e.target.value, 0) })} /></Field>
        <Field label="Max share of an invoice payable with points (%)"><input className={inputClass} inputMode="numeric" value={p.max_redeem_pct} onChange={(e) => setP({ ...p, max_redeem_pct: num(e.target.value, 0) })} /></Field>
        <Field label="Active-member earn multiplier" hint="1 = no bonus. Applies when the customer has an active membership."><input className={inputClass} inputMode="decimal" value={p.member_multiplier} onChange={(e) => setP({ ...p, member_multiplier: num(e.target.value, 1) })} /></Field>
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={expires} onChange={(e) => { setExpires(e.target.checked); if (e.target.checked && !p.expiry_months) setP({ ...p, expiry_months: 12 }); }} /> Points expire</label>
        {expires && <Field label="Months until expiry"><input className={`${inputClass} sm:max-w-[10rem]`} inputMode="numeric" value={p.expiry_months ?? ''} onChange={(e) => setP({ ...p, expiry_months: num(e.target.value, 0) })} /></Field>}
        <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={p.earn_on_promo_invoices} onChange={(e) => setP({ ...p, earn_on_promo_invoices: e.target.checked })} /> Earn points on invoices that used a promo code</label>
      </div>
      <div className="flex justify-end"><button type="button" className={primaryBtn} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button></div>
    </Card>
  );
}

// ============================================================
// PAGE
// ============================================================

type Tab = 'members' | 'rules' | 'settings';
type ModalState = { type: 'detail'; id: string } | { type: 'adjust'; preset: { id: string; name: string } | null } | { type: 'rule'; rule: EarnRule | null } | null;

export function PointsLedgerPage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;

  const [tab, setTab] = useState<Tab>('members');
  const [accounts, setAccounts] = useState<LoyaltyAccount[]>([]);
  const [rules, setRules] = useState<EarnRule[]>([]);
  const [program, setProgram] = useState<Program>(DEFAULT_PROGRAM);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!user || !canAccess) return;
      if (!silent) { setLoading(true); setFailed(false); }
      try {
        const [a, r, p] = await Promise.all([fetchAccounts(), fetchRules(), fetchProgram()]);
        setAccounts(a); setRules(r); setProgram(p);
      } catch {
        if (silent) toast('Could not refresh loyalty data.', 'error'); else setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [user, canAccess, toast],
  );
  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizeAccounts(accounts), [accounts]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? accounts.filter((a) => [a.customers?.name, a.customers?.email, a.customers?.phone].some((v) => v?.toLowerCase().includes(q))) : accounts;
  }, [accounts, query]);
  const detail = modal?.type === 'detail' ? accounts.find((a) => a.id === modal.id) ?? null : null;

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Points Ledger">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const TABS: { key: Tab; label: string }[] = [{ key: 'members', label: 'Members' }, { key: 'rules', label: 'Earn rules' }, { key: 'settings', label: 'Settings' }];

  return (
    <DashboardLayout activeLabel="Points Ledger">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Award size={22} className="text-accent" /> Loyalty points</h1>
          <p className="text-sm text-text-secondary">Customers earn points on paid invoices and completed jobs, and redeem them on invoices.</p>
        </div>
        <button type="button" className={primaryBtn} onClick={() => setModal({ type: 'adjust', preset: null })}><Plus size={14} /> Add or remove points</button>
      </div>

      {!loading && !failed && !program.enabled && (
        <div className="mb-4 rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          The program is switched off, so nothing is earned or redeemable yet. Turn it on under Settings.
        </div>
      )}

      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Loyalty sections">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`focus-ring shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium ${tab === t.key ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
        ))}
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : failed ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load loyalty data" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      ) : (
        <FadeIn>
          {tab === 'members' && (
            <>
              <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Points outstanding" value={fmtPts(summary.outstandingPoints)} />
                <Stat label="Members with points" value={fmtPts(summary.members)} />
                <Stat label="Lifetime earned" value={fmtPts(summary.earnedPoints)} />
                <Stat label="Lifetime redeemed" value={fmtPts(summary.redeemedPoints)} />
              </div>
              {accounts.length === 0 ? (
                <EmptyState icon={Award} title="No points yet" description="Add an earn rule and enable the program. Points appear here as invoices are paid and jobs are completed." action={{ label: 'Add earn rule', onClick: () => { setTab('rules'); setModal({ type: 'rule', rule: null }); } }} />
              ) : (
                <>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer…" aria-label="Search members" className={`${inputClass} mb-3 sm:max-w-xs`} />
                  <div className="overflow-hidden rounded-2xl border border-border">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-bg-secondary text-xs uppercase tracking-wide text-text-secondary">
                        <tr><th className="px-4 py-3">Customer</th><th className="px-4 py-3 text-right">Balance</th><th className="hidden px-4 py-3 text-right sm:table-cell">Earned</th><th className="hidden px-4 py-3 text-right sm:table-cell">Redeemed</th></tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {visible.map((a) => (
                          <tr key={a.id} className="cursor-pointer hover:bg-bg-secondary/60" onClick={() => setModal({ type: 'detail', id: a.id })}>
                            <td className="px-4 py-3"><button type="button" className="focus-ring rounded font-medium text-text-primary" onClick={(e) => { e.stopPropagation(); setModal({ type: 'detail', id: a.id }); }}>{a.customers?.name ?? 'Customer'}</button></td>
                            <td className="px-4 py-3 text-right font-semibold text-text-primary">{fmtPts(a.balance_points)}</td>
                            <td className="hidden px-4 py-3 text-right text-text-secondary sm:table-cell">{fmtPts(a.lifetime_earned)}</td>
                            <td className="hidden px-4 py-3 text-right text-text-secondary sm:table-cell">{fmtPts(a.lifetime_redeemed)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'rules' && (
            <>
              <div className="mb-3 flex justify-end"><button type="button" className={primaryBtn} onClick={() => setModal({ type: 'rule', rule: null })}><Plus size={14} /> New rule</button></div>
              {rules.length === 0 ? (
                <EmptyState icon={Award} title="No earn rules" description="Create a rule such as 1 point per dollar paid, or a bonus for completed jobs." action={{ label: 'New rule', onClick: () => setModal({ type: 'rule', rule: null }) }} />
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
                  {rules.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-bg-secondary/60" onClick={() => setModal({ type: 'rule', rule: r })}>
                        <div>
                          <p className="font-medium text-text-primary">{r.label}</p>
                          <p className="text-xs text-text-secondary">
                            {RULE_LABELS[r.kind]}
                            {r.points_per_dollar > 0 ? ` · ${r.points_per_dollar} pt/$` : ''}
                            {r.flat_points > 0 ? ` · +${fmtPts(r.flat_points)} flat` : ''}
                            {r.promo_code ? ` · code ${r.promo_code}` : ''}
                          </p>
                        </div>
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${r.active ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>{r.active ? 'Active' : 'Paused'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === 'settings' && <SettingsTab program={program} onSaved={() => load(true)} />}
        </FadeIn>
      )}

      {detail && <DetailModal account={detail} onClose={() => setModal(null)} onAdjust={() => setModal({ type: 'adjust', preset: { id: detail.customer_id, name: detail.customers?.name ?? 'Customer' } })} />}
      {modal?.type === 'adjust' && <AdjustModal preset={modal.preset} onClose={() => setModal(null)} onDone={() => load(true)} />}
      {modal?.type === 'rule' && <RuleModal rule={modal.rule} onClose={() => setModal(null)} onDone={() => load(true)} />}
    </DashboardLayout>
  );
}
