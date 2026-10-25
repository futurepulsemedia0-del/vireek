import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ExternalLink, FlaskConical, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { Job } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { HazardChips, ReviewBadge, SignalBadge } from '@/components/safety/SdsUi';
import { fetchJobChecklist, type JobChecklistItem } from '@/lib/jobTemplates';
import {
  acknowledgeSds,
  attachSds,
  describeSdsError,
  detachSds,
  fetchJobSds,
  fetchSdsList,
  filterSds,
  isSdsUnavailable,
  openSdsFile,
  type SdsAck,
  type SdsDocument,
  type SdsJobLink,
} from '@/lib/sds';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus-visible:border-accent';

// ============================================================
// Picker — search the library and attach to the whole job or one step
// ============================================================

function SdsPickerDialog({
  accountOwnerId,
  jobId,
  checklist,
  links,
  onClose,
  onAttached,
}: {
  accountOwnerId: string;
  jobId: string;
  checklist: JobChecklistItem[];
  links: SdsJobLink[];
  onClose: () => void;
  onAttached: () => void;
}) {
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  const { toast } = useToast();
  const [docs, setDocs] = useState<SdsDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<string>('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSdsList(accountOwnerId)
      .then((d) => { if (!cancelled) setDocs(d); })
      .catch((err) => { if (!cancelled) setError(describeSdsError(err, 'Could not load the library.')); });
    return () => { cancelled = true; };
  }, [accountOwnerId]);

  const visible = useMemo(
    () => (docs ? filterSds(docs, { query, status: 'active', hazard: 'all', attentionOnly: false }) : []),
    [docs, query],
  );
  const attachedHere = useMemo(
    () => new Set(links.filter((l) => (l.checklist_item_id ?? '') === target).map((l) => l.sds_id)),
    [links, target],
  );

  const attach = async (doc: SdsDocument) => {
    setBusyId(doc.id);
    try {
      await attachSds(doc.id, jobId, target || null);
      toast(`${doc.product_name} attached.`, 'success');
      onAttached();
    } catch (err) {
      toast(describeSdsError(err, 'Could not attach the sheet.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sds-picker-title"
        className="relative flex h-[94dvh] w-full max-w-xl flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:h-auto sm:max-h-[85vh] sm:rounded-2xl dark:shadow-card-hover-dark"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 id="sds-picker-title" className="text-lg font-bold text-text-primary">Attach a safety data sheet</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 border-b border-border px-5 py-4">
          <Input type="search" icon={Search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search product, manufacturer or CAS number" aria-label="Search the SDS library" className="!py-2.5 !text-sm" />
          {checklist.length > 0 && (
            <div>
              <label htmlFor="sds-target" className="mb-1 block text-xs font-medium text-text-secondary">Applies to</label>
              <select id="sds-target" className={selectClass} value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">The whole job</option>
                {checklist.map((c) => <option key={c.id} value={c.id}>Checklist: {c.label}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p role="alert" className="text-sm text-danger">{error}</p>
          ) : docs === null ? (
            <div role="status" aria-label="Loading the library" className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" /> Loading…</div>
          ) : docs.filter((d) => d.status === 'active').length === 0 ? (
            <p className="text-sm text-text-secondary">
              Your library is empty. <Link to="/safety/sds" className="font-medium text-accent underline-offset-2 hover:underline">Add your first sheet</Link> and it will show up here.
            </p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing matches that search. Try the product name or its CAS number.</p>
          ) : (
            <ul className="space-y-2">
              {visible.map((d) => {
                const done = attachedHere.has(d.id);
                return (
                  <li key={d.id} className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
                    <div className="min-w-0 space-y-1.5">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                        <span className="truncate">{d.product_name}</span>
                        <SignalBadge signal={d.signal_word} />
                      </p>
                      {d.manufacturer && <p className="text-xs text-text-secondary">{d.manufacturer}</p>}
                      <HazardChips classes={d.hazard_classes} />
                    </div>
                    <Button type="button" size="sm" variant={done ? 'ghost' : 'secondary'} disabled={done || busyId !== null} onClick={() => void attach(d)} aria-label={done ? `${d.product_name} already attached` : `Attach ${d.product_name}`}>
                      {busyId === d.id ? <Loader2 size={16} className="animate-spin" /> : done ? <CheckCircle2 size={16} /> : <Plus size={16} />}
                      {done ? 'Attached' : 'Attach'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-5 py-4">
          <Button type="button" size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Panel
// ============================================================

/**
 * Safety Data Sheets attached to this job (whole job or a specific checklist
 * step). Anyone on the account can attach a sheet and confirm they reviewed
 * it; the confirmation is recorded server-side with a timestamp. If the SDS
 * feature is not available yet (migration not applied) the panel renders
 * nothing — it must never break the job page.
 */
export function SdsJobPanel({ job }: { job: Job }) {
  const { user, profile, teamMember, isOwner } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const reviewerName = (profile?.full_name || teamMember?.member_name || user?.email || '').trim();

  const [links, setLinks] = useState<SdsJobLink[]>([]);
  const [acks, setAcks] = useState<SdsAck[]>([]);
  const [checklist, setChecklist] = useState<JobChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detachTarget, setDetachTarget] = useState<SdsJobLink | null>(null);

  const jobId = job.id;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [res, items] = await Promise.all([fetchJobSds(jobId), fetchJobChecklist(jobId).catch(() => [] as JobChecklistItem[])]);
      setLinks(res.links);
      setAcks(res.acks);
      setChecklist(items);
      setUnavailable(false);
    } catch (err) {
      if (isSdsUnavailable(err)) setUnavailable(true);
      else setError(describeSdsError(err, 'Could not load safety data sheets.'));
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const byItem = new Map<string, string>(checklist.map((c) => [c.id, c.label]));
    const out: Array<{ key: string; title: string; links: SdsJobLink[] }> = [];
    const whole = links.filter((l) => !l.checklist_item_id);
    if (whole.length > 0) out.push({ key: 'job', title: 'Whole job', links: whole });
    for (const item of checklist) {
      const ls = links.filter((l) => l.checklist_item_id === item.id);
      if (ls.length > 0) out.push({ key: item.id, title: `Checklist: ${item.label}`, links: ls });
    }
    const orphan = links.filter((l) => l.checklist_item_id && !byItem.has(l.checklist_item_id));
    if (orphan.length > 0) out.push({ key: 'other', title: 'Checklist step', links: orphan });
    return out;
  }, [links, checklist]);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const acknowledge = async (link: SdsJobLink) => {
    if (!reviewerName) {
      toast(describeSdsError({ message: 'name_required' }), 'error');
      return;
    }
    setBusyId(link.id);
    try {
      await acknowledgeSds(link.sds_id, jobId, reviewerName);
      toast('Recorded that you reviewed this sheet.', 'success');
      await load();
    } catch (err) {
      toast(describeSdsError(err, 'Could not record your review.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDetach = async () => {
    if (!detachTarget) return;
    try {
      await detachSds(detachTarget.id);
      toast('Sheet removed from this job.', 'success');
      setDetachTarget(null);
      await load();
    } catch (err) {
      toast(describeSdsError(err, 'Could not remove the sheet.'), 'error');
      setDetachTarget(null);
    }
  };

  const openFile = async (path: string) => {
    try {
      await openSdsFile(path);
    } catch (err) {
      toast(describeSdsError(err, 'Could not open the file.'), 'error');
    }
  };

  if (unavailable) return null;

  return (
    <section aria-label="Safety data sheets for this job" className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
          <FlaskConical size={16} className="text-accent" /> Safety data sheets
        </h3>
        {accountOwnerId && !loading && !error && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
            <Plus size={16} /> Attach sheet
          </Button>
        )}
      </div>

      {loading ? (
        <div role="status" aria-label="Loading safety data sheets" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
          {error}
          <Button type="button" size="sm" variant="secondary" onClick={() => { setLoading(true); void load(); }}><RefreshCw size={16} /> Try again</Button>
        </div>
      ) : links.length === 0 ? (
        <p className="text-sm text-text-secondary">
          Nothing is attached to this job. Attach the products it uses so the crew can open hazards, first aid and PPE in one tap.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.key}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{g.title}</p>
              <ul className="space-y-2">
                {g.links.map((l) => {
                  const sds = l.sds;
                  const mine = acks.find((a) => a.sds_id === l.sds_id && a.ack_user_id === user?.id);
                  const others = acks.filter((a) => a.sds_id === l.sds_id && a.ack_user_id !== user?.id).length;
                  const open = expanded.has(l.id);
                  return (
                    <li key={l.id} className="rounded-xl border border-border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <button type="button" onClick={() => toggle(l.id)} aria-expanded={open} className="focus-ring flex min-w-0 flex-1 items-start gap-2 rounded-lg text-left">
                          <ChevronDown size={16} className={`mt-0.5 shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-semibold text-text-primary">{sds?.product_name ?? 'Unavailable sheet'}</span>
                              {sds && <SignalBadge signal={sds.signal_word} />}
                              {sds?.status === 'archived' && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">Archived</span>}
                            </span>
                            {sds && <span className="mt-1.5 block"><HazardChips classes={sds.hazard_classes} /></span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setDetachTarget(l)}
                          aria-label={`Remove ${sds?.product_name ?? 'sheet'} from this job`}
                          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-danger"
                        >
                          <X size={16} />
                        </button>
                      </div>

                      {open && sds && (
                        <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
                          {sds.first_aid && <p><span className="font-semibold text-text-primary">First aid: </span><span className="whitespace-pre-line text-text-secondary">{sds.first_aid}</span></p>}
                          {sds.ppe && <p><span className="font-semibold text-text-primary">PPE: </span><span className="whitespace-pre-line text-text-secondary">{sds.ppe}</span></p>}
                          {!sds.first_aid && !sds.ppe && <p className="text-text-secondary">No first-aid or PPE notes were entered. Open the full sheet.</p>}
                          <ReviewBadge doc={sds} />
                        </div>
                      )}

                      {sds && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {sds.file_path && (
                            <Button type="button" size="sm" variant="secondary" onClick={() => void openFile(sds.file_path as string)}>
                              <ExternalLink size={16} /> Open sheet
                            </Button>
                          )}
                          {mine ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                              <CheckCircle2 size={14} aria-hidden="true" /> You reviewed this · {new Date(mine.acknowledged_at).toLocaleString()}
                            </span>
                          ) : (
                            <Button type="button" size="sm" disabled={busyId === l.id} onClick={() => void acknowledge(l)}>
                              {busyId === l.id ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} I reviewed this sheet
                            </Button>
                          )}
                          {others > 0 && <span className="text-xs text-text-secondary">{others} other{others === 1 ? '' : 's'} reviewed</span>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {pickerOpen && accountOwnerId && (
        <SdsPickerDialog
          accountOwnerId={accountOwnerId}
          jobId={jobId}
          checklist={checklist}
          links={links}
          onClose={() => setPickerOpen(false)}
          onAttached={() => void load()}
        />
      )}
      <ConfirmDialog
        open={detachTarget !== null}
        title="Remove this sheet from the job?"
        description="The sheet stays in your library. Anyone who already confirmed they reviewed it keeps that record."
        confirmLabel="Remove"
        onConfirm={confirmDetach}
        onCancel={() => setDetachTarget(null)}
      />
    </section>
  );
}
