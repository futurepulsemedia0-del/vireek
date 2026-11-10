import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { createClaim, fetchClaims, fetchUnits, friendlySolarError, setClaimStatus, useAsyncData, type SolarClaim } from '@/lib/solarApi';
import { CLAIM_RESOLUTIONS, CLAIM_STATUS_LABELS, CLAIM_TRANSITIONS, claimTransitionError, type ClaimResolution, type ClaimStatus } from '@/lib/tradePacks/solarPipeline';
import { Pill, SelectField, fmtDate } from './shared';

const NOTE_MOVES: ClaimStatus[] = ['denied', 'withdrawn'];

export function SolarClaimsView({ ownerId, projectId, canManage }: { ownerId: string; projectId: string; canManage: boolean }) {
  const { toast } = useToast();
  const claims = useAsyncData(() => fetchClaims(ownerId, projectId), [ownerId, projectId], 'Could not load claims.');
  const units = useAsyncData(() => fetchUnits(ownerId, projectId), [ownerId, projectId], 'Could not load equipment.');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ unit_id: '', serial: '', failure_date: '', description: '', goodwill: false });
  const [pending, setPending] = useState<{ c: SolarClaim; to: ClaimStatus } | null>(null);
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState<ClaimResolution | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true); setError(null);
    try { await createClaim(ownerId, { project_id: projectId, ...f }); toast('Draft claim created', 'success'); setAdding(false); setF({ unit_id: '', serial: '', failure_date: '', description: '', goodwill: false }); await claims.reload(); }
    catch (e) { setError(friendlySolarError(e)); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try { await setClaimStatus(pending.c.id, pending.to, { note, resolution: resolution || null }); toast(`Claim → ${CLAIM_STATUS_LABELS[pending.to]}`, 'success'); setPending(null); setNote(''); setResolution(''); await claims.reload(); }
    catch (e) { toast(friendlySolarError(e), 'error'); } finally { setBusy(false); }
  };

  if (claims.loading) return <Skeleton className="h-40 w-full rounded-2xl" />;
  const list = claims.data ?? [];
  const unitList = units.data ?? [];
  const pendingErr = pending ? claimTransitionError(pending.c, pending.to, note, resolution || null) : null;

  return (
    <div className="space-y-4">
      {claims.error && <p className="text-sm text-danger" role="alert">{claims.error}</p>}
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">Warranty claims against registered equipment. Coverage is checked against the failure date.</p>
        {!adding && <Button onClick={() => setAdding(true)} disabled={unitList.length === 0}>New claim</Button>}
      </div>
      {unitList.length === 0 && <p className="text-sm text-text-secondary">Register equipment first to file a claim.</p>}
      {adding && (
        <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField label="Equipment" required value={f.unit_id} onChange={(v) => setF({ ...f, unit_id: v })}>
              <option value="">Choose…</option>
              {unitList.map((u) => <option key={u.id} value={u.id}>{u.component_kind} — {[u.make, u.model].filter(Boolean).join(' ') || 'unnamed'}</option>)}
            </SelectField>
            <Input label="Serial (optional)" value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} />
            <Input label="Failure date" type="date" required value={f.failure_date} onChange={(e) => setF({ ...f, failure_date: e.target.value })} />
          </div>
          <Textarea label="What failed?" required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.goodwill} onChange={(e) => setF({ ...f, goodwill: e.target.checked })} /> Goodwill request (allows filing outside warranty)</label>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex gap-2"><Button onClick={create} loading={busy} disabled={!f.unit_id || !f.failure_date || f.description.trim().length < 5}>Create draft</Button><Button variant="ghost" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button></div>
        </div>
      )}
      {list.length === 0 && !adding ? <p className="text-sm text-text-secondary">No warranty claims yet.</p> : (
        <ul className="space-y-3">
          {list.map((c) => (
            <li key={c.id} className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-text-primary">Failure {fmtDate(c.failure_date)}</span>
                <span className="flex gap-2">
                  <Pill tone={c.warranty_state === 'in_warranty' ? 'success' : c.warranty_state === 'expired' ? 'danger' : 'neutral'}>{c.warranty_state === 'in_warranty' ? 'In warranty' : c.warranty_state === 'expired' ? 'Out of warranty' : 'Coverage unknown'}{c.goodwill ? ' · goodwill' : ''}</Pill>
                  <Pill>{CLAIM_STATUS_LABELS[c.status]}</Pill>
                </span>
              </div>
              <p className="mt-1 text-text-secondary">{c.description}</p>
              {c.resolution && <p className="mt-1 text-text-secondary">Resolution: {c.resolution}</p>}
              {canManage && CLAIM_TRANSITIONS[c.status].length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {CLAIM_TRANSITIONS[c.status].map((to) => <Button key={to} size="sm" variant="secondary" disabled={busy} onClick={() => { setPending({ c, to }); setNote(''); setResolution(c.resolution ?? ''); }}>{CLAIM_STATUS_LABELS[to]}</Button>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <div className="space-y-3 rounded-2xl border border-accent/40 bg-accent/5 p-4" role="group" aria-label="Confirm claim change">
          <p className="text-sm font-medium text-text-primary">{CLAIM_STATUS_LABELS[pending.c.status]} → {CLAIM_STATUS_LABELS[pending.to]}</p>
          {pending.to === 'resolved' && (
            <SelectField label="Resolution" required value={resolution} onChange={(v) => setResolution(v as ClaimResolution)}>
              <option value="">Choose…</option>{CLAIM_RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </SelectField>
          )}
          <Textarea label={NOTE_MOVES.includes(pending.to) ? 'Reason (min 5 characters)' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
          {pendingErr && <p className="text-sm text-danger" role="alert">{pendingErr}</p>}
          <div className="flex gap-2"><Button onClick={confirm} loading={busy} disabled={!!pendingErr}>Confirm</Button><Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>Cancel</Button></div>
        </div>
      )}
    </div>
  );
}
