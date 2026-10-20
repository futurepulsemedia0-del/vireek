import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import { RankingList } from '@/components/dispatch/DispatchRulesPanel';
import {
  RULE_META,
  RULE_TYPES,
  addPreference,
  deletePreference,
  draftRule,
  fetchDecisions,
  fetchPreferences,
  fetchRulesBundle,
  rankJob,
  saveRule,
  searchCustomers,
  type DecisionRow,
  type DispatchRule,
  type ParamField,
  type PreferenceRow,
  type RulesBundle,
} from '@/lib/dispatchRulesApi';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4';
const input = 'focus-ring rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

function ParamInput({ field, value, onChange, disabled }: { field: ParamField; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const id = `p-${field.key}`;
  if (field.kind === 'select') {
    return (
      <select id={id} disabled={disabled} value={String(value ?? field.options?.[0].value)} onChange={(e) => onChange(e.target.value)} className={input}>
        {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  const scale = field.kind === 'percent' ? 100 : field.kind === 'hours' ? 1 / 60 : 1;
  const shown = typeof value === 'number' ? Math.round(value * scale * 100) / 100 : '';
  return (
    <input
      id={id} type="number" disabled={disabled} min={field.min} max={field.max} step={field.step} value={shown}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (e.target.value === '' || !Number.isFinite(n)) return;
        onChange(field.kind === 'percent' ? n / 100 : field.kind === 'hours' ? Math.round(n * 60) : n);
      }}
      className={`${input} w-24`}
    />
  );
}

function RuleCard({ rule, canEdit, saving, onSave }: { rule: DispatchRule; canEdit: boolean; saving: boolean; onSave: (r: DispatchRule) => void }) {
  const meta = RULE_META[rule.rule_type];
  const [draft, setDraft] = useState(rule);
  useEffect(() => setDraft(rule), [rule]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rule);
  const set = (patch: Partial<DispatchRule>) => setDraft((d) => ({ ...d, ...patch }));
  const dis = !canEdit || saving;

  return (
    <div className={`${card} ${draft.enabled ? '' : 'opacity-80'}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">{meta.title}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{meta.description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" role="switch" checked={draft.enabled} disabled={dis} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-[var(--color-accent,#3b82f6)]" />
          {draft.enabled ? 'On' : 'Off'}
        </label>
      </div>

      {draft.enabled && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`mode-${rule.rule_type}`} className="mb-1 block text-xs text-text-secondary">Behavior</label>
            <select id={`mode-${rule.rule_type}`} disabled={dis} value={draft.mode} onChange={(e) => set({ mode: e.target.value as DispatchRule['mode'] })} className={`${input} w-full`}>
              <option value="require">Required — exclude technicians who fail</option>
              <option value="score">Weighted — add or subtract points</option>
            </select>
          </div>
          {draft.mode === 'score' && (
            <div>
              <label htmlFor={`w-${rule.rule_type}`} className="mb-1 block text-xs text-text-secondary">Weight: {draft.weight} pts</label>
              <input id={`w-${rule.rule_type}`} type="range" min={0} max={100} step={5} disabled={dis} value={draft.weight} onChange={(e) => set({ weight: Number(e.target.value) })} className="w-full accent-[var(--color-accent,#3b82f6)]" />
            </div>
          )}
          {meta.fields.filter((f) => !f.onlyMode || f.onlyMode === draft.mode).map((f) => (
            <div key={f.key}>
              <label htmlFor={`p-${f.key}`} className="mb-1 block text-xs text-text-secondary">{f.label}</label>
              <ParamInput field={f} value={draft.params[f.key]} disabled={dis} onChange={(v) => set({ params: { ...draft.params, [f.key]: v } })} />
            </div>
          ))}
        </div>
      )}

      {canEdit && dirty && (
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={() => setDraft(rule)} className="focus-ring rounded-lg px-3 py-1.5 text-xs text-text-secondary">Reset</button>
          <button type="button" disabled={saving} onClick={() => onSave(draft)} className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            {saving ? 'Saving…' : 'Save rule'}
          </button>
        </div>
      )}
    </div>
  );
}

function Preferences({ ownerId, canEdit, technicians, onChanged }: { ownerId: string; canEdit: boolean; technicians: { id: string; name: string }[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<PreferenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tech, setTech] = useState('');
  const [pref, setPref] = useState<'prefer' | 'avoid' | 'require'>('prefer');
  const [scope, setScope] = useState<'customer' | 'service'>('customer');
  const [service, setService] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; name: string }[]>([]);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await fetchPreferences(ownerId)); } catch (e) { toast(errMsg(e), 'error'); } finally { setLoading(false); }
  }, [ownerId, toast]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (customer || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => void searchCustomers(ownerId, q).then(setHits), 250);
    return () => clearTimeout(t);
  }, [q, customer, ownerId]);

  const nameOf = (id: string) => technicians.find((t) => t.id === id)?.name ?? 'Technician';
  const ready = tech && (scope === 'customer' ? customer : service.trim());

  const add = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await addPreference(ownerId, { technician_id: tech, customer_id: scope === 'customer' ? customer!.id : null, service_type: scope === 'service' ? service : null, preference: pref });
      setCustomer(null); setQ(''); setService('');
      await load(); onChanged();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await deletePreference(id); setRows((r) => r.filter((x) => x.id !== id)); onChanged(); } catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <section aria-labelledby="prefs-h" className="mt-8">
      <h2 id="prefs-h" className="mb-3 text-sm font-semibold text-text-primary">Technician preferences</h2>
      <div className={card}>
        {loading ? <Loader2 size={16} className="animate-spin text-text-secondary" aria-label="Loading" /> : rows.length === 0 ? (
          <p className="text-xs text-text-secondary">No preferences yet. Pin a technician to a customer or service type, or steer jobs away from one.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-2 text-xs text-text-secondary">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-text-primary">{nameOf(r.technician_id)}</span>{' '}
                  <span className={r.preference === 'avoid' ? 'text-danger' : 'text-success-500'}>{r.preference}</span>{' '}
                  {r.customer_name ? `customer ${r.customer_name}` : `service “${r.service_type}”`}
                </span>
                {canEdit && (
                  <button type="button" onClick={() => void remove(r.id)} aria-label="Remove preference" className="focus-ring rounded p-1 text-text-secondary hover:text-danger">
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-2">
            <select aria-label="Technician" value={tech} onChange={(e) => setTech(e.target.value)} className={input}>
              <option value="">Technician…</option>
              {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select aria-label="Preference" value={pref} onChange={(e) => setPref(e.target.value as typeof pref)} className={input}>
              <option value="prefer">Prefer</option>
              <option value="avoid">Avoid</option>
              <option value="require">Require (only this technician)</option>
            </select>
            <select aria-label="Applies to" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className={input}>
              <option value="customer">For a customer</option>
              <option value="service">For a service type</option>
            </select>
            {scope === 'service' ? (
              <input aria-label="Service type" placeholder="e.g. plumbing" value={service} maxLength={80} onChange={(e) => setService(e.target.value)} className={input} />
            ) : customer ? (
              <button type="button" onClick={() => setCustomer(null)} className={`${input} text-left`}>{customer.name} ✕</button>
            ) : (
              <div className="relative">
                <input aria-label="Search customer" placeholder="Search customer…" value={q} onChange={(e) => setQ(e.target.value)} className={`${input} w-full`} />
                {hits.length > 0 && (
                  <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-border bg-bg-primary shadow-lg">
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button type="button" onClick={() => { setCustomer(h); setHits([]); }} className="focus-ring w-full px-3 py-1.5 text-left text-sm text-text-primary hover:bg-bg-tertiary">{h.name}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <button type="button" disabled={!ready || busy} onClick={() => void add()} className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 sm:col-span-2">
              {busy ? 'Adding…' : 'Add preference'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function Simulator({ bundle }: { bundle: RulesBundle | null }) {
  const { isOwner, profile, teamMember } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const [jobs, setJobs] = useState<Record<string, unknown>[]>([]);
  const [sel, setSel] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!ownerId) return;
    void supabase.from('jobs').select('id, customer_name, customer_id, service_type, address, scheduled_datetime, duration_minutes, latitude, longitude')
      .eq('user_id', ownerId).in('job_status', ['scheduled', 'en_route', 'in_progress']).order('scheduled_datetime', { ascending: true }).limit(50)
      .then(({ data }) => { setJobs((data ?? []) as Record<string, unknown>[]); setLoaded(true); });
  }, [ownerId]);

  const job = jobs.find((j) => j.id === sel);
  const ranking = useMemo(() => (bundle && job ? rankJob(job, bundle) : null), [bundle, job]);

  return (
    <section aria-labelledby="sim-h" className="mt-8">
      <h2 id="sim-h" className="mb-3 text-sm font-semibold text-text-primary">Test your rules</h2>
      <div className={card}>
        <label htmlFor="sim-job" className="mb-1 block text-xs text-text-secondary">Pick an open job to see how the engine would rank technicians (nothing is assigned)</label>
        <select id="sim-job" value={sel} onChange={(e) => setSel(e.target.value)} className={`${input} w-full`}>
          <option value="">{loaded && jobs.length === 0 ? 'No open jobs' : 'Select a job…'}</option>
          {jobs.map((j) => <option key={j.id as string} value={j.id as string}>{String(j.customer_name)} · {String(j.service_type ?? 'service')}</option>)}
        </select>
        {!bundle?.hasRules && <p className="mt-3 text-xs text-text-secondary">Turn on at least one rule above and save to see rankings.</p>}
        {ranking && bundle?.hasRules && <div className="mt-3"><RankingList ranking={ranking} /></div>}
      </div>
    </section>
  );
}

const MODE_LABEL: Record<DecisionRow['mode'], string> = { auto: 'Auto-assigned', manual: 'Assigned (top pick)', override: 'Manual override', no_eligible: 'No eligible technician' };

function Decisions({ ownerId, refreshKey, names }: { ownerId: string; refreshKey: number; names: Record<string, string> }) {
  const [rows, setRows] = useState<DecisionRow[] | null>(null);
  useEffect(() => { void fetchDecisions(ownerId).then(setRows).catch(() => setRows([])); }, [ownerId, refreshKey]);
  return (
    <section aria-labelledby="dec-h" className="mt-8">
      <h2 id="dec-h" className="mb-3 text-sm font-semibold text-text-primary">Recent decisions</h2>
      <div className={card}>
        {rows === null ? <Loader2 size={16} className="animate-spin text-text-secondary" aria-label="Loading" /> : rows.length === 0 ? (
          <p className="text-xs text-text-secondary">Decisions appear here when auto-assign runs or someone overrides the engine.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="py-2 text-xs text-text-secondary">
                <p>
                  <span className="font-medium text-text-primary">{MODE_LABEL[r.mode]}</span>
                  {r.technician_id && <> → {names[r.technician_id] ?? 'Technician'}</>}
                  {r.job && <> · {r.job.customer_name} · {r.job.service_type ?? 'service'}</>}
                  <span className="float-right tabular-nums">{new Date(r.created_at).toLocaleString()}</span>
                </p>
                {r.mode === 'override' && r.recommended_technician_id && <p>Engine recommended {names[r.recommended_technician_id] ?? 'another technician'}.</p>}
                {r.note && <p className="mt-0.5 break-words">{r.note}</p>}
                {!r.note && r.explanation.candidates?.[0] && r.mode !== 'no_eligible' && <p className="mt-0.5">{r.explanation.candidates.find((c) => c.technician_id === r.technician_id)?.summary ?? r.explanation.candidates[0].summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function DispatchRulesPage() {
  const { isOwner, profile, teamMember, permissions } = useAuth();
  const { toast } = useToast();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canEdit = isOwner || permissions.can_manage_team;

  const [bundle, setBundle] = useState<RulesBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!ownerId) return;
    try { setBundle(await fetchRulesBundle(ownerId, [])); setError(null); } catch (e) { setError(errMsg(e)); }
  }, [ownerId]);
  useEffect(() => { void load(); }, [load]);

  const rules = useMemo(() => RULE_TYPES.map((t) => draftRule(t, bundle?.ctx.rules.find((r) => r.rule_type === t))), [bundle]);
  const technicians = useMemo(() => (bundle?.ctx.technicians ?? []).map((t) => ({ id: t.id, name: t.name })), [bundle]);
  const names = useMemo(() => Object.fromEntries(technicians.map((t) => [t.id, t.name])), [technicians]);

  const onSave = async (rule: DispatchRule) => {
    if (!ownerId) return;
    setSaving(rule.rule_type);
    try { await saveRule(ownerId, rule); toast('Rule saved', 'success'); await load(); } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(null); }
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Link to="/dashboard/dispatch" className="focus-ring mb-4 inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-accent">
          <ArrowLeft size={12} /> Dispatch Board
        </Link>
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><SlidersHorizontal size={20} /></span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Dispatch Rules</h1>
            <p className="mt-1 text-sm text-text-secondary">Decide how technicians are scored for auto-assign. Every pick is explained, and you can always override it.</p>
          </div>
        </div>

        {!canEdit && <p role="status" className="mb-4 rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">You can view the rules. Only owners and team managers can change them.</p>}
        {error && <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-text-primary">Couldn’t load dispatch rules: {error}</p>}
        {!bundle && !error && <div className="flex justify-center py-12"><Loader2 className="animate-spin text-text-secondary" aria-label="Loading" /></div>}

        {bundle && ownerId && (
          <>
            <p className="mb-3 text-xs text-text-secondary">
              Without any rule turned on, auto-assign keeps using the built-in skill/area/capacity scoring. Time off, daily capacity and required credentials are always enforced on top of your rules.
            </p>
            <div className="space-y-3">
              {rules.map((r) => <RuleCard key={r.rule_type} rule={r} canEdit={canEdit} saving={saving === r.rule_type} onSave={(x) => void onSave(x)} />)}
            </div>
            <Preferences ownerId={ownerId} canEdit={canEdit} technicians={technicians} onChanged={() => { void load(); setTick((t) => t + 1); }} />
            <Simulator bundle={bundle} />
            <Decisions ownerId={ownerId} refreshKey={tick} names={names} />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
