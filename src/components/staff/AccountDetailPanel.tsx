import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, LogIn, Siren, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { HealthBadge } from './HealthBadge';
import { ImpersonateDialog } from './ImpersonateDialog';
import { AUDIT_ACTION_LABELS, fetchAccountDetail, type AccountDetail, type DailyUsage, type StaffAccount } from '@/lib/staffCustomers';

/** Last 30 calendar days, zero-filled, oldest first. */
function fillDays(daily: DailyUsage[]): DailyUsage[] {
  const byDay = new Map(daily.map((d) => [d.day.slice(0, 10), d]));
  const out: DailyUsage[] = [];
  for (let i = 29; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, calls: 0, minutes: 0 });
  }
  return out;
}

interface AccountDetailPanelProps {
  account: StaffAccount;
  onClose: () => void;
}

export function AccountDetailPanel({ account, onClose }: AccountDetailPanelProps) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [impersonating, setImpersonating] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(false);
    setDetail(null);
    try {
      const d = await fetchAccountDetail(account.id);
      if (id === requestId.current) setDetail(d);
    } catch {
      if (id === requestId.current) setError(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const label = account.companyName || account.email;
  const days = detail ? fillDays(detail.daily) : [];
  const maxCalls = Math.max(1, ...days.map((d) => d.calls));
  const pct = detail && detail.minutesIncluded > 0 ? Math.min(100, Math.round((detail.minutesUsed / detail.minutesIncluded) * 100)) : 0;

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5 hover:translate-y-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-text-primary">{label}</h2>
            <p className="truncate text-xs text-text-secondary">{account.email}</p>
            <p className="mt-0.5 font-mono text-[11px] text-text-secondary">{account.id}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close account details" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HealthBadge band={account.health.band} score={account.health.score} />
          <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold capitalize text-text-secondary">{account.plan}</span>
          <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold capitalize text-text-secondary">{account.status}</span>
          {account.subscriptionStatus !== 'active' && <span className="rounded-full bg-danger/10 px-2.5 py-1 text-[11px] font-semibold text-danger">{account.subscriptionStatus.replace('_', ' ')}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" onClick={() => setImpersonating(true)} disabled={account.isStaff}>
            <LogIn size={14} /> Sign in as customer
          </Button>
          {account.isStaff && <span className="text-xs text-text-secondary">Staff accounts cannot be impersonated.</span>}
        </div>
      </Card>

      <Card className="space-y-3 p-5 hover:translate-y-0">
        <h3 className="text-sm font-semibold text-text-primary">Why this health score</h3>
        <ul className="space-y-3">
          {account.health.factors.map((f) => (
            <li key={f.key}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-text-primary">{f.label}</span>
                <span className="font-mono text-text-secondary">{f.points}/{f.max}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-label={f.label} aria-valuemin={0} aria-valuemax={f.max} aria-valuenow={f.points}>
                <div className={`h-full ${f.points / f.max >= 0.7 ? 'bg-success-500' : f.points / f.max >= 0.35 ? 'bg-warning-500' : 'bg-danger'}`} style={{ width: `${(f.points / f.max) * 100}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-text-secondary">{f.detail}</p>
            </li>
          ))}
        </ul>
      </Card>

      {loading ? (
        <Card className="space-y-3 p-5 hover:translate-y-0" aria-busy="true">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-4 w-56" />
        </Card>
      ) : error || !detail ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load this account" description="The request was not completed. Nothing was changed." action={{ label: 'Retry', onClick: () => void load() }} />
      ) : (
        <>
          <Card className="space-y-4 p-5 hover:translate-y-0">
            <h3 className="text-sm font-semibold text-text-primary">Usage</h3>
            <div>
              <div className="flex justify-between text-xs text-text-secondary">
                <span>Minutes this month</span>
                <span className="font-mono">{Math.round(detail.minutesUsed)} / {detail.minutesIncluded}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-label="Minutes used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className={`h-full ${pct >= 100 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs text-text-secondary">Calls per day, last 30 days</p>
              <div className="flex h-16 items-end gap-[2px]" role="img" aria-label={`${days.reduce((s, d) => s + d.calls, 0)} calls in the last 30 days`}>
                {days.map((d) => (
                  <div key={d.day} title={`${d.day}: ${d.calls} calls`} className="flex-1 rounded-sm bg-accent/70" style={{ height: `${Math.max(d.calls === 0 ? 4 : 10, (d.calls / maxCalls) * 100)}%`, opacity: d.calls === 0 ? 0.25 : 1 }} />
                ))}
              </div>
            </div>
          </Card>

          <Card className="space-y-2 p-5 hover:translate-y-0">
            <h3 className="text-sm font-semibold text-text-primary">Recent calls</h3>
            {detail.recentCalls.length === 0 ? (
              <p className="rounded-xl bg-bg-tertiary p-3 text-xs text-text-secondary">This account has not taken a call.</p>
            ) : (
              <ul className="divide-y divide-border">
                {detail.recentCalls.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      {c.isEmergency && <Siren size={12} className="shrink-0 text-danger" aria-label="Emergency" />}
                      <span className="font-mono text-text-primary">{c.callerMasked}</span>
                      <span className="truncate capitalize text-text-secondary">{c.status.replace('_', ' ')}</span>
                    </span>
                    <span className="shrink-0 text-text-secondary">{c.durationSeconds !== null ? `${Math.round(c.durationSeconds)}s · ` : ''}{new Date(c.at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-text-secondary">Caller numbers are masked and transcripts are never shown here.</p>
          </Card>

          <Card className="grid gap-4 p-5 hover:translate-y-0 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold text-text-primary">Team ({detail.team.length})</h3>
              {detail.team.length === 0 ? <p className="text-xs text-text-secondary">Only the owner.</p> : (
                <ul className="space-y-0.5 text-xs text-text-secondary">
                  {detail.team.slice(0, 8).map((m, i) => <li key={i} className="truncate">{m.name} · {m.role}</li>)}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-text-primary">Numbers ({detail.numbers.length})</h3>
              {detail.numbers.length === 0 ? <p className="text-xs text-text-secondary">No phone numbers connected.</p> : (
                <ul className="space-y-0.5 font-mono text-xs text-text-secondary">
                  {detail.numbers.slice(0, 8).map((n) => <li key={n}>{n}</li>)}
                </ul>
              )}
            </div>
          </Card>

          <Card className="space-y-2 p-5 hover:translate-y-0">
            <h3 className="text-sm font-semibold text-text-primary">Staff access to this account</h3>
            {detail.staffAccess.length === 0 ? (
              <p className="text-xs text-text-secondary">No staff access has been recorded.</p>
            ) : (
              <ul className="divide-y divide-border">
                {detail.staffAccess.map((a) => (
                  <li key={a.id} className="py-2 text-xs">
                    <p className="text-text-primary">{AUDIT_ACTION_LABELS[a.action] ?? a.action} · <span className="text-text-secondary">{a.staffEmail ?? 'unknown'}</span></p>
                    {a.reason && <p className="mt-0.5 break-words text-text-secondary">“{a.reason}”</p>}
                    <p className="text-[11px] text-text-secondary">{new Date(a.createdAt).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <ImpersonateDialog open={impersonating} accountId={account.id} accountLabel={`${label} · ${account.email}`} onClose={() => { setImpersonating(false); void load(); }} />
    </div>
  );
}
