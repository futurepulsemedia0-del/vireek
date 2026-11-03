import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, BookOpenCheck, CalendarClock, Check, ChevronDown, ChevronUp, FlaskConical, History, Lock, Play,
  RotateCcw, Share2, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { formatDateTime } from '@/lib/format';
import {
  GOAL_LABELS, PLAYBOOKS, TRADES, SEASONS, GOALS, REASON_TEXT, activate, approveItem, confirmActivation, defaultEnabledIds,
  deleteCustomPlaybook, fetchActivationItems, fetchActivations, fetchAudit, fetchCurrentState, fetchCustomPlaybooks, fetchSettings,
  filterPlaybooks, previewFor, requiresApproval, rollbackActivation, saveCustomPlaybook, shareCustomPlaybook, suggestPlaybooks,
  updateSettings, findPlaybook,
  type ActivationItemRow, type ActivationRow, type AuditRow, type CurrentState, type CustomPlaybookRow, type DiffRow, type Playbook,
  type RpcResult, type TradeKey,
} from '@/lib/playbookLibrary';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark';
const BTN = 'focus-ring flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50';
const BTN_PRIMARY = 'focus-ring flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50';
const SELECT = 'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

const DIFF_TONE: Record<DiffRow['status'], string> = {
  will_change: 'bg-accent/10 text-accent', no_change: 'bg-bg-tertiary text-text-secondary', needs_approval: 'bg-warning-500/10 text-warning-500',
  advisory: 'bg-bg-tertiary text-text-secondary', blocked: 'bg-danger/10 text-danger', inactive: 'bg-warning-500/10 text-warning-500',
};
const DIFF_LABEL: Record<DiffRow['status'], string> = {
  will_change: 'Will change', no_change: 'No change', needs_approval: 'Needs approval', advisory: 'Recommendation', blocked: 'Blocked', inactive: 'No effect yet',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function impactLine(pb: Playbook): string {
  const i = pb.impact[0];
  if (!i) return '';
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return `${i.metric}: ${sign(i.lowPct)}% to ${sign(i.highPct)}% (planning estimate)`;
}

// ------------------------------------------------------------------ gallery card

function PlaybookCard({ pb, reason, onOpen, live }: { pb: Playbook; reason?: string; onOpen: () => void; live: boolean }) {
  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{pb.name}</h3>
        {live && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Live</span>}
      </div>
      <p className="mt-1 text-xs text-text-secondary">{pb.tagline}</p>
      {reason && <p className="mt-2 rounded-lg bg-accent/[0.07] px-2 py-1 text-xs text-accent">{reason}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {pb.trades.map((t) => <span key={t} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{t === 'all' ? 'All trades' : cap(t)}</span>)}
        {pb.seasons.map((s) => <span key={s} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{s === 'any' ? 'Year-round' : cap(s)}</span>)}
      </div>
      <p className="mt-3 text-[11px] text-text-secondary">{impactLine(pb)}</p>
      <button type="button" onClick={onOpen} className={`${BTN} mt-4 w-full`}><Play size={14} /> Preview and activate</button>
    </div>
  );
}

// ------------------------------------------------------------------ activation drawer

function itemDetail(it: Playbook['items'][number]): string {
  const p = it.params as unknown as Record<string, unknown>;
  switch (it.kind) {
    case 'call_script': return `${String(p.opening_line ?? '')}\n\n${String(p.body ?? '')}`.trim();
    case 'surge': return `${String(p.message)}\n\nPriority: ${String(p.priority)}`;
    case 'message_template': return `${p.subject ? `Subject: ${String(p.subject)}\n\n` : ''}${String(p.body)}`;
    case 'advisory': return String(p.detail);
    case 'closure': return `${String(p.label)}: ${String(p.message)}`;
    case 'escalation_rule': return `${String(p.trigger)} -> ${String(p.action)} to the account owner's phone. ${String(p.note ?? '')}`;
    case 'capacity': return Object.entries(p).map(([k, v]) => `${k}: ${String(v)}`).join('\n');
    case 'automation': return `Makes sure the "${String(p.slug)}" automation is not paused.`;
    default: return '';
  }
}

function Drawer({ pb, state, custom, isOwner, onClose, onDone }: {
  pb: Playbook; state: CurrentState; custom: CustomPlaybookRow | null; isOwner: boolean; onClose: () => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState<string[]>(() => defaultEnabledIds(pb));
  const [open, setOpen] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date()));
  const [endsAt, setEndsAt] = useState(() => toLocalInput(new Date(Date.now() + pb.defaultDurationHours * 3_600_000)));
  const [mode, setMode] = useState<'now' | 'schedule'>('now');
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<RpcResult | null>(null);

  const start = mode === 'now' ? new Date() : new Date(startsAt);
  const end = new Date(endsAt);
  const valid = !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime());
  const preview = useMemo(() => (valid ? previewFor(pb, enabled, state, start, end) : null), [pb, enabled, state, valid, startsAt, endsAt, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const diffById = new Map((preview?.diff ?? []).map((d) => [d.itemId, d] as const));
  const blocked = (preview?.diff ?? []).filter((d) => d.status === 'blocked');
  const blockedByViolations = (preview?.violations.length ?? 0) > 0;
  const ownerOnlyNeeded = !isOwner && pb.items.some((i) => enabled.includes(i.id) && ['capacity', 'after_hours_fee', 'automation'].includes(i.kind));

  const toggle = (id: string) => { setServer(null); setEnabled((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id])); };

  const run = async (m: 'now' | 'schedule' | 'dry_run') => {
    if (!valid || enabled.length === 0) return;
    setBusy(true);
    try {
      const r = await activate({ playbook: pb, enabledItemIds: enabled, mode: m, startsAt: m === 'schedule' ? start : null, endsAt: end, customId: custom?.id ?? null });
      if (m === 'dry_run') { setServer(r); return; }
      if (r.status === 'active') { toast(`${pb.name} is now active.`, 'success'); onDone(); return; }
      if (r.status === 'scheduled') { toast(`${pb.name} is scheduled.`, 'success'); onDone(); return; }
      if (r.status === 'pending_approval' || r.status === 'owner_required') { toast('Saved. The account owner needs to approve it.', 'info'); onDone(); return; }
      setServer(r);
      toast(r.error ?? REASON_TEXT[r.status] ?? 'Could not activate this playbook.', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not activate this playbook.', 'error');
    } finally { setBusy(false); }
  };

  const saveCopy = async () => {
    setBusy(true);
    try {
      const ckey = (pb.key.startsWith('custom-') ? pb.key : `custom-${pb.key}`).slice(0, 55);
      const copy: Playbook = { ...pb, key: ckey as Playbook['key'], name: pb.name.endsWith('(custom)') ? pb.name : `${pb.name} (custom)`, items: pb.items.filter((i) => enabled.includes(i.id)) };
      const r = await saveCustomPlaybook(ckey, copy);
      toast(r.status === 'ok' ? 'Saved to My playbooks.' : (r.error ?? 'Could not save.'), r.status === 'ok' ? 'success' : 'error');
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save.', 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={pb.name}>
      <div className="flex max-h-[95vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-primary sm:max-w-3xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-4 sm:p-5">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{pb.name}</h2>
            <p className="mt-0.5 text-xs text-text-secondary">{pb.whenToUse}</p>
          </div>
          <button type="button" onClick={onClose} className={`${BTN} !px-2 !py-2`} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="space-y-5 overflow-y-auto p-4 sm:p-5">
          {pb.impact.length > 0 && (
            <div className="rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
              <p className="font-medium text-text-primary">Estimated impact (planning ranges, not guarantees)</p>
              {pb.impact.map((i) => (
                <div key={i.metric} className="mt-2">
                  <p>{i.metric}: {i.lowPct > 0 ? '+' : ''}{i.lowPct}% to {i.highPct > 0 ? '+' : ''}{i.highPct}%</p>
                  <p className="text-[11px]">Assumes: {i.assumptions.join('; ')}.</p>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-text-secondary">Start
              <select className={`${SELECT} mt-1 w-full`} value={mode} onChange={(e) => { setServer(null); setMode(e.target.value as 'now' | 'schedule'); }}>
                <option value="now">Now</option><option value="schedule">Schedule for later</option>
              </select>
            </label>
            {mode === 'schedule' && (
              <label className="text-xs text-text-secondary">Starts at
                <input type="datetime-local" className={`${SELECT} mt-1 w-full`} value={startsAt} onChange={(e) => { setServer(null); setStartsAt(e.target.value); }} />
              </label>
            )}
            <label className="text-xs text-text-secondary">Ends automatically at
              <input type="datetime-local" className={`${SELECT} mt-1 w-full`} value={endsAt} onChange={(e) => { setServer(null); setEndsAt(e.target.value); }} />
            </label>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-text-primary">What this changes ({enabled.length} of {pb.items.length} on)</p>
            <ul className="space-y-2">
              {pb.items.map((it) => {
                const on = enabled.includes(it.id);
                const row = diffById.get(it.id);
                const isOpen = open === it.id;
                return (
                  <li key={it.id} className="rounded-xl border border-border bg-bg-secondary">
                    <div className="flex items-start gap-3 p-3">
                      <input type="checkbox" className="mt-1 h-4 w-4" checked={on} onChange={() => toggle(it.id)} aria-label={`Include ${it.title}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-text-primary">{it.title}</p>
                          {on && row && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${DIFF_TONE[row.status]}`}>{DIFF_LABEL[row.status]}</span>}
                          {requiresApproval(it) && <span className="flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] text-warning-500"><Lock size={10} /> Owner approval</span>}
                        </div>
                        <p className="mt-0.5 text-xs text-text-secondary">{it.why}</p>
                        {on && row && (
                          <p className="mt-1 text-xs text-text-secondary"><span className="font-medium">Now:</span> {row.before} <span className="mx-1">→</span> <span className="font-medium">After:</span> {row.after}</p>
                        )}
                        {on && row?.reason && <p className="mt-1 text-xs text-warning-500">{row.reason}</p>}
                      </div>
                      <button type="button" onClick={() => setOpen(isOpen ? null : it.id)} className="text-text-secondary" aria-label="Preview content">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
                    </div>
                    {isOpen && <pre className="mx-3 mb-3 whitespace-pre-wrap rounded-lg bg-bg-primary p-3 text-xs text-text-secondary">{itemDetail(it)}</pre>}
                  </li>
                );
              })}
            </ul>
          </div>

          {blockedByViolations && (
            <div className="rounded-xl border border-danger/30 bg-danger/[0.06] p-3 text-xs text-danger">
              <p className="flex items-center gap-1 font-medium"><AlertTriangle size={14} /> Safety checks failed</p>
              <ul className="mt-1 list-disc pl-4">{preview!.violations.map((v, i) => <li key={i}>{v.message}</li>)}</ul>
            </div>
          )}
          {blocked.length > 0 && (
            <div className="rounded-xl border border-danger/30 bg-danger/[0.06] p-3 text-xs text-danger">
              <p className="font-medium">Conflicts with an active playbook</p>
              <p>Roll back the other playbook or switch off the blocked items. Nothing is changed while a conflict exists.</p>
            </div>
          )}
          {ownerOnlyNeeded && <p className="rounded-xl bg-warning-500/10 p-3 text-xs text-warning-500">Some selected items change owner-only settings. You can submit this, and the account owner will approve it before it runs.</p>}

          {server && (
            <div className="rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
              <p className="flex items-center gap-1 font-medium text-text-primary"><FlaskConical size={14} /> {server.dry_run ? 'Dry run result (nothing was changed)' : 'Result'}: {server.status}</p>
              {server.error && <p className="mt-1">{server.error}</p>}
              {server.conflicts?.map((c) => <p key={c.item_id + c.surface} className="mt-1">{c.item_id} conflicts with “{c.playbook_name}” ({c.surface}).</p>)}
              {server.items?.map((i) => <p key={i.item_id} className="mt-1">{i.item_id}: {i.status}{i.note ? ` — ${i.note}` : ''}</p>)}
            </div>
          )}

          <p className="flex items-start gap-2 text-[11px] text-text-secondary"><ShieldCheck size={14} className="mt-0.5 shrink-0" /> {pb.rollback} {pb.compliance.join(' ')}</p>
        </div>

        <div className="flex flex-col gap-2 border-t border-border p-4 sm:flex-row sm:flex-wrap sm:justify-end sm:p-5">
          <button type="button" className={BTN} disabled={busy} onClick={saveCopy}><Share2 size={14} /> Save as custom</button>
          <button type="button" className={BTN} disabled={busy || !valid || enabled.length === 0 || blockedByViolations} onClick={() => run('dry_run')}><FlaskConical size={14} /> Dry run</button>
          {mode === 'schedule'
            ? <button type="button" className={BTN_PRIMARY} disabled={busy || !valid || enabled.length === 0 || blockedByViolations || blocked.length > 0} onClick={() => run('schedule')}><CalendarClock size={14} /> Schedule</button>
            : <button type="button" className={BTN_PRIMARY} disabled={busy || !valid || enabled.length === 0 || blockedByViolations || blocked.length > 0} onClick={() => run('now')}><Play size={14} /> Activate now</button>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ active / history

function ActivationCard({ a, isOwner, onChanged }: { a: ActivationRow; isOwner: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [items, setItems] = useState<ActivationItemRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (a.status === 'active') fetchActivationItems(a.id).then(setItems).catch(() => setItems([])); }, [a.id, a.status]);

  const act = async (fn: () => Promise<RpcResult>, ok: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (['rolled_back', 'dismissed', 'active', 'scheduled', 'applied', 'advisory', 'expired'].includes(r.status)) toast(ok, 'success');
      else toast(r.error ?? REASON_TEXT[r.status] ?? `Could not complete (${r.status}).`, 'error');
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); } finally { setBusy(false); }
  };

  const reason = typeof a.signal?.reason === 'string' ? a.signal.reason : null;
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{a.playbook_name}</h3>
          <p className="text-xs text-text-secondary">
            {a.status === 'active' && `Active until ${formatDateTime(a.ends_at)}`}
            {a.status === 'scheduled' && `Scheduled ${formatDateTime(a.starts_at)} to ${formatDateTime(a.ends_at)}`}
            {a.status === 'pending_approval' && 'Waiting for the account owner'}
            {a.status === 'suggested' && `Suggested. Expires ${formatDateTime(a.suggest_expires_at ?? a.ends_at)}`}
          </p>
          {reason && <p className="mt-1 text-xs text-accent">{reason}</p>}
        </div>
        <div className="flex gap-2">
          {(a.status === 'suggested' || a.status === 'pending_approval' || a.status === 'scheduled') && (
            <>
              <button type="button" className={BTN} disabled={busy} onClick={() => act(() => confirmActivation(a.id, true), 'Dry run finished, see the result in the Activity tab.')}><FlaskConical size={14} /> Dry run</button>
              <button type="button" className={BTN_PRIMARY} disabled={busy || (a.status === 'pending_approval' && !isOwner)} onClick={() => act(() => confirmActivation(a.id), 'Confirmed.')}><Check size={14} /> {a.status === 'suggested' ? 'Confirm' : 'Approve'}</button>
            </>
          )}
          <button type="button" className={BTN} disabled={busy} onClick={() => act(() => rollbackActivation(a.id), a.status === 'active' ? 'Rolled back.' : 'Dismissed.')}>
            <RotateCcw size={14} /> {a.status === 'active' ? 'Roll back' : 'Dismiss'}
          </button>
        </div>
      </div>
      {a.status === 'active' && (
        <ul className="mt-3 space-y-1.5">
          {(items ?? []).map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-primary px-3 py-2 text-xs">
              <span className="text-text-primary">{i.title} <span className="text-text-secondary">· {i.status.replace('_', ' ')}</span>{i.note ? <span className="text-text-secondary"> — {i.note}</span> : null}</span>
              {i.status === 'pending_approval' && isOwner && <button type="button" className={`${BTN} !px-3 !py-1.5`} disabled={busy} onClick={() => act(() => approveItem(i.id), 'Approved.')}>Approve</button>}
              {i.status === 'pending_approval' && !isOwner && <span className="text-text-secondary">Owner must approve</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page

type Tab = 'library' | 'active' | 'custom' | 'activity' | 'settings';

export function PlaybookLibraryPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'library';
  const canAccess = isOwner || permissions.can_edit_business_profile;

  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<(CurrentState & { trade: string | null }) | null>(null);
  const [acts, setActs] = useState<ActivationRow[]>([]);
  const [custom, setCustom] = useState<CustomPlaybookRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [settings, setSettings] = useState<{ suggestions_enabled: boolean; auto_apply_keys: string[] }>({ suggestions_enabled: true, auto_apply_keys: [] });
  const [error, setError] = useState<string | null>(null);
  const [trade, setTrade] = useState<TradeKey | 'any'>('any');
  const [season, setSeason] = useState('any');
  const [goal, setGoal] = useState('any');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<{ pb: Playbook; custom: CustomPlaybookRow | null } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [st, a, c, au, se] = await Promise.all([fetchCurrentState(), fetchActivations(), fetchCustomPlaybooks(), fetchAudit(40), fetchSettings()]);
      setState(st); setActs(a); setCustom(c); setAudit(au); setSettings(se);
      if (trade === 'any' && st.trade && (TRADES as readonly string[]).includes(st.trade)) setTrade(st.trade as TradeKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load playbooks.');
    } finally { setLoading(false); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (canAccess) void load(); else setLoading(false); }, [canAccess, load]);

  const liveKeys = acts.filter((a) => ['suggested', 'scheduled', 'pending_approval', 'active'].includes(a.status)).map((a) => a.playbook_key);
  const filtered = useMemo(() => filterPlaybooks(PLAYBOOKS, { trade, season, goal, q }), [trade, season, goal, q]);
  const seasonal = useMemo(() => state
    ? suggestPlaybooks({ trade: state.trade, now: new Date(), weather: [], calls: null, liveKeys, dismissedKeys: [] }) : [], [state, acts]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggested = acts.filter((a) => a.status === 'suggested');
  const current = acts.filter((a) => ['active', 'scheduled', 'pending_approval', 'suggested'].includes(a.status));

  const setTab = (t: Tab) => setParams(t === 'library' ? {} : { tab: t });
  const open = (pb: Playbook, c: CustomPlaybookRow | null = null) => setSelected({ pb, custom: c });
  const afterChange = () => { setSelected(null); void load(); };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'library', label: 'Library' }, { id: 'active', label: `Active${current.length ? ` (${current.length})` : ''}` },
    { id: 'custom', label: 'My playbooks' }, { id: 'activity', label: 'Activity' }, { id: 'settings', label: 'Settings' },
  ];

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Playbook Library">
        <div className={CARD}><p className="flex items-center gap-2 text-sm text-text-primary"><Lock size={16} /> You need permission to edit the business profile to manage playbooks.</p></div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Playbook Library">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary"><BookOpenCheck size={20} /> Playbook Library</h1>
        <p className="mt-1 text-sm text-text-secondary">One-click operating modes that change your scripts, rules, messages and capacity together. You see exactly what changes first, everything expires on its own, and one click rolls it back.</p>
      </div>

      <div className="mb-5 flex gap-1 overflow-x-auto" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
            className={`focus-ring whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary'}`}>{t.label}</button>
        ))}
      </div>

      {loading ? <SkeletonCardList count={3} /> : error ? (
        <div className={CARD}><p className="text-sm text-danger">{error}</p><button type="button" className={`${BTN} mt-3`} onClick={() => { setLoading(true); void load(); }}>Try again</button></div>
      ) : (
        <FadeIn>
          {tab === 'library' && state && (
            <div className="space-y-6">
              {(suggested.length > 0 || seasonal.length > 0) && (
                <section aria-label="Recommended now">
                  <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary"><Sparkles size={16} /> Recommended now</h2>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {suggested.map((a) => (
                      <div key={a.id} className={CARD}>
                        <h3 className="text-sm font-semibold text-text-primary">{a.playbook_name}</h3>
                        <p className="mt-1 text-xs text-accent">{typeof a.signal?.reason === 'string' ? a.signal.reason : 'Suggested from a live signal.'}</p>
                        <button type="button" className={`${BTN} mt-4 w-full`} onClick={() => setTab('active')}>Review and confirm</button>
                      </div>
                    ))}
                    {seasonal.filter((s) => !suggested.some((a) => a.playbook_key === s.key)).map((s) => {
                      const pb = findPlaybook(s.key); if (!pb) return null;
                      return <PlaybookCard key={s.key} pb={pb} reason={s.reason} live={liveKeys.includes(pb.key)} onOpen={() => open(pb)} />;
                    })}
                  </div>
                </section>
              )}

              <section aria-label="Filters" className="flex flex-wrap gap-2">
                <input className={`${SELECT} min-w-[10rem] flex-1`} placeholder="Search playbooks" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
                <select className={SELECT} value={trade} onChange={(e) => setTrade(e.target.value as TradeKey | 'any')} aria-label="Trade">
                  <option value="any">All trades</option>{TRADES.filter((t) => t !== 'all').map((t) => <option key={t} value={t}>{cap(t)}</option>)}
                </select>
                <select className={SELECT} value={season} onChange={(e) => setSeason(e.target.value)} aria-label="Season">
                  <option value="any">Any season</option>{SEASONS.filter((s) => s !== 'any').map((s) => <option key={s} value={s}>{cap(s)}</option>)}
                </select>
                <select className={SELECT} value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Goal">
                  <option value="any">Any goal</option>{GOALS.map((g) => <option key={g} value={g}>{GOAL_LABELS[g]}</option>)}
                </select>
              </section>

              {filtered.length === 0 ? (
                <div className={`${CARD} text-center`}><p className="text-sm text-text-primary">No playbooks match these filters.</p>
                  <button type="button" className={`${BTN} mx-auto mt-3`} onClick={() => { setTrade('any'); setSeason('any'); setGoal('any'); setQ(''); }}>Clear filters</button></div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {filtered.map((pb) => <PlaybookCard key={pb.key} pb={pb} live={liveKeys.includes(pb.key)} onOpen={() => open(pb)} />)}
                </div>
              )}
            </div>
          )}

          {tab === 'active' && (
            current.length === 0 ? (
              <div className={`${CARD} text-center`}><p className="text-sm text-text-primary">Nothing is active or waiting.</p><p className="mt-1 text-xs text-text-secondary">Activate a playbook from the Library, or turn on suggestions in Settings.</p>
                <button type="button" className={`${BTN} mx-auto mt-3`} onClick={() => setTab('library')}>Browse the library</button></div>
            ) : <div className="space-y-4">{current.map((a) => <ActivationCard key={a.id} a={a} isOwner={isOwner} onChanged={load} />)}</div>
          )}

          {tab === 'custom' && (
            custom.length === 0 ? (
              <div className={`${CARD} text-center`}><p className="text-sm text-text-primary">No custom playbooks yet.</p><p className="mt-1 text-xs text-text-secondary">Open any library playbook, switch off what you do not want, then choose “Save as custom”. Franchise HQ accounts can share them with every location.</p></div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {custom.map((c) => (
                  <div key={c.id} className={CARD}>
                    <h3 className="text-sm font-semibold text-text-primary">{c.name}</h3>
                    <p className="mt-1 text-xs text-text-secondary">Version {c.version}{c.shared_group_id ? ' · shared with your franchise group' : ''}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button type="button" className={BTN_PRIMARY} onClick={() => open(c.definition, c)}><Play size={14} /> Preview</button>
                      {isOwner && c.user_id && (
                        <button type="button" className={BTN} onClick={async () => { const r = await shareCustomPlaybook(c.id, !c.shared_group_id); if (r.status !== 'ok') toast(r.error ?? 'Could not change sharing.', 'error'); void load(); }}><Share2 size={14} /> {c.shared_group_id ? 'Unshare' : 'Share'}</button>
                      )}
                      {isOwner && <button type="button" className={BTN} onClick={async () => { await deleteCustomPlaybook(c.id); void load(); }}>Delete</button>}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'activity' && (
            audit.length === 0 ? <div className={`${CARD} text-center`}><p className="text-sm text-text-primary">No activity yet.</p></div> : (
              <div className={CARD}>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><History size={16} /> Audit log</h2>
                <ul className="divide-y divide-border">
                  {audit.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                      <span className="text-text-primary">{e.event.replace(/_/g, ' ')}{e.playbook_key ? ` · ${e.playbook_key}` : ''}</span>
                      <span className="text-text-secondary">{e.actor_type === 'system' ? 'System' : 'Team member'} · {formatDateTime(e.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}

          {tab === 'settings' && (
            <div className={`${CARD} space-y-4`}>
              <label className="flex items-start gap-3 text-sm text-text-primary">
                <input type="checkbox" className="mt-1 h-4 w-4" disabled={!isOwner} checked={settings.suggestions_enabled}
                  onChange={async (e) => { const next = { ...settings, suggestions_enabled: e.target.checked }; setSettings(next); try { await updateSettings(next.suggestions_enabled, next.auto_apply_keys); } catch { toast('Could not save.', 'error'); void load(); } }} />
                <span>Suggest playbooks from real signals (weather alerts, call spikes, season). Suggestions never change anything until you confirm.</span>
              </label>
              <div>
                <p className="text-sm font-medium text-text-primary">Start automatically (owner only)</p>
                <p className="mb-2 text-xs text-text-secondary">Only for real weather or call-spike signals. Price changes and ad changes always still wait for your approval.</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {PLAYBOOKS.map((pb) => (
                    <label key={pb.key} className="flex items-center gap-2 text-xs text-text-primary">
                      <input type="checkbox" disabled={!isOwner} checked={settings.auto_apply_keys.includes(pb.key)}
                        onChange={async (e) => {
                          const keys = e.target.checked ? [...settings.auto_apply_keys, pb.key] : settings.auto_apply_keys.filter((k) => k !== pb.key);
                          setSettings({ ...settings, auto_apply_keys: keys });
                          try { await updateSettings(settings.suggestions_enabled, keys); } catch { toast('Could not save.', 'error'); void load(); }
                        }} />{pb.name}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </FadeIn>
      )}

      {selected && state && <Drawer pb={selected.pb} custom={selected.custom} state={state} isOwner={isOwner} onClose={() => setSelected(null)} onDone={afterChange} />}
    </DashboardLayout>
  );
}
