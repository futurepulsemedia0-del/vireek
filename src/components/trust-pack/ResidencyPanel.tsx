import { useMemo, useState } from 'react';
import { Globe2, Server } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  cancelRegionChange, chooseRegion, fetchChangeRequests, fetchDedicated, fetchRegions, fetchResidency,
  requestDedicated, requestRegionChange, withdrawDedicated,
} from '@/lib/trustPack/api';
import { REGIONS, REGION_CODES, RESIDENCY_SCOPE, isRegionCode, regionLabel, type RegionCode } from '@/lib/trustPack/regions';
import { residencyImpact } from '@/lib/trustPack/subprocessorResidency';
import { Badge, Card, Field, PanelError, PanelSkeleton, Spinner, fmtDate, inputClass, useLoader, type Tone } from './ui';

const SCOPE_TONE: Record<string, { tone: Tone; label: string }> = {
  enforced: { tone: 'ok', label: 'Pinned to your region' },
  control_plane: { tone: 'neutral', label: 'Primary control plane' },
  third_party: { tone: 'warn', label: 'Processed in the US' },
};
const REQ_TONE: Record<string, Tone> = { pending: 'warn', approved: 'ok', rejected: 'bad', completed: 'ok', cancelled: 'neutral' };
const DED_LABEL: Record<string, string> = {
  requested: 'Requested — our team will contact you', provisioning: 'Being provisioned', active: 'Active', suspended: 'Suspended', declined: 'Declined',
};

export function ResidencyPanel({ ownerId, isOwner }: { ownerId: string; isOwner: boolean }) {
  const { toast } = useToast();
  const { data, status, error, reload, retry } = useLoader(async () => {
    const [regions, residency, requests, dedicated] = await Promise.all([
      fetchRegions(), fetchResidency(ownerId), fetchChangeRequests(ownerId), fetchDedicated(ownerId),
    ]);
    return { regions, residency, requests, dedicated };
  });

  const [pick, setPick] = useState<RegionCode>('us');
  const [confirmPick, setConfirmPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<RegionCode | ''>('');
  const [reason, setReason] = useState('');
  const [dedNote, setDedNote] = useState('');

  const current: RegionCode = data?.residency?.region && isRegionCode(data.residency.region) ? data.residency.region : 'us';
  const impact = useMemo(() => residencyImpact(current), [current]);
  const available = useMemo(() => new Set((data?.regions ?? []).filter((r) => r.is_available && !!r.enforced_at).map((r) => r.code)), [data]);

  if (status === 'loading') return <PanelSkeleton />;
  if (status === 'error' || !data) return <PanelError message={error || 'Could not load residency settings.'} onRetry={retry} />;

  const open = data.requests.find((r) => r.status === 'pending' || r.status === 'approved');
  const reasonError = reason.trim().length > 0 && reason.trim().length < 10 ? 'Please give at least 10 characters.' : undefined;

  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <Card title="Data region" icon={Globe2} aside={data.residency ? <Badge tone="ok">Locked</Badge> : <Badge>Default</Badge>}>
        {!data.residency ? (
          <>
            <p className="text-sm text-text-secondary">
              Choose where your call recordings and sealed fields are stored. Until you choose, everything stays in the United States.
              {!isOwner && ' Only the account owner can choose a region.'}
            </p>
            <fieldset className="mt-4 grid gap-3 sm:grid-cols-3" disabled={!isOwner || busy}>
              <legend className="sr-only">Data region</legend>
              {REGION_CODES.map((code) => {
                const ok = available.has(code);
                return (
                  <label key={code} className={`rounded-xl border p-4 text-sm transition-colors ${pick === code ? 'border-accent bg-accent/5' : 'border-border'} ${ok ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                    <input type="radio" name="region" className="sr-only" checked={pick === code} disabled={!ok} onChange={() => setPick(code)} />
                    <span className="block font-semibold text-text-primary">{REGIONS[code].label}</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">{REGIONS[code].frameworks.join(' · ')}</span>
                    {!ok && <span className="mt-2 block text-xs text-amber-600 dark:text-amber-400">Not available yet</span>}
                  </label>
                );
              })}
            </fieldset>
            <div className="mt-4">
              <Button disabled={!isOwner || busy || !available.has(pick)} onClick={() => setConfirmPick(true)}>Lock {REGIONS[pick].label}</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-text-secondary">
              Your region is <strong className="text-text-primary">{regionLabel(current)}</strong>, chosen {fmtDate(data.residency.selected_at)}.
              Writes to any other region are rejected by the platform.
            </p>

            <h3 className="mt-6 text-sm font-semibold text-text-primary">Request a region change</h3>
            {open ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                <Badge tone={REQ_TONE[open.status]}>{open.status}</Badge>
                {regionLabel(open.from_region)} → {regionLabel(open.to_region)}
                {open.status === 'pending' && isOwner && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => cancelRegionChange(open.id), 'Request withdrawn')}>Withdraw</Button>
                )}
                {open.status === 'approved' && <span>Approved — our team is moving your data.</span>}
              </div>
            ) : (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Move to">
                  <select className={inputClass} value={target} disabled={!isOwner || busy} onChange={(e) => setTarget(e.target.value as RegionCode | '')}>
                    <option value="">Select a region…</option>
                    {REGION_CODES.filter((c) => c !== current && available.has(c)).map((c) => <option key={c} value={c}>{REGIONS[c].label}</option>)}
                  </select>
                </Field>
                <Field label="Reason" error={reasonError}>
                  <textarea className={inputClass} rows={2} maxLength={1000} value={reason} disabled={!isOwner || busy} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <div className="sm:col-span-2">
                  <Button size="sm" variant="secondary" disabled={!isOwner || busy || !target || reason.trim().length < 10}
                    onClick={() => run(async () => { await requestRegionChange(ownerId, target as RegionCode, reason); setTarget(''); setReason(''); }, 'Request sent')}>
                    {busy ? <Spinner /> : null} Send request
                  </Button>
                  <p className="mt-2 text-xs text-text-secondary">Changes are reviewed by our team and are blocked while a legal hold is active.</p>
                </div>
              </div>
            )}
            {data.requests.filter((r) => r !== open).length > 0 && (
              <ul className="mt-4 space-y-1 text-xs text-text-secondary">
                {data.requests.filter((r) => r !== open).map((r) => (
                  <li key={r.id}><Badge tone={REQ_TONE[r.status]}>{r.status}</Badge> {regionLabel(r.from_region)} → {regionLabel(r.to_region)} · {fmtDate(r.created_at)}{r.decision_note ? ` — ${r.decision_note}` : ''}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <Card title="What is stored in your region" icon={Globe2}>
        <ul className="divide-y divide-border">
          {RESIDENCY_SCOPE.map((s) => (
            <li key={s.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">{s.label}</p>
                <p className="text-xs text-text-secondary">{s.note}</p>
              </div>
              <Badge tone={SCOPE_TONE[s.status].tone}>{SCOPE_TONE[s.status].label}</Badge>
            </li>
          ))}
        </ul>
        {impact.outsideRegion.length > 0 && (
          <div className="mt-4 rounded-xl bg-amber-500/5 p-4 text-sm text-text-secondary">
            <p className="font-medium text-text-primary">Sub-processors that handle data outside {regionLabel(current)}</p>
            <p className="mt-1">{impact.outsideRegion.map((p) => p.name).join(', ')}.</p>
            <p className="mt-2 text-xs">Review <a className="text-accent underline" href="/subprocessors">the full sub-processor list</a> and your DPA before enabling regional storage for regulated data.</p>
          </div>
        )}
        {impact.unclassified.length > 0 && (
          <p role="alert" className="mt-3 text-xs text-red-500">Unclassified sub-processors: {impact.unclassified.map((p) => p.name).join(', ')}.</p>
        )}
      </Card>

      <Card title="Dedicated tenant" icon={Server} aside={data.dedicated ? <Badge tone={data.dedicated.status === 'active' ? 'ok' : 'warn'}>{data.dedicated.status}</Badge> : undefined}>
        {data.dedicated ? (
          <div className="space-y-3 text-sm text-text-secondary">
            <p>{DED_LABEL[data.dedicated.status]} · requested {fmtDate(data.dedicated.requested_at)}{data.dedicated.activated_at ? ` · active since ${fmtDate(data.dedicated.activated_at)}` : ''}.</p>
            {data.dedicated.status === 'requested' && isOwner && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => withdrawDedicated(ownerId), 'Request withdrawn')}>Withdraw request</Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">An isolated deployment with its own storage and encryption boundary, in your chosen region. Provisioned by our team.</p>
            <Field label="Anything we should know? (optional)">
              <textarea className={inputClass} rows={2} maxLength={1000} value={dedNote} disabled={!isOwner || busy} onChange={(e) => setDedNote(e.target.value)} />
            </Field>
            <Button size="sm" variant="secondary" disabled={!isOwner || busy} onClick={() => run(() => requestDedicated(ownerId, dedNote), 'Request sent')}>
              {busy ? <Spinner /> : null} Request a dedicated tenant
            </Button>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmPick}
        title={`Lock ${REGIONS[pick].label}?`}
        description="Your region can only be changed later through a reviewed request. Recordings and sealed fields will be stored only in this region."
        confirmLabel="Lock region"
        onCancel={() => setConfirmPick(false)}
        onConfirm={async () => { setConfirmPick(false); await run(() => chooseRegion(ownerId, pick), 'Region locked'); }}
      />
    </div>
  );
}
