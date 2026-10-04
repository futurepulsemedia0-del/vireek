import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Landmark, Loader2, Lock, History } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { RegulationEntryCard } from '@/components/regulation/RegulationEntryCard';
import {
  fetchJobRegulationContext,
  fetchSnapshotReport,
  recordJobSnapshot,
} from '@/lib/temporalRegulationApi';
import {
  PROOF_META,
  describeDrift,
  formatIsoDate,
  formatTimestamp,
  groupByKind,
  isValidIsoDate,
  proofLevel,
  shortHash,
  type JobRegulationContext,
  type SnapshotReport,
} from '@/lib/temporalRegulation';

/**
 * Decision Proof for one job: "which version of each regulation governed this job on its service date,
 * and what did we know then?" The record is sealed into a per-job hash chain and mirrored into the
 * Job Evidence Chain. If the migration is not installed the panel renders nothing.
 */
export function JobRegulationSnapshotPanel({ job }: { job: { id: string } }) {
  const { toast } = useToast();
  const [ctx, setCtx] = useState<JobRegulationContext | null>(null);
  const [report, setReport] = useState<SnapshotReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [asOf, setAsOf] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([fetchJobRegulationContext(job.id), fetchSnapshotReport(job.id, 5)]);
      setCtx(c);
      setReport(r);
      setAsOf((prev) => prev || c.as_of);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, [job.id]);

  useEffect(() => {
    setLoading(true);
    setAsOf('');
    void load();
  }, [load]);

  const latest = report?.snapshots[0] ?? null;
  const level = proofLevel(report);
  const groups = useMemo(() => (latest ? groupByKind(latest.entries) : []), [latest]);

  const record = async () => {
    if (!ctx?.jurisdiction || !isValidIsoDate(asOf)) return;
    setRecording(true);
    try {
      const res = await recordJobSnapshot({
        jobId: job.id,
        jurisdictionId: ctx.jurisdiction.id,
        asOf,
        reason,
        basis: asOf === ctx.as_of ? ctx.as_of_basis : 'manual',
      });
      toast(
        res.deduplicated
          ? 'This exact regulatory state is already on record.'
          : `Regulation snapshot #${res.seq} sealed (${res.entry_count} regulations).`,
        'success',
      );
      setReason('');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record the regulation snapshot.', 'error');
    } finally {
      setRecording(false);
    }
  };

  if (loading) return <div className="h-14 animate-pulse rounded-xl bg-bg-tertiary" />;
  if (unavailable || !ctx) return null;

  const meta = level === 'none' ? null : PROOF_META[level];

  return (
    <div className="rounded-xl border border-accent/20 bg-accent/5 p-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
          <Landmark size={16} className="shrink-0 text-accent" />
          <span className="truncate">Regulation Record</span>
        </span>
        <span className="shrink-0 text-xs text-text-secondary">{expanded ? 'Hide' : 'Details'}</span>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {meta ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`} title={meta.hint}>
            {meta.label}
          </span>
        ) : (
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
            Not recorded yet
          </span>
        )}
        {latest && (
          <span className="text-xs text-text-secondary">
            As of {formatIsoDate(latest.as_of)} · {latest.jurisdiction_label}
          </span>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {meta && <p className="text-xs text-text-secondary">{meta.hint}</p>}

          {!ctx.jurisdiction ? (
            <p className="rounded-lg border border-border/70 bg-bg-primary p-3 text-xs text-text-secondary">
              {ctx.has_review
                ? `No matching jurisdiction in the regulation graph for ${ctx.review_jurisdiction_label ?? 'this address'}. `
                : 'Run the permit & compliance check first so Vireek knows where this job is. '}
              <Link to="/dashboard/regulation-graph" className="text-accent hover:underline">
                Open the Regulation Graph
              </Link>
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-text-secondary">
                Service date
                <input
                  type="date"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                  className="focus-ring mt-1 block rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
                />
              </label>
              <label className="min-w-[10rem] flex-1 text-xs text-text-secondary">
                Note (optional)
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  placeholder="e.g. Re-checked after code update"
                  className="focus-ring mt-1 block w-full rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-secondary/60"
                />
              </label>
              <button
                type="button"
                onClick={() => void record()}
                disabled={recording || !isValidIsoDate(asOf)}
                className="focus-ring flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {recording ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
                {latest ? 'Re-check & seal' : 'Record & seal'}
              </button>
            </div>
          )}

          {latest && latest.drifted && (
            <div className="rounded-lg border border-warning-500/30 bg-warning-500/5 p-3">
              <p className="text-xs font-medium text-warning-500">Knowledge changed after this record</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-text-primary">
                {latest.drift.map((d) => (
                  <li key={d.key}>{describeDrift(d)}</li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-text-secondary">
                Use “Re-check &amp; seal” to record the corrected state; the original stays on file.
              </p>
            </div>
          )}

          {groups.map((g) => (
            <ul key={g.kind} className="space-y-2">
              {g.items.map((e) => (
                <RegulationEntryCard key={e.version_id} entry={e} compact />
              ))}
            </ul>
          ))}

          {latest && (
            <p className="font-mono text-[11px] text-text-secondary" title="SHA-256 of this record, chained to the previous one">
              Seal #{latest.seq} · {shortHash(latest.snapshot_hash, 16)} · known {formatTimestamp(latest.known_at)}
            </p>
          )}

          {report && report.snapshots.length > 1 && (
            <details className="text-xs text-text-secondary">
              <summary className="focus-ring flex cursor-pointer items-center gap-1.5">
                <History size={12} /> History ({report.snapshots.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {report.snapshots.map((s) => (
                  <li key={s.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-bg-primary px-2 py-1">
                    <span>
                      #{s.seq} · as of {formatIsoDate(s.as_of)} · {s.entries.length} regulations
                      {s.reason ? ` · ${s.reason}` : ''}
                    </span>
                    <span className="font-mono">{shortHash(s.snapshot_hash, 8)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
