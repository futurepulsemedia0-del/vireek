import { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { salesErrorMessage, type SalesTeamMember } from '@/lib/inHomeSales';
import { listSalesTeam, setComfortAdvisor } from '@/lib/inHomeSalesApi';

/** Managers choose who may run in-home presentations. */
export function AdvisorTeamPanel() {
  const { toast } = useToast();
  const [members, setMembers] = useState<SalesTeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMembers(await listSalesTeam());
    } catch (e) {
      setError(salesErrorMessage(e, 'Could not load your team.'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(m: SalesTeamMember) {
    setBusyId(m.member_id);
    try {
      await setComfortAdvisor(m.member_id, !m.is_comfort_advisor);
      setMembers((cur) => cur?.map((x) => (x.member_id === m.member_id ? { ...x, is_comfort_advisor: !m.is_comfort_advisor } : x)) ?? cur);
    } catch (e) {
      toast(salesErrorMessage(e), 'error');
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <EmptyStateError icon={Users} title="Team unavailable" description={error} onRetry={() => void load()} />;
  if (members === null) return <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading team" />;
  if (members.length === 0) return <EmptyState icon={Users} title="No active team members" description="Invite a team member first, then enable them as a comfort advisor here. Owners and admins can always present." />;

  return (
    <section aria-label="Comfort advisors">
      <p className="mb-3 text-sm text-text-secondary">Turn on anyone who runs in-home sales visits. Owners and admins can always present.</p>
      <ul className="divide-y divide-border/60 rounded-2xl border border-border bg-bg-secondary">
        {members.map((m) => (
          <li key={m.member_id} className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="truncate font-medium text-text-primary">{m.name}</p>
              <p className="truncate text-xs text-text-secondary">{m.email} · {m.role}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={m.is_comfort_advisor}
              aria-label={`Comfort advisor: ${m.name}`}
              disabled={busyId === m.member_id}
              onClick={() => void toggle(m)}
              className={`focus-ring relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-50 ${m.is_comfort_advisor ? 'bg-accent' : 'bg-bg-tertiary'}`}
            >
              <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${m.is_comfort_advisor ? 'left-7' : 'left-1'}`} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
