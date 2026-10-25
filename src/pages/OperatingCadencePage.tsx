import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarCheck, ChevronLeft, ChevronRight, Lock, Settings2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { AccountabilityTab } from '@/components/cadence/AccountabilityTab';
import { IssuesTab } from '@/components/cadence/IssuesTab';
import { MeetingTab } from '@/components/cadence/MeetingTab';
import { PrioritiesTab } from '@/components/cadence/PrioritiesTab';
import { ReviewTab } from '@/components/cadence/ReviewTab';
import { ScorecardTab } from '@/components/cadence/ScorecardTab';
import { CadenceModal, ErrorBlock, errMsg, labelClass, selectClass, type TabProps } from '@/components/cadence/shared';
import { addDays, cadenceRole, currentWeekStart, describeWeek, tabsFor, todayIn, type TabKey } from '@/lib/cadence';
import { fetchTimezone, saveTimezone } from '@/lib/cadenceApi';
import { fetchAssignees, type Assignee } from '@/lib/tasksApi';

const browserTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const zoneList = (current: string): string[] => {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return all.includes(current) ? all : [current, ...all];
  } catch {
    return [current];
  }
};

export function OperatingCadencePage() {
  const { user, profile, isOwner, teamMember, permissions, profileLoading } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();

  const resolving = profileLoading || !profile;
  const canAccess = isOwner || teamMember !== null;
  const role = cadenceRole({ isOwner, canViewAllJobs: permissions.can_view_all_jobs });
  const canManage = role !== 'member';
  const canViewFinancials = isOwner || permissions.can_view_billing;
  const meId = user?.id ?? '';
  const selfName = profile?.full_name || profile?.company_name || user?.email || 'Me';

  const [boot, setBoot] = useState<'loading' | 'error' | 'ready'>('loading');
  const [bootError, setBootError] = useState('');
  const [tz, setTz] = useState('UTC');
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [weekStart, setWeekStart] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const bootstrap = useCallback(async () => {
    if (!meId || !canAccess) return;
    setBoot('loading');
    try {
      const [saved, people] = await Promise.all([fetchTimezone(), fetchAssignees({ userId: meId, selfName, isManager: canManage })]);
      let zone = saved;
      if (!zone) {
        zone = browserTz();
        if (canManage) await saveTimezone(zone).catch(() => undefined); // first visit: remember it for everyone
      }
      setTz(zone);
      setAssignees(people);
      setWeekStart(currentWeekStart(zone));
      setBoot('ready');
    } catch (e) {
      setBootError(errMsg(e));
      setBoot('error');
    }
  }, [meId, canAccess, canManage, selfName]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const tabs = useMemo(() => tabsFor(role), [role]);
  const requested = params.get('tab') as TabKey | null;
  const active: TabKey = tabs.some((t) => t.key === requested) ? (requested as TabKey) : 'scorecard';
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const selectTab = (k: TabKey) => {
    const next = new URLSearchParams(params);
    if (k === 'scorecard') next.delete('tab');
    else next.set('tab', k);
    setParams(next, { replace: true });
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[n].key);
    tabRefs.current[tabs[n].key]?.focus();
  };

  const header = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <CalendarCheck size={16} />
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Operating Cadence</h1>
        </div>
        <p className="mt-1 text-sm text-text-secondary">
          {role === 'member' ? 'Your team’s numbers, priorities and issues' : 'Run the business weekly: numbers, priorities, issues, meeting'}
        </p>
      </div>
      {canManage && boot === 'ready' && (
        <Button size="sm" variant="secondary" onClick={() => setSettingsOpen(true)}>
          <Settings2 size={16} /> Week settings
        </Button>
      )}
    </div>
  );

  if (resolving || (canAccess && boot === 'loading')) {
    return (
      <DashboardLayout activeLabel="Operating Cadence">
        {header}
        <SkeletonStatGrid count={4} />
        <div className="mt-6">
          <SkeletonCardList count={3} />
        </div>
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Operating Cadence">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don’t have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">The Operating Cadence is available to account owners and team members. Ask your account owner for access.</p>
        </div>
      </DashboardLayout>
    );
  }

  if (boot === 'error') {
    return (
      <DashboardLayout activeLabel="Operating Cadence">
        {header}
        <ErrorBlock message={bootError} onRetry={() => void bootstrap()} />
      </DashboardLayout>
    );
  }

  const today = todayIn(tz);
  const thisWeek = currentWeekStart(tz);
  const tabProps: TabProps = { role, canManage, canViewFinancials, tz, today, weekStart, meId, assignees };

  return (
    <DashboardLayout activeLabel="Operating Cadence">
      {header}

      <div className="-mx-1 mb-5 overflow-x-auto px-1">
        <div role="tablist" aria-label="Operating cadence sections" className="inline-flex min-w-full gap-1 rounded-2xl border border-border bg-bg-secondary p-1 sm:min-w-0">
          {tabs.map((t, i) => (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[t.key] = el;
              }}
              id={`cadence-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={active === t.key}
              aria-controls={`cadence-panel-${t.key}`}
              tabIndex={active === t.key ? 0 : -1}
              onClick={() => selectTab(t.key)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`focus-ring min-h-[40px] whitespace-nowrap rounded-xl px-4 text-sm font-medium transition-colors ${active === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {active === 'scorecard' && (
        <div className="mb-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            aria-label="Previous week"
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-[150px] text-center text-sm font-semibold text-text-primary">{weekStart === thisWeek ? 'This week' : describeWeek(weekStart)}</span>
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            disabled={weekStart >= thisWeek}
            aria-label="Next week"
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            <ChevronRight size={18} />
          </button>
          {weekStart !== thisWeek && (
            <Button size="sm" variant="ghost" onClick={() => setWeekStart(thisWeek)}>
              Jump to this week
            </Button>
          )}
        </div>
      )}

      <div role="tabpanel" id={`cadence-panel-${active}`} aria-labelledby={`cadence-tab-${active}`} tabIndex={0} className="focus:outline-none">
        {active === 'scorecard' && <ScorecardTab key={weekStart} {...tabProps} />}
        {active === 'priorities' && <PrioritiesTab {...tabProps} />}
        {active === 'issues' && <IssuesTab {...tabProps} />}
        {active === 'chart' && <AccountabilityTab {...tabProps} />}
        {active === 'meeting' && canManage && <MeetingTab {...tabProps} />}
        {active === 'review' && canManage && <ReviewTab {...tabProps} />}
      </div>

      <WeekSettings
        open={settingsOpen}
        tz={tz}
        onClose={() => setSettingsOpen(false)}
        onSaved={(zone) => {
          setSettingsOpen(false);
          setTz(zone);
          setWeekStart(currentWeekStart(zone));
          toast('Time zone saved.', 'success');
        }}
      />
    </DashboardLayout>
  );
}

function WeekSettings({ open, tz, onClose, onSaved }: { open: boolean; tz: string; onClose: () => void; onSaved: (zone: string) => void }) {
  const { toast } = useToast();
  const [value, setValue] = useState(tz);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => zoneList(tz), [tz]);

  useEffect(() => {
    if (open) setValue(tz);
  }, [open, tz]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await saveTimezone(value);
      onSaved(value);
    } catch (e) {
      toast(errMsg(e, 'Could not save the time zone.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CadenceModal open={open} title="Week settings" onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <div>
          <label htmlFor="cadence-tz" className={labelClass}>
            Business time zone
          </label>
          <select id="cadence-tz" className={selectClass} value={value} onChange={(e) => setValue(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-text-secondary">Weeks run Monday to Sunday in this time zone. Past weekly snapshots keep the boundaries they were captured with.</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </CadenceModal>
  );
}
