import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import { RiskBadge } from '@/components/staff/RiskBadge';
import { getStaffSuccessOverview } from '@/lib/successToolsApi';
import {
  ADOPTION_LEVEL_LABELS,
  STATUS_LABELS,
  buildStaffSuccessRow,
  type FeatureStatus,
  type StaffSuccessData,
  type SuccessAccountInput,
} from '@/lib/successTools';

const CHIP: Record<FeatureStatus, string> = {
  active: 'bg-success-500/10 text-success-500',
  lapsed: 'bg-warning-500/10 text-warning-500',
  unused: 'bg-bg-tertiary text-text-secondary',
  unmeasured: 'bg-bg-tertiary text-text-secondary/60',
};

/** Success risk, feature adoption and latest NPS for one account, inside the staff detail panel. */
export function AccountSuccessSection({ account }: { account: SuccessAccountInput }) {
  const [data, setData] = useState<StaffSuccessData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    getStaffSuccessOverview()
      .then((d) => { if (alive) { setData(d); setState('ready'); } })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [account.id]);

  const row = useMemo(() => (data ? buildStaffSuccessRow(account, data) : null), [account, data]);

  if (state === 'loading') {
    return <Card className="space-y-3 p-5 hover:translate-y-0" aria-busy="true"><Skeleton className="h-4 w-40" /><Skeleton className="h-16 w-full" /></Card>;
  }
  if (state === 'error' || !row) {
    return <Card className="p-5 hover:translate-y-0"><p className="text-xs text-text-secondary">Success data couldn’t be loaded for this account.</p></Card>;
  }

  const { risk, adoption, nps } = row;
  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">Customer success</h3>
        <RiskBadge level={risk.level} score={risk.score} />
      </div>

      {risk.reasons.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-text-primary">
          {risk.reasons.map((r, i) => <li key={i}>{r.text}</li>)}
        </ul>
      )}
      <p className="text-xs font-medium text-accent">{risk.action}</p>

      <div>
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-text-primary">Feature adoption · {ADOPTION_LEVEL_LABELS[adoption.level]}</span>
          <span className="font-mono text-text-secondary">{adoption.score === null ? 'n/a' : `${adoption.score}/100`}</span>
        </div>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {adoption.items.filter((i) => i.status !== 'unmeasured').map((i) => (
            <li key={i.key} className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${CHIP[i.status]}`} title={STATUS_LABELS[i.status]}>
              {i.label} · {STATUS_LABELS[i.status]}
            </li>
          ))}
        </ul>
      </div>

      <div className="text-xs">
        <p className="font-medium text-text-primary">Latest NPS (90 days)</p>
        {nps ? (
          <>
            <p className="mt-0.5 text-text-secondary">{nps.score}/10 · {new Date(nps.at).toLocaleDateString()}</p>
            {nps.comment && <p className="mt-1 break-words rounded-xl bg-bg-primary p-2 text-text-primary">“{nps.comment}”</p>}
          </>
        ) : (
          <p className="mt-0.5 text-text-secondary">No response yet.</p>
        )}
      </div>
    </Card>
  );
}
