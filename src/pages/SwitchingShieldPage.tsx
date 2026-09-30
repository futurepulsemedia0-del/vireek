import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ShieldAlert, RefreshCw, Phone, MessageSquare, Check, X, Settings2, Sparkles, Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  ShieldCase, ShieldAction, ShieldSettings, ShieldOutcome, ShieldOfferType,
  SIGNAL_LABELS, OFFER_LABELS, ALL_OFFERS, LEVEL_LABELS, LEVEL_BADGE, LEVEL_BAR,
  isActiveCase, formatUsd, daysAgo,
  fetchShieldCases, fetchShieldSettings, saveShieldSettings, scanNow, regeneratePlan,
  executeAction, closeCase, rejectAction, setActionOutcome,
} from '@/lib/switchingShield';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
const ghostBtn =
  'focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50';
const primaryBtn =
  'focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110 disabled:opacity-50';

type Filter = 'active' | 'saved' | 'closed' | 'all';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'saved', label: 'Saved' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const REASONS: Record<string, string> = {
  A2P_NOT_APPROVED: 'Texting is not approved yet for this account (A2P registration).',
  OPTED_OUT: 'This customer has opted out of texts.',
  NOT_CONFIGURED: 'SMS is not configured.',
  TWILIO_ERROR: 'The SMS provider rejected the message.',
};

function ActionRow({ action, phone, onDone }: { action: ShieldAction; phone: string | null; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [text, setText] = useState(action.message);
  const [busy, setBusy] = useState(false);
  const isCall = action.channel === 'call_task';
  const pending = action.status === 'proposed';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); await onDone(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  const approve = () => run(async () => {
    const r = await executeAction(action.id, isCall ? undefined : text);
    if (!r.ok) throw new Error(REASONS[r.reason ?? ''] ?? 'Could not send.');
    toast(isCall ? 'Call logged.' : 'Message sent.');
  });

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
          {isCall ? <Phone size={14} /> : <MessageSquare size={14} />} {OFFER_LABELS[action.offer_type]}
          {action.offer_type === 'discount' && typeof action.terms.percent === 'number' ? ` · ${action.terms.percent}% off` : ''}
        </p>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] capitalize text-text-secondary">{action.status}</span>
      </div>
      {action.rationale && <p className="mt-1 text-[11px] text-text-secondary">{action.rationale}</p>}

      {pending ? (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={isCall ? 2 : 3} maxLength={480} className={`${inputClass} mt-2`} aria-label={isCall ? 'Call objective' : 'Message to customer'} />
          {action.error && <p className="mt-1 text-[11px] text-danger">{REASONS[action.error] ?? action.error}</p>}
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => run(async () => { await rejectAction(action.id); })} className={ghostBtn}>
              <X size={12} /> Reject
            </button>
            {isCall && phone && (
              <a href={`tel:${phone}`} className={ghostBtn}><Phone size={12} /> Call {phone}</a>
            )}
            <button type="button" disabled={busy || !text.trim()} onClick={approve} className={primaryBtn}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {isCall ? 'Mark call done' : 'Approve & send'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 whitespace-pre-wrap text-xs text-text-secondary">{action.message}</p>
          {(action.status === 'sent' || action.status === 'completed') && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-secondary">Customer response:</span>
              {(['accepted', 'declined', 'no_response'] as ShieldOutcome[]).map((o) => (
                <button key={o} type="button" disabled={busy}
                  onClick={() => run(async () => { await setActionOutcome(action.id, o); })}
                  className={`focus-ring rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors ${action.outcome === o ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
                  {o.replace('_', ' ')}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CaseCard({ c, onChange }: { c: ShieldCase; onChange: () => Promise<void> }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const active = isActiveCase(c);
  const name = c.customers?.name ?? 'Unknown customer';

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await onChange(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/dashboard/customers/${c.customer_id}`} className="text-base font-semibold text-text-primary hover:underline">{name}</Link>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_BADGE[c.risk_level]}`}>{LEVEL_LABELS[c.risk_level]}</span>
            {!active && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] capitalize text-text-secondary">{c.status.replace('_', ' ')}</span>}
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Lifetime value {formatUsd(c.customer_value_cents)} · detected {daysAgo(c.first_detected_at)}
            {c.customers?.phone ? ` · ${c.customers.phone}` : ''}
          </p>
        </div>
        <div className="w-40 shrink-0">
          <div className="flex items-baseline justify-between text-xs text-text-secondary">
            <span>Switch risk</span><span className="text-lg font-semibold text-text-primary">{c.risk_score}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="meter" aria-valuenow={c.risk_score} aria-valuemin={0} aria-valuemax={100} aria-label="Switch risk score">
            <div className={`h-full rounded-full ${LEVEL_BAR[c.risk_level]}`} style={{ width: `${c.risk_score}%` }} />
          </div>
        </div>
      </div>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {c.signals.map((s) => (
          <li key={s.type} title={s.detail} className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary">
            {SIGNAL_LABELS[s.type] ?? s.type}{s.count > 1 ? ` ×${s.count}` : ''} <span className="font-medium text-text-primary">+{s.points}</span>
          </li>
        ))}
      </ul>

      {c.narrative && (
        <p className="mt-3 flex gap-2 text-sm text-text-primary">
          <Sparkles size={14} className="mt-0.5 shrink-0 text-accent" /> <span>{c.narrative}</span>
        </p>
      )}
      {c.talk_track && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-text-secondary hover:text-text-primary">Manager talk track</summary>
          <p className="mt-2 whitespace-pre-wrap rounded-xl bg-bg-primary p-3 text-xs text-text-secondary">{c.talk_track}</p>
        </details>
      )}

      {c.switching_shield_actions.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium text-text-secondary">Save plan — nothing reaches the customer until you approve it</p>
          {c.switching_shield_actions.map((a) => (
            <ActionRow key={a.id} action={a} phone={c.customers?.phone ?? null} onDone={onChange} />
          ))}
        </div>
      )}
      {active && !c.plan_generated_at && (
        <p className="mt-3 text-xs text-text-secondary">The Save Customer Agent is preparing a plan for this customer…</p>
      )}

      {active && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-3">
          <button type="button" disabled={busy} onClick={() => run(() => regeneratePlan(c.id), 'Plan refreshed.')} className={ghostBtn}>
            <RefreshCw size={12} /> Regenerate plan
          </button>
          <button type="button" disabled={busy} onClick={() => run(() => closeCase(c.id, 'dismissed'), 'Dismissed.')} className={ghostBtn}>Dismiss</button>
          <button type="button" disabled={busy} onClick={() => run(() => closeCase(c.id, 'lost'), 'Marked lost.')} className={`${ghostBtn} hover:!text-danger`}>Mark lost</button>
          <button type="button" disabled={busy} onClick={() => run(() => closeCase(c.id, 'saved'), 'Customer saved.')} className={primaryBtn}>
            <Check size={12} /> Mark saved
          </button>
        </div>
      )}
    </motion.div>
  );
}

function SettingsPanel({ settings, onSaved }: { settings: ShieldSettings; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const [s, setS] = useState(settings);
  const [saving, setSaving] = useState(false);
  const num = (k: keyof ShieldSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  const valid = s.watch_threshold < s.at_risk_threshold && s.at_risk_threshold < s.critical_threshold;

  const toggleOffer = (o: ShieldOfferType) =>
    setS({ ...s, enabled_offers: s.enabled_offers.includes(o) ? s.enabled_offers.filter((x) => x !== o) : [...s.enabled_offers, o] });

  const save = async () => {
    setSaving(true);
    try {
      const { user_id, ...patch } = s;
      await saveShieldSettings(user_id, patch);
      toast('Settings saved.');
      await onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  const field = (label: string, k: keyof ShieldSettings, min: number, max: number) => (
    <label className="block text-xs text-text-secondary">
      {label}
      <input type="number" min={min} max={max} value={Number(s[k])} onChange={num(k)} className={`${inputClass} mt-1`} />
    </label>
  );

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Shield enabled
      </label>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {field('Watch at score', 'watch_threshold', 1, 99)}
        {field('At risk at score', 'at_risk_threshold', 2, 99)}
        {field('Critical at score', 'critical_threshold', 3, 100)}
        {field('Look-back (days)', 'lookback_days', 30, 365)}
        {field('Re-open cooldown (days)', 'case_cooldown_days', 0, 180)}
        {field('Max discount (%)', 'max_discount_percent', 0, 50)}
      </div>
      <p className="mt-4 text-xs font-medium text-text-secondary">Offers the agent may propose</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {ALL_OFFERS.map((o) => (
          <button key={o} type="button" onClick={() => toggleOffer(o)} aria-pressed={s.enabled_offers.includes(o)}
            className={`focus-ring rounded-full px-3 py-1 text-xs transition-colors ${s.enabled_offers.includes(o) ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}>
            {OFFER_LABELS[o]}
          </button>
        ))}
      </div>
      {!valid && <p className="mt-3 text-xs text-danger">Thresholds must increase: watch &lt; at risk &lt; critical.</p>}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={save} disabled={saving || !valid} className={primaryBtn}>
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save settings
        </button>
      </div>
    </div>
  );
}

export function SwitchingShieldPage() {
  const { toast } = useToast();
  const [cases, setCases] = useState<ShieldCase[]>([]);
  const [settings, setSettings] = useState<ShieldSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([fetchShieldCases(), fetchShieldSettings()]);
      setCases(c);
      setSettings(s);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await scanNow();
      toast(r.skipped ? 'The Shield is switched off in settings.' : `Scan complete — ${r.opened ?? 0} new case${r.opened === 1 ? '' : 's'}.`, r.skipped ? 'info' : 'success');
      await load();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setScanning(false); }
  };

  const stats = useMemo(() => {
    const active = cases.filter(isActiveCase);
    const cutoff = Date.now() - 90 * 86_400_000;
    const recentClosed = cases.filter((c) => (c.status === 'saved' || c.status === 'lost') && c.closed_at && new Date(c.closed_at).getTime() >= cutoff);
    const saved = recentClosed.filter((c) => c.status === 'saved');
    return {
      active: active.length,
      critical: active.filter((c) => c.risk_level === 'critical').length,
      atRisk: active.reduce((sum, c) => sum + c.customer_value_cents, 0),
      saved: saved.length,
      savedValue: saved.reduce((sum, c) => sum + c.customer_value_cents, 0),
      rate: recentClosed.length ? Math.round((saved.length / recentClosed.length) * 100) : null,
    };
  }, [cases]);

  const visible = useMemo(() => cases.filter((c) => {
    if (filter === 'all') return true;
    if (filter === 'active') return isActiveCase(c);
    if (filter === 'saved') return c.status === 'saved';
    return c.status === 'lost' || c.status === 'dismissed' || c.status === 'cleared';
  }), [cases, filter]);

  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: 'Active cases', value: String(stats.active), sub: `${stats.critical} critical` },
    { label: 'Lifetime value at risk', value: formatUsd(stats.atRisk) },
    { label: 'Saved (90 days)', value: String(stats.saved), sub: stats.savedValue ? `${formatUsd(stats.savedValue)} retained` : undefined },
    { label: 'Save rate (90 days)', value: stats.rate === null ? '—' : `${stats.rate}%` },
  ];

  return (
    <DashboardLayout activeLabel="Switching Shield">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-primary"><ShieldAlert size={22} /> Customer Switching Shield</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Predicts which customers are about to leave from their booking, complaint, price, response, satisfaction, service and competitor signals — then drafts a save plan for you to approve.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowSettings((v) => !v)} className={`${ghostBtn} border border-border`} aria-expanded={showSettings}>
              <Settings2 size={13} /> Settings
            </button>
            <button type="button" onClick={scan} disabled={scanning} className={primaryBtn}>
              {scanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Scan now
            </button>
          </div>
        </div>

        {showSettings && settings && <SettingsPanel settings={settings} onSaved={load} />}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="text-xs text-text-secondary">{t.label}</p>
              <p className="mt-1 text-2xl font-semibold text-text-primary">{t.value}</p>
              {t.sub && <p className="text-[11px] text-text-secondary">{t.sub}</p>}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}
              className={`focus-ring rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'}`}>
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-text-secondary"><Loader2 className="animate-spin" size={20} /></div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-text-secondary">
            {filter === 'active'
              ? 'No customers are showing switching signals right now. Press “Scan now” to re-check.'
              : 'Nothing here yet.'}
          </div>
        ) : (
          <div className="space-y-4">
            {visible.map((c) => <CaseCard key={c.id} c={c} onChange={load} />)}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
