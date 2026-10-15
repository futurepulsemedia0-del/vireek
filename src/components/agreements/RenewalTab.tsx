import { useState } from 'react';
import { CalendarCheck, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase } from '@/lib/supabase';
import {
  RENEWAL_STATUS_LABELS,
  addMonths,
  applyPriceChange,
  formatDate,
  formatMoney,
  friendlyWriteError,
  insertAgreementRow,
  parseDay,
  toDateKey,
  updateAgreementRow,
  type RenewalRow,
  type RenewalStatus,
  type WriteResult,
} from '@/lib/serviceAgreement';
import { FormActions, KeyValue, Panel, Pill, StatTile, centsToDollarsText, dollarsToCents, type TabProps } from './AgreementUi';
import { useAgreementActions } from './useAgreementActions';

const RISK_STYLES = {
  none: 'bg-bg-tertiary text-text-secondary',
  watch: 'bg-accent/10 text-accent',
  urgent: 'bg-warning-500/10 text-warning-500',
  lapsed: 'bg-danger/10 text-danger',
  secured: 'bg-success-500/10 text-success-500',
} as const;

const STATUS_STYLES: Record<RenewalStatus, string> = {
  pending: 'bg-warning-500/10 text-warning-500',
  quoted: 'bg-accent/10 text-accent',
  accepted: 'bg-success-500/10 text-success-500',
  declined: 'bg-danger/10 text-danger',
  lapsed: 'bg-bg-tertiary text-text-secondary',
};

export function RenewalTab({ data, derived, canManage, canSeeMoney, ownerId, reload }: TabProps) {
  const { busy, run } = useAgreementActions(reload);
  const { contract } = data;
  const { renewalState: rs } = derived;
  const open = data.renewals.find((r) => r.status === 'pending' || r.status === 'quoted') ?? null;
  const history = data.renewals.filter((r) => r !== open);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [changes, setChanges] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<RenewalRow | null>(null);

  const termMonths = data.terms.renewal.term_months ?? 12;

  const begin = (r: RenewalRow | null) => {
    const base = contract.end_date ? parseDay(contract.end_date) : new Date();
    const nextStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
    setValue(centsToDollarsText(r?.proposed_value_cents ?? contract.contract_value_cents));
    setStart(r?.proposed_start ?? toDateKey(nextStart));
    setEnd(r?.proposed_end ?? toDateKey(new Date(addMonths(nextStart, termMonths).getTime() - 86_400_000)));
    setChanges(r?.proposed_changes ?? '');
    setError(null);
    setEditing(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cents = dollarsToCents(value);
    if (cents === null) return setError('Enter the proposed fee as a positive dollar amount.');
    if (!end) return setError('Choose the new end date.');
    if (start && end < start) return setError('The new end date must be after the start date.');
    setError(null);
    const payload = { proposed_value_cents: cents ?? null, proposed_start: start || null, proposed_end: end, proposed_changes: changes.trim() || null };
    const ok = await run(
      () => (open ? updateAgreementRow('agreement_renewals', open.id, payload) : insertAgreementRow('agreement_renewals', ownerId, { ...payload, contract_id: contract.id, status: 'pending' })),
      open ? 'Renewal proposal updated.' : 'Renewal started.'
    );
    if (ok) setEditing(false);
  };

  const setStatus = (r: RenewalRow, status: RenewalStatus, msg: string) => run(() => updateAgreementRow('agreement_renewals', r.id, { status }), msg);

  /** Accepting extends THIS agreement in place (same contract, so jobs, history and PM plans carry on). */
  const accept = async (r: RenewalRow) => {
    if (!r.proposed_end) return;
    const patch: Record<string, unknown> = { end_date: r.proposed_end, status: 'active' };
    await run(async () => {
      if (r.proposed_value_cents !== null && r.proposed_value_cents !== contract.contract_value_cents) {
        const price = await applyPriceChange({
          ownerId,
          contractId: contract.id,
          kind: 'renewal',
          previousCents: contract.contract_value_cents,
          newCents: r.proposed_value_cents,
          effectiveDate: r.proposed_start ?? toDateKey(new Date()),
          reason: 'Renewal accepted',
        });
        if (price.error) return price;
      }
      const upd = await supabaseUpdateContract(contract.id, patch);
      if (upd.error) return upd;
      return updateAgreementRow('agreement_renewals', r.id, { status: 'accepted' });
    }, 'Renewal accepted — the agreement now runs to the new end date.');
    setAccepting(null);
  };

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Days to expiry" value={rs.daysLeft === null ? '—' : rs.daysLeft < 0 ? `${-rs.daysLeft} ago` : rs.daysLeft} icon={CalendarCheck} tone={rs.risk === 'urgent' || rs.risk === 'lapsed' ? 'text-danger' : 'text-accent'} />
        <StatTile label="Notice window" value={`${contract.renewal_notice_days} days`} icon={CalendarCheck} />
        <StatTile label="Auto-renew" value={contract.auto_renew ? 'On' : 'Off'} icon={RefreshCcw} />
        <StatTile label="Ends" value={contract.end_date ? formatDate(contract.end_date) : 'Open-ended'} icon={CalendarCheck} />
      </div>

      <Panel
        title="Renewal"
        description="Track the renewal from first proposal to signed extension."
        action={
          canManage && !open && contract.end_date ? (
            <Button size="sm" onClick={() => begin(null)} disabled={editing}>
              Start renewal
            </Button>
          ) : undefined
        }
      >
        <div className="mb-4 flex items-center gap-2">
          <Pill className={RISK_STYLES[rs.risk]}>{rs.headline}</Pill>
        </div>

        {editing && (
          <form onSubmit={submit} className="mb-4 grid gap-3 rounded-lg border border-border bg-bg-primary p-4 sm:grid-cols-3">
            {canSeeMoney && <Input label="Proposed fee per period ($)" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} helperText={`Current: ${formatMoney(contract.contract_value_cents)}`} />}
            <Input label="New term starts" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <Input label="New term ends" type="date" required value={end} onChange={(e) => setEnd(e.target.value)} />
            <div className="sm:col-span-3">
              <Textarea label="Proposed changes" rows={3} maxLength={4000} placeholder="Scope changes, new SLA, added equipment…" value={changes} onChange={(e) => setChanges(e.target.value)} />
            </div>
            {error && <p className="text-sm text-danger sm:col-span-3" role="alert">{error}</p>}
            <div className="sm:col-span-3">
              <FormActions busy={busy} onCancel={() => setEditing(false)} submitLabel={open ? 'Save proposal' : 'Start renewal'} />
            </div>
          </form>
        )}

        {open ? (
          <div className="rounded-lg border border-border bg-bg-primary p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <p className="flex-1 text-sm font-medium text-text-primary">Open renewal</p>
              <Pill className={STATUS_STYLES[open.status]}>{RENEWAL_STATUS_LABELS[open.status]}</Pill>
            </div>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {canSeeMoney && <KeyValue label="Proposed fee" value={formatMoney(open.proposed_value_cents)} />}
              <KeyValue label="New term" value={`${formatDate(open.proposed_start)} → ${formatDate(open.proposed_end)}`} />
              <KeyValue label="Quote sent" value={formatDate(open.quoted_at)} />
              <KeyValue label="Started" value={formatDate(open.created_at)} />
            </dl>
            {open.proposed_changes && <p className="mt-3 whitespace-pre-line text-sm text-text-secondary">{open.proposed_changes}</p>}
            {canManage && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => begin(open)} disabled={editing || busy}>Edit proposal</Button>
                {open.status === 'pending' && <Button size="sm" variant="secondary" onClick={() => setStatus(open, 'quoted', 'Marked as quote sent.')} disabled={busy}>Mark quote sent</Button>}
                <Button size="sm" onClick={() => setAccepting(open)} disabled={busy || !open.proposed_end}>Customer accepted</Button>
                <Button size="sm" variant="ghost" onClick={() => setStatus(open, 'declined', 'Marked as declined.')} disabled={busy}>Declined</Button>
              </div>
            )}
          </div>
        ) : (
          !editing && (
            <EmptyState icon={RefreshCcw} title="No renewal in progress" description={contract.end_date ? 'Start a renewal before the notice window opens so the customer never lapses.' : 'This agreement is open-ended, so there is nothing to renew.'} />
          )
        )}
      </Panel>

      {history.length > 0 && (
        <Panel title="Renewal history">
          <ul className="divide-y divide-border">
            {history.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">
                    {formatDate(r.proposed_start)} → {formatDate(r.proposed_end)}
                    {canSeeMoney && r.proposed_value_cents !== null ? ` · ${formatMoney(r.proposed_value_cents)}` : ''}
                  </p>
                  <p className="text-xs text-text-secondary">Decided {formatDate(r.decided_at)}</p>
                </div>
                <Pill className={STATUS_STYLES[r.status]}>{RENEWAL_STATUS_LABELS[r.status]}</Pill>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <ConfirmDialog
        open={accepting !== null}
        title="Accept this renewal?"
        description={`The agreement will run until ${formatDate(accepting?.proposed_end)} and the status will be set to Active${accepting?.proposed_value_cents != null && accepting.proposed_value_cents !== contract.contract_value_cents ? `, with the fee changing to ${formatMoney(accepting.proposed_value_cents)}` : ''}. This is recorded in the audit log.`}
        confirmLabel="Yes, accept renewal"
        onConfirm={async () => {
          if (accepting) await accept(accepting);
        }}
        onCancel={() => setAccepting(null)}
      />
    </>
  );
}

async function supabaseUpdateContract(id: string, patch: Record<string, unknown>): Promise<WriteResult> {
  const { error } = await supabase.from('commercial_contracts').update(patch).eq('id', id);
  return { error: error ? friendlyWriteError(error) : null };
}
