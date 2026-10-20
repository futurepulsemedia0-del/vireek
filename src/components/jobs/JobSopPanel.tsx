import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpenCheck } from 'lucide-react';
import type { Job } from '@/lib/supabase';
import { StatusBadge } from '@/components/sop/SopUi';
import { JobSopRow, fetchSopsForTemplate } from '@/lib/sop';

/**
 * SOPs attached to the job template a job was created from. Anyone on the
 * account can see them; the status chip is the signed-in person's own
 * training state. Renders nothing for jobs without a template, when no SOP is
 * linked, or if the SOP feature is not available yet (migration not applied) —
 * it must never break the job page.
 */
export function JobSopPanel({ job }: { job: Job }) {
  const templateId = (job.job_template_id as string | null | undefined) ?? null;
  const [rows, setRows] = useState<JobSopRow[]>([]);

  useEffect(() => {
    if (!templateId) { setRows([]); return; }
    let cancelled = false;
    fetchSopsForTemplate(templateId)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [templateId]);

  if (!templateId || rows.length === 0) return null;

  return (
    <section aria-label="Procedures for this job" className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-text-primary">
        <BookOpenCheck size={16} className="text-accent" /> Procedures (SOPs)
      </h3>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.sop_id} className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <Link to="/dashboard/training" className="text-sm font-medium text-accent underline-offset-2 hover:underline">
                {r.title}
              </Link>
              {r.linked_items.length > 0 && (
                <p className="text-xs text-text-secondary">Covers checklist: {r.linked_items.join(', ')}</p>
              )}
            </div>
            <StatusBadge status={r.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
