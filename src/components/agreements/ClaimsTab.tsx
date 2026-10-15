import { useMemo, useState } from 'react';
import { FileWarning, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { BREACH_SEVERITY_LABELS, BREACH_TYPE_LABELS, type BreachType } from '@/lib/contracts';
import {
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_OPTIONS,
  CLAIM_STATUS_STYLES,
  CLAIM_TYPE_LABELS,
  CLAIM_TYPE_OPTIONS,
  claimCashCents,
  deleteAgreementRow,
  formatDate,
  formatMoney,
  insertAgreementRow,
  updateAgreementRow,
  type ClaimStatus,
  type ClaimType,
} from '@/lib/serviceAgreement';
import { DeleteConfirm, FormActions, Panel, Pill, RowActions, SelectField, StatTile, centsToDollarsText, dollarsToCents, useInlineForm, type TabProps } from './AgreementUi';
import { useAgreementActions } from './useAgreementActions';
import { Banknote, Hourglass, Undo2 } from 'lucide-react';

interface ClaimForm {
  claim_type: ClaimType;
  status: ClaimStatus;
  title: string;
  description: string;
  claimed: string;
  approved: string;
  settled: string;
  breach_id: string;
  job_id: string;
  resolution_notes: string;
}
const EMPTY_CLAIM: ClaimForm = { claim_type: 'coverage_dispute', status: 'open', title: '', description: '', claimed: '', approved: '', settled: '', breach_id: '', job_id: '', resolution_notes: '' };

export function ClaimsTab({ data, canManage, canSeeMoney, ownerId, reload }: TabProps) {
  const { busy, run } = useAgreementActions(reload);
  const form = useInlineForm<ClaimForm>(EMPTY_CLAIM);
  const [deleting, setDeleting] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const breachOptions = useMemo(
    () => [
      { value: '', label: 'Not linked to a breach' },
      ...data.breaches.map((b) => ({ value: b.id, label: `${formatDate(b.created_at)} · ${BREACH_TYPE_LABELS[b.breach_type as BreachType] ?? b.breach_type} · ${BREACH_SEVERITY_LABELS[b.severity]}` })),
    ],
    [data.breaches]
  );
  const jobOptions = useMemo(() => [{ value: '', label: 'Not linked to a job' }, ...data.jobs.slice(0, 150).map((j) => ({ value: j.id, label: `${formatDate(j.created_at)} · ${j.service_type ?? 'Job'}` }))], [data.jobs]);

  const totals = useMemo(() => {
    const cash = data.claims.map(claimCashCents);
    return {
      open: data.claims.filter((c) => c.status === 'open' || c.status === 'under_review').length,
      exposure: data.claims.filter((c) => (c.status === 'open' || c.status === 'under_review') && c.claim_type !== 'warranty_recovery').reduce((s, c) => s + (c.claimed_cents ?? 0), 0),
      paid: cash.reduce((s, c) => s + c.out, 0),
      recovered: cash.reduce((s, c) => s + c.in, 0),
    };
  }, [data.claims]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = form.form;
    const claimed = dollarsToCents(f.claimed);
    const approved = dollarsToCents(f.approved);
    const settled = dollarsToCents(f.settled);
    if (!f.title.trim()) return setError('Give the claim a title.');
    if (claimed === null || approved === null || settled === null) return setError('Amounts must be positive dollar values.');
    if (f.status === 'settled' && settled === undefined && approved === undefined) return setError('Enter the settled amount (or approved amount) for a settled claim.');
    setError(null);
    const payload = {
      claim_type: f.claim_type,
      status: f.status,
      title: f.title.trim(),
      description: f.description.trim() || null,
      claimed_cents: claimed ?? null,
      approved_cents: approved ?? null,
      settled_cents: settled ?? null,
      breach_id: f.breach_id || null,
      job_id: f.job_id || null,
      resolution_notes: f.resolution_notes.trim() || null,
    };
    const ok = await run(
      () => (form.editingId ? updateAgreementRow('agreement_claims', form.editingId, payload) : insertAgreementRow('agreement_claims', ownerId, { ...payload, contract_id: data.contract.id })),
      form.editingId ? 'Claim updated.' : 'Claim opened.'
    );
    if (ok) form.close();
  };

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open claims" value={totals.open} icon={Hourglass} tone={totals.open ? 'text-warning-500' : 'text-success-500'} />
        {canSeeMoney && <StatTile label="Open exposure" value={formatMoney(totals.exposure)} icon={FileWarning} tone="text-warning-500" />}
        {canSeeMoney && <StatTile label="Paid out" value={formatMoney(totals.paid)} icon={Banknote} tone="text-danger" />}
        {canSeeMoney && <StatTile label="Recovered from manufacturers" value={formatMoney(totals.recovered)} icon={Undo2} tone="text-success-500" />}
      </div>

      <Panel
        title="Claims"
        description="Coverage disputes, SLA credits and manufacturer recoveries tied to this agreement. Payouts and recoveries feed the profitability view."
        action={
          canManage ? (
            <Button size="sm" onClick={() => form.start(EMPTY_CLAIM)} disabled={form.open}>
              <Plus size={14} aria-hidden="true" /> New claim
            </Button>
          ) : undefined
        }
      >
        {form.open && (
          <form onSubmit={submit} className="mb-4 grid gap-3 rounded-lg border border-border bg-bg-primary p-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Input label="Title" required maxLength={200} value={form.form.title} onChange={(e) => form.patch({ title: e.target.value })} />
            </div>
            <SelectField label="Type" value={form.form.claim_type} onChange={(v) => form.patch({ claim_type: v })} options={CLAIM_TYPE_OPTIONS.map((t) => ({ value: t, label: CLAIM_TYPE_LABELS[t] }))} />
            <SelectField label="Status" value={form.form.status} onChange={(v) => form.patch({ status: v })} options={CLAIM_STATUS_OPTIONS.map((s) => ({ value: s, label: CLAIM_STATUS_LABELS[s] }))} />
            <SelectField label="Related SLA breach" value={form.form.breach_id} onChange={(v) => form.patch({ breach_id: v })} options={breachOptions} />
            <SelectField label="Related job" value={form.form.job_id} onChange={(v) => form.patch({ job_id: v })} options={jobOptions} />
            {canSeeMoney && (
              <>
                <Input label="Claimed ($)" inputMode="decimal" value={form.form.claimed} onChange={(e) => form.patch({ claimed: e.target.value })} />
                <Input label="Approved ($)" inputMode="decimal" value={form.form.approved} onChange={(e) => form.patch({ approved: e.target.value })} />
                <Input label="Settled ($)" inputMode="decimal" helperText="Cash actually paid or received." value={form.form.settled} onChange={(e) => form.patch({ settled: e.target.value })} />
              </>
            )}
            <div className="sm:col-span-2">
              <Textarea label="Description" rows={3} maxLength={4000} value={form.form.description} onChange={(e) => form.patch({ description: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Textarea label="Resolution notes" rows={2} maxLength={4000} value={form.form.resolution_notes} onChange={(e) => form.patch({ resolution_notes: e.target.value })} />
            </div>
            {error && <p className="text-sm text-danger sm:col-span-2" role="alert">{error}</p>}
            <div className="sm:col-span-2">
              <FormActions busy={busy} onCancel={() => { setError(null); form.close(); }} submitLabel={form.editingId ? 'Save changes' : 'Open claim'} />
            </div>
          </form>
        )}

        {data.claims.length === 0 ? (
          <EmptyState icon={FileWarning} title="No claims" description="Open a claim when a customer disputes coverage, an SLA credit is owed, or you are recovering cost from a manufacturer." />
        ) : (
          <ul className="divide-y divide-border">
            {data.claims.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{c.title}</p>
                  <p className="text-xs text-text-secondary">
                    {CLAIM_TYPE_LABELS[c.claim_type]} · opened {formatDate(c.opened_at)}
                    {c.resolved_at ? ` · resolved ${formatDate(c.resolved_at)}` : ''}
                    {canSeeMoney && c.claimed_cents !== null ? ` · claimed ${formatMoney(c.claimed_cents)}` : ''}
                    {canSeeMoney && c.settled_cents !== null ? ` · settled ${formatMoney(c.settled_cents)}` : canSeeMoney && c.approved_cents !== null ? ` · approved ${formatMoney(c.approved_cents)}` : ''}
                  </p>
                  {c.description && <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">{c.description}</p>}
                </div>
                <Pill className={CLAIM_STATUS_STYLES[c.status]}>{CLAIM_STATUS_LABELS[c.status]}</Pill>
                {canManage && (
                  <RowActions
                    label={c.title}
                    onEdit={() =>
                      form.start(
                        {
                          claim_type: c.claim_type,
                          status: c.status,
                          title: c.title,
                          description: c.description ?? '',
                          claimed: centsToDollarsText(c.claimed_cents),
                          approved: centsToDollarsText(c.approved_cents),
                          settled: centsToDollarsText(c.settled_cents),
                          breach_id: c.breach_id ?? '',
                          job_id: c.job_id ?? '',
                          resolution_notes: c.resolution_notes ?? '',
                        },
                        c.id
                      )
                    }
                    onDelete={() => setDeleting({ id: c.id, label: c.title })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <DeleteConfirm target={deleting} noun="claim" onCancel={() => setDeleting(null)} onConfirm={async (id) => { await run(() => deleteAgreementRow('agreement_claims', id), 'Claim deleted.'); setDeleting(null); }} />
    </>
  );
}
