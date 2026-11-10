import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { fetchEvents, fetchStages, friendlySolarError, setStageStatus, updateStageMeta, useAsyncData, type SolarJurisdiction, type SolarStage } from '@/lib/solarApi';
import { fetchTeam, type TeamOption } from '@/lib/tradePacksApi';
import {
  MIN_NOTE_LENGTH, SOLAR_STAGE_LABELS, STAGE_NOTE_REQUIRED, STAGE_STATUS_LABELS, availableStageMoves, isStageOverdue, stageTransitionError, suggestDueDate, summarizePipeline, type StageStatus,
} from '@/lib/tradePacks/solarPipeline';
import { Pill, SelectField, fmtDate, fmtDateTime } from './shared';

const today = () => new Date().toISOString().slice(0, 10);
const tone = (s: StageStatus) => (s === 'approved' ? 'success' : s === 'rejected' ? 'danger' : s === 'corrections_required' ? 'warning' : 'neutral');

export function SolarPipelineView({ ownerId, projectId, jurisdiction, canManage }: { ownerId: string; projectId: string; jurisdiction: SolarJurisdiction | null; canManage: boolean }) {
  const { toast } = useToast();
  const stages = useAsyncData(() => fetchStages(ownerId, projectId), [ownerId, projectId], 'Could not load the pipeline.');
  const events = useAsyncData(() => fetchEvents(ownerId, projectId), [ownerId, projectId], 'Could not load history.');
  const team = useAsyncData<TeamOption[]>(() => fetchTeam(ownerId), [ownerId], 'Could not load team.');
  const [pending, setPending] = useState<{ stage: SolarStage; to: StageStatus } | null>(null);
  const [note, setNote] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const list = stages.data ?? [];
  const summary = useMemo(() => summarizePipeline(list, today()), [list]);

  if (stages.loading) return <Skeleton className="h-48 w-full rounded-2xl" />;
  if (stages.error) return <p className="text-sm text-danger" role="alert">{stages.error}</p>;
  if (!list.length) return <p className="text-sm text-text-secondary">No pipeline stages yet.</p>;

  const reloadAll = async () => { await Promise.all([stages.reload(), events.reload()]); };
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); await reloadAll(); } catch (e) { toast(friendlySolarError(e), 'error'); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!pending) return;
    const { stage, to } = pending;
    await run(() => setStageStatus(stage, to, note, ref), `${SOLAR_STAGE_LABELS[stage.stage_key]} → ${STAGE_STATUS_LABELS[to]}`);
    setPending(null); setNote(''); setRef('');
  };
  const pendingError = pending ? stageTransitionError(pending.stage, pending.to, list, note) : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary" aria-live="polite">
        {summary.done}/{summary.total} stages done{summary.current ? ` · current: ${SOLAR_STAGE_LABELS[summary.current]}` : ' · pipeline complete'}
        {summary.overdue.length > 0 && <span className="text-danger"> · overdue: {summary.overdue.map((k) => SOLAR_STAGE_LABELS[k]).join(', ')}</span>}
      </p>
      <ol className="space-y-3">
        {list.map((s) => {
          const moves = availableStageMoves(s, list);
          const blocked = s.status === 'not_started' && stageTransitionError(s, 'in_progress', list) !== null;
          const suggestion = suggestDueDate(s.stage_key, today(), jurisdiction?.stage_review_days);
          return (
            <li key={s.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-text-primary">{s.position}. {SOLAR_STAGE_LABELS[s.stage_key]}</h3>
                <div className="flex items-center gap-2">
                  {isStageOverdue(s, today()) && <Pill tone="danger">Overdue</Pill>}
                  {blocked && <Pill>Waiting on earlier stage</Pill>}
                  <Pill tone={tone(s.status)}>{STAGE_STATUS_LABELS[s.status]}</Pill>
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <SelectField label="Owner" value={s.owner_id ?? ''} disabled={!canManage || busy} onChange={(v) => run(() => updateStageMeta(ownerId, s.id, { owner_id: v || null }), 'Owner saved')}>
                  <option value="">Unassigned</option>
                  {(team.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.member_name ?? 'Team member'}</option>)}
                </SelectField>
                <Input label="Due date" type="date" value={s.due_date ?? ''} disabled={!canManage || busy} onChange={(e) => run(() => updateStageMeta(ownerId, s.id, { due_date: e.target.value || null }), 'Due date saved')}
                  helperText={!s.due_date && suggestion ? `Suggested ${fmtDate(suggestion)} from your jurisdiction profile` : undefined} />
                <Input label="Reference no." defaultValue={s.reference_number ?? ''} disabled={!canManage || busy} onBlur={(e) => { if ((e.target.value || null) !== s.reference_number) void run(() => updateStageMeta(ownerId, s.id, { reference_number: e.target.value.trim() || null }), 'Reference saved'); }} />
              </div>
              {canManage && moves.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {moves.map((to) => <Button key={to} size="sm" variant={to === 'approved' ? 'primary' : 'secondary'} disabled={busy} onClick={() => { setPending({ stage: s, to }); setNote(''); setRef(s.reference_number ?? ''); }}>{STAGE_STATUS_LABELS[to]}</Button>)}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {pending && (
        <div className="space-y-3 rounded-2xl border border-accent/40 bg-accent/5 p-4" role="group" aria-label="Confirm stage change">
          <p className="text-sm font-medium text-text-primary">{SOLAR_STAGE_LABELS[pending.stage.stage_key]}: {STAGE_STATUS_LABELS[pending.stage.status]} → {STAGE_STATUS_LABELS[pending.to]}</p>
          <Textarea label={STAGE_NOTE_REQUIRED.includes(pending.to) ? `Reason (min ${MIN_NOTE_LENGTH} characters)` : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
          {pending.to === 'submitted' && <Input label="Application / permit reference" value={ref} onChange={(e) => setRef(e.target.value)} />}
          {pendingError && <p className="text-sm text-danger" role="alert">{pendingError}</p>}
          <div className="flex gap-2">
            <Button onClick={confirm} loading={busy} disabled={!!pendingError}>Confirm</Button>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}

      <details className="rounded-2xl border border-border p-4 text-sm">
        <summary className="cursor-pointer font-medium text-text-primary">History</summary>
        {events.loading ? <Skeleton className="mt-2 h-16 w-full" /> : events.error ? <p className="mt-2 text-danger" role="alert">{events.error}</p> : (events.data ?? []).length === 0 ? <p className="mt-2 text-text-secondary">No changes yet.</p> : (
          <ul className="mt-2 space-y-1 text-text-secondary">
            {(events.data ?? []).map((e) => <li key={e.id}>{fmtDateTime(e.created_at)} — {e.entity_type}: {e.from_status ?? '—'} → {e.to_status}{e.note ? ` (${e.note})` : ''}</li>)}
          </ul>
        )}
      </details>
    </div>
  );
}
