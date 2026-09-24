import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Stethoscope, Upload, X, TriangleAlert as AlertTriangle, ShieldAlert,
  ListChecks, Wrench, PackageSearch, ChevronDown,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import {
  DIAGNOSIS_LIMITS, DIAGNOSIS_SEVERITY_META, analyzeDiagnosis, fetchDiagnosisHistory,
  uploadDiagnosisPhoto, type DiagnosisResult, type DiagnosisSessionRow,
} from '@/lib/diagnosisCopilot';

interface JobOption { id: string; customer_name: string; customer_id: string | null; service_type: string | null }
interface EquipmentOption { id: string; equipment_type: string; make: string | null; model: string | null; serial_number: string | null }

export function DiagnosisCopilotPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [equipmentOptions, setEquipmentOptions] = useState<EquipmentOption[]>([]);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState('');

  const [symptoms, setSymptoms] = useState('');
  const [meterReadings, setMeterReadings] = useState('');
  const [equipmentLabel, setEquipmentLabel] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<DiagnosisResult | null>(null);

  const [history, setHistory] = useState<DiagnosisSessionRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const fetchJobs = useCallback(async () => {
    const { data } = await supabase
      .from('jobs')
      .select('id, customer_name, customer_id, service_type')
      .neq('job_status', 'completed')
      .order('scheduled_datetime', { ascending: false })
      .limit(100);
    setJobs((data as JobOption[]) ?? []);
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      setHistory(await fetchDiagnosisHistory(20));
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => { fetchJobs(); fetchHistory(); }, [fetchJobs, fetchHistory]);

  useEffect(() => {
    setSelectedEquipmentId('');
    const job = jobs.find((j) => j.id === selectedJobId);
    if (!job?.customer_id) { setEquipmentOptions([]); return; }
    supabase
      .from('equipment')
      .select('id, equipment_type, make, model, serial_number')
      .eq('customer_id', job.customer_id)
      .then(({ data }) => setEquipmentOptions((data as EquipmentOption[]) ?? []));
  }, [selectedJobId, jobs]);

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).slice(0, DIAGNOSIS_LIMITS.photos);
    setFiles(picked);
  };
  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const runDiagnosis = async () => {
    if (!user || symptoms.trim().length < 8) {
      toast('Describe the symptom in a bit more detail.', 'error');
      return;
    }
    setAnalyzing(true);
    setResult(null);
    try {
      const photoPaths = await Promise.all(files.map((f) => uploadDiagnosisPhoto(user.id, f)));
      const diagnosis = await analyzeDiagnosis({
        symptoms,
        meterReadings,
        equipmentLabel,
        jobId: selectedJobId || null,
        equipmentId: selectedEquipmentId || null,
        photoPaths,
      });
      setResult(diagnosis);
      fetchHistory();
      toast(
        diagnosis.severity === 'emergency' || diagnosis.severity === 'high'
          ? 'Diagnosis ready — safety flags found, review before proceeding.'
          : 'Diagnosis ready.',
        diagnosis.severity === 'emergency' ? 'error' : 'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not run the diagnosis.', 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Diagnosis Copilot">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Stethoscope size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">AI Diagnosis-to-Resolution Copilot</h1>
          <p className="text-sm text-text-secondary">Give the symptoms, a meter reading and a photo — get probable causes, a test plan, parts needed, safety warnings and a repair path.</p>
        </div>
      </div>

      <div className="mb-8 rounded-2xl border border-border bg-bg-secondary p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Job (optional)</label>
            <select value={selectedJobId} onChange={(e) => setSelectedJobId(e.target.value)} className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
              <option value="">No job selected…</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.customer_name}{j.service_type ? ` — ${j.service_type}` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Equipment on file (optional)</label>
            <select value={selectedEquipmentId} onChange={(e) => setSelectedEquipmentId(e.target.value)} disabled={equipmentOptions.length === 0} className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm disabled:opacity-50">
              <option value="">{equipmentOptions.length ? 'Select equipment…' : 'No equipment on file for this job'}</option>
              {equipmentOptions.map((eq) => (
                <option key={eq.id} value={eq.id}>{[eq.equipment_type, eq.make, eq.model].filter(Boolean).join(' ')}</option>
              ))}
            </select>
          </div>
        </div>

        {!selectedEquipmentId && (
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-text-secondary">Equipment brand / model (if not on file)</label>
            <input value={equipmentLabel} onChange={(e) => setEquipmentLabel(e.target.value)} placeholder="e.g. Carrier 24ACC6 3-ton condenser" className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
          </div>
        )}

        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary">Symptoms *</label>
          <textarea value={symptoms} onChange={(e) => setSymptoms(e.target.value)} rows={3} placeholder="e.g. Outdoor unit runs but no cold air inside, compressor cycles every 90 seconds, light frost on the suction line." className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary">Meter / gauge reading (optional)</label>
          <input value={meterReadings} onChange={(e) => setMeterReadings(e.target.value)} placeholder="e.g. Suction 118 psi, Discharge 210 psi, Superheat 4°F" className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm" />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={() => fileInputRef.current?.click()} className="focus-ring flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
            <Upload size={14} /> Add photos ({files.length}/{DIAGNOSIS_LIMITS.photos})
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickFiles} />
        </div>
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
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
          onClick={runDiagnosis}
          disabled={symptoms.trim().length < 8 || analyzing}
          className="focus-ring mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <Stethoscope size={14} /> {analyzing ? 'Diagnosing…' : 'Run diagnosis'}
        </button>

        {result && (
          <div className="mt-5 space-y-4 rounded-xl border border-border bg-bg-primary p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${DIAGNOSIS_SEVERITY_META[result.severity].className}`}>
                {DIAGNOSIS_SEVERITY_META[result.severity].label}
              </span>
              <span className="text-xs text-text-secondary">Confidence: {Math.round(result.confidence * 100)}%</span>
              {result.recommend_specialist && (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2.5 py-0.5 text-xs font-medium text-warning-500">Recommend specialist</span>
              )}
            </div>
            <p className="text-sm text-text-primary">{result.summary}</p>

            {result.safety_warnings.length > 0 && (
              <div className="rounded-lg border border-danger-500/30 bg-danger-500/5 p-3">
                <p className="flex items-center gap-1 text-xs font-semibold text-danger-500"><ShieldAlert size={12} /> Safety warnings</p>
                <ul className="mt-1 space-y-1">
                  {result.safety_warnings.map((f, i) => <li key={i} className="text-xs text-danger-500">• {f}</li>)}
                </ul>
              </div>
            )}

            {result.probable_causes.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold text-text-primary">Probable causes</p>
                <div className="space-y-2">
                  {result.probable_causes.map((c, i) => (
                    <div key={i} className="rounded-lg border border-border p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-text-primary">{c.cause}</span>
                        <span className="text-xs text-text-secondary">{Math.round(c.likelihood * 100)}%</span>
                      </div>
                      <p className="mt-0.5 text-xs text-text-secondary">{c.reasoning}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.test_steps.length > 0 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-text-primary"><ListChecks size={12} /> Diagnostic test plan</p>
                <ol className="space-y-1.5">
                  {result.test_steps.map((t, i) => (
                    <li key={i} className="text-xs text-text-secondary">
                      <span className="font-medium text-text-primary">{i + 1}. {t.step}</span>
                      {t.tool_needed && <span className="text-text-secondary"> — tool: {t.tool_needed}</span>}
                      {t.expected_result && <span className="block text-text-secondary">Expected: {t.expected_result}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {result.parts_needed.length > 0 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-text-primary"><PackageSearch size={12} /> Parts likely needed</p>
                <div className="flex flex-wrap gap-1.5">
                  {result.parts_needed.map((p, i) => (
                    <span key={i} className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
                      {p.quantity}× {p.name} <span className="text-text-secondary/70">({p.necessity.replace('_', ' ')})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {result.repair_path.length > 0 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-text-primary"><Wrench size={12} /> Repair path (once confirmed)</p>
                <ol className="list-decimal space-y-1 pl-4">
                  {result.repair_path.map((r, i) => <li key={i} className="text-xs text-text-secondary">{r}</li>)}
                </ol>
              </div>
            )}

            {result.missing_info.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-text-primary">Would help narrow this down</p>
                <ul className="space-y-1">
                  {result.missing_info.map((m, i) => <li key={i} className="text-xs text-text-secondary">• {m}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <h2 className="mb-3 text-sm font-semibold text-text-primary">Recent diagnoses</h2>
      {loadingHistory ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : history.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">No diagnoses yet — run one above to build your history.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {history.map((h) => (
            <details key={h.id} className="group rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${DIAGNOSIS_SEVERITY_META[h.severity].className}`}>
                    {DIAGNOSIS_SEVERITY_META[h.severity].label}
                  </span>
                  <span className="text-sm font-medium text-text-primary">{h.equipment_label || 'Equipment'}</span>
                  <span className="text-xs text-text-secondary">{new Date(h.created_at).toLocaleString()}</span>
                </div>
                <ChevronDown size={16} className="text-text-secondary transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-2 text-xs text-text-secondary">{h.symptoms}</p>
              <p className="mt-2 text-sm text-text-primary">{h.ai_result.summary}</p>
            </details>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
