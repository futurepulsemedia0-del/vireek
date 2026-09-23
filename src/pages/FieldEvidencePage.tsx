import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanEye, Upload, X, TriangleAlert as AlertTriangle, ShieldAlert, CircleCheck as CheckCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import { MAX_EVIDENCE_PHOTOS, uploadEvidencePhoto, verifyJobEvidence, type JobEvidenceVerdict } from '@/lib/jobEvidence';

interface JobOption { id: string; customer_name: string; service_type: string | null; job_status: string }

interface QueueRow {
  id: string;
  job_id: string;
  verdict: 'pass' | 'needs_attention' | 'fail';
  ai_summary: string | null;
  safety_flags: { hazard: string; severity: string }[];
  quality_issues: { issue: string; severity: string }[];
  created_at: string;
  jobs: { customer_name: string } | null;
}

const VERDICT_STYLES: Record<string, string> = {
  pass: 'bg-success-500/10 text-success-500',
  needs_attention: 'bg-warning-500/10 text-warning-500',
  fail: 'bg-danger-500/10 text-danger-500',
};

export function FieldEvidencePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<JobEvidenceVerdict | null>(null);

  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(true);

  const fetchJobs = useCallback(async () => {
    const { data } = await supabase
      .from('jobs')
      .select('id, customer_name, service_type, job_status')
      .neq('job_status', 'completed')
      .order('scheduled_datetime', { ascending: false })
      .limit(100);
    setJobs((data as JobOption[]) ?? []);
  }, []);

  const fetchQueue = useCallback(async () => {
    setLoadingQueue(true);
    const { data } = await supabase
      .from('job_evidence_checks')
      .select('id, job_id, verdict, ai_summary, safety_flags, quality_issues, created_at, jobs:job_id (customer_name)')
      .eq('resolved', false)
      .neq('verdict', 'pass')
      .order('created_at', { ascending: false })
      .limit(50);
    setQueue((data as unknown as QueueRow[]) ?? []);
    setLoadingQueue(false);
  }, []);

  useEffect(() => { fetchJobs(); fetchQueue(); }, [fetchJobs, fetchQueue]);

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).slice(0, MAX_EVIDENCE_PHOTOS);
    setFiles(picked);
    setResult(null);
  };

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const runVerification = async () => {
    if (!user || !selectedJobId || files.length === 0) return;
    setVerifying(true);
    setResult(null);
    try {
      const paths = await Promise.all(files.map((f) => uploadEvidencePhoto(user.id, f)));
      const verdict = await verifyJobEvidence(selectedJobId, paths);
      setResult(verdict);
      if (verdict.verdict !== 'pass') fetchQueue();
      toast(
        verdict.verdict === 'pass' ? 'Evidence passed — this job is clear to close.' : 'Evidence needs a look before this job closes.',
        verdict.verdict === 'fail' ? 'error' : verdict.verdict === 'pass' ? 'success' : 'info',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not verify evidence.', 'error');
    } finally {
      setVerifying(false);
    }
  };

  const markResolved = async (id: string) => {
    await supabase.from('job_evidence_checks').update({ resolved: true }).eq('id', id);
    setQueue((prev) => prev.filter((q) => q.id !== id));
  };

  return (
    <DashboardLayout activeLabel="Field Evidence">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><ScanEye size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Field Safety &amp; Quality Verification</h1>
          <p className="text-sm text-text-secondary">AI reviews technician photos for incomplete evidence, poor quality, unclear serials, or safety issues — before the job closes.</p>
        </div>
      </div>

      <div className="mb-8 rounded-2xl border border-border bg-bg-secondary p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <select value={selectedJobId} onChange={(e) => { setSelectedJobId(e.target.value); setResult(null); }} className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
            <option value="">Select a job…</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.customer_name}{j.service_type ? ` — ${j.service_type}` : ''}</option>)}
          </select>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="focus-ring flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
            <Upload size={14} /> Add photos ({files.length}/{MAX_EVIDENCE_PHOTOS})
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickFiles} />
        </div>

        {files.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-2.5 py-1 text-xs text-text-secondary">
                {f.name.length > 20 ? `${f.name.slice(0, 20)}…` : f.name}
                <button type="button" onClick={() => removeFile(i)} className="focus-ring text-text-secondary hover:text-danger-500"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={runVerification}
          disabled={!selectedJobId || files.length === 0 || verifying}
          className="focus-ring mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <ScanEye size={14} /> {verifying ? 'Verifying…' : 'Verify evidence'}
        </button>

        {result && (
          <div className="mt-5 rounded-xl border border-border bg-bg-primary p-4">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${VERDICT_STYLES[result.verdict]}`}>
                {result.verdict === 'pass' ? <CheckCircle size={11} /> : <AlertTriangle size={11} />} {result.verdict.replace('_', ' ')}
              </span>
              <span className="text-xs text-text-secondary">Evidence completeness: {Math.round(result.evidence_completeness * 100)}%</span>
            </div>
            <p className="mt-2 text-sm text-text-primary">{result.summary}</p>

            {result.safety_flags.length > 0 && (
              <div className="mt-3">
                <p className="flex items-center gap-1 text-xs font-semibold text-danger-500"><ShieldAlert size={12} /> Safety flags</p>
                <ul className="mt-1 space-y-1">
                  {result.safety_flags.map((f, i) => <li key={i} className="text-xs text-text-secondary">• {f.hazard} <span className="capitalize text-danger-500">({f.severity})</span></li>)}
                </ul>
              </div>
            )}
            {result.quality_issues.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold text-warning-500">Photo quality issues</p>
                <ul className="mt-1 space-y-1">
                  {result.quality_issues.map((q, i) => <li key={i} className="text-xs text-text-secondary">• {q.issue} <span className="capitalize text-warning-500">({q.severity})</span></li>)}
                </ul>
              </div>
            )}
            {result.detected_serials.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold text-text-primary">Detected serial/model numbers</p>
                <p className="mt-1 text-xs text-text-secondary">{result.detected_serials.join(', ')}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <h2 className="mb-3 text-sm font-semibold text-text-primary">Needs attention</h2>
      <p className="mb-3 text-xs text-text-secondary">Jobs whose most recent evidence check did not pass — clear these before closing the job.</p>
      {loadingQueue ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : queue.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">Nothing outstanding — every recent evidence check has passed or been resolved.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {queue.map((q) => (
            <div key={q.id} className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${VERDICT_STYLES[q.verdict]}`}>
                      <AlertTriangle size={11} /> {q.verdict.replace('_', ' ')}
                    </span>
                    <span className="text-sm font-semibold text-text-primary">{q.jobs?.customer_name ?? 'Job'}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-text-secondary">{q.ai_summary}</p>
                  {q.safety_flags.length > 0 && <p className="mt-1 text-xs font-medium text-danger-500">{q.safety_flags.length} safety flag{q.safety_flags.length > 1 ? 's' : ''}</p>}
                </div>
                <button type="button" onClick={() => markResolved(q.id)} className="focus-ring shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
                  Mark resolved
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
