import { useState } from 'react';
import { AlertTriangle, Banknote, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { Dialog, LoadError, StatusPill, useLoader, type Tone } from '@/components/commissions/shared';
import {
  fetchSpiffPayouts,
  generateSpiffPayouts,
  leaderboardErrorMessage,
  reviewSpiffPayout,
} from '@/lib/technicianLeaderboardApi';
import {
  PAYOUT_STATUS_LABEL,
  formatUsd,
  ordinal,
  periodLabel,
  summarizePayouts,
  type LeaderboardPeriod,
  type PayoutStatus,
  type SpiffPayout,
} from '@/lib/technicianLeaderboard';

const TONE: Record<PayoutStatus, Tone> = { pending: 'warning', approved: 'info', paid: 'success', rejected: 'neutral' };

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Card className="!p-4 hover:!translate-y-0">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${tone ?? 'text-text-primary'}`}>{value}</p>
    </Card>
  );
}

export function SpiffPayoutsPanel() {
  const { toast } = useToast();
  const payouts = useLoader(() => fetchSpiffPayouts(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<SpiffPayout | null>(null);
  const [note, setNote] = useState('');

  const list = payouts.data ?? [];
  const totals = summarizePayouts(list);
  const blocked = list.filter((p) => p.status === 'approved' && !p.pay_run_id && !p.has_payroll_profile);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    try { await fn(); if (ok) toast(ok, 'success'); payouts.reload(); }
    catch (e) { toast(leaderboardErrorMessage(e), 'error'); }
    finally { setBusy(null); }
  };

  const generate = (period: LeaderboardPeriod) =>
    run(`gen-${period}`, async () => {
      const r = await generateSpiffPayouts(period);
      toast(
        r.inserted === 0
          ? `No new bonuses for ${periodLabel(period, r.period_start, r.period_end)}.`
          : `${r.inserted} bonus${r.inserted === 1 ? '' : 'es'} (${formatUsd(r.total_cents)}) for ${periodLabel(period, r.period_start, r.period_end)}.`,
        'info',
      );
    }, '');

  const confirmReject = async () => {
    if (!rejecting) return;
    const target = rejecting;
    if (note.trim().length < 3) return toast('Add a short reason so there is an audit trail.', 'error');
    await run(`rej-${target.id}`, () => reviewSpiffPayout(target.id, 'reject', note.trim()), 'Bonus rejected.');
    setRejecting(null);
    setNote('');
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Needs approval" value={formatUsd(totals.pending)} tone={totals.pending > 0 ? 'text-warning-500' : undefined} />
        <Stat label="Waiting for next pay run" value={formatUsd(totals.awaitingPayroll)} />
        <Stat label="Paid" value={formatUsd(totals.paid)} tone="text-success-500" />
        <Stat label="Can’t be paid yet" value={formatUsd(totals.blocked)} tone={totals.blocked > 0 ? 'text-danger' : undefined} />
      </div>

      {blocked.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {blocked.length} approved bonus{blocked.length === 1 ? '' : 'es'} belong to technicians without an active payroll profile, so they will not appear in a pay run.{' '}
            <Link to="/dashboard/payroll" className="font-semibold underline">Add them in Payroll</Link>.
          </span>
        </div>
      )}

      <Card className="flex flex-col gap-3 !p-4 hover:!translate-y-0 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-secondary">
          Bonuses are created automatically when you start a pay run. You can also settle the latest finished period now to review it early. Safe to repeat — nothing is ever paid twice.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => generate('weekly')}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Weekly</Button>
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => generate('monthly')}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Monthly</Button>
        </div>
      </Card>

      {payouts.loading ? <SkeletonCardList count={3} rows={2} />
        : payouts.error ? <LoadError message={payouts.error} onRetry={payouts.reload} />
        : list.length === 0 ? (
          <EmptyState icon={Banknote} title="No bonuses yet" description="Once a period closes and a rule is met, the bonus shows up here and flows into the next pay run." />
        ) : (
          <ul className="space-y-2">
            {list.map((p) => (
              <li key={p.id}>
                <Card className="flex flex-col gap-3 !p-4 hover:!translate-y-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                      {p.technician_name}
                      <StatusPill tone={TONE[p.status]}>{PAYOUT_STATUS_LABEL[p.status]}</StatusPill>
                      {p.pay_run_id && p.status === 'approved' && <StatusPill tone="info">In pay run</StatusPill>}
                    </p>
                    <p className="text-sm text-text-secondary">
                      {p.rule_name}{p.rank ? ` · ${ordinal(p.rank)} place` : ''} · {periodLabel(p.period, p.period_start, p.period_end)}
                    </p>
                    {p.review_note && <p className="text-xs text-text-secondary">Note: {p.review_note}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-lg font-bold tabular-nums text-text-primary">{formatUsd(p.amount_cents)}</span>
                    {p.status === 'pending' && (
                      <Button size="sm" disabled={busy !== null} onClick={() => run(`app-${p.id}`, () => reviewSpiffPayout(p.id, 'approve'), 'Bonus approved.')}><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Approve</Button>
                    )}
                    {(p.status === 'pending' || (p.status === 'approved' && !p.pay_run_id)) && (
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setRejecting(p); setNote(''); }} aria-label={`Reject bonus for ${p.technician_name}`}><XCircle className="h-4 w-4" aria-hidden="true" /></Button>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}

      <Dialog
        open={!!rejecting}
        danger
        title="Reject this bonus?"
        description="It won’t be paid. The reason is kept in the record."
        onClose={() => setRejecting(null)}
        footer={<><Button variant="ghost" onClick={() => setRejecting(null)}>Cancel</Button><Button onClick={confirmReject} disabled={busy !== null}>Reject bonus</Button></>}
      >
        <p className="text-sm text-text-primary">{rejecting && `${rejecting.technician_name} · ${rejecting.rule_name} · ${formatUsd(rejecting.amount_cents)}`}</p>
        <Input label="Reason" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </div>
  );
}
