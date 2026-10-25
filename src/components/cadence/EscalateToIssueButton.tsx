import { useState } from 'react';
import { Flag } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { createIssue, type IssueInput } from '@/lib/cadenceApi';
import type { IssueSource, MetricKey } from '@/lib/cadence';
import { errMsg } from '@/components/cadence/shared';

/**
 * Drop-in "Escalate to issues list" button. Safe to double-click: the database
 * allows only one live issue per (source_type, source_ref).
 */
export function EscalateToIssueButton({
  title,
  description = null,
  sourceType,
  sourceRef,
  metricKey = null,
  impactCents = null,
  compact = false,
  onDone,
}: {
  title: string;
  description?: string | null;
  sourceType: Exclude<IssueSource, 'manual'>;
  sourceRef: string;
  metricKey?: MetricKey | null;
  impactCents?: number | null;
  compact?: boolean;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const input: IssueInput = {
        title: title.slice(0, 200),
        description,
        impact_cents: impactCents,
        needs_decision: false,
        owner_user_id: null,
        owner_name: null,
        source_type: sourceType,
        source_ref: sourceRef.slice(0, 200),
        metric_key: metricKey,
      };
      const result = await createIssue(input);
      toast(result === 'duplicate' ? 'Already on the issues list.' : 'Added to the issues list.', result === 'duplicate' ? 'info' : 'success');
      onDone?.();
    } catch (e) {
      toast(errMsg(e, 'Could not add the issue.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      title="Escalate to the issues list"
      aria-label="Escalate to the issues list"
      className={
        compact
          ? 'focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-accent disabled:opacity-50'
          : 'focus-ring inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-accent disabled:opacity-50'
      }
    >
      <Flag size={compact ? 14 : 13} />
      {!compact && (busy ? 'Adding…' : 'Escalate')}
    </button>
  );
}
