import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  computeExpertRisk,
  RISK_TIER_LABELS,
  RISK_TIER_STYLES,
  type ExpertRiskRow,
} from '@/lib/knowledgeCapture';
import { fetchExpertRisk, setExpertProfile } from '@/lib/knowledgeCaptureApi';

function RiskRow({ row, onSaved }: { row: ExpertRiskRow; onSaved: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(row.expected_departure ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');
  const [saving, setSaving] = useState(false);
  const risk = useMemo(() => computeExpertRisk(row), [row]);

  const save = async () => {
    setSaving(true);
    try {
      await setExpertProfile(row.team_member_id, date || null, notes.trim());
      toast('Saved.', 'success');
      setEditing(false);
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="rounded-2xl border border-border/80 bg-bg-secondary p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{row.member_name}</h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            {row.jobs_completed_180d} jobs (180d) · {row.rules_originated} rules originated ·{' '}
            {row.rules_deployed} live · {row.sole_source_rules} single-source
          </p>
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${RISK_TIER_STYLES[risk.tier]}`}
        >
          {RISK_TIER_LABELS[risk.tier]} risk · {risk.score}
        </span>
      </div>

      {risk.reasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-text-secondary">
          {risk.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-text-primary">
        <span className="font-semibold">Next step:</span> {risk.suggestedAction}
      </p>

      {editing ? (
        <div className="mt-4 space-y-3 rounded-xl bg-bg-primary p-4">
          <Input
            type="date"
            label="Expected last day (optional)"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Input
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="focus-ring mt-3 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
        >
          <CalendarClock size={13} aria-hidden="true" />{' '}
          {row.expected_departure
            ? `Leaving ${row.expected_departure} — edit`
            : 'Set expected departure'}
        </button>
      )}
    </li>
  );
}

export function ExpertRiskPanel() {
  const [rows, setRows] = useState<ExpertRiskRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await fetchExpertRisk());
      setFailed(false);
    } catch {
      setFailed(true);
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () =>
      (rows ?? [])
        .map((r) => ({ r, s: computeExpertRisk(r).score }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r),
    [rows],
  );

  if (rows === null) return <Skeleton className="h-40 w-full" />;
  if (failed)
    return (
      <EmptyState
        icon={Users}
        title="Couldn't load knowledge risk"
        description="Refresh the page to try again."
      />
    );
  if (sorted.length === 0)
    return (
      <EmptyState
        icon={Users}
        title="No technicians on your team yet"
        description="Invite your technicians to start tracking whose knowledge is at risk."
      />
    );

  return (
    <div>
      <p className="mb-4 max-w-2xl text-xs leading-relaxed text-text-secondary">
        Risk combines how soon someone may leave, how little of their experience has been captured
        relative to the work they do, and how many rules exist only in their head. Highest risk
        first.
      </p>
      <ul className="grid gap-3 lg:grid-cols-2">
        {sorted.map((row) => (
          <RiskRow key={row.team_member_id} row={row} onSaved={load} />
        ))}
      </ul>
    </div>
  );
}
