/**
 * AI Takeoff — /dashboard/takeoff
 *
 * Upload plans, blueprints or photos. The AI extracts rooms, fixtures and
 * quantities; staff review and correct them; the result becomes a tiered draft
 * quote. List + "new takeoff" form. The review workspace is TakeoffDetailPage.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileUp, Ruler, Trash2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfidenceBadge } from '@/components/takeoff/ConfidenceBadge';
import {
  STATUS_LABELS,
  TAKEOFF_ACCEPT,
  TAKEOFF_LIMITS,
  createTakeoff,
  deleteTakeoff,
  isStaleAnalysis,
  listTakeoffs,
  validatePlanFile,
  type TakeoffProject,
} from '@/lib/takeoff';

const STATUS_CLASS: Record<TakeoffProject['status'], string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  analyzing: 'bg-accent/10 text-accent',
  review: 'bg-warning-500/10 text-warning-500',
  converted: 'bg-success-500/10 text-success-500',
  failed: 'bg-danger/10 text-danger',
};

function NewTakeoffForm({ ownerId, onCancel }: { ownerId: string; onCancel: () => void }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [customer, setCustomer] = useState('');
  const [trade, setTrade] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      const problem = validatePlanFile(f);
      if (problem) { toast(problem, 'error'); continue; }
      if (next.length >= TAKEOFF_LIMITS.files) { toast(`At most ${TAKEOFF_LIMITS.files} files per takeoff.`, 'error'); break; }
      next.push(f);
    }
    setFiles(next);
    if (fileInput.current) fileInput.current.value = '';
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return toast('Give the takeoff a name.', 'error');
    if (files.length === 0) return toast('Add at least one plan or photo.', 'error');
    setBusy(true);
    try {
      const id = await createTakeoff({ ownerId, name, customerName: customer, trade, notes, files });
      navigate(`/dashboard/takeoff/${id}?start=1`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the takeoff.', 'error');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Project name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Kitchen remodel — 12 Oak St" maxLength={160} />
        <Input label="Customer" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Needed before you can create the quote" maxLength={160} />
        <Input label="Trade (optional)" value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Electrical, plumbing, remodel…" maxLength={60} />
      </div>
      <div className="mt-4">
        <Textarea label="Notes for the estimator (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000}
          helperText="Scope, finishes, what is NOT included, the drawing scale if it isn't printed." />
      </div>

      <div className="mt-4">
        <p className="mb-1.5 text-sm font-medium text-text-primary">Plans, blueprints or photos</p>
        <button type="button" onClick={() => fileInput.current?.click()}
          className="focus-ring flex w-full flex-col items-center gap-1 rounded-xl border border-dashed border-border bg-bg-primary px-4 py-8 text-center text-sm text-text-secondary hover:border-accent">
          <FileUp size={22} aria-hidden />
          <span>Choose files (PDF, PNG, JPG, WebP, HEIC · up to 25 MB each · max {TAKEOFF_LIMITS.files})</span>
          <span className="text-xs">CAD files (DWG/DXF): export to PDF first.</span>
        </button>
        <input ref={fileInput} type="file" multiple accept={TAKEOFF_ACCEPT} className="hidden" onChange={(e) => addFiles(e.target.files)} />
        {files.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between rounded-lg bg-bg-tertiary px-3 py-2 text-sm">
                <span className="truncate">{f.name} <span className="text-text-secondary">· {(f.size / 1024 / 1024).toFixed(1)} MB</span></span>
                <button type="button" aria-label={`Remove ${f.name}`} className="focus-ring rounded p-1 text-text-secondary hover:text-danger"
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}><X size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-4 text-xs text-text-secondary">
        The AI only drafts. Every uncertain line must be confirmed or corrected by your team before a quote can be created,
        and the quote is always a draft you review and send yourself.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Upload & analyze'}</Button>
      </div>
    </form>
  );
}

export function TakeoffPage() {
  const { profile, teamMember, isOwner, profileLoading } = useAuth();
  const { toast } = useToast();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const [items, setItems] = useState<TakeoffProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TakeoffProject | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await listTakeoffs());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your takeoffs.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const header = (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">AI Takeoff</h1>
        <p className="mt-1 max-w-xl text-sm text-text-secondary">
          Upload plans or photos, get rooms, fixtures, quantities, materials and labor priced from your price book and suppliers,
          correct anything the AI is unsure about, then turn it into a Good / Better / Best quote.
        </p>
      </div>
      {!creating && ownerId && <Button onClick={() => setCreating(true)}>New takeoff</Button>}
    </div>
  );

  return (
    <DashboardLayout activeLabel="AI Takeoff">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        {header}
        {creating && ownerId && <div className="mb-6"><NewTakeoffForm ownerId={ownerId} onCancel={() => setCreating(false)} /></div>}

        {loading || profileLoading ? (
          <SkeletonCardList count={3} rows={2} />
        ) : error ? (
          <EmptyState icon={Ruler} title="Couldn't load takeoffs" description={error} action={{ label: 'Try again', onClick: () => void load() }} />
        ) : items.length === 0 && !creating ? (
          <EmptyState icon={Ruler} title="No takeoffs yet" description="Upload a floor plan, blueprint or job-site photos to get your first AI takeoff."
            action={{ label: 'New takeoff', onClick: () => setCreating(true) }} />
        ) : (
          <ul className="space-y-3">
            {items.map((p) => {
              const stale = isStaleAnalysis(p);
              const status = stale ? 'failed' : p.status;
              return (
                <li key={p.id} className="flex items-center gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
                  <Link to={`/dashboard/takeoff/${p.id}`} className="focus-ring min-w-0 flex-1 rounded-lg">
                    <p className="truncate font-semibold text-text-primary">{p.name}</p>
                    <p className="mt-0.5 truncate text-sm text-text-secondary">
                      {p.customer_name || 'No customer yet'} · {p.source_files.length} file{p.source_files.length === 1 ? '' : 's'} · {new Date(p.created_at).toLocaleDateString()}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[status]}`}>{stale ? 'Analysis stalled' : STATUS_LABELS[p.status]}</span>
                      {p.overall_confidence != null && p.status !== 'draft' && <ConfidenceBadge confidence={p.overall_confidence} />}
                    </div>
                  </Link>
                  {p.status !== 'converted' && (
                    <button type="button" aria-label={`Delete ${p.name}`} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-danger/10 hover:text-danger"
                      onClick={() => setDeleting(p)}><Trash2 size={16} /></button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={deleting != null}
        title="Delete this takeoff?"
        description="The uploaded plans and all quantities are removed. A quote already created from it is not affected."
        confirmLabel="Delete takeoff"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try { await deleteTakeoff(deleting); toast('Takeoff deleted', 'success'); await load(); }
          catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.', 'error'); }
          setDeleting(null);
        }}
      />
    </DashboardLayout>
  );
}
