import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { friendlyCommercialError } from '@/lib/commercial/errors';
import {
  decideApproval, issueStatement, loadApprovals, loadPmDue, loadStatements, loadTimers, timerAction, useCommercialData,
  type LoadState,
} from '@/lib/commercialApi';

type Tab = 'timers' | 'approvals' | 'statements' | 'pm';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'timers', label: 'SLA timers' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'statements', label: 'Statements' },
  { key: 'pm', label: 'PM due' },
];

const money = (c: number) => (c / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

/** One place for loading / error / empty so every tab behaves the same. */
function Panel<T>({ state, empty, children }: { state: LoadState<T[]>; empty: string; children: (rows: T[]) => React.ReactNode }) {
  if (state.loading) return <div className="space-y-2" role="status" aria-label="Loading"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>;
  if (state.error) {
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p className="text-text-primary">{friendlyCommercialError(state.error)}</p>
        <Button size="sm" variant="secondary" onClick={state.reload}>Try again</Button>
      </div>
    );
  }
  if (!state.data || state.data.length === 0) return <p className="text-sm text-text-secondary">{empty}</p>;
  return <>{children(state.data)}</>;
}

const STATE_LABEL: Record<string, string> = { running: 'On track', at_risk: 'At risk', paused: 'Paused', breached: 'Breached' };

export function CommercialPackPage() {
  const enabled = useFeatureFlag('commercial_pack');
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('timers');
  const [busy, setBusy] = useState<string | null>(null);
  const timers = useCommercialData(loadTimers);
  const approvals = useCommercialData(loadApprovals);
  const statements = useCommercialData(loadStatements);
  const pm = useCommercialData(() => loadPmDue(30));

  async function run(id: string, fn: () => Promise<unknown>, ok: string, after: () => void) {
    setBusy(id);
    try {
      await fn();
      toast(ok, 'success');
      after();
    } catch (e) {
      toast(friendlyCommercialError(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (!enabled) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Card className="space-y-2 p-6">
          <h1 className="text-xl font-semibold text-text-primary">Commercial services</h1>
          <p className="text-sm text-text-secondary">This feature is not available on your account yet.</p>
          <Link to="/dashboard" className="text-accent hover:underline">Back to the dashboard</Link>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-text-primary">Commercial services</h1>
        <p className="text-sm text-text-secondary">SLA clocks, approvals, consolidated billing and preventive maintenance for commercial customers.</p>
      </header>

      <div role="tablist" aria-label="Commercial sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} role="tab" id={`tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`panel-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`focus-ring whitespace-nowrap px-4 py-2 text-sm font-medium ${tab === t.key ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <Card className="p-4" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'timers' && (
          <Panel state={timers} empty="No running SLA timers. Start one from a job that falls under a contract with an SLA policy.">
            {(rows) => (
              <ul className="divide-y divide-border">
                {rows.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <div>
                      <p className="font-medium text-text-primary">{t.policy ? `${t.policy.kind} · ${t.policy.priority}` : 'Timer'} — {STATE_LABEL[t.state] ?? t.state}</p>
                      <p className="text-text-secondary">Due {t.due_at ? new Date(t.due_at).toLocaleString() : 'when resumed'}{t.pct_elapsed != null ? ` · ${Math.round(t.pct_elapsed)}% used` : ''}</p>
                    </div>
                    <div className="flex gap-2">
                      {t.state === 'paused'
                        ? <Button size="sm" variant="secondary" loading={busy === t.id} onClick={() => run(t.id, () => timerAction(t.id, 'resume'), 'Clock resumed.', timers.reload)}>Resume</Button>
                        : <Button size="sm" variant="secondary" loading={busy === t.id} onClick={() => run(t.id, () => timerAction(t.id, 'pause', 'Manual pause'), 'Clock paused.', timers.reload)}>Pause</Button>}
                      <Button size="sm" loading={busy === t.id} onClick={() => run(t.id, () => timerAction(t.id, 'stop'), 'Timer stopped.', timers.reload)}>Mark met</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {tab === 'approvals' && (
          <Panel state={approvals} empty="No approval requests yet.">
            {(rows) => (
              <ul className="divide-y divide-border">
                {rows.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <div>
                      <p className="font-medium text-text-primary">{a.work_order?.work_order_number ?? 'Work order'} · {a.work_order?.title}</p>
                      <p className="text-text-secondary">{money(a.amount_cents)}{a.work_order?.po_number ? ` · PO ${a.work_order.po_number}` : ''} · needs {a.required_steps.join(' → ')} · {a.status}</p>
                    </div>
                    {a.status === 'pending' && (
                      <div className="flex gap-2">
                        <Button size="sm" loading={busy === a.id} onClick={() => run(a.id, () => decideApproval(a.id, 'approve'), 'Decision recorded.', approvals.reload)}>Approve</Button>
                        <Button size="sm" variant="danger" loading={busy === a.id} onClick={() => run(a.id, () => decideApproval(a.id, 'reject'), 'Request rejected.', approvals.reload)}>Reject</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {tab === 'statements' && (
          <Panel state={statements} empty="No statements yet.">
            {(rows) => (
              <ul className="divide-y divide-border">
                {rows.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <div>
                      <p className="font-medium text-text-primary">{s.period_start} → {s.period_end} · {money(s.total_cents)}</p>
                      <p className="text-text-secondary">Due {s.due_on} · {s.status}</p>
                    </div>
                    {s.status === 'draft' && <Button size="sm" loading={busy === s.id} onClick={() => run(s.id, () => issueStatement(s.id), 'Statement issued.', statements.reload)}>Issue</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {tab === 'pm' && (
          <Panel state={pm} empty="No preventive maintenance due in the next 30 days.">
            {(rows) => (
              <ul className="divide-y divide-border">
                {rows.map((p) => (
                  <li key={p.id} className="py-3 text-sm">
                    <p className="font-medium text-text-primary">{p.name}</p>
                    <p className="text-text-secondary">{p.days_until < 0 ? `${-p.days_until} days overdue` : p.days_until === 0 ? 'Due today' : `Due in ${p.days_until} days`} · {p.next_due_date}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </Card>
    </main>
  );
}
