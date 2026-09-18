import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlarmClock, Plus, Trash2, ArrowUp, ArrowDown, Phone } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, OnCallSchedule, OnCallScheduleMember, EscalationTier, EscalationEvent, TeamMember } from '@/lib/supabase';
import { ROTATION_TYPE_LABELS, NOTIFY_VIA_LABELS, ESCALATION_STATUS_LABELS, ESCALATION_STATUS_COLORS, formatHandoffHour } from '@/lib/onCall';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary transition-colors';

export function OnCallPage() {
  const { user } = useAuth();
  const { showToast } = useToast();

  const [schedule, setSchedule] = useState<OnCallSchedule | null>(null);
  const [members, setMembers] = useState<(OnCallScheduleMember & { team_member: Pick<TeamMember, 'member_name' | 'member_phone'> })[]>([]);
  const [tiers, setTiers] = useState<EscalationTier[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [events, setEvents] = useState<EscalationEvent[]>([]);
  const [currentOnCallId, setCurrentOnCallId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [addMemberId, setAddMemberId] = useState('');
  const [newTier, setNewTier] = useState({ team_member_id: '', delay_minutes: '5', notify_via: 'sms' as 'sms' | 'call' | 'both' });

  const load = useCallback(async () => {
    if (!user) return;
    let { data: sched } = await supabase.from('on_call_schedules').select('*').limit(1).maybeSingle();
    if (!sched) {
      const { data: created } = await supabase
        .from('on_call_schedules')
        .insert({ user_id: user.id, name: 'Emergency Dispatch' })
        .select('*')
        .maybeSingle();
      sched = created;
    }
    setSchedule(sched);

    const [{ data: mem }, { data: tm }, { data: tr }, { data: ev }] = await Promise.all([
      sched
        ? supabase.from('on_call_schedule_members').select('*, team_member:team_members(member_name, member_phone)').eq('schedule_id', sched.id).order('position')
        : Promise.resolve({ data: [] }),
      supabase.from('team_members').select('*').eq('invite_status', 'active'),
      sched ? supabase.from('escalation_tiers').select('*').eq('schedule_id', sched.id).order('tier_order') : Promise.resolve({ data: [] }),
      supabase.from('escalation_events').select('*').order('created_at', { ascending: false }).limit(20),
    ]);
    setMembers((mem as typeof members) ?? []);
    setTeamMembers(tm ?? []);
    setTiers(tr ?? []);
    setEvents(ev ?? []);

    if (sched) {
      const { data: onCallId } = await supabase.rpc('get_current_on_call', { p_schedule_id: sched.id });
      setCurrentOnCallId(onCallId ?? null);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const currentOnCallName = teamMembers.find((t) => t.id === currentOnCallId)?.member_name
    ?? members.find((m) => m.team_member_id === currentOnCallId)?.team_member?.member_name
    ?? null;

  const updateSchedule = async (patch: Partial<OnCallSchedule>) => {
    if (!schedule) return;
    const { error } = await supabase.from('on_call_schedules').update(patch).eq('id', schedule.id);
    if (error) { showToast('Failed to save', 'error'); return; }
    setSchedule({ ...schedule, ...patch });
    load();
  };

  const addMember = async () => {
    if (!schedule || !addMemberId) return;
    const { error } = await supabase.from('on_call_schedule_members').insert({
      schedule_id: schedule.id,
      team_member_id: addMemberId,
      position: members.length,
    });
    if (error) { showToast('Failed to add', 'error'); return; }
    setAddMemberId('');
    load();
  };

  const removeMember = async (id: string) => {
    await supabase.from('on_call_schedule_members').delete().eq('id', id);
    load();
  };

  const moveMember = async (index: number, dir: -1 | 1) => {
    const target = members[index + dir];
    const current = members[index];
    if (!target || !current) return;
    await Promise.all([
      supabase.from('on_call_schedule_members').update({ position: target.position }).eq('id', current.id),
      supabase.from('on_call_schedule_members').update({ position: current.position }).eq('id', target.id),
    ]);
    load();
  };

  const addTier = async () => {
    if (!schedule) return;
    const { error } = await supabase.from('escalation_tiers').insert({
      schedule_id: schedule.id,
      tier_order: tiers.length + 1,
      team_member_id: newTier.team_member_id || null,
      delay_minutes: Number(newTier.delay_minutes) || 5,
      notify_via: newTier.notify_via,
    });
    if (error) { showToast('Failed to add tier', 'error'); return; }
    setNewTier({ team_member_id: '', delay_minutes: '5', notify_via: 'sms' });
    load();
  };

  const removeTier = async (id: string) => {
    await supabase.from('escalation_tiers').delete().eq('id', id);
    load();
  };

  if (loading || !schedule) {
    return <DashboardLayout activeLabel="On-Call Rotation"><div className="p-8 text-text-secondary">Loading…</div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="On-Call Rotation">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <AlarmClock size={20} />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">On-Call Rotation & Escalation</h1>
            <p className="text-sm text-text-secondary">Who gets alerted for emergency calls, in what order.</p>
          </div>
        </div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-6 rounded-xl border border-accent/30 bg-accent/5 p-4">
          <div className="flex items-center gap-2 text-sm text-text-primary">
            <Phone size={16} className="text-accent" />
            {currentOnCallName ? <>Currently on call: <strong>{currentOnCallName}</strong></> : 'No one is currently in the rotation — add a member below.'}
          </div>
        </motion.div>

        <div className="mb-6 rounded-xl border border-border bg-bg-secondary p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Rotation settings</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <select value={schedule.rotation_type} onChange={(e) => updateSchedule({ rotation_type: e.target.value as 'daily' | 'weekly' })} className={inputClass}>
              {Object.entries(ROTATION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={schedule.handoff_hour} onChange={(e) => updateSchedule({ handoff_hour: Number(e.target.value) })} className={inputClass}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHandoffHour(h)} handoff</option>)}
            </select>
            <input value={schedule.timezone} onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })} onBlur={() => updateSchedule({ timezone: schedule.timezone })} placeholder="America/New_York" className={inputClass} />
          </div>
        </div>

        <div className="mb-6 rounded-xl border border-border bg-bg-secondary p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Rotation order</h2>
          <div className="space-y-2">
            {members.map((m, i) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
                <span>{i + 1}. {m.team_member?.member_name ?? 'Unnamed'} — {m.team_member?.member_phone ?? 'no phone'}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => moveMember(i, -1)} disabled={i === 0} className="rounded p-1 text-text-secondary hover:text-accent disabled:opacity-30"><ArrowUp size={14} /></button>
                  <button onClick={() => moveMember(i, 1)} disabled={i === members.length - 1} className="rounded p-1 text-text-secondary hover:text-accent disabled:opacity-30"><ArrowDown size={14} /></button>
                  <button onClick={() => removeMember(m.id)} className="rounded p-1 text-text-secondary hover:text-error-500"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <select value={addMemberId} onChange={(e) => setAddMemberId(e.target.value)} className={inputClass}>
              <option value="">Add a team member…</option>
              {teamMembers.filter((t) => !members.some((m) => m.team_member_id === t.id)).map((t) => (
                <option key={t.id} value={t.id}>{t.member_name ?? t.member_email}</option>
              ))}
            </select>
            <button onClick={addMember} className="shrink-0 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90"><Plus size={16} /></button>
          </div>
        </div>

        <div className="mb-6 rounded-xl border border-border bg-bg-secondary p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Escalation tiers</h2>
          <p className="mb-3 text-xs text-text-secondary">If a tier doesn't acknowledge in time, it escalates to the next one.</p>
          <div className="space-y-2">
            {tiers.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
                <span>
                  Tier {t.tier_order}: {t.team_member_id ? teamMembers.find((m) => m.id === t.team_member_id)?.member_name ?? 'Team member' : 'Current on-call'}
                  {' '}— after {t.delay_minutes}m, via {NOTIFY_VIA_LABELS[t.notify_via]}
                </span>
                <button onClick={() => removeTier(t.id)} className="rounded p-1 text-text-secondary hover:text-error-500"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <select value={newTier.team_member_id} onChange={(e) => setNewTier((f) => ({ ...f, team_member_id: e.target.value }))} className={inputClass}>
              <option value="">Current on-call</option>
              {teamMembers.map((t) => <option key={t.id} value={t.id}>{t.member_name ?? t.member_email}</option>)}
            </select>
            <input type="number" min={1} value={newTier.delay_minutes} onChange={(e) => setNewTier((f) => ({ ...f, delay_minutes: e.target.value }))} placeholder="Delay (min)" className={inputClass} />
            <select value={newTier.notify_via} onChange={(e) => setNewTier((f) => ({ ...f, notify_via: e.target.value as typeof newTier.notify_via }))} className={inputClass}>
              {Object.entries(NOTIFY_VIA_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button onClick={addTier} className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90">Add tier</button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-bg-secondary p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Recent escalations</h2>
          {events.length === 0 && <p className="text-sm text-text-secondary">No escalations yet.</p>}
          <div className="space-y-2">
            {events.map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
                <span>Tier {e.current_tier} — {new Date(e.created_at).toLocaleString()}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ESCALATION_STATUS_COLORS[e.status]}`}>{ESCALATION_STATUS_LABELS[e.status]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
