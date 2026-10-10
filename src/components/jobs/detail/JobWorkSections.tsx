import { useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';
import { Camera, ImageOff, Package, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import type { Job } from '@/lib/supabase';
import { PHOTO_MIME_TYPES, jobPhotoUrl, summarizeRequiredParts, summarizeUsedParts } from '@/lib/jobDetail';
import type { RequiredPartRow, UsedPartRow } from '@/lib/jobDetail';
import { formatCents } from '@/lib/jobCosting';
import { JobSection, Pill, Row, SectionError, SectionSkeleton } from './JobSection';
import type { SectionState } from './JobSection';

// ============================================================
// PHOTOS
// ============================================================

type Slot = 'before' | 'after';

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/80 p-4" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={alt} tabIndex={-1} className="relative max-h-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="max-h-[85vh] w-auto max-w-full rounded-xl object-contain" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className="focus-ring absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

function PhotoThumb({ value, alt, onOpen }: { value: string; alt: string; onOpen: (src: string, alt: string) => void }) {
  const [failed, setFailed] = useState(false);
  const src = jobPhotoUrl(value);
  if (failed) {
    return (
      <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border border-border bg-bg-tertiary text-xs text-text-secondary">
        <ImageOff size={18} aria-hidden="true" />
        Unavailable
      </div>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(src, alt)} className="focus-ring block aspect-square w-full overflow-hidden rounded-xl border border-border bg-bg-tertiary">
      <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
    </button>
  );
}

export function JobPhotosCard({
  job,
  canEdit,
  uploading,
  onUpload,
}: {
  job: Job;
  canEdit: boolean;
  uploading: Slot | null;
  onUpload: (slot: Slot, files: File[]) => void;
}) {
  const [viewing, setViewing] = useState<{ src: string; alt: string } | null>(null);
  const beforeRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);
  const slots: { slot: Slot; label: string; photos: string[]; input: RefObject<HTMLInputElement> }[] = [
    { slot: 'before', label: 'Before', photos: job.before_photos ?? [], input: beforeRef },
    { slot: 'after', label: 'After', photos: job.after_photos ?? [], input: afterRef },
  ];

  return (
    <JobSection title="Before / after photos" icon={Camera}>
      <div className="grid gap-5 sm:grid-cols-2">
        {slots.map(({ slot, label, photos, input }) => (
          <div key={slot}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-text-secondary">
                {label} <span aria-label={`${photos.length} photos`}>({photos.length})</span>
              </h3>
              {canEdit && (
                <>
                  <input
                    ref={input}
                    type="file"
                    multiple
                    accept={PHOTO_MIME_TYPES.join(',')}
                    className="hidden"
                    aria-label={`Add ${label.toLowerCase()} photos`}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = ''; // allow re-selecting the same file
                      if (files.length > 0) onUpload(slot, files);
                    }}
                  />
                  <Button variant="secondary" size="sm" disabled={uploading !== null} onClick={() => input.current?.click()}>
                    <Camera size={14} /> {uploading === slot ? 'Uploading…' : 'Add'}
                  </Button>
                </>
              )}
            </div>
            {photos.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-text-secondary">No {label.toLowerCase()} photos</p>
            ) : (
              <ul className="grid grid-cols-3 gap-2">
                {photos.map((p, i) => (
                  <li key={`${p}-${i}`}>
                    <PhotoThumb value={p} alt={`${label} photo ${i + 1}`} onOpen={(src, alt) => setViewing({ src, alt })} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {viewing && <Lightbox src={viewing.src} alt={viewing.alt} onClose={() => setViewing(null)} />}
    </JobSection>
  );
}

// ============================================================
// PARTS
// ============================================================

const PART_STATUS_LABEL: Record<RequiredPartRow['status'], string> = {
  needed: 'Needed',
  allocated: 'Allocated',
  installed: 'Installed',
  backordered: 'Backordered',
};
const PART_STATUS_CLASS: Record<RequiredPartRow['status'], string> = {
  needed: 'bg-bg-tertiary text-text-secondary',
  allocated: 'bg-blue-500/10 text-blue-500',
  installed: 'bg-success-500/10 text-success-500',
  backordered: 'bg-danger/10 text-danger',
};

function Readiness({ row }: { row: RequiredPartRow }) {
  if (row.status === 'installed') return null;
  if (row.readiness_status === 'ready') {
    return <Pill className="bg-success-500/10 text-success-500">In stock{row.source_location_name ? ` · ${row.source_location_name}` : ''}</Pill>;
  }
  if (row.readiness_status === 'short') {
    return (
      <Pill className="bg-warning-500/10 text-warning-500">
        Short by {row.shortage_quantity}
        {row.source_location_name ? ` · ${row.source_location_name}` : ''}
      </Pill>
    );
  }
  return <Pill className="bg-danger/10 text-danger">No stock location</Pill>;
}

export function JobPartsCard({ required, used }: { required: SectionState<RequiredPartRow[]>; used: SectionState<UsedPartRow[]> }) {
  const loading = (required.loading && required.data.length === 0) || (used.loading && used.data.length === 0);
  const summary = summarizeRequiredParts(required.data);
  const usedSummary = summarizeUsedParts(used.data);
  const usedCost = usedSummary.reduce((s, p) => s + p.costCents, 0);
  const empty = required.data.length === 0 && usedSummary.length === 0;

  let body: ReactNode;
  if (loading) {
    body = <SectionSkeleton />;
  } else if (required.error && used.error) {
    body = (
      <SectionError
        onRetry={() => {
          required.reload();
          used.reload();
        }}
      />
    );
  } else if (empty && !required.error && !used.error) {
    body = (
      <>
        <EmptyState
          icon={Package}
          title="No parts on this job"
          description="Add required parts in Parts & Inventory to check van and warehouse stock before dispatch."
        />
        <p className="mt-3 text-center text-xs">
          <Link to="/dashboard/inventory" className="focus-ring font-medium text-accent hover:underline">
            Open Parts &amp; Inventory
          </Link>
        </p>
      </>
    );
  } else {
    body = (
      <div className="space-y-5">
        {required.error && <SectionError message="Could not load required parts." onRetry={required.reload} />}
        {used.error && <SectionError message="Could not load parts used." onRetry={used.reload} />}

        {required.data.length > 0 && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-medium text-text-secondary">Required</h3>
              <Pill className="bg-bg-tertiary text-text-secondary">
                {summary.installed}/{summary.total} installed
              </Pill>
              {summary.atRisk > 0 && (
                <Pill className="bg-warning-500/10 text-warning-500">
                  {summary.atRisk} at risk
                </Pill>
              )}
            </div>
            <ul className="space-y-2">
              {required.data.map((r) => (
                <li key={r.requirement_id}>
                  <Row>
                    <span className="min-w-0 text-sm font-medium text-text-primary">
                      {r.part_name} <span className="font-normal text-text-secondary">× {r.quantity_required}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Readiness row={r} />
                      <Pill className={PART_STATUS_CLASS[r.status]}>{PART_STATUS_LABEL[r.status]}</Pill>
                    </span>
                  </Row>
                </li>
              ))}
            </ul>
          </div>
        )}

        {usedSummary.length > 0 && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-medium text-text-secondary">Used on this job</h3>
              {usedCost > 0 && <Pill className="bg-bg-tertiary text-text-secondary">{formatCents(usedCost)} at cost</Pill>}
            </div>
            <ul className="space-y-2">
              {usedSummary.map((p) => (
                <li key={p.part_id}>
                  <Row>
                    <span className="min-w-0 text-sm font-medium text-text-primary">
                      {p.part_name}
                      {p.part_number && <span className="ml-2 text-xs font-normal text-text-secondary">{p.part_number}</span>}
                    </span>
                    <span className="text-sm text-text-secondary">
                      {p.quantity} used{p.costCents > 0 ? ` · ${formatCents(p.costCents)}` : ''}
                    </span>
                  </Row>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <JobSection
      title="Parts"
      icon={Package}
      action={
        <Link to="/dashboard/inventory" className="focus-ring text-xs font-medium text-accent hover:underline">
          Inventory
        </Link>
      }
    >
      {body}
    </JobSection>
  );
}
