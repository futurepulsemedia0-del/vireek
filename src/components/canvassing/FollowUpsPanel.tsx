import { useMemo, useState } from 'react';
import { CalendarCheck, Check, Phone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { followUpBucket, formatAddress, type Door, type FollowUpBucket, type Territory } from '@/lib/canvassing';
import { completeFollowUp } from '@/lib/canvassingApi';
import { StatusBadge, TerritoryDot } from './canvassUi';

interface FollowUpsPanelProps {
  doors: Door[];
  territories: Territory[];
  onOpenDoor: (id: string) => void;
  onDoorChanged: (door: Door) => void;
}

const GROUPS: { id: FollowUpBucket; title: string }[] = [
  { id: 'overdue', title: 'Overdue' },
  { id: 'today', title: 'Today' },
  { id: 'upcoming', title: 'Upcoming' },
];

const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function FollowUpsPanel({ doors, territories, onOpenDoor, onDoorChanged }: FollowUpsPanelProps) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const territoryById = useMemo(() => new Map(territories.map((t) => [t.id, t])), [territories]);

  const grouped = useMemo(() => {
    const now = new Date();
    const out: Record<FollowUpBucket, Door[]> = { overdue: [], today: [], upcoming: [] };
    doors
      .filter((d) => d.follow_up_at && d.status !== 'do_not_knock')
      .sort((a, b) => Date.parse(a.follow_up_at as string) - Date.parse(b.follow_up_at as string))
      .forEach((d) => out[followUpBucket(d.follow_up_at as string, now)].push(d));
    return out;
  }, [doors]);

  const total = grouped.overdue.length + grouped.today.length + grouped.upcoming.length;

  const done = async (d: Door) => {
    if (busyId) return;
    setBusyId(d.id);
    try {
      onDoorChanged(await completeFollowUp(d.id));
      toast('Follow-up marked as done.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not mark the follow-up as done.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (total === 0) {
    return <EmptyState icon={CalendarCheck} title="No follow-ups scheduled" description="When a visit ends in Call back, Appointment set or a follow-up date, it shows up here and as a task for the rep." />;
  }

  return (
    <div className="space-y-6">
      {GROUPS.map((g) => grouped[g.id].length > 0 && (
        <section key={g.id} aria-label={g.title}>
          <h3 className={`mb-2 text-sm font-semibold ${g.id === 'overdue' ? 'text-danger' : 'text-text-primary'}`}>{g.title} <span className="font-normal text-text-secondary">({grouped[g.id].length})</span></h3>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
            {grouped[g.id].map((d) => {
              const t = d.territory_id ? territoryById.get(d.territory_id) : undefined;
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <button type="button" onClick={() => onOpenDoor(d.id)} className="focus-ring min-w-0 flex-1 rounded-lg text-left">
                    <span className="block truncate text-sm font-medium text-text-primary">{formatAddress(d)}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                      <span className={g.id === 'overdue' ? 'font-medium text-danger' : ''}>{fmt.format(new Date(d.follow_up_at as string))}</span>
                      <StatusBadge status={d.status} />
                      {d.contact_name && <span>{d.contact_name}</span>}
                      {t && <span className="inline-flex items-center gap-1.5"><TerritoryDot color={t.color} />{t.name}</span>}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {d.contact_phone && (
                      <a href={`tel:${d.contact_phone}`} aria-label={`Call ${d.contact_name ?? d.contact_phone}`} className="focus-ring inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary"><Phone size={16} /></a>
                    )}
                    <Button type="button" variant="secondary" size="sm" onClick={() => onOpenDoor(d.id)}>Log visit</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void done(d)} disabled={busyId === d.id} aria-label={`Mark follow-up at ${d.line1} as done`}><Check size={16} aria-hidden="true" />{busyId === d.id ? 'Saving…' : 'Done'}</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
