import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  Copy,
  Gift,
  Link2,
  Loader2,
  Lock,
  Mail,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Trophy,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  MAX_PAYOUT_BATCH,
  MAX_RULES,
  PAYOUT_METHOD_LABELS,
  PAYOUT_METHOD_OPTIONS,
  PERIOD_OPTIONS,
  REWARD_TYPE_OPTIONS,
  buildReferralLink,
  conversionRate,
  countConversionTabs,
  defaultMethodFor,
  describeRule,
  emptyRuleForm,
  filterConversions,
  formatMoney,
  formatReward,
  isPayable,
  mailtoHref,
  pickRule,
  rankLeaderboard,
  referrerLabel,
  ruleToForm,
  ruleToPayload,
  shareMessage,
  smsHref,
  sortRules,
  sumPayable,
  summarizeBoard,
  validateRule,
  whatsappHref,
  type ConversionDetail,
  type LeaderboardPeriod,
  type LeaderboardRow,
  type PayoutFilter,
  type PayoutMethod,
  type RewardRule,
  type RuleErrors,
  type RuleFormValues,
} from '@/lib/referrals';
import {
  createReferralCode,
  createRule,
  deleteRule,
  fetchConversions,
  fetchLeaderboard,
  fetchRules,
  recordPayouts,
  searchCustomers,
  updateRule,
  voidPayout,
  type CustomerOption,
} from '@/lib/referralsApi';

// ============================================================
// SHARED PIECES
// ============================================================

type TabKey = 'leaderboard' | 'links' | 'rules' | 'payouts';
const TABS: { key: TabKey; label: string; icon: typeof Trophy }[] = [
  { key: 'leaderboard', label: 'Leaderboard', icon: Trophy },
  { key: 'links', label: 'Links', icon: Link2 },
  { key: 'rules', label: 'Reward rules', icon: SlidersHorizontal },
  { key: 'payouts', label: 'Payouts', icon: Wallet },
];

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary';
const shareLinkClass =
  'focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:border-accent/40';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {children}
    </span>
  );
}

function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={selectClass}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center"
    >
      <TriangleAlert size={26} className="text-danger" aria-hidden="true" />
      <p className="text-sm text-text-secondary">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        <RefreshCw size={14} /> Try again
      </Button>
    </div>
  );
}

function Modal({
  title,
  onClose,
  busy,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useFocusTrap(true);
  const guardedClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  useEscapeToClose(true, guardedClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) guardedClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-xl sm:max-w-lg sm:rounded-2xl sm:p-6"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-bold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={guardedClose}
            disabled={busy}
            aria-label="Close"
            className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Could not copy. Select the link and copy it manually.', 'error');
    }
  };

  return (
    <button type="button" onClick={() => void copy()} className={shareLinkClass}>
      {copied ? <Check size={14} className="text-success-500" /> : <Copy size={14} />}
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

// ============================================================
// LEADERBOARD
// ============================================================

function LeaderboardTab({ allTimeRows, onNewLink }: { allTimeRows: LeaderboardRow[]; onNewLink: () => void }) {
  const [period, setPeriod] = useState<LeaderboardPeriod>('all');
  const [periodRows, setPeriodRows] = useState<LeaderboardRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const days = PERIOD_OPTIONS.find((p) => p.key === period)?.days ?? null;
    if (days === null) {
      setPeriodRows(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    fetchLeaderboard(days)
      .then((rows) => {
        if (!cancelled) setPeriodRows(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the leaderboard.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, allTimeRows]);

  const rows = period === 'all' ? allTimeRows : (periodRows ?? []);
  const ranked = useMemo(() => rankLeaderboard(rows), [rows]);
  const hasConversions = ranked.some((r) => r.conversions > 0);

  if (allTimeRows.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No referral links yet"
        description="Create a link for a happy customer. Once friends book through it, your top referrers show up here."
        action={{ label: 'Create a referral link', onClick: onNewLink }}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          {hasConversions
            ? 'Ranked by converted referrals, then rewards earned.'
            : 'No converted referrals in this period yet.'}
        </p>
        <select
          aria-label="Leaderboard period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as LeaderboardPeriod)}
          className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
        >
          {PERIOD_OPTIONS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4" aria-busy={busy}>
        {error ? (
          <ErrorPanel message={error} onRetry={() => setPeriod((p) => p)} />
        ) : busy && periodRows === null ? (
          <SkeletonCardList count={3} rows={2} />
        ) : (
          <ul className={`space-y-3 transition-opacity ${busy ? 'opacity-60' : ''}`}>
            {ranked.map((row) => {
              const rate = conversionRate(row.clicks, row.conversions);
              const podium = row.conversions > 0 && row.rank === 1;
              return (
                <motion.li
                  key={row.referral_code_id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                        podium ? 'bg-warning-500/15 text-warning-500' : 'bg-bg-tertiary text-text-secondary'
                      }`}
                      aria-label={`Rank ${row.rank}`}
                    >
                      {row.conversions > 0 ? row.rank : '–'}
                    </span>
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-semibold text-text-primary">{referrerLabel(row)}</h3>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        Code {row.code}
                        {rate !== null && ` · ${rate}% of clicks converted`}
                      </p>
                    </div>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-4 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-text-secondary">Clicks</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-text-primary">{row.clicks}</dd>
                    </div>
                    <div>
                      <dt className="text-text-secondary">Conversions</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-text-primary">{row.conversions}</dd>
                    </div>
                    <div>
                      <dt className="text-text-secondary">Rewards paid</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-text-primary">{formatMoney(row.earned)}</dd>
                    </div>
                    <div>
                      <dt className="text-text-secondary">To pay</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-text-primary">{formatMoney(row.unpaid)}</dd>
                    </div>
                  </dl>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ============================================================
// LINKS
// ============================================================

function LinksTab({
  rows,
  rules,
  onNewLink,
}: {
  rows: LeaderboardRow[];
  rules: RewardRule[];
  onNewLink: () => void;
}) {
  const [query, setQuery] = useState('');
  const base = typeof window === 'undefined' ? 'https://vireek.com' : window.location.origin;
  const topRule = useMemo(() => pickRule(rules, { amount: 0, priorConversions: 0 }), [rules]);
  const rewardLabel = topRule ? formatReward(topRule.reward_type, topRule.reward_value) : undefined;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => referrerLabel(r).toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
  }, [rows, query]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Link2}
        title="No tracking links yet"
        description="Each customer gets their own link. Clicks and bookings through it are tracked automatically."
        action={{ label: 'Create a referral link', onClick: onNewLink }}
      />
    );
  }

  return (
    <div>
      <div className="max-w-sm">
        <Input
          icon={Search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or code"
          aria-label="Search referral links"
        />
      </div>
      {visible.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={Search}
            title="No links match your search"
            description="Try a different name or code."
            action={{ label: 'Clear search', onClick: () => setQuery('') }}
          />
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {visible.map((row) => {
            const link = buildReferralLink(base, row.code);
            const message = shareMessage(link, rewardLabel);
            return (
              <li key={row.referral_code_id} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="break-words text-sm font-semibold text-text-primary">{referrerLabel(row)}</h3>
                    <p className="mt-1 break-all rounded-lg bg-bg-primary px-2.5 py-1.5 text-xs text-text-secondary">
                      {link}
                    </p>
                    <p className="mt-2 text-xs text-text-secondary">
                      {row.clicks} click{row.clicks === 1 ? '' : 's'} · {row.conversions} conversion
                      {row.conversions === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <CopyButton text={link} />
                    <a href={smsHref(message)} className={shareLinkClass}>
                      <MessageSquare size={14} aria-hidden="true" /> Text
                    </a>
                    <a href={mailtoHref('Your referral link', message)} className={shareLinkClass}>
                      <Mail size={14} aria-hidden="true" /> Email
                    </a>
                    <a href={whatsappHref(message)} target="_blank" rel="noopener noreferrer" className={shareLinkClass}>
                      <Share2 size={14} aria-hidden="true" /> WhatsApp
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NewLinkDialog({
  ownerId,
  existing,
  onClose,
  onCreated,
}: {
  ownerId: string;
  existing: LeaderboardRow[];
  onClose: () => void;
  onCreated: (code: string) => void;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CustomerOption | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      searchCustomers(ownerId, term)
        .then((rows) => {
          if (!cancelled) setResults(rows);
        })
        .catch((err) => {
          if (!cancelled) setSearchError(err instanceof Error ? err.message : 'Search failed.');
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, ownerId]);

  const existingCode = selected ? existing.find((r) => r.referrer_customer_id === selected.id)?.code : undefined;

  const create = async () => {
    if (!selected || existingCode) return;
    setCreating(true);
    try {
      const code = await createReferralCode(ownerId, selected);
      toast('Referral link created', 'success');
      onCreated(code);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create this link', 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal title="New referral link" onClose={onClose} busy={creating}>
      <Input
        icon={Search}
        label="Find a customer"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
        }}
        placeholder="Start typing a name"
        autoFocus
      />
      <div className="mt-3 min-h-[3rem]" aria-live="polite">
        {searching && (
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin" /> Searching…
          </p>
        )}
        {searchError && (
          <p role="alert" className="text-xs text-danger">
            {searchError}
          </p>
        )}
        {!searching && !searchError && query.trim().length >= 2 && results.length === 0 && (
          <p className="text-xs text-text-secondary">No customers match that name.</p>
        )}
        <ul className="space-y-1.5">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelected(c)}
                aria-pressed={selected?.id === c.id}
                className={`focus-ring w-full rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                  selected?.id === c.id
                    ? 'border-accent bg-accent/10 text-text-primary'
                    : 'border-border text-text-primary hover:border-accent/40'
                }`}
              >
                <span className="block font-medium">{c.name}</span>
                <span className="block text-xs text-text-secondary">{c.email ?? c.phone ?? 'No contact details'}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {existingCode && (
        <p className="mt-3 rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">
          {selected?.name} already has a link (code {existingCode}). Find it in the Links tab.
        </p>
      )}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void create()} disabled={!selected || Boolean(existingCode) || creating}>
          {creating && <Loader2 size={14} className="animate-spin" />}
          Create link
        </Button>
      </div>
    </Modal>
  );
}

// ============================================================
// REWARD RULES
// ============================================================

function RuleDialog({
  rule,
  onClose,
  onSave,
}: {
  rule: RewardRule | null;
  onClose: () => void;
  onSave: (values: RuleFormValues, existing: RewardRule | null) => Promise<void>;
}) {
  const { toast } = useToast();
  const uid = useId();
  const [values, setValues] = useState<RuleFormValues>(() => (rule ? ruleToForm(rule) : emptyRuleForm()));
  const [errors, setErrors] = useState<RuleErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof RuleFormValues>(key: K, value: RuleFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next: Record<string, unknown> = { ...prev };
      delete next[key];
      return next as RuleErrors;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateRule(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      await onSave(values, rule);
      toast(rule ? 'Rule updated' : 'Rule created', 'success');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this rule', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const isDiscount = values.rewardType === 'discount';

  return (
    <Modal title={rule ? 'Edit reward rule' : 'New reward rule'} onClose={onClose} busy={submitting}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <Input
          label="Rule name"
          required
          maxLength={60}
          value={values.name}
          onChange={(e) => set('name', e.target.value)}
          error={errors.name}
          placeholder="e.g. Standard reward"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id={`${uid}-type`}
            label="Reward type"
            value={values.rewardType}
            options={REWARD_TYPE_OPTIONS}
            onChange={(v) => set('rewardType', v)}
          />
          <Input
            label={isDiscount ? 'Discount (%)' : 'Amount ($)'}
            required
            inputMode="decimal"
            value={values.rewardValue}
            onChange={(e) => set('rewardValue', e.target.value)}
            error={errors.rewardValue}
          />
        </div>
        <fieldset className="rounded-xl border border-border bg-bg-primary p-4">
          <legend className="px-1 text-sm font-semibold text-text-primary">Conditions (optional)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Referred customer pays at least ($)"
              inputMode="decimal"
              value={values.minInvoice}
              onChange={(e) => set('minInvoice', e.target.value)}
              error={errors.minInvoice}
            />
            <Input
              label="Referrer has at least N earlier conversions"
              inputMode="numeric"
              value={values.minConversions}
              onChange={(e) => set('minConversions', e.target.value)}
              error={errors.minConversions}
            />
          </div>
          <p className="mt-3 text-xs text-text-secondary">
            When several rules match, the most specific one wins: most earlier conversions first, then the highest
            job value.
          </p>
        </fieldset>
        <label className="flex items-center gap-3 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={values.isActive}
            onChange={(e) => set('isActive', e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          Active
        </label>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {rule ? 'Save changes' : 'Create rule'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RulePreview({ rules }: { rules: RewardRule[] }) {
  const [amount, setAmount] = useState('500');
  const [prior, setPrior] = useState('0');
  const amountNum = Number(amount.replace(/,/g, ''));
  const priorNum = Number(prior);
  const valid = Number.isFinite(amountNum) && amountNum >= 0 && Number.isInteger(priorNum) && priorNum >= 0;
  const match = valid ? pickRule(rules, { amount: amountNum, priorConversions: priorNum }) : null;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-text-primary">Try it</h3>
      <p className="mt-1 text-xs text-text-secondary">See which rule would apply to a future referral.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Input label="Referred customer pays ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input label="Referrer's earlier conversions" inputMode="numeric" value={prior} onChange={(e) => setPrior(e.target.value)} />
      </div>
      <p className="mt-3 text-sm text-text-primary" aria-live="polite">
        {!valid
          ? 'Enter a dollar amount and a whole number.'
          : match
            ? `${match.name}: ${formatReward(match.reward_type, match.reward_value)}`
            : 'No active rule matches. The referral would convert without a reward.'}
      </p>
    </div>
  );
}

function RulesTab({
  rules,
  onAdd,
  onEdit,
  onToggle,
  onDelete,
  busyId,
}: {
  rules: RewardRule[];
  onAdd: () => void;
  onEdit: (r: RewardRule) => void;
  onToggle: (r: RewardRule) => void;
  onDelete: (r: RewardRule) => void;
  busyId: string | null;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-secondary">
          Rules decide the reward the moment a referred customer pays. They apply to new conversions only.
        </p>
        <Button size="sm" onClick={onAdd} disabled={rules.length >= MAX_RULES} className="w-full sm:w-auto">
          <Plus size={16} /> Add rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No reward rules yet"
          description="Without a rule, referrals still convert but earn no reward. Start with one simple rule for every referral."
          action={{ label: 'Create your first rule', onClick: onAdd }}
        />
      ) : (
        <ul className="space-y-3">
          {sortRules(rules).map((r) => (
            <motion.li
              key={r.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5 ${r.is_active ? '' : 'opacity-70'}`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words text-sm font-semibold text-text-primary">{r.name}</h3>
                    <Pill className={r.is_active ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}>
                      {r.is_active ? 'Active' : 'Paused'}
                    </Pill>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">{describeRule(r)}</p>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <Button variant="secondary" size="sm" onClick={() => onToggle(r)} disabled={busyId === r.id}>
                    {busyId === r.id && <Loader2 size={14} className="animate-spin" />}
                    {r.is_active ? 'Pause' : 'Resume'}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => onEdit(r)} disabled={busyId === r.id}>
                    <Pencil size={14} /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(r)}
                    disabled={busyId === r.id}
                    className="hover:text-danger"
                    aria-label={`Delete ${r.name}`}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </motion.li>
          ))}
        </ul>
      )}

      {rules.length > 0 && <RulePreview rules={rules} />}
    </div>
  );
}

// ============================================================
// PAYOUTS
// ============================================================

const PAYOUT_TABS: { key: PayoutFilter; label: string }[] = [
  { key: 'to_pay', label: 'To pay' },
  { key: 'pending', label: 'Pending' },
  { key: 'paid', label: 'Paid' },
  { key: 'all', label: 'All' },
];

function PayoutDialog({
  count,
  summary,
  initialMethod,
  onClose,
  onConfirm,
}: {
  count: number;
  summary: string;
  initialMethod: PayoutMethod;
  onClose: () => void;
  onConfirm: (method: PayoutMethod, note: string) => Promise<void>;
}) {
  const uid = useId();
  const [method, setMethod] = useState<PayoutMethod>(initialMethod);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(method, note);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the payout.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Record payout" onClose={onClose} busy={submitting}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-primary">
          {count} referral{count === 1 ? '' : 's'} · {summary}
        </p>
        <SelectField
          id={`${uid}-method`}
          label="How was it paid?"
          value={method}
          options={PAYOUT_METHOD_OPTIONS}
          onChange={setMethod}
        />
        <Textarea
          label="Note (optional)"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          helperText="For example a check number or the credit memo reference."
        />
        <p className="text-xs text-text-secondary">
          This records the payout in your ledger. It does not move money or change an invoice by itself.
        </p>
        {error && (
          <p role="alert" className="flex items-start gap-2 text-sm text-danger">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            Record payout
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PayoutsTab({
  conversions,
  onPay,
  onVoid,
}: {
  conversions: ConversionDetail[];
  onPay: (ids: string[]) => void;
  onVoid: (c: ConversionDetail) => void;
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<PayoutFilter>('to_pay');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const counts = useMemo(() => countConversionTabs(conversions), [conversions]);
  const visible = useMemo(() => filterConversions(conversions, { tab: filter, query }), [conversions, filter, query]);
  const payableVisible = useMemo(() => visible.filter(isPayable), [visible]);

  // Drop selections that are no longer payable (after a payout or a refresh).
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set(conversions.filter(isPayable).map((c) => c.id));
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [conversions]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size >= MAX_PAYOUT_BATCH) toast(`You can pay up to ${MAX_PAYOUT_BATCH} referrals at once.`, 'error');
      else next.add(id);
      return next;
    });

  const allSelected = payableVisible.length > 0 && payableVisible.every((c) => selected.has(c.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(payableVisible.slice(0, MAX_PAYOUT_BATCH).map((c) => c.id)));

  const selectedRows = conversions.filter((c) => selected.has(c.id));
  const totals = sumPayable(selectedRows);

  if (conversions.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="No referral activity yet"
        description="When a referred customer books and pays, the conversion and its reward appear here, ready to pay out."
      />
    );
  }

  return (
    <div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="group"
          aria-label="Filter referrals"
          className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1"
        >
          {PAYOUT_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={filter === t.key}
              onClick={() => setFilter(t.key)}
              className={`focus-ring shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label} <span className="opacity-70">{counts[t.key]}</span>
            </button>
          ))}
        </div>
        <div className="w-full lg:max-w-xs">
          <Input
            icon={Search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search referrals"
            aria-label="Search referrals"
          />
        </div>
      </div>

      {payableVisible.length > 0 && (
        <label className="mt-4 flex items-center gap-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          Select all ({Math.min(payableVisible.length, MAX_PAYOUT_BATCH)})
        </label>
      )}

      <div className="mt-4">
        {visible.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={
              query.trim()
                ? 'No referrals match your search'
                : filter === 'to_pay'
                  ? 'Nothing to pay right now'
                  : 'Nothing here yet'
            }
            description={
              query.trim()
                ? 'Try a different name or code.'
                : filter === 'to_pay'
                  ? 'Converted referrals with a reward will show up here.'
                  : 'Switch the filter to see other referrals.'
            }
            action={query.trim() ? { label: 'Clear search', onClick: () => setQuery('') } : undefined}
          />
        ) : (
          <ul className="space-y-3">
            {visible.map((c) => {
              const payable = isPayable(c);
              return (
                <li key={c.id} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    {payable && (
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                        aria-label={`Select referral from ${referrerLabel(c)}`}
                        className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-accent"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words text-sm font-semibold text-text-primary">
                          {referrerLabel(c)} <span className="font-normal text-text-secondary">referred</span>{' '}
                          {c.referred_name ?? 'a new customer'}
                        </h3>
                        <Pill
                          className={
                            c.status === 'rewarded'
                              ? 'bg-success-500/10 text-success-500'
                              : c.status === 'converted'
                                ? 'bg-accent/10 text-accent'
                                : 'bg-bg-tertiary text-text-secondary'
                          }
                        >
                          {c.status === 'rewarded' ? 'Paid' : c.status === 'converted' ? 'Converted' : 'Pending'}
                        </Pill>
                      </div>
                      <p className="mt-1.5 text-xs text-text-secondary">
                        {c.reward_type && c.reward_value !== null
                          ? formatReward(c.reward_type, c.reward_value)
                          : c.status === 'pending'
                            ? 'Reward is set when the referred customer pays'
                            : 'No reward set. Add a rule to reward future referrals'}
                        {c.qualifying_amount ? ` · customer paid ${formatMoney(c.qualifying_amount)}` : ''}
                        {c.converted_at ? ` · converted ${formatDate(c.converted_at)}` : ` · started ${formatDate(c.created_at)}`}
                      </p>
                      {c.status === 'rewarded' && c.payout_paid_at && (
                        <p className="mt-1 text-xs text-text-secondary">
                          Paid {formatDate(c.payout_paid_at)}
                          {c.payout_method ? ` via ${PAYOUT_METHOD_LABELS[c.payout_method]}` : ''}
                        </p>
                      )}
                    </div>
                    {c.status === 'rewarded' && c.payout_id && (
                      <Button variant="ghost" size="sm" onClick={() => onVoid(c)} className="shrink-0 hover:text-danger">
                        Void
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky bottom-3 mt-4 flex flex-col gap-3 rounded-2xl border border-border bg-bg-secondary p-3 shadow-xl sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <p className="text-sm text-text-primary">
            <strong>{selected.size}</strong> selected · {formatMoney(totals.cash)}
            {totals.discounts > 0 && ` + ${totals.discounts} discount${totals.discounts === 1 ? '' : 's'}`}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" onClick={() => onPay([...selected])}>
              Record payout
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ReferralsPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_billing;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const [tab, setTab] = useState<TabKey>('leaderboard');
  const [board, setBoard] = useState<LeaderboardRow[]>([]);
  const [rules, setRules] = useState<RewardRule[]>([]);
  const [conversions, setConversions] = useState<ConversionDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const [newLinkOpen, setNewLinkOpen] = useState(false);
  const [ruleDialog, setRuleDialog] = useState<{ rule: RewardRule | null } | null>(null);
  const [deletingRule, setDeletingRule] = useState<RewardRule | null>(null);
  const [ruleBusyId, setRuleBusyId] = useState<string | null>(null);
  const [payoutIds, setPayoutIds] = useState<string[] | null>(null);
  const [voiding, setVoiding] = useState<ConversionDetail | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!accountOwnerId || !canAccess) return;
      const requestId = ++requestRef.current;
      if (!silent) setLoading(true);
      setLoadError(null);
      try {
        const [boardRows, ruleRows, conversionRows] = await Promise.all([
          fetchLeaderboard(null),
          fetchRules(accountOwnerId),
          fetchConversions(accountOwnerId),
        ]);
        if (requestId !== requestRef.current) return;
        setBoard(boardRows);
        setRules(ruleRows);
        setConversions(conversionRows);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load the referral program.');
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [accountOwnerId, canAccess],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarizeBoard(board), [board]);
  const activeRules = rules.filter((r) => r.is_active).length;
  const unpaidCount = useMemo(() => conversions.filter(isPayable).length, [conversions]);

  // ----- rules -----
  const handleSaveRule = async (values: RuleFormValues, existing: RewardRule | null) => {
    if (!accountOwnerId) return;
    const payload = ruleToPayload(values);
    const saved = existing
      ? await updateRule(accountOwnerId, existing.id, payload)
      : await createRule(accountOwnerId, payload);
    setRules((prev) => sortRules(existing ? prev.map((r) => (r.id === saved.id ? saved : r)) : [...prev, saved]));
  };

  const handleToggleRule = async (rule: RewardRule) => {
    if (!accountOwnerId) return;
    setRuleBusyId(rule.id);
    try {
      const saved = await updateRule(accountOwnerId, rule.id, { is_active: !rule.is_active });
      setRules((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
      toast(saved.is_active ? 'Rule resumed' : 'Rule paused', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update this rule', 'error');
    } finally {
      setRuleBusyId(null);
    }
  };

  const handleDeleteRule = async () => {
    const target = deletingRule;
    if (!target || !accountOwnerId) return;
    try {
      await deleteRule(accountOwnerId, target.id);
      setRules((prev) => prev.filter((r) => r.id !== target.id));
      toast('Rule deleted', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete this rule', 'error');
    } finally {
      setDeletingRule(null);
    }
  };

  // ----- payouts -----
  const payoutRows = useMemo(
    () => (payoutIds ? conversions.filter((c) => payoutIds.includes(c.id)) : []),
    [conversions, payoutIds],
  );

  const handleConfirmPayout = async (method: PayoutMethod, note: string) => {
    if (!payoutIds) return;
    await recordPayouts(payoutIds, method, note);
    toast(`${payoutIds.length} payout${payoutIds.length === 1 ? '' : 's'} recorded`, 'success');
    setPayoutIds(null);
    await load(true);
  };

  const handleVoid = async () => {
    const target = voiding;
    if (!target?.payout_id) return;
    try {
      await voidPayout(target.payout_id);
      toast('Payout voided. The referral is back in To pay.', 'success');
      await load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not void this payout', 'error');
    } finally {
      setVoiding(null);
    }
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Referrals">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Referral rewards and payouts are restricted. Ask your account owner to grant you the "View Billing"
            permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Referrals">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Gift size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Referrals</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Turn happy customers into your best sales channel: links, rewards and payouts in one place.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => setNewLinkOpen(true)} disabled={!accountOwnerId} className="w-full sm:w-auto">
            <Plus size={16} /> New referral link
          </Button>
        </div>

        <div className="mt-6">
          {loading ? (
            <div className="space-y-6">
              <SkeletonStatGrid count={4} />
              <SkeletonCardList count={3} rows={2} />
            </div>
          ) : loadError ? (
            <ErrorPanel message={loadError} onRetry={() => void load()} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Tile label="Referral links" value={String(summary.links)} />
                <Tile label="Clicks" value={String(summary.clicks)} />
                <Tile
                  label="Conversions"
                  value={String(summary.conversions)}
                  hint={summary.rate === null ? undefined : `${summary.rate}% of clicks`}
                />
                <Tile
                  label="Rewards to pay"
                  value={formatMoney(summary.unpaid)}
                  hint={unpaidCount > 0 ? `${unpaidCount} referral${unpaidCount === 1 ? '' : 's'} waiting` : 'All paid'}
                />
              </div>

              {activeRules === 0 && (
                <div
                  role="status"
                  className="mt-4 flex flex-col gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <p className="flex items-start gap-2 text-sm text-text-primary">
                    <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
                    No active reward rule. Referrals will convert, but earn nothing until you add one.
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => setTab('rules')}>
                    Set up rewards
                  </Button>
                </div>
              )}

              <div
                role="tablist"
                aria-label="Referral program sections"
                className="mt-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1"
              >
                {TABS.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    id={`ref-tab-${key}`}
                    aria-selected={tab === key}
                    aria-controls="ref-panel"
                    onClick={() => setTab(key)}
                    className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${
                      tab === key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>

              <div id="ref-panel" role="tabpanel" aria-labelledby={`ref-tab-${tab}`} className="mt-5">
                {tab === 'leaderboard' && (
                  <LeaderboardTab allTimeRows={board} onNewLink={() => setNewLinkOpen(true)} />
                )}
                {tab === 'links' && <LinksTab rows={board} rules={rules} onNewLink={() => setNewLinkOpen(true)} />}
                {tab === 'rules' && (
                  <RulesTab
                    rules={rules}
                    busyId={ruleBusyId}
                    onAdd={() => setRuleDialog({ rule: null })}
                    onEdit={(rule) => setRuleDialog({ rule })}
                    onToggle={(rule) => void handleToggleRule(rule)}
                    onDelete={setDeletingRule}
                  />
                )}
                {tab === 'payouts' && (
                  <PayoutsTab conversions={conversions} onPay={setPayoutIds} onVoid={setVoiding} />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {newLinkOpen && accountOwnerId && (
        <NewLinkDialog
          ownerId={accountOwnerId}
          existing={board}
          onClose={() => setNewLinkOpen(false)}
          onCreated={() => {
            setTab('links');
            void load(true);
          }}
        />
      )}

      {ruleDialog && (
        <RuleDialog
          key={ruleDialog.rule?.id ?? 'new'}
          rule={ruleDialog.rule}
          onClose={() => setRuleDialog(null)}
          onSave={handleSaveRule}
        />
      )}

      {payoutIds && payoutRows.length > 0 && (
        <PayoutDialog
          count={payoutRows.length}
          summary={(() => {
            const t = sumPayable(payoutRows);
            return `${formatMoney(t.cash)}${t.discounts > 0 ? ` + ${t.discounts} discount${t.discounts === 1 ? '' : 's'}` : ''}`;
          })()}
          initialMethod={defaultMethodFor(
            payoutRows.map((c) => c.reward_type).filter((t): t is NonNullable<typeof t> => t !== null),
          )}
          onClose={() => setPayoutIds(null)}
          onConfirm={handleConfirmPayout}
        />
      )}

      <ConfirmDialog
        open={deletingRule !== null}
        title="Delete this reward rule?"
        description={`"${deletingRule?.name ?? ''}" will stop applying to new referrals. Past conversions keep the reward they already earned.`}
        confirmLabel="Yes, delete rule"
        onConfirm={handleDeleteRule}
        onCancel={() => setDeletingRule(null)}
      />

      <ConfirmDialog
        open={voiding !== null}
        title="Void this payout?"
        description="The referral goes back to To pay and the payout stays in the ledger as voided. Use this if the reward was recorded by mistake."
        confirmLabel="Yes, void payout"
        onConfirm={handleVoid}
        onCancel={() => setVoiding(null)}
      />
    </DashboardLayout>
  );
}
