import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, ShieldCheck, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import {
  computeJobRisk,
  DECISION_COLORS,
  DECISION_LABELS,
  DIMENSION_LABELS,
  LEVEL_COLORS,
  LEVEL_LABELS,
  RISK_DIMENSIONS,
  type RiskLevel,
  type RiskReport,
} from '@/lib/riskIntelligence';
import {
  acknowledgeAssessment,
  buildRiskInputs,
  fetchAcknowledgements,
  fetchAssessmentHistory,
  recordAssessment,
  type StoredAcknowledgement,
  type StoredAssessment,
} from '@/lib/riskIntelligenceApi';

const BAR_COLORS: Record<RiskLevel, string> = {
  low: 'bg-success-500',
  medium: 'bg-warning-500',
  high: 'bg-danger',
};

const ACTIVE_STATUSES = new Set(['scheduled', 'en_route', 'in_progress']);

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function JobRiskPanel({ job }: { job: Job }) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [report, setReport] = useState<RiskReport | null>(null);
  const [history, setHistory] = useState<StoredAssessment[]>([]);
  const [acks, setAcks] = useState<StoredAcknowledgement[]>([]);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const jobRef = useRef(job);
  jobRef.current = job;
  const recordedKey = useRef<string | null>(null);

  // Everything that can change the score.
  const jobKey = [
    job.id,
    job.job_status,
    job.service_type,
    job.address,
    job.scheduled_datetime,
    job.assigned_technician_id,
    job.invoice_amount,
    job.customer_type,
    job.diagnosis_notes,
    job.technician_diagnosis,
    Array.isArray(job.before_photos) ? job.before_photos.length : 0,
  ].join('|');

  const load = useCallback(async () => {
    const j = jobRef.current;
    try {
      const { inputs } = await buildRiskInputs([j], j.user_id);
      const live = inputs.get(j.id);
      if (!live) return;
      const next = computeJobRisk(live);

      let hist: StoredAssessment[] = [];
      let ackRows: StoredAcknowledgement[] = [];
      try {
        [hist, ackRows] = await Promise.all([fetchAssessmentHistory(j.id, 8), fetchAcknowledgements(j.id)]);
      } catch {
        // History tables not available yet: still show the live assessment.
      }

      // Keep the audit trail current: record a snapshot whenever the live
      // assessment differs from the last stored one (active jobs only).
      const key = `${j.id}:${next.signature}`;
      if (ACTIVE_STATUSES.has(j.job_status) && hist[0]?.signature !== next.signature && recordedKey.current !== key) {
        recordedKey.current = key;
        try {
          await recordAssessment(j.user_id, j.id, j.assigned_technician_id, next);
          hist = await fetchAssessmentHistory(j.id, 8);
        } catch {
          recordedKey.current = null;
        }
      }

      setReport(next);
      setHistory(hist);
      setAcks(ackRows);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [jobKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed && !report) {
    return <p className="rounded-xl border border-border bg-bg-primary px-4 py-3 text-xs text-text-secondary">Risk assessment is unavailable right now.</p>;
  }
  if (!report) return null;

  const latest = history[0];
  const acknowledged = !!latest && latest.signature === report.signature && acks.some((a) => a.assessment_id === latest.id);
  const ackForLatest = latest ? acks.find((a) => a.assessment_id === latest.id) : undefined;
  const isActive = ACTIVE_STATUSES.has(job.job_status);
  const needsAck = report.coverage.requiresAck && !acknowledged && isActive;
  const tone =
    report.overallLevel === 'high'
      ? 'border-danger/30 bg-danger/5'
      : report.overallLevel === 'medium'
        ? 'border-warning-500/30 bg-warning-500/5'
        : 'border-success-500/30 bg-success-500/5';

  const handleAcknowledge = async () => {
    if (!user || reason.trim().length < 10) return;
    setBusy(true);
    try {
      let assessmentId = latest && latest.signature === report.signature ? latest.id : null;
      if (!assessmentId) {
        assessmentId = await recordAssessment(job.user_id, job.id, job.assigned_technician_id, report);
      }
      await acknowledgeAssessment(job.user_id, user.id, job.id, assessmentId, reason);
      setReason('');
      toast('Risk acknowledged. The job can proceed.', 'success');
      await load();
    } catch {
      toast('Could not record the acknowledgement.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          {report.overallLevel === 'low' ? (
            <ShieldCheck size={16} className="text-success-500" />
          ) : (
            <ShieldAlert size={16} className={report.overallLevel === 'high' ? 'text-danger' : 'text-warning-500'} />
          )}
          Risk Intelligence — {LEVEL_LABELS[report.overallLevel]} risk ({report.overallScore})
        </span>
        <span className="text-xs text-text-secondary">{expanded ? 'Hide' : 'Details'}</span>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${DECISION_COLORS[report.coverage.decision]}`}>
          {DECISION_LABELS[report.coverage.decision]}
        </span>
        {report.flags.filter((f) => f.severity === 'high').length > 0 && (
          <span className="text-xs text-text-secondary">
            {report.flags.filter((f) => f.severity === 'high').length} critical flag
            {report.flags.filter((f) => f.severity === 'high').length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {report.flags.length > 0 && !expanded && (
        <p className="mt-1.5 text-xs text-text-secondary">{report.flags[0].title}</p>
      )}

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-border/60 pt-3">
          <ul className="space-y-2">
            {RISK_DIMENSIONS.map((d) => {
              const dim = report.dimensions[d];
              return (
                <li key={d} className="text-xs">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-medium text-text-primary">
                      {DIMENSION_LABELS[d]}
                      {!dim.applicable && <span className="ml-1.5 font-normal text-text-secondary">(not applicable)</span>}
                      {dim.applicable && !dim.known && <span className="ml-1.5 font-normal text-text-secondary">(incomplete data)</span>}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 font-medium ${LEVEL_COLORS[dim.level]}`}>{LEVEL_LABELS[dim.level]}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                    <div className={`h-full rounded-full ${BAR_COLORS[dim.level]}`} style={{ width: `${dim.score}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>

          {report.flags.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">Findings</p>
              <ul className="space-y-2.5">
                {report.flags.map((f, i) => (
                  <li key={`${f.code}-${i}`} className="text-xs">
                    <p className="flex items-center gap-2 font-medium text-text-primary">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${BAR_COLORS[f.severity]}`} />
                      {f.title}
                    </p>
                    <p className="mt-0.5 pl-3.5 text-text-secondary">{f.detail}</p>
                    <p className="mt-0.5 pl-3.5 text-text-primary">→ {f.action}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.coverage.reasons.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">Why this coverage decision</p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-text-primary">
                {report.coverage.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {report.dataGaps.length > 0 && (
            <p className="text-xs text-text-secondary">
              Confidence {Math.round(report.dataCoverage * 100)}% — {report.dataGaps.join(' · ')}
            </p>
          )}

          {needsAck && (
            <div className="rounded-lg border border-border bg-bg-primary p-3">
              <p className="text-xs font-medium text-text-primary">Acknowledgement required before dispatch</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                Record who accepted this risk and why. This is stored permanently as part of the job&apos;s audit trail.
              </p>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="Reason for proceeding (at least 10 characters)…"
                className="mt-2 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={handleAcknowledge}
                disabled={busy || reason.trim().length < 10}
                className="focus-ring mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                Acknowledge risk &amp; proceed
              </button>
            </div>
          )}

          {acknowledged && ackForLatest && (
            <p className="text-xs text-text-secondary">
              Acknowledged {formatWhen(ackForLatest.created_at)} — “{ackForLatest.reason}”
            </p>
          )}

          {history.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">Assessment history</p>
              <ul className="space-y-1 text-xs text-text-secondary">
                {history.slice(0, 5).map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-2">
                    <span>{formatWhen(h.created_at)}</span>
                    <span>
                      {LEVEL_LABELS[h.overall_level]} ({h.overall_score}) · {DECISION_LABELS[h.coverage_decision]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
