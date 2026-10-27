import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Phone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SkeletonRow } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  EMPTY_VISIT,
  OUTCOMES,
  OUTCOME_ORDER,
  QUICK_FOLLOW_UPS,
  formatAddress,
  hasErrors,
  localInputToIso,
  quickFollowUp,
  relativeTime,
  validateVisit,
  type Door,
  type DoorOutcome,
  type Territory,
  type Visit,
  type VisitDraft,
  type VisitErrors,
  type VisitLogResult,
} from '@/lib/canvassing';
import { listDoorVisits, logVisit } from '@/lib/canvassingApi';
import { Sheet, StatusBadge, TerritoryDot } from './canvassUi';

interface VisitSheetProps {
  door: Door | null;
  territory: Territory | null;
  isManager: boolean;
  myUserId: string | null;
  /** user id -> display name (managers only; reps see "You" / "Teammate"). */
  repNames: Map<string, string>;
  onClose: () => void;
  onSaved: (result: VisitLogResult) => void;
}

export function VisitSheet({ door, territory, isManager, myUserId, repNames, onClose, onSaved }: VisitSheetProps) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<VisitDraft>(EMPTY_VISIT);
  const [errors, setErrors] = useState<VisitErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ state: 'loading' | 'error' | 'ready'; rows: Visit[] }>({ state: 'loading', rows: [] });

  const doorId = door?.id ?? null;
  const loadHistory = useCallback(async (id: string, isCurrent: () => boolean) => {
    setHistory({ state: 'loading', rows: [] });
    try {
      const rows = await listDoorVisits(id);
      if (isCurrent()) setHistory({ state: 'ready', rows });
    } catch {
      if (isCurrent()) setHistory({ state: 'error', rows: [] });
    }
  }, []);

  useEffect(() => {
    setDraft(EMPTY_VISIT);
    setErrors({});
    setSubmitError(null);
    if (!doorId) return;
    let current = true;
    void loadHistory(doorId, () => current);
    return () => { current = false; };
  }, [doorId, loadHistory]);

  const locked = !!door && door.status === 'do_not_knock' && !isManager;
  const meta = draft.outcome ? OUTCOMES[draft.outcome] : null;
  const showContact = !!meta && (meta.needsContact || draft.outcome === 'callback');
  const showFollowUp = !!meta && meta.followUp !== 'none';

  const set = <K extends keyof VisitDraft>(key: K, value: VisitDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key === 'outcome' ? 'outcome' : key]: undefined }));
  };

  const submit = async () => {
    if (!door || submitting || locked) return;
    const errs = validateVisit(draft, { name: door.contact_name, phone: door.contact_phone, email: door.contact_email }, new Date());
    setErrors(errs);
    if (hasErrors(errs) || !draft.outcome) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await logVisit({
        doorId: door.id,
        outcome: draft.outcome,
        note: draft.note,
        contactName: draft.contactName,
        contactPhone: draft.contactPhone,
        contactEmail: draft.contactEmail,
        service: draft.service,
        followUpIso: showFollowUp && draft.followUp ? localInputToIso(draft.followUp) : null,
      });
      const parts = [res.duplicate ? 'Already saved a moment ago.' : `Saved: ${OUTCOMES[draft.outcome].label}.`];
      if (!res.duplicate && res.lead_id && !door.lead_id) parts.push('Lead created.');
      if (!res.duplicate && res.door.follow_up_at && showFollowUp && draft.followUp) parts.push('Follow-up scheduled.');
      toast(parts.join(' '), 'success');
      onSaved(res);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Could not save the visit. Nothing was lost — try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const who = (id: string | null) => (id && id === myUserId ? 'You' : (id && repNames.get(id)) || 'Teammate');

  return (
    <Sheet
      open={!!door}
      title={door ? door.line1 : 'Door'}
      description={door ? formatAddress({ ...door, line1: '', line2: door.line2 }).replace(/^,\s*/, '') || undefined : undefined}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" className="flex-1" onClick={() => void submit()} disabled={submitting || locked || !draft.outcome}>
            {submitting ? 'Saving…' : 'Save visit'}
          </Button>
        </>
      }
    >
      {door && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-secondary">
            <StatusBadge status={door.status} />
            {territory && <span className="inline-flex items-center gap-1.5"><TerritoryDot color={territory.color} />{territory.name}</span>}
            <span>{door.visit_count} {door.visit_count === 1 ? 'visit' : 'visits'}</span>
            {door.lead_id && <Link to={`/dashboard/leads/${door.lead_id}`} className="focus-ring rounded font-medium text-accent hover:underline">Open lead</Link>}
          </div>

          {(door.contact_name || door.contact_phone) && (
            <div className="rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm">
              <p className="font-medium text-text-primary">{door.contact_name ?? 'Contact'}</p>
              {door.contact_phone && (
                <a href={`tel:${door.contact_phone}`} className="focus-ring mt-1 inline-flex items-center gap-1.5 rounded text-accent hover:underline">
                  <Phone size={14} aria-hidden="true" /> {door.contact_phone}
                </a>
              )}
              {door.contact_email && <p className="mt-0.5 text-xs text-text-secondary">{door.contact_email}</p>}
            </div>
          )}

          {locked ? (
            <div role="status" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-text-primary">
              <Lock size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
              <p>This address is marked <strong>Do Not Knock</strong>. Do not visit. Only a manager can change it.</p>
            </div>
          ) : (
            <>
              <fieldset>
                <legend className="text-sm font-medium text-text-primary">What happened?</legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {OUTCOME_ORDER.map((o: DoorOutcome) => (
                    <label key={o} className={`focus-within:ring-2 focus-within:ring-accent/50 relative flex min-h-[56px] cursor-pointer flex-col justify-center rounded-xl border px-3 py-2 transition-colors ${draft.outcome === o ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:border-accent/40'}`}>
                      <input type="radio" name="visit-outcome" value={o} checked={draft.outcome === o} onChange={() => set('outcome', o)} className="sr-only" />
                      <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: OUTCOMES[o].color }} />
                        {OUTCOMES[o].label}
                      </span>
                      <span className="mt-0.5 text-[11px] leading-snug text-text-secondary">{OUTCOMES[o].hint}</span>
                    </label>
                  ))}
                </div>
                {errors.outcome && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.outcome}</p>}
              </fieldset>

              {showContact && (
                <div className="space-y-3">
                  <Input label="Contact name" value={draft.contactName} onChange={(e) => set('contactName', e.target.value)} error={errors.contactName}
                    placeholder={door.contact_name ?? ''} autoComplete="off" maxLength={120} required={!!meta?.needsContact && !door.contact_name} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input label="Phone" type="tel" inputMode="tel" value={draft.contactPhone} onChange={(e) => set('contactPhone', e.target.value)}
                      error={errors.contactPhone} placeholder={door.contact_phone ?? ''} autoComplete="off" maxLength={32} />
                    <Input label="Email" type="email" inputMode="email" value={draft.contactEmail} onChange={(e) => set('contactEmail', e.target.value)}
                      error={errors.contactEmail} placeholder={door.contact_email ?? ''} autoComplete="off" maxLength={254} />
                  </div>
                  {meta?.needsContact && <Input label="Service they asked about" value={draft.service} onChange={(e) => set('service', e.target.value)} error={errors.service} maxLength={120} placeholder="e.g. AC tune-up" />}
                </div>
              )}

              {showFollowUp && (
                <div>
                  <Input label={meta?.followUp === 'required' ? 'Follow up on' : 'Follow up on (optional)'} type="datetime-local" value={draft.followUp}
                    onChange={(e) => set('followUp', e.target.value)} error={errors.followUp} required={meta?.followUp === 'required'} />
                  <div className="mt-2 flex flex-wrap gap-2">
                    {QUICK_FOLLOW_UPS.map((q) => (
                      <button key={q.id} type="button" onClick={() => set('followUp', quickFollowUp(q.id, new Date()))}
                        className="focus-ring rounded-full border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-accent/40 hover:text-text-primary">
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <Textarea label="Note (optional)" value={draft.note} onChange={(e) => set('note', e.target.value)} error={errors.note} rows={3} maxLength={1000}
                  helperText={`${draft.note.length}/1000`} />
              </div>

              {submitError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger">{submitError}</p>}
            </>
          )}

          <section aria-label="Visit history">
            <h3 className="text-sm font-semibold text-text-primary">History</h3>
            {history.state === 'loading' && <div className="mt-2 space-y-2"><SkeletonRow columns={2} /><SkeletonRow columns={2} /></div>}
            {history.state === 'error' && (
              <p className="mt-2 text-sm text-text-secondary">
                Couldn&apos;t load the history.{' '}
                <button type="button" className="focus-ring rounded font-medium text-accent hover:underline" onClick={() => void loadHistory(door.id, () => true)}>Try again</button>
              </p>
            )}
            {history.state === 'ready' && history.rows.length === 0 && <p className="mt-2 text-sm text-text-secondary">No visits yet — this will be the first.</p>}
            {history.state === 'ready' && history.rows.length > 0 && (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {history.rows.map((v) => (
                  <li key={v.id} className="px-3.5 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <StatusBadge status={v.outcome} />
                      <span className="shrink-0 text-xs text-text-secondary">{who(v.rep_user_id)} · {relativeTime(v.visited_at, new Date())}</span>
                    </div>
                    {v.note && <p className="mt-1 text-xs leading-relaxed text-text-secondary">{v.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
