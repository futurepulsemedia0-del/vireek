import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Clock, Loader2, Phone, PhoneForwarded, Plus, RefreshCw, Search, ShieldCheck, Smartphone, TriangleAlert, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  DEFAULT_TTL_HOURS, TTL_OPTIONS, closeReasonLabel, effectiveStatus, filterSessions, formatPhone, normalizePhone,
  summarizeNumbers, telHref, timeLeftLabel, validateProxyNumber, validateSessionInput,
  type MySession, type ProxyCallEvent, type ProxyNumber, type ProxyNumberStats, type ProxySession, type SessionFilter, type TechnicianOption,
} from '@/lib/callMasking';
import {
  addProxyNumber, allocateSession, closeSession, extendSession, fetchMySessions, fetchProxyNumberStats, fetchProxyNumbers,
  fetchRecentEvents, fetchSessions, fetchTechnicians, setProxyNumberStatus, setTechnicianPhone, startBridgeCall,
} from '@/lib/callMaskingApi';

type Tab = 'conversations' | 'pool' | 'technicians' | 'mine';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent';

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref as React.RefObject<HTMLDivElement>} role="dialog" aria-modal="true" aria-label={title}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 sm:max-w-md sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- new conversation
function NewSessionDialog({ technicians, onClose, onCreated }: { technicians: TechnicianOption[]; onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [technicianId, setTechnicianId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [ttlHours, setTtlHours] = useState(DEFAULT_TTL_HOURS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const tech = technicians.find((t) => t.id === technicianId);
  const techMissingPhone = !!tech && !normalizePhone(tech.member_phone);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validateSessionInput({ technicianId, customerName, customerPhone, ttlHours });
    if (problem) return setError(problem);
    setSaving(true);
    setError(null);
    try {
      await allocateSession({ technicianId, customerName: customerName.trim(), customerPhone, ttlHours });
      toast('Masked number assigned', 'success');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New masked conversation" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="cm-tech" className="mb-1.5 block text-sm font-medium text-text-primary">Technician</label>
          <select id="cm-tech" className={selectClass} value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
            <option value="">Choose a technician…</option>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>{t.member_name || t.member_email}</option>
            ))}
          </select>
          {techMissingPhone && (
            <p className="mt-1.5 text-xs text-warning-500">This technician has no mobile number yet. Add it under “Technician phones”.</p>
          )}
        </div>
        <Input label="Customer name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} maxLength={120} autoComplete="off" />
        <Input label="Customer phone" type="tel" inputMode="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="(555) 201-0001" autoComplete="off" />
        <div>
          <label htmlFor="cm-ttl" className="mb-1.5 block text-sm font-medium text-text-primary">Keep the number active for</label>
          <select id="cm-ttl" className={selectClass} value={ttlHours} onChange={(e) => setTtlHours(Number(e.target.value))}>
            {TTL_OPTIONS.map((o) => <option key={o.hours} value={o.hours}>{o.label}</option>)}
          </select>
        </div>
        {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || techMissingPhone}>
            {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Assign number
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- tabs
function SessionCard({ s, canAct, onClose, onExtend, onCall, calling }: {
  s: ProxySession; canAct: boolean; onClose: () => void; onExtend: () => void; onCall: () => void; calling: boolean;
}) {
  const status = effectiveStatus(s);
  const live = status === 'active';
  const proxyLabel = s.proxy_number_id;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{s.customer_name}</p>
          <p className="text-xs text-text-secondary">Technician: {s.technician_name || 'Unnamed'} · {formatPhone(s.technician_e164)}</p>
          <p className="text-xs text-text-secondary">Customer: {formatPhone(s.customer_e164)}</p>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${live ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>
          {live ? timeLeftLabel(s.expires_at) : status === 'closed' ? closeReasonLabel(s.close_reason) : 'Expired'}
        </span>
      </div>
      {live && canAct && (
        <div className="mt-3 flex flex-wrap gap-2" data-proxy={proxyLabel}>
          <Button size="sm" variant="secondary" onClick={onCall} disabled={calling}>
            {calling ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Phone size={14} aria-hidden="true" />} Bridge a call
          </Button>
          <Button size="sm" variant="ghost" onClick={onExtend}>+24 h</Button>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      )}
    </motion.div>
  );
}

function PoolTab({ numbers, stats, canAdmin, onChanged }: { numbers: ProxyNumber[]; stats: Record<string, ProxyNumberStats>; canAdmin: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const { profile, teamMember, isOwner } = useAuth();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const [raw, setRaw] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retire, setRetire] = useState<ProxyNumber | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateProxyNumber(raw, label);
    if (v.error || !v.e164 || !ownerId) return setError(v.error ?? 'Not signed in.');
    setBusy(true);
    setError(null);
    try {
      await addProxyNumber(ownerId, v.e164, v.label);
      setRaw('');
      setLabel('');
      toast('Number added to the pool', 'success');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (n: ProxyNumber) => {
    try {
      await setProxyNumberStatus(n.id, n.status === 'active' ? 'paused' : 'active');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the number', 'error');
    }
  };

  return (
    <div className="space-y-4">
      {canAdmin && (
        <form onSubmit={add} className="rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="mb-3 text-sm text-text-secondary">
            Add numbers you already own in Twilio. Set each number's voice webhook to the <code>call-bridge-voice</code> function with <code>?action=proxy-inbound</code>.
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Input label="Phone number" type="tel" inputMode="tel" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="+1 555 201 0001" />
            <Input label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />} Add
            </Button>
          </div>
          {error && <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        </form>
      )}
      {numbers.length === 0 ? (
        <EmptyState icon={Smartphone} title="No proxy numbers yet" description="Add at least one number to start masking calls between technicians and customers." />
      ) : (
        <ul className="space-y-2">
          {numbers.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
              <div>
                <p className="text-sm font-semibold text-text-primary">{formatPhone(n.e164)} {n.label && <span className="font-normal text-text-secondary">· {n.label}</span>}</p>
                <p className="text-xs text-text-secondary">
                  {stats[n.id]?.active_sessions ?? 0} live · {stats[n.id]?.calls_30d ?? 0} calls in 30 days
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs font-medium capitalize text-text-secondary">{n.status}</span>
                {canAdmin && n.status !== 'retired' && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => toggle(n)}>{n.status === 'active' ? 'Pause' : 'Resume'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRetire(n)}>Retire</Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!retire}
        title="Retire this number?"
        description="Every live conversation on this number ends immediately and the number cannot be used again."
        confirmLabel="Retire number"
        onCancel={() => setRetire(null)}
        onConfirm={async () => {
          if (!retire) return;
          try {
            await setProxyNumberStatus(retire.id, 'retired');
            toast('Number retired', 'success');
            onChanged();
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not retire the number', 'error');
          }
          setRetire(null);
        }}
      />
    </div>
  );
}

function TechniciansTab({ technicians, canAdmin, onChanged }: { technicians: TechnicianOption[]; canAdmin: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  if (technicians.length === 0) {
    return <EmptyState icon={Smartphone} title="No team members yet" description="Invite your technicians first, then add the mobile number each one answers on." />;
  }

  const save = async (t: TechnicianOption) => {
    const value = drafts[t.id] ?? t.member_phone ?? '';
    if (value.trim() && !normalizePhone(value)) return toast('That phone number is not valid', 'error');
    setSavingId(t.id);
    try {
      await setTechnicianPhone(t.id, value);
      toast('Phone saved', 'success');
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== t.id)));
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the phone', 'error');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <ul className="space-y-2">
      {technicians.map((t) => (
        <li key={t.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="text-sm font-semibold text-text-primary">{t.member_name || t.member_email}</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <Input label="Mobile number" aria-label={`Mobile number for ${t.member_name || t.member_email}`} type="tel" inputMode="tel" disabled={!canAdmin}
                value={drafts[t.id] ?? t.member_phone ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))} />
            </div>
            {canAdmin && (
              <Button variant="secondary" disabled={savingId === t.id || drafts[t.id] === undefined} onClick={() => save(t)}>
                {savingId === t.id && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Save
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function MineTab({ sessions, onCall, calling }: { sessions: MySession[]; onCall: (id: string) => void; calling: string | null }) {
  if (sessions.length === 0) {
    return <EmptyState icon={PhoneForwarded} title="No active masked numbers" description="When dispatch assigns you a customer conversation it appears here." />;
  }
  return (
    <ul className="space-y-2">
      {sessions.map((s) => (
        <li key={s.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-text-primary">{s.customer_name}</p>
              <p className="text-xs text-text-secondary">Customer sees: {formatPhone(s.proxy_e164)} · {timeLeftLabel(s.expires_at)}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => onCall(s.id)} disabled={calling === s.id}>
                {calling === s.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Phone size={14} aria-hidden="true" />} Call customer
              </Button>
              <a href={telHref(s.proxy_e164)} className="focus-ring inline-flex min-h-[40px] items-center rounded-xl border border-border px-4 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">
                Dial proxy
              </a>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- page
export function CallMaskingPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAdmin = isOwner || permissions.can_manage_numbers || permissions.can_view_billing;
  const canManage = canAdmin || permissions.can_view_all_jobs;

  const [tab, setTab] = useState<Tab>(canManage ? 'conversations' : 'mine');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [numbers, setNumbers] = useState<ProxyNumber[]>([]);
  const [stats, setStats] = useState<Record<string, ProxyNumberStats>>({});
  const [sessions, setSessions] = useState<ProxySession[]>([]);
  const [events, setEvents] = useState<ProxyCallEvent[]>([]);
  const [technicians, setTechnicians] = useState<TechnicianOption[]>([]);
  const [mine, setMine] = useState<MySession[]>([]);
  const [filter, setFilter] = useState<SessionFilter>('active');
  const [query, setQuery] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [closing, setClosing] = useState<ProxySession | null>(null);
  const [calling, setCalling] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ownerId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const myPromise = fetchMySessions().catch((): MySession[] => []);
      if (canManage) {
        const [n, st, s, ev, t, m] = await Promise.all([
          fetchProxyNumbers(ownerId), fetchProxyNumberStats(ownerId).catch((): Record<string, ProxyNumberStats> => ({})),
          fetchSessions(ownerId), fetchRecentEvents(ownerId).catch((): ProxyCallEvent[] => []), fetchTechnicians(ownerId), myPromise,
        ]);
        setNumbers(n); setStats(st); setSessions(s); setEvents(ev); setTechnicians(t); setMine(m);
      } else {
        setMine(await myPromise);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId, canManage]);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizeNumbers(numbers, stats), [numbers, stats]);
  const visible = useMemo(() => filterSessions(sessions, filter, query), [sessions, filter, query]);
  const calls30 = useMemo(() => Object.values(stats).reduce((s, r) => s + r.calls_30d, 0), [stats]);

  const bridge = async (sessionId: string) => {
    setCalling(sessionId);
    try {
      await startBridgeCall(sessionId);
      toast('Calling you now. Pick up to reach the customer.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the call', 'error');
    } finally {
      setCalling(null);
    }
  };

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'conversations', label: 'Conversations', show: canManage },
    { key: 'pool', label: 'Number pool', show: canManage },
    { key: 'technicians', label: 'Technician phones', show: canManage },
    { key: 'mine', label: 'My calls', show: true },
  ];

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><ShieldCheck size={20} /></span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Call Masking</h1>
              <p className="mt-1 text-sm text-text-secondary">Technicians and customers talk through a temporary number. Nobody sees the other's real phone.</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} aria-label="Refresh"><RefreshCw size={16} /></Button>
            {canManage && <Button size="sm" onClick={() => setShowNew(true)}><Plus size={16} aria-hidden="true" /> New conversation</Button>}
          </div>
        </div>

        {loading ? (
          <div className="space-y-4"><SkeletonStatGrid count={3} /><SkeletonCardList count={3} /></div>
        ) : loadError ? (
          <EmptyStateError icon={TriangleAlert} title="Could not load call masking" onRetry={() => void load()} />
        ) : (
          <>
            {canManage && (
              <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatTile label="Live conversations" value={String(summary.liveSessions)} />
                <StatTile label="Usable numbers" value={`${summary.usable} / ${summary.total}`} hint={summary.usable === 0 ? 'Add a number to start' : undefined} />
                <StatTile label="Masked calls (30 days)" value={String(calls30)} />
              </div>
            )}

            <div role="tablist" aria-label="Call masking sections" className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-bg-tertiary p-1">
              {tabs.filter((t) => t.show).map((t) => (
                <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                  className={`focus-ring min-h-[40px] whitespace-nowrap rounded-lg px-4 text-sm font-medium ${tab === t.key ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'conversations' && canManage && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-[200px] flex-1">
                    <Input icon={Search} aria-label="Search conversations" placeholder="Search name or phone" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </div>
                  <div className="flex gap-1">
                    {(['active', 'ended', 'all'] as SessionFilter[]).map((f) => (
                      <Button key={f} size="sm" variant={filter === f ? 'secondary' : 'ghost'} onClick={() => setFilter(f)}>{f === 'active' ? 'Live' : f === 'ended' ? 'Ended' : 'All'}</Button>
                    ))}
                  </div>
                </div>
                {visible.length === 0 ? (
                  <EmptyState icon={PhoneForwarded} title={sessions.length === 0 ? 'No masked conversations yet' : 'Nothing matches'}
                    description={sessions.length === 0 ? 'Assign a technician and a customer to give them a shared temporary number.' : 'Try a different filter or search.'}
                    action={sessions.length === 0 ? { label: 'New conversation', onClick: () => setShowNew(true) } : undefined} />
                ) : (
                  visible.map((s) => (
                    <SessionCard key={s.id} s={s} canAct={canManage} calling={calling === s.id}
                      onCall={() => void bridge(s.id)} onClose={() => setClosing(s)}
                      onExtend={async () => {
                        try { await extendSession(s.id, 24); toast('Extended by 24 hours', 'success'); void load(); }
                        catch (err) { toast(err instanceof Error ? err.message : 'Could not extend', 'error'); }
                      }} />
                  ))
                )}
                {events.length > 0 && (
                  <p className="flex items-center gap-1.5 pt-2 text-xs text-text-secondary">
                    <Clock size={12} aria-hidden="true" /> {events.length} recent masked calls logged
                  </p>
                )}
              </div>
            )}
            {tab === 'pool' && canManage && <PoolTab numbers={numbers} stats={stats} canAdmin={canAdmin} onChanged={() => void load()} />}
            {tab === 'technicians' && canManage && <TechniciansTab technicians={technicians} canAdmin={canAdmin} onChanged={() => void load()} />}
            {tab === 'mine' && <MineTab sessions={mine} calling={calling} onCall={(id) => void bridge(id)} />}
          </>
        )}
      </div>

      {showNew && <NewSessionDialog technicians={technicians} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); void load(); }} />}
      <ConfirmDialog
        open={!!closing}
        title="Close this conversation?"
        description="The temporary number stops working for this customer and technician right away."
        confirmLabel="Close conversation"
        onCancel={() => setClosing(null)}
        onConfirm={async () => {
          if (!closing) return;
          try { await closeSession(closing.id); toast('Conversation closed', 'success'); void load(); }
          catch (err) { toast(err instanceof Error ? err.message : 'Could not close', 'error'); }
          setClosing(null);
        }}
      />
    </DashboardLayout>
  );
}
