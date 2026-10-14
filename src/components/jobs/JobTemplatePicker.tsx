import { useCallback, useEffect, useState } from 'react';
import { Clock, LayoutTemplate, ListChecks, Package, RefreshCw, Wrench } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  JobTemplateSummary,
  describeTemplateError,
  fetchActiveJobTemplates,
  formatDuration,
  formatTemplatePrice,
} from '@/lib/jobTemplates';

/**
 * "Start from a template" control for the New Job modal. Fully self-contained:
 * it loads the account's active templates, handles loading / error / empty
 * states, and reports the chosen template to the parent. It never blocks job
 * creation — if it fails, the user can still create a job the normal way.
 */
export function JobTemplatePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: JobTemplateSummary | null;
  onChange: (template: JobTemplateSummary | null) => void;
  disabled?: boolean;
}) {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canSeePrices = isOwner || permissions.can_view_billing;

  const [templates, setTemplates] = useState<JobTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    setError(null);
    try {
      setTemplates(await fetchActiveJobTemplates(accountOwnerId));
    } catch (err) {
      setError(describeTemplateError(err, 'Could not load templates.'));
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Nothing to offer and nothing wrong: stay out of the way.
  if (!loading && !error && templates.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3.5">
      <label htmlFor="job-template-select" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-text-primary">
        <LayoutTemplate size={15} className="text-accent" /> Start from a template
        <span className="font-normal text-text-secondary">(optional)</span>
      </label>

      {loading ? (
        <div className="h-10 animate-pulse rounded-xl bg-bg-tertiary" aria-label="Loading templates" role="status" />
      ) : error ? (
        <div role="alert" className="flex items-center justify-between gap-3 text-xs text-text-secondary">
          <span>{error} You can still create the job without one.</span>
          <button
            type="button"
            onClick={() => void load()}
            className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-medium text-accent hover:bg-accent/10"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      ) : (
        <>
          <select
            id="job-template-select"
            value={value?.id ?? ''}
            disabled={disabled}
            onChange={(e) => onChange(templates.find((t) => t.id === e.target.value) ?? null)}
            className="focus-ring w-full rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm text-text-primary disabled:opacity-60"
          >
            <option value="">No template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {canSeePrices && t.price_cents > 0 ? ` — ${formatTemplatePrice(t.price_cents)}` : ''}
              </option>
            ))}
          </select>

          {value && (
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
              <li className="flex items-center gap-1.5">
                <Clock size={12} /> {formatDuration(value.expected_duration_minutes)}
              </li>
              <li className="flex items-center gap-1.5">
                <Wrench size={12} /> {value.service_count} services
              </li>
              <li className="flex items-center gap-1.5">
                <Package size={12} /> {value.part_count} parts
              </li>
              <li className="flex items-center gap-1.5">
                <ListChecks size={12} /> {value.checklist_count} checklist items
              </li>
            </ul>
          )}
        </>
      )}
    </div>
  );
}
