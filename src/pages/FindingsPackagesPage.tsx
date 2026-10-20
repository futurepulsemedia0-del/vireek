/**
 * /dashboard/findings and /dashboard/findings/:id
 *
 * Technician pins annotated job photos → prices each finding with Good / Better
 * / Best options → sends one customer link → customer approves per finding →
 * approved items become a job (done in SQL, see respond_to_findings_package).
 *
 * Scoping: everything is keyed by the ACCOUNT OWNER id (owner + team share it).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Camera, CheckCircle2, Check, Copy, ExternalLink, Eye, Loader2, Mail, MessageSquare, Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { FindingEditor } from '@/components/findings/FindingEditor';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { useGalleryScope } from '@/hooks/useGalleryScope';
import {
  STATUS_LABEL,
  canManageFindings,
  formatDate,
  formatMoney,
  getFindingsShareUrl,
  packageHeadline,
  shareState,
  validateForSend,
  type FindingsPackageRow,
} from '@/lib/findingsPackage';
import {
  addItemFromPhoto,
  createFromJob,
  deleteItem,
  deletePackage,
  fetchJobPhotos,
  fetchJobsForFindings,
  fetchPackage,
  listPackages,
  reopenPackage,
  saveItem,
  sendPackage,
  updatePackage,
  type FindingsJobOption,
  type FindingsPhoto,
  type ItemPatch,
  type PackageDetail,
  type PackageListRow,
} from '@/lib/findingsPackageApi';

const NAV = 'Findings Packages';
const fieldCls = 'w-full rounded-md border border-border bg-bg-primary px-2.5 py-2 text-sm text-text-primary focus-ring';

function StatusPill({ status }: { status: FindingsPackageRow['status'] }) {
  const tone =
    status === 'approved' ? 'bg-success-500/10 text-success-500' :
    status === 'partially_approved' ? 'bg-accent/10 text-accent' :
    status === 'declined' ? 'bg-danger/10 text-danger' :
    status === 'sent' ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{STATUS_LABEL[status]}</span>;
}

// ============================================================
// PAGE SWITCH
// ============================================================
export function FindingsPackagesPage() {
  const { id } = useParams<{ id: string }>();
  const { isOwner, permissions } = useAuth();
  const { accountOwnerId, ready } = useGalleryScope();

  if (!ready || !accountOwnerId) {
    return (
      <DashboardLayout activeLabel={NAV}>
        <div className="space-y-4" aria-busy="true" aria-label="Loading">
          <div className="h-10 w-64 animate-pulse rounded-xl bg-bg-tertiary" />
          <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
        </div>
      </DashboardLayout>
    );
  }
  const canSend = canManageFindings(isOwner, permissions);
  return (
    <DashboardLayout activeLabel={NAV}>
      {id ? <PackageBuilder ownerId={accountOwnerId} id={id} canSend={canSend} /> : <PackageList ownerId={accountOwnerId} />}
    </DashboardLayout>
  );
}

// ============================================================
// LIST + CREATE
// ============================================================
function PackageList({ ownerId }: { ownerId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [rows, setRows] = useState<PackageListRow[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      setRows(await listPackages(ownerId));
    } catch {
      setError(true);
    }
  }, [ownerId]);
  useEffect(() => void load(), [load]);

  return (
    <>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Findings Packages</h1>
          <p className="text-sm text-text-secondary">Annotated photos → priced findings → one-tap customer approval → job.</p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white">
          <Plus size={16} /> New package
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          <span className="flex items-center gap-2"><AlertCircle size={16} /> Could not load packages.</span>
          <button type="button" onClick={() => void load()} className="focus-ring font-medium underline">Retry</button>
        </div>
      )}
      {!error && rows === null && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading packages">
          {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
        </div>
      )}
      {rows?.length === 0 && (
        <EmptyState icon={Camera} title="No findings packages yet" description="Pick a job with photos, pin what you found, price the fix and send the customer one link they can approve in a tap." action={{ label: 'Create your first package', onClick: () => setCreating(true) }} />
      )}
      {rows && rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <Link to={`/dashboard/findings/${r.id}`} className="focus-ring flex flex-col gap-2 rounded-2xl border border-border bg-bg-secondary p-4 transition-colors hover:border-accent/40 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-semibold text-text-primary">{r.title}</p>
                    <StatusPill status={r.status} />
                  </div>
                  <p className="truncate text-xs text-text-secondary">{r.customer_name} · {r.finding_count} finding{r.finding_count === 1 ? '' : 's'} · {formatDate(r.created_at)}</p>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  {r.view_count > 0 && r.status === 'sent' && <span className="inline-flex items-center gap-1 text-xs text-text-secondary"><Eye size={12} /> Viewed</span>}
                  <span className="font-semibold text-text-primary">{packageHeadline(r, r.potential_cents)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateDialog
          ownerId={ownerId}
          onClose={() => setCreating(false)}
          onCreated={(newId) => {
            setCreating(false);
            toast('Package created — price each finding, then send.', 'success');
            navigate(`/dashboard/findings/${newId}`);
          }}
        />
      )}
    </>
  );
}

function CreateDialog({ ownerId, onClose, onCreated }: { ownerId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [jobs, setJobs] = useState<FindingsJobOption[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<FindingsPhoto[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetchJobsForFindings(ownerId).then(setJobs).catch(() => setError('Could not load jobs.'));
  }, [ownerId]);

  useEffect(() => {
    if (!jobId) return;
    setPhotos(null);
    setPicked([]);
    fetchJobPhotos(ownerId, jobId).then(setPhotos).catch(() => setError('Could not load photos for this job.'));
  }, [ownerId, jobId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (jobs ?? []).filter((j) => !q || `${j.customer_name} ${j.service_type ?? ''} ${j.address ?? ''}`.toLowerCase().includes(q));
  }, [jobs, query]);

  async function create() {
    if (!jobId || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createFromJob(jobId, picked));
    } catch {
      setError('Could not create the package. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="New findings package">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-t-2xl bg-bg-secondary shadow-xl sm:rounded-2xl">
        <div className="border-b border-border p-4">
          <h2 className="text-lg font-semibold text-text-primary">{jobId ? 'Choose the photos to include' : 'Choose a job'}</h2>
          <p className="text-xs text-text-secondary">{jobId ? 'Each photo becomes one finding. Pins you already dropped come with it.' : 'Photos come from the job gallery.'}</p>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
          {!jobId ? (
            <>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer, service or address" aria-label="Search jobs" className={`${fieldCls} mb-3`} />
              {jobs === null ? <div className="h-24 animate-pulse rounded-xl bg-bg-tertiary" /> : filtered.length === 0 ? <p className="py-6 text-center text-sm text-text-secondary">No matching jobs.</p> : (
                <ul className="divide-y divide-border/60 rounded-xl border border-border">
                  {filtered.map((j) => (
                    <li key={j.id}>
                      <button type="button" onClick={() => setJobId(j.id)} className="focus-ring flex w-full flex-col items-start px-4 py-3 text-left hover:bg-bg-tertiary">
                        <span className="text-sm font-medium text-text-primary">{j.customer_name}</span>
                        <span className="text-xs text-text-secondary">{[j.service_type, j.address, formatDate(j.created_at)].filter(Boolean).join(' · ')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : photos === null ? (
            <div className="grid grid-cols-3 gap-2">{[0, 1, 2].map((i) => <div key={i} className="aspect-square animate-pulse rounded-lg bg-bg-tertiary" />)}</div>
          ) : photos.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-secondary">This job has no photos yet. Add some in the Gallery first.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {photos.map((p) => {
                const on = picked.includes(p.id);
                return (
                  <li key={p.id}>
                    <button type="button" aria-pressed={on} onClick={() => setPicked((prev) => (on ? prev.filter((x) => x !== p.id) : prev.length >= 30 ? prev : [...prev, p.id]))} className={`focus-ring relative block aspect-square w-full overflow-hidden rounded-lg border-2 ${on ? 'border-accent' : 'border-transparent'}`}>
                      {p.url ? <img src={p.url} alt={p.caption ?? 'Job photo'} loading="lazy" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center bg-bg-tertiary text-xs text-text-secondary">Unavailable</span>}
                      {p.annotations.length > 0 && <span className="absolute left-1 top-1 rounded bg-danger px-1.5 text-[10px] font-medium text-white">{p.annotations.length} pin{p.annotations.length === 1 ? '' : 's'}</span>}
                      {on && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white"><Check size={12} /></span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          <button type="button" onClick={jobId ? () => setJobId(null) : onClose} className="focus-ring rounded-lg border border-border px-4 py-2 text-sm text-text-secondary">{jobId ? 'Back' : 'Cancel'}</button>
          {jobId && (
            <button type="button" disabled={picked.length === 0 || busy} onClick={create} className="focus-ring inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy && <Loader2 size={14} className="animate-spin" />} Create with {picked.length} photo{picked.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// BUILDER / DETAIL
// ============================================================
function PackageBuilder({ ownerId, id, canSend }: { ownerId: string; id: string; canSend: boolean }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [detail, setDetail] = useState<PackageDetail | null | undefined>(undefined);
  const [error, setError] = useState(false);
  const [expiry, setExpiry] = useState(30);
  const [busy, setBusy] = useState<null | 'send' | 'reopen' | 'photos'>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removeItem, setRemoveItem] = useState<string | null>(null);
  const [meta, setMeta] = useState({ title: '', summary: '', customer_email: '', customer_phone: '', address: '', tax_percent: '0' });
  const [addingPhotos, setAddingPhotos] = useState<FindingsPhoto[] | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const d = await fetchPackage(ownerId, id);
      setDetail(d);
      if (d) {
        setMeta({
          title: d.pkg.title,
          summary: d.pkg.summary ?? '',
          customer_email: d.pkg.customer_email ?? '',
          customer_phone: d.pkg.customer_phone ?? '',
          address: d.pkg.address ?? '',
          tax_percent: String(d.pkg.tax_percent),
        });
      }
    } catch {
      setError(true);
    }
  }, [ownerId, id]);
  useEffect(() => void load(), [load]);

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
        Could not load this package. <button type="button" onClick={() => void load()} className="font-medium underline">Retry</button>
      </div>
    );
  }
  if (detail === undefined) return <div className="h-64 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading package" />;
  if (detail === null) {
    return <EmptyState icon={AlertCircle} title="Package not found" description="It may have been deleted." action={{ label: 'Back to packages', onClick: () => navigate('/dashboard/findings') }} />;
  }

  const { pkg, items } = detail;
  const draft = pkg.status === 'draft';
  const share = shareState(pkg, new Date());
  const errors = validateForSend(items, pkg.tax_percent);
  const shareUrl = getFindingsShareUrl(pkg.share_token);
  const taxPercent = Number(meta.tax_percent) || 0;

  async function saveMeta() {
    try {
      await updatePackage(pkg.id, {
        title: meta.title.trim() || pkg.title,
        summary: meta.summary.trim() || null,
        customer_email: meta.customer_email.trim() || null,
        customer_phone: meta.customer_phone.trim() || null,
        address: meta.address.trim() || null,
        tax_percent: Math.min(30, Math.max(0, taxPercent)),
      });
      await load();
    } catch {
      toast('Could not save details.', 'error');
    }
  }

  async function onSaveItem(itemId: string, patch: ItemPatch) {
    await saveItem(itemId, patch);
    await load();
  }

  async function send() {
    setBusy('send');
    try {
      await saveMeta();
      await sendPackage(pkg.id, expiry);
      toast('Sent. Share the link with your customer.', 'success');
      await load();
    } catch {
      toast('Could not send. Fix the items listed and try again.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function reopen() {
    setBusy('reopen');
    try {
      await reopenPackage(pkg.id);
      await load();
    } catch {
      toast('Could not reopen this package.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function openPhotoPicker() {
    if (!pkg.job_id) return;
    setBusy('photos');
    try {
      const all = await fetchJobPhotos(ownerId, pkg.job_id);
      const used = new Set(items.map((i) => i.photo_id));
      setAddingPhotos(all.filter((p) => !used.has(p.id)));
    } catch {
      toast('Could not load job photos.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast('Link copied', 'success');
    } catch {
      toast('Copy failed — select the link and copy it manually.', 'error');
    }
  }

  const message = encodeURIComponent(`Hi ${pkg.customer_name.split(' ')[0]}, here are the findings from today's visit with photos and options. You can approve what you'd like in one tap: ${shareUrl}`);

  return (
    <>
      <Link to="/dashboard/findings" className="focus-ring mb-4 inline-flex items-center gap-1 rounded text-sm text-text-secondary hover:text-text-primary"><ArrowLeft size={14} /> All packages</Link>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-text-primary">{pkg.title}</h1>
        <StatusPill status={pkg.status} />
      </div>

      {/* OUTCOME / SHARE */}
      {!draft && (
        <section className="mb-6 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5" aria-label="Customer link and outcome">
          {(pkg.status === 'approved' || pkg.status === 'partially_approved') && (
            <div className="mb-4 flex flex-col gap-2 rounded-xl bg-success-500/10 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 text-sm font-medium text-success-500"><CheckCircle2 size={16} /> {formatMoney(pkg.approved_total_cents)} approved{pkg.approver_name ? ` by ${pkg.approver_name}` : ''} on {formatDate(pkg.responded_at)}</p>
              {pkg.converted_job_id && <Link to={`/dashboard/jobs/${pkg.converted_job_id}`} className="focus-ring inline-flex items-center gap-1 rounded text-sm font-medium text-accent">Open the new job <ExternalLink size={13} /></Link>}
            </div>
          )}
          {pkg.status === 'declined' && <p className="mb-4 rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary">The customer declined all recommended repairs on {formatDate(pkg.responded_at)}.</p>}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input readOnly value={shareUrl} aria-label="Customer link" onFocus={(e) => e.currentTarget.select()} className={`${fieldCls} flex-1 font-mono text-xs`} />
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={copyLink} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm"><Copy size={14} /> Copy</button>
              {pkg.customer_phone && <a href={`sms:${pkg.customer_phone}?&body=${message}`} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm"><MessageSquare size={14} /> Text</a>}
              {pkg.customer_email && <a href={`mailto:${pkg.customer_email}?subject=${encodeURIComponent(pkg.title)}&body=${message}`} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm"><Mail size={14} /> Email</a>}
            </div>
          </div>
          <p className="mt-3 text-xs text-text-secondary">
            {share === 'active' && `Expires ${formatDate(pkg.share_expires_at)} · ${pkg.view_count === 0 ? 'Not opened yet' : `Opened ${pkg.view_count} time${pkg.view_count === 1 ? '' : 's'}, last ${formatDate(pkg.last_viewed_at)}`}`}
            {share === 'expired' && 'This link expired. Reopen the package and send it again for a fresh link.'}
            {share === 'disabled' && 'Sharing is switched off for this package.'}
            {share === 'answered' && `Answered ${formatDate(pkg.responded_at)}.`}
          </p>
          {pkg.status === 'sent' && canSend && (
            <button type="button" onClick={reopen} disabled={busy === 'reopen'} className="focus-ring mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50">
              <RotateCcw size={14} /> Reopen to edit (pauses the link)
            </button>
          )}
        </section>
      )}

      {/* DETAILS */}
      <section className="mb-6 grid gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:grid-cols-2 sm:p-5" aria-label="Package details">
        <label className="text-xs font-medium text-text-secondary sm:col-span-2">Title
          <input value={meta.title} disabled={!draft} maxLength={200} onChange={(e) => setMeta({ ...meta, title: e.target.value })} onBlur={() => draft && void saveMeta()} className={`${fieldCls} mt-1`} />
        </label>
        <label className="text-xs font-medium text-text-secondary sm:col-span-2">Message to the customer (optional)
          <textarea value={meta.summary} disabled={!draft} maxLength={4000} rows={3} onChange={(e) => setMeta({ ...meta, summary: e.target.value })} onBlur={() => draft && void saveMeta()} placeholder="A short, honest summary of what you found today." className={`${fieldCls} mt-1`} />
        </label>
        <label className="text-xs font-medium text-text-secondary">Customer email
          <input type="email" value={meta.customer_email} disabled={!draft} onChange={(e) => setMeta({ ...meta, customer_email: e.target.value })} onBlur={() => draft && void saveMeta()} className={`${fieldCls} mt-1`} />
        </label>
        <label className="text-xs font-medium text-text-secondary">Customer phone
          <input type="tel" value={meta.customer_phone} disabled={!draft} onChange={(e) => setMeta({ ...meta, customer_phone: e.target.value })} onBlur={() => draft && void saveMeta()} className={`${fieldCls} mt-1`} />
        </label>
        <label className="text-xs font-medium text-text-secondary">Service address
          <input value={meta.address} disabled={!draft} onChange={(e) => setMeta({ ...meta, address: e.target.value })} onBlur={() => draft && void saveMeta()} className={`${fieldCls} mt-1`} />
        </label>
        <label className="text-xs font-medium text-text-secondary">Sales tax %
          <input inputMode="decimal" value={meta.tax_percent} disabled={!draft} onChange={(e) => /^\d{0,2}(\.\d{0,3})?$/.test(e.target.value) && setMeta({ ...meta, tax_percent: e.target.value })} onBlur={() => draft && void saveMeta()} className={`${fieldCls} mt-1`} />
        </label>
      </section>

      {/* FINDINGS */}
      <div className="space-y-4">
        {items.map((item, i) => (
          <FindingEditor key={item.id} item={item} index={i} taxPercent={draft ? taxPercent : pkg.tax_percent} locked={!draft} onSave={onSaveItem} onDelete={(rid) => setRemoveItem(rid)} />
        ))}
      </div>
      {draft && pkg.job_id && (
        <button type="button" onClick={openPhotoPicker} disabled={busy === 'photos'} className="focus-ring mt-4 inline-flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50">
          {busy === 'photos' ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />} Add more photos from this job
        </button>
      )}

      {/* SEND */}
      {draft && (
        <section className="mt-8 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5" aria-label="Send to customer">
          {errors.length > 0 && (
            <ul role="status" className="mb-4 list-disc space-y-1 pl-5 text-sm text-warning-500">
              {errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <label htmlFor="expiry">Link valid for</label>
              <select id="expiry" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} className="rounded-md border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary">
                {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmDelete(true)} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary hover:text-danger"><Trash2 size={14} /> Delete draft</button>
              <button type="button" onClick={send} disabled={errors.length > 0 || busy === 'send' || !canSend} title={!canSend ? 'You need job visibility permission to send prices to customers.' : undefined} className="focus-ring inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send to customer
              </button>
            </div>
          </div>
          {!canSend && <p className="mt-2 text-xs text-text-secondary">Build and price your findings — an owner or office manager sends them.</p>}
        </section>
      )}

      {addingPhotos && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Add photos">
          <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-bg-secondary p-4 sm:rounded-2xl">
            <h2 className="mb-3 text-lg font-semibold text-text-primary">Add a photo as a finding</h2>
            {addingPhotos.length === 0 ? <p className="py-6 text-center text-sm text-text-secondary">Every photo from this job is already in the package.</p> : (
              <ul className="grid grid-cols-3 gap-2">
                {addingPhotos.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await addItemFromPhoto(ownerId, pkg.id, p, items.length);
                          setAddingPhotos(null);
                          await load();
                        } catch {
                          toast('Could not add the photo.', 'error');
                        }
                      }}
                      className="focus-ring block aspect-square w-full overflow-hidden rounded-lg"
                    >
                      {p.url ? <img src={p.url} alt={p.caption ?? 'Job photo'} loading="lazy" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center bg-bg-tertiary text-xs">Unavailable</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" onClick={() => setAddingPhotos(null)} className="focus-ring mt-4 w-full rounded-lg border border-border py-2 text-sm text-text-secondary">Close</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this draft?"
        description="The package and its findings are removed. The job photos stay in the gallery."
        confirmLabel="Yes, delete"
        onConfirm={async () => {
          try {
            await deletePackage(pkg.id);
            navigate('/dashboard/findings');
          } catch {
            toast('Could not delete the draft.', 'error');
            setConfirmDelete(false);
          }
        }}
        onCancel={() => setConfirmDelete(false)}
      />
      <ConfirmDialog
        open={removeItem !== null}
        title="Remove this finding?"
        description="The photo stays in the gallery; only this finding and its prices are removed."
        confirmLabel="Remove"
        onConfirm={async () => {
          const target = removeItem;
          setRemoveItem(null);
          if (!target) return;
          try {
            await deleteItem(target);
            await load();
          } catch {
            toast('Could not remove the finding.', 'error');
          }
        }}
        onCancel={() => setRemoveItem(null)}
      />
    </>
  );
}
