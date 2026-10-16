import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Briefcase,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_COLORS,
  APPLICATION_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPE_OPTIONS,
  LIMITS,
  LOCATION_TYPE_LABELS,
  LOCATION_TYPE_OPTIONS,
  POSTING_STATUS_COLORS,
  POSTING_STATUS_LABELS,
  SALARY_PERIOD_OPTIONS,
  countByStatus,
  emptyPostingForm,
  filterApplications,
  formToPayload,
  formatSalary,
  postingToForm,
  slugify,
  validatePostingForm,
  type ApplicationStatus,
  type JobApplication,
  type JobPosting,
  type PostingErrors,
  type PostingFormValues,
  type PostingStats,
  type PostingStatus,
} from '@/lib/careers';
import {
  createPosting,
  deleteApplication,
  deletePosting,
  fetchAllPostings,
  fetchApplications,
  fetchPostingStats,
  setPostingStatus,
  updateApplication,
  updatePosting,
  type ApplicationPatch,
} from '@/lib/careersApi';

// ============================================================
// HELPERS
// ============================================================

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {children}
    </span>
  );
}

function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={selectClass}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

// ============================================================
// POSTING FORM DIALOG
// ============================================================

interface PostingFormDialogProps {
  posting: JobPosting | null;
  onClose: () => void;
  onSaved: (posting: JobPosting, created: boolean) => void;
}

function PostingFormDialog({ posting, onClose, onSaved }: PostingFormDialogProps) {
  const { toast } = useToast();
  const uid = useId();
  const titleId = `${uid}-title`;
  const dialogRef = useFocusTrap(true);
  const isEdit = posting !== null;
  const slugLocked = Boolean(posting?.published_at);

  const [values, setValues] = useState<PostingFormValues>(() => (posting ? postingToForm(posting) : emptyPostingForm()));
  const [errors, setErrors] = useState<PostingErrors>({});
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);

  const guardedClose = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);
  useEscapeToClose(true, guardedClose);

  const set = <K extends keyof PostingFormValues>(key: K, value: PostingFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next: Record<string, unknown> = { ...prev };
      delete next[key];
      return next as PostingErrors;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const found = validatePostingForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      const payload = formToPayload(values);
      if (isEdit && posting) {
        const { slug: _slug, ...rest } = payload;
        const saved = await updatePosting(posting.id, slugLocked ? rest : payload);
        onSaved(saved, false);
        toast('Posting updated', 'success');
      } else {
        const saved = await createPosting(payload);
        onSaved(saved, true);
        toast('Posting saved as draft', 'success');
      }
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this posting', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) guardedClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-xl sm:max-w-2xl sm:rounded-2xl sm:p-6"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-bold text-text-primary">
            {isEdit ? 'Edit posting' : 'New posting'}
          </h2>
          <button
            type="button"
            onClick={guardedClose}
            disabled={submitting}
            aria-label="Close"
            className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Title"
              required
              maxLength={LIMITS.title}
              value={values.title}
              onChange={(e) => {
                const title = e.target.value;
                set('title', title);
                if (!slugTouched && !slugLocked) set('slug', slugify(title));
              }}
              error={errors.title}
              placeholder="Senior Full-Stack Engineer"
            />
            <Input
              label="URL slug"
              required
              disabled={slugLocked}
              value={values.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug', slugify(e.target.value));
              }}
              error={errors.slug}
              helperText={
                slugLocked
                  ? 'Locked after publishing so public links never break.'
                  : `vireek.com/careers/${values.slug || '…'}`
              }
            />
            <Input
              label="Department"
              required
              maxLength={LIMITS.department}
              value={values.department}
              onChange={(e) => set('department', e.target.value)}
              error={errors.department}
              placeholder="Engineering"
            />
            <Input
              label="Location"
              required
              maxLength={LIMITS.location}
              value={values.location}
              onChange={(e) => set('location', e.target.value)}
              error={errors.location}
              helperText="For remote roles, enter the country candidates must live in (e.g. United States)."
            />
            <SelectField
              id={`${uid}-loc`}
              label="Workplace"
              value={values.locationType}
              options={LOCATION_TYPE_OPTIONS}
              onChange={(v) => set('locationType', v)}
            />
            <SelectField
              id={`${uid}-emp`}
              label="Employment type"
              value={values.employmentType}
              options={EMPLOYMENT_TYPE_OPTIONS}
              onChange={(v) => set('employmentType', v)}
            />
          </div>

          <Textarea
            label="Summary"
            required
            rows={2}
            maxLength={LIMITS.summary}
            value={values.summary}
            onChange={(e) => set('summary', e.target.value)}
            error={errors.summary}
            helperText="One or two sentences shown on the roles list and in search results."
          />
          <Textarea
            label="Description"
            required
            rows={7}
            maxLength={LIMITS.description}
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            error={errors.description}
            helperText="Plain text. Leave a blank line between paragraphs."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Textarea
              label="Responsibilities"
              rows={5}
              value={values.responsibilities}
              onChange={(e) => set('responsibilities', e.target.value)}
              error={errors.responsibilities}
              helperText="One per line."
            />
            <Textarea
              label="Requirements"
              rows={5}
              value={values.requirements}
              onChange={(e) => set('requirements', e.target.value)}
              error={errors.requirements}
              helperText="One per line."
            />
          </div>

          <fieldset className="rounded-xl border border-border bg-bg-primary p-4">
            <legend className="px-1 text-sm font-semibold text-text-primary">Salary range (optional)</legend>
            <div className="grid gap-4 sm:grid-cols-4">
              <Input
                label="Min"
                inputMode="numeric"
                value={values.salaryMin}
                onChange={(e) => set('salaryMin', e.target.value)}
                error={errors.salaryMin}
              />
              <Input
                label="Max"
                inputMode="numeric"
                value={values.salaryMax}
                onChange={(e) => set('salaryMax', e.target.value)}
              />
              <Input
                label="Currency"
                maxLength={3}
                value={values.salaryCurrency}
                onChange={(e) => set('salaryCurrency', e.target.value.toUpperCase())}
                error={errors.salaryCurrency}
              />
              <SelectField
                id={`${uid}-per`}
                label="Period"
                value={values.salaryPeriod}
                options={SALARY_PERIOD_OPTIONS}
                onChange={(v) => set('salaryPeriod', v)}
              />
            </div>
          </fieldset>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={guardedClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Save draft'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// POSTING CARD
// ============================================================

interface PostingCardProps {
  posting: JobPosting;
  stats: PostingStats | undefined;
  busy: boolean;
  onApplicants: (p: JobPosting) => void;
  onEdit: (p: JobPosting) => void;
  onSetStatus: (p: JobPosting, status: PostingStatus) => void;
  onDelete: (p: JobPosting) => void;
}

function PostingCard({ posting, stats, busy, onApplicants, onEdit, onSetStatus, onDelete }: PostingCardProps) {
  const salary = formatSalary(posting);
  const total = stats?.applicants_total ?? 0;
  const fresh = stats?.applicants_new ?? 0;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-semibold text-text-primary">{posting.title}</h3>
            <Pill className={POSTING_STATUS_COLORS[posting.status]}>{POSTING_STATUS_LABELS[posting.status]}</Pill>
            {fresh > 0 && <Pill className="bg-accent/10 text-accent">{fresh} new</Pill>}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            <span className="flex items-center gap-1">
              <Briefcase size={12} aria-hidden="true" /> {posting.department}
            </span>
            <span className="flex items-center gap-1">
              <MapPin size={12} aria-hidden="true" /> {posting.location} · {LOCATION_TYPE_LABELS[posting.location_type]}
            </span>
            <span>{EMPLOYMENT_TYPE_LABELS[posting.employment_type]}</span>
            {salary && <span>{salary}</span>}
          </p>
          <p className="mt-1.5 text-xs text-text-secondary">
            {total} applicant{total === 1 ? '' : 's'} · created {formatDate(posting.created_at)}
            {posting.status === 'open' && (
              <>
                {' · '}
                <a
                  href={`/careers/${posting.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                >
                  Public page <ExternalLink size={11} aria-hidden="true" />
                </a>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button variant="secondary" size="sm" onClick={() => onApplicants(posting)} disabled={busy}>
            <Users size={14} /> Applicants
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onEdit(posting)} disabled={busy}>
            <Pencil size={14} /> Edit
          </Button>
          {posting.status === 'open' ? (
            <Button variant="secondary" size="sm" onClick={() => onSetStatus(posting, 'closed')} disabled={busy}>
              {busy && <Loader2 size={14} className="animate-spin" />} Close
            </Button>
          ) : (
            <Button size="sm" onClick={() => onSetStatus(posting, 'open')} disabled={busy}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              {posting.status === 'closed' ? 'Reopen' : 'Publish'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(posting)}
            disabled={busy}
            className="hover:text-danger"
            aria-label={`Delete ${posting.title}`}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
    </motion.li>
  );
}

// ============================================================
// APPLICANTS
// ============================================================

interface ApplicantCardProps {
  app: JobApplication;
  onChange: (id: string, patch: ApplicationPatch) => Promise<void>;
  onDelete: (app: JobApplication) => void;
}

function ApplicantCard({ app, onChange, onDelete }: ApplicantCardProps) {
  const [notes, setNotes] = useState(app.staff_notes ?? '');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dirty = notes.trim() !== (app.staff_notes ?? '').trim();
  const longNote = (app.cover_note?.length ?? 0) > 280;
  const links = [
    { label: 'LinkedIn', href: app.linkedin_url },
    { label: 'Portfolio', href: app.portfolio_url },
    { label: 'Résumé', href: app.resume_url },
  ].filter((l): l is { label: string; href: string } => Boolean(l.href));

  const saveNotes = async () => {
    setSaving(true);
    await onChange(app.id, { staff_notes: notes.trim() || null });
    setSaving(false);
  };

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-text-primary">{app.full_name}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            <a href={`mailto:${app.email}`} className="inline-flex items-center gap-1 break-all hover:text-accent">
              <Mail size={12} aria-hidden="true" /> {app.email}
            </a>
            {app.phone && (
              <a href={`tel:${app.phone}`} className="inline-flex items-center gap-1 hover:text-accent">
                <Phone size={12} aria-hidden="true" /> {app.phone}
              </a>
            )}
            {app.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} aria-hidden="true" /> {app.location}
              </span>
            )}
            <span>Applied {formatDate(app.created_at)}</span>
            {app.referral_source && <span>via {app.referral_source}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill className={APPLICATION_STATUS_COLORS[app.status]}>{APPLICATION_STATUS_LABELS[app.status]}</Pill>
          <select
            aria-label={`Status for ${app.full_name}`}
            value={app.status}
            onChange={(e) => void onChange(app.id, { status: e.target.value as ApplicationStatus })}
            className="focus-ring rounded-lg border border-border bg-bg-primary px-2.5 py-2 text-xs text-text-primary"
          >
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {APPLICATION_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-medium text-text-secondary hover:border-accent/40 hover:text-accent"
            >
              {l.label} <ExternalLink size={11} aria-hidden="true" />
            </a>
          ))}
        </div>
      )}

      {app.cover_note && (
        <div className="mt-3 text-sm leading-relaxed text-text-secondary">
          <p className={`whitespace-pre-line ${!expanded && longNote ? 'line-clamp-3' : ''}`}>{app.cover_note}</p>
          {longNote && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="focus-ring mt-1 text-xs font-medium text-accent hover:underline"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-[auto_1fr]">
        <div>
          <p className="mb-1.5 text-xs font-medium text-text-secondary">Rating</p>
          <div className="flex gap-1" role="group" aria-label={`Rating for ${app.full_name}`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                aria-pressed={app.rating === n}
                onClick={() => void onChange(app.id, { rating: app.rating === n ? null : n })}
                className="focus-ring rounded p-1 text-warning-500"
              >
                <Star size={18} className={app.rating !== null && n <= app.rating ? 'fill-current' : ''} />
              </button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor={`notes-${app.id}`} className="mb-1.5 block text-xs font-medium text-text-secondary">
            Internal notes
          </label>
          <textarea
            id={`notes-${app.id}`}
            rows={2}
            maxLength={4000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <Button variant="secondary" size="sm" onClick={() => void saveNotes()} disabled={!dirty || saving}>
              {saving && <Loader2 size={14} className="animate-spin" />} Save note
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(app)}
              className="hover:text-danger"
              aria-label={`Delete ${app.full_name}`}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      </div>
    </motion.li>
  );
}

function ApplicantsView({ posting, onBack }: { posting: JobPosting; onBack: () => void }) {
  const { toast } = useToast();
  const [apps, setApps] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ApplicationStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<JobApplication | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchApplications(posting.id);
      if (requestId !== requestRef.current) return;
      setApps(rows);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not load applicants.');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [posting.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => countByStatus(apps), [apps]);
  const visible = useMemo(() => filterApplications(apps, { status, query }), [apps, status, query]);

  const handleChange = useCallback(
    async (id: string, patch: ApplicationPatch) => {
      try {
        const saved = await updateApplication(id, patch);
        setApps((prev) => prev.map((a) => (a.id === id ? saved : a)));
        toast('Applicant updated', 'success');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not update this applicant', 'error');
      }
    },
    [toast],
  );

  const handleDelete = async () => {
    const target = deleting;
    if (!target) return;
    try {
      await deleteApplication(target.id);
      setApps((prev) => prev.filter((a) => a.id !== target.id));
      toast('Applicant deleted', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete this applicant', 'error');
    } finally {
      setDeleting(null);
    }
  };

  const tabs: (ApplicationStatus | 'all')[] = ['all', ...APPLICATION_STATUSES];

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="focus-ring mb-4 inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft size={16} /> All postings
      </button>
      <h1 className="text-2xl font-bold text-text-primary">{posting.title}</h1>
      <p className="mt-1 text-sm text-text-secondary">
        {counts.all} applicant{counts.all === 1 ? '' : 's'}
      </p>

      <div className="mt-6">
        {loading ? (
          <SkeletonCardList count={3} rows={3} />
        ) : error ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center"
          >
            <TriangleAlert size={26} className="text-danger" aria-hidden="true" />
            <p className="text-sm text-text-secondary">{error}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCw size={14} /> Try again
            </Button>
          </div>
        ) : apps.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No applicants yet"
            description={
              posting.status === 'open'
                ? 'Share the public page and applications will show up here.'
                : 'Publish this posting to start receiving applications.'
            }
          />
        ) : (
          <>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div
                role="group"
                aria-label="Filter applicants by status"
                className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1"
              >
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    aria-pressed={status === tab}
                    onClick={() => setStatus(tab)}
                    className={`focus-ring shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      status === tab ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {tab === 'all' ? 'All' : APPLICATION_STATUS_LABELS[tab]}{' '}
                    <span className="opacity-70">{counts[tab]}</span>
                  </button>
                ))}
              </div>
              <div className="w-full lg:max-w-xs">
                <Input
                  icon={Search}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search applicants"
                  aria-label="Search applicants"
                />
              </div>
            </div>

            <div className="mt-4">
              {visible.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No applicants match this filter"
                  description="Try another status or clear the search."
                  action={{
                    label: 'Reset filters',
                    onClick: () => {
                      setStatus('all');
                      setQuery('');
                    },
                  }}
                />
              ) : (
                <ul className="space-y-3">
                  {visible.map((app) => (
                    <ApplicantCard key={app.id} app={app} onChange={handleChange} onDelete={setDeleting} />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this applicant?"
        description={`${deleting?.full_name ?? 'This applicant'}'s application and notes will be permanently erased. Use this for data-erasure requests.`}
        confirmLabel="Yes, delete applicant"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

// ============================================================
// PAGE
// ============================================================

export function HiringPage() {
  const { toast } = useToast();
  const [postings, setPostings] = useState<JobPosting[]>([]);
  const [stats, setStats] = useState<Record<string, PostingStats>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<JobPosting | null>(null);
  const [deleting, setDeleting] = useState<JobPosting | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (silent = false) => {
    const requestId = ++requestRef.current;
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const [rows, statRows] = await Promise.all([
        fetchAllPostings(),
        fetchPostingStats().catch((): Record<string, PostingStats> => ({})),
      ]);
      if (requestId !== requestRef.current) return;
      setPostings(rows);
      setStats(statRows);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setLoadError(err instanceof Error ? err.message : 'Could not load postings.');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = postings.find((p) => p.id === selectedId) ?? null;

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (p: JobPosting) => {
    setEditing(p);
    setFormOpen(true);
  };
  const closeForm = useCallback(() => setFormOpen(false), []);

  const handleSaved = useCallback((saved: JobPosting, created: boolean) => {
    setPostings((prev) => (created ? [saved, ...prev] : prev.map((p) => (p.id === saved.id ? saved : p))));
  }, []);

  const handleSetStatus = async (posting: JobPosting, next: PostingStatus) => {
    setBusyId(posting.id);
    try {
      const saved = await setPostingStatus(posting.id, next);
      handleSaved(saved, false);
      toast(next === 'open' ? 'Posting is live' : 'Posting closed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the status', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    const target = deleting;
    if (!target) return;
    try {
      await deletePosting(target.id);
      setPostings((prev) => prev.filter((p) => p.id !== target.id));
      toast('Posting deleted', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete this posting', 'error');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Hiring">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {selected ? (
          <ApplicantsView
            posting={selected}
            onBack={() => {
              setSelectedId(null);
              void load(true);
            }}
          />
        ) : (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Briefcase size={20} />
                </span>
                <div>
                  <h1 className="text-2xl font-bold text-text-primary">Hiring</h1>
                  <p className="mt-1 text-sm text-text-secondary">
                    Manage Vireek's job postings and review applicants.
                  </p>
                </div>
              </div>
              <Button size="sm" onClick={openCreate} className="w-full sm:w-auto">
                <Plus size={16} /> New posting
              </Button>
            </div>

            <div className="mt-6">
              {loading ? (
                <SkeletonCardList count={3} rows={2} />
              ) : loadError ? (
                <div
                  role="alert"
                  className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center"
                >
                  <TriangleAlert size={26} className="text-danger" aria-hidden="true" />
                  <p className="text-sm text-text-secondary">{loadError}</p>
                  <Button variant="secondary" size="sm" onClick={() => void load()}>
                    <RefreshCw size={14} /> Try again
                  </Button>
                </div>
              ) : postings.length === 0 ? (
                <EmptyState
                  icon={Briefcase}
                  title="No postings yet"
                  description="Create your first role. It stays a draft until you publish it."
                  action={{ label: 'Create a posting', onClick: openCreate }}
                />
              ) : (
                <ul className="space-y-3">
                  {postings.map((p) => (
                    <PostingCard
                      key={p.id}
                      posting={p}
                      stats={stats[p.id]}
                      busy={busyId === p.id}
                      onApplicants={(posting) => setSelectedId(posting.id)}
                      onEdit={openEdit}
                      onSetStatus={(posting, next) => void handleSetStatus(posting, next)}
                      onDelete={setDeleting}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {formOpen && (
        <PostingFormDialog
          key={editing?.id ?? 'new'}
          posting={editing}
          onClose={closeForm}
          onSaved={handleSaved}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this posting?"
        description={`"${deleting?.title ?? ''}" and ALL of its applicants will be permanently deleted. Close it instead if you only want to stop receiving applications.`}
        confirmLabel="Yes, delete posting"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
