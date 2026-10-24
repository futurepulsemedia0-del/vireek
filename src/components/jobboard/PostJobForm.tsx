import { useEffect, useMemo, useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { jobBoardApi, type PostableJob } from '@/lib/jobBoardApi';
import {
  AUDIENCE_LABELS,
  CLAIM_MODE_LABELS,
  audienceCounts,
  describeBlockers,
  describeJobBoardError,
  validatePostForm,
  type AudienceEntry,
  type ClaimMode,
  type PostAudience,
  type PostPriority,
  type PostSource,
} from '@/lib/jobBoard';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

interface Props {
  jobs: PostableJob[];
  areas: Array<{ id: string; name: string }>;
  initialJobId?: string | null;
  defaultExpiryMinutes: number;
  allowSubcontractors: boolean;
  onPosted: () => void;
  onCancel: () => void;
}

const jobLabel = (j: PostableJob) => {
  const when = j.scheduled_datetime
    ? new Date(j.scheduled_datetime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Unscheduled';
  return `${when} · ${j.service_type ?? 'Service'} · ${j.customer_name}${j.assigned_technician_id ? ' (assigned)' : ''}`;
};

export function PostJobForm({ jobs, areas, initialJobId, defaultExpiryMinutes, allowSubcontractors, onPosted, onCancel }: Props) {
  const { toast } = useToast();
  const first = jobs.find((j) => j.id === initialJobId) ?? null;
  const [jobId, setJobId] = useState(first?.id ?? '');
  const [source, setSource] = useState<PostSource>(first?.assigned_technician_id ? 'overflow' : 'unassigned');
  const [audience, setAudience] = useState<PostAudience>('both');
  const [claimMode, setClaimMode] = useState<ClaimMode>('first_come');
  const [priority, setPriority] = useState<PostPriority>('normal');
  const [skill, setSkill] = useState(first?.service_type?.toLowerCase() ?? '');
  const [areaId, setAreaId] = useState('');
  const [title, setTitle] = useState(first?.service_type ?? '');
  const [summary, setSummary] = useState('');
  const [locationLabel, setLocationLabel] = useState('');
  const [offer, setOffer] = useState('');
  const [maxBid, setMaxBid] = useState('');
  const [expires, setExpires] = useState(String(defaultExpiryMinutes));
  const [autoAward, setAutoAward] = useState(false);
  const [errors, setErrors] = useState<ReturnType<typeof validatePostForm>['errors']>({});
  const [submitting, setSubmitting] = useState(false);

  const [preview, setPreview] = useState<AudienceEntry[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const selectedJob = useMemo(() => jobs.find((j) => j.id === jobId) ?? null, [jobs, jobId]);

  const pickJob = (id: string) => {
    setJobId(id);
    const j = jobs.find((x) => x.id === id);
    if (!j) return;
    setSource(j.assigned_technician_id ? 'overflow' : 'unassigned');
    if (!title.trim()) setTitle(j.service_type ?? '');
    if (!skill.trim()) setSkill(j.service_type?.toLowerCase() ?? '');
  };

  // Live audience preview — "who would see this, and why not the others".
  useEffect(() => {
    if (!jobId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      jobBoardApi
        .previewAudience(jobId, skill.trim(), areaId || null, audience, priority)
        .then((rows) => {
          if (cancelled) return;
          setPreview(rows);
          setPreviewError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(describeJobBoardError(e));
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId, skill, areaId, audience, priority]);

  const counts = useMemo(() => (preview ? audienceCounts(preview) : null), [preview]);
  const blocked = useMemo(() => (preview ?? []).filter((e) => e.blockers.length > 0), [preview]);

  const submit = async () => {
    if (submitting) return;
    if (!jobId) {
      toast('Choose the job to post.', 'error');
      return;
    }
    const v = validatePostForm({ title, summary, locationLabel, offer, maxBid, expiresMinutes: expires, audience, claimMode, autoAward });
    setErrors(v.errors);
    if (Object.keys(v.errors).length > 0) return;

    setSubmitting(true);
    try {
      await jobBoardApi.post({
        jobId,
        source,
        audience,
        claimMode,
        priority,
        skill: skill.trim(),
        areaId: areaId || null,
        title: title.trim(),
        summary: summary.trim(),
        locationLabel: locationLabel.trim(),
        offerCents: v.offerCents,
        maxBidCents: v.maxBidCents,
        expiresMinutes: v.expiresMinutes,
        autoAward,
      });
      toast(priority === 'urgent' ? 'Urgent shift broadcast' : 'Shift posted to the board', 'success');
      onPosted();
    } catch (e) {
      toast(describeJobBoardError(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-5 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Post a job to the board">
      <div>
        <label htmlFor="jb-job" className="mb-1.5 block text-sm font-medium text-text-primary">
          Job
        </label>
        <select id="jb-job" value={jobId} onChange={(e) => pickJob(e.target.value)} className={selectClass}>
          <option value="">Choose a scheduled job…</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {jobLabel(j)}
            </option>
          ))}
        </select>
        {selectedJob?.assigned_technician_id && (
          <p className="mt-1.5 text-xs text-text-secondary">
            This job already has a technician. Posting it as overflow lets someone else take it over.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="jb-audience" className="mb-1.5 block text-sm font-medium text-text-primary">
            Who sees it
          </label>
          <select id="jb-audience" value={audience} onChange={(e) => setAudience(e.target.value as PostAudience)} className={selectClass}>
            {(Object.keys(AUDIENCE_LABELS) as PostAudience[])
              .filter((a) => allowSubcontractors || a === 'internal')
              .map((a) => (
                <option key={a} value={a}>
                  {AUDIENCE_LABELS[a]}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label htmlFor="jb-mode" className="mb-1.5 block text-sm font-medium text-text-primary">
            How it is claimed
          </label>
          <select
            id="jb-mode"
            value={claimMode}
            onChange={(e) => {
              const m = e.target.value as ClaimMode;
              setClaimMode(m);
              if (m !== 'bidding') setAutoAward(false);
            }}
            className={selectClass}
          >
            {(Object.keys(CLAIM_MODE_LABELS) as ClaimMode[]).map((m) => (
              <option key={m} value={m}>
                {CLAIM_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="jb-skill" className="mb-1.5 block text-sm font-medium text-text-primary">
            Required skill
          </label>
          <Input id="jb-skill" value={skill} onChange={(e) => setSkill(e.target.value)} placeholder="e.g. hvac (blank = anyone)" maxLength={60} />
        </div>
        <div>
          <label htmlFor="jb-area" className="mb-1.5 block text-sm font-medium text-text-primary">
            Service zone
          </label>
          <select id="jb-area" value={areaId} onChange={(e) => setAreaId(e.target.value)} className={selectClass}>
            <option value="">Any zone</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div role="radiogroup" aria-label="Priority" className="flex gap-2">
        {(['normal', 'urgent'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={priority === p}
            onClick={() => setPriority(p)}
            className={`focus-ring rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              priority === p
                ? p === 'urgent'
                  ? 'bg-cta text-white'
                  : 'bg-accent text-white'
                : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
            }`}
          >
            {p === 'urgent' ? 'Urgent — no head start, open to all at once' : 'Normal — fair rotation applies'}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} maxLength={120} required />
        <Input
          label="Location (public)"
          value={locationLabel}
          onChange={(e) => setLocationLabel(e.target.value)}
          error={errors.locationLabel}
          helperText="Neighbourhood or city only — never an address."
          maxLength={80}
        />
      </div>
      <Textarea
        label="Summary (public)"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        error={errors.summary}
        helperText="What the work involves. Customer details are never shown on the board."
        rows={3}
        maxLength={1000}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Input
          label="Offer / shift bonus ($)"
          value={offer}
          onChange={(e) => setOffer(e.target.value)}
          error={errors.offer}
          inputMode="decimal"
          placeholder="optional"
        />
        <Input
          label="Max subcontractor bid ($)"
          value={maxBid}
          onChange={(e) => setMaxBid(e.target.value)}
          error={errors.maxBid}
          inputMode="decimal"
          helperText="Hidden from bidders."
          placeholder="optional"
        />
        <Input
          label="Expires in (minutes)"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          error={errors.expiresMinutes}
          inputMode="numeric"
          helperText="Never later than the job’s start."
        />
      </div>

      {claimMode === 'bidding' && (
        <label className="flex items-start gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={autoAward} onChange={(e) => setAutoAward(e.target.checked)} className="mt-1" />
          <span>
            Auto-award at expiry
            <span className="block text-xs text-text-secondary">
              If nobody is awarded by the deadline, the fairest eligible technician — or the lowest eligible subcontractor bid — wins.
            </span>
          </span>
        </label>
      )}
      {errors.autoAward && <p className="text-xs text-danger">{errors.autoAward}</p>}

      {jobId && (
        <div className="rounded-xl border border-border bg-bg-primary p-4" aria-live="polite">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Users size={16} className="text-accent" />
            Who will see this
            {previewing && <Loader2 size={14} className="animate-spin text-text-secondary" />}
          </div>
          {previewError ? (
            <p className="mt-2 text-sm text-danger">{previewError}</p>
          ) : counts ? (
            <>
              <p className="mt-2 text-sm text-text-secondary">
                {counts.techEligible} technician{counts.techEligible === 1 ? '' : 's'}
                {counts.firstLook > 0 && counts.firstLook < counts.techEligible && priority === 'normal'
                  ? ` (${counts.firstLook} get a head start)`
                  : ''}
                {audience !== 'internal' && ` · ${counts.vendorEligible} subcontractor${counts.vendorEligible === 1 ? '' : 's'}`}
              </p>
              {counts.techEligible + counts.vendorEligible === 0 && (
                <p className="mt-2 text-sm text-danger">
                  Nobody qualifies. Relax the skill or zone, or change who sees it.
                </p>
              )}
              {blocked.length > 0 && (
                <details className="mt-2 text-xs text-text-secondary">
                  <summary className="cursor-pointer">{blocked.length} excluded — why</summary>
                  <ul className="mt-1.5 space-y-0.5">
                    {blocked.map((b) => (
                      <li key={`${b.recipient_type}-${b.technician_id ?? b.vendor_id}`}>
                        <span className="font-medium text-text-primary">{b.label}</span> — {describeBlockers(b.blockers)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={submitting || !jobId}>
          {submitting && <Loader2 size={14} className="animate-spin" />}
          Post to board
        </Button>
      </div>
    </section>
  );
}
