// src/components/technician/FieldCapturePanel.tsx
// Offline field capture for one job: photos, signature, voice notes, barcode / NFC,
// the completion form and the GPS trail. Every action is saved on the device first
// and synced automatically — it works the same with or without signal.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, CheckCircle2, ImagePlus, Mic, MapPin, Nfc, PenLine, ScanLine, Square, Trash2 } from 'lucide-react';
import { SignaturePad, type SignaturePadValue } from '@/components/signatures/SignaturePad';
import { useToast } from '@/contexts/ToastContext';
import { useFieldVersion, useSyncState } from '@/hooks/useFieldSync';
import {
  compressImage, dataUrlToBlob, getLastKnownFix, isTrackingEnabled, isVoiceSupported, setTrackingEnabled,
  startVoiceRecording, type VoiceRecording,
} from '@/lib/offline/capture';
import { detectCapabilities, ensureTrailPermission, readTag, scanCode } from '@/lib/native/capabilities';
import { FieldFormsCard } from '@/components/technician/FieldFormsCard';
import type { OutboxOp } from '@/lib/offline/db';
import { dismissOp, enqueue, listOutboxForJob } from '@/lib/offline/outbox';
import { MAX_EVIDENCE_PHOTOS, verifyJobEvidence, type JobEvidenceVerdict } from '@/lib/jobEvidence';
import { supabase } from '@/lib/supabase';

type Kind = 'photo' | 'signature' | 'voice_note' | 'barcode' | 'nfc' | 'form';

interface SyncedArtifact {
  id: string;
  kind: Kind;
  storage_bucket: string | null;
  storage_path: string | null;
}

const KIND_LABEL: Record<Kind, string> = {
  photo: 'Photo', signature: 'Signature', voice_note: 'Voice note', barcode: 'Scan', nfc: 'NFC tag', form: 'Form',
};
const MAX_VOICE_SECONDS = 180;

function ActionButton(props: { onClick?: () => void; disabled?: boolean; active?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
        props.active ? 'border-danger bg-danger/10 text-danger' : 'border-border bg-bg-primary text-text-primary'
      }`}
    >
      {props.icon}
      {props.children}
    </button>
  );
}

export function FieldCapturePanel({ jobId, customerName }: { jobId: string; customerName: string }) {
  const { toast } = useToast();
  const version = useFieldVersion();
  const sync = useSyncState();
  const [queued, setQueued] = useState<OutboxOp[]>([]);
  const [synced, setSynced] = useState<SyncedArtifact[]>([]);
  const [verdict, setVerdict] = useState<JobEvidenceVerdict | null>(null);
  const [checking, setChecking] = useState(false);

  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<VoiceRecording | null>(null);

  const [signing, setSigning] = useState(false);
  const [signature, setSignature] = useState<SignaturePadValue | null>(null);
  const [signerName, setSignerName] = useState(customerName);

  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanAbort = useRef<AbortController | null>(null);
  const [manualCode, setManualCode] = useState('');

  const [gps, setGps] = useState(false);
  const [caps, setCaps] = useState({ scan: false, nfc: false });
  const [form, setForm] = useState({
    work_performed: '', parts_used: '', system_tested: false, area_cleaned: false,
    customer_walkthrough: false, follow_up_needed: false, follow_up_note: '',
  });

  useEffect(() => {
    let cancelled = false;
    void listOutboxForJob(jobId).then((ops) => {
      if (!cancelled) setQueued(ops.filter((o) => o.type === 'artifact'));
    });
    void isTrackingEnabled().then((on) => {
      if (!cancelled) setGps(on);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, version]);

  useEffect(() => {
    if (!sync.online) return undefined;
    let cancelled = false;
    void supabase
      .from('job_field_artifacts')
      .select('id, kind, storage_bucket, storage_path')
      .eq('job_id', jobId)
      .order('captured_at', { ascending: true })
      .limit(100)
      .then(({ data }) => {
        if (!cancelled && data) setSynced(data as SyncedArtifact[]);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, sync.online, sync.lastSyncAt]);

  useEffect(() => {
    let cancelled = false;
    void detectCapabilities().then((c) => {
      if (!cancelled) setCaps(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!recording) return undefined;
    const t = window.setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => () => {
    recorderRef.current?.cancel();
    scanAbort.current?.abort();
  }, []);

  const queue = useCallback(
    async (kind: Kind, data: Record<string, unknown>, blob?: { data: Blob; bucket: string; ext: string }) => {
      const fix = getLastKnownFix();
      try {
        await enqueue('artifact', jobId, { kind, data, lat: fix?.lat ?? null, lng: fix?.lng ?? null }, { blob });
        return true;
      } catch {
        toast('Could not save on this device — free up storage and try again.', 'error');
        return false;
      }
    },
    [jobId, toast],
  );

  async function onPhotos(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const out = await compressImage(file);
      await queue('photo', { original_bytes: file.size, bytes: out.size }, { data: out, bucket: 'job-evidence-photos', ext: 'jpg' });
    }
    toast(`${files.length} photo${files.length === 1 ? '' : 's'} saved`, 'success');
  }

  async function toggleVoice() {
    if (recording) {
      const rec = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      if (!rec) return;
      try {
        const { blob, durationMs, ext } = await rec.stop();
        if (await queue('voice_note', { duration_ms: durationMs }, { data: blob, bucket: 'field-captures', ext })) {
          toast('Voice note saved', 'success');
        }
      } catch {
        toast('Recording failed.', 'error');
      }
      return;
    }
    try {
      recorderRef.current = await startVoiceRecording();
      setSeconds(0);
      setRecording(true);
    } catch {
      toast('Microphone permission is needed for voice notes.', 'error');
    }
  }

  useEffect(() => {
    if (recording && seconds >= MAX_VOICE_SECONDS) void toggleVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, recording]);

  async function saveSignature() {
    if (!signature || !signerName.trim()) return;
    const ok =
      signature.type === 'drawn'
        ? await queue('signature', { method: 'drawn', signer_name: signerName.trim() }, { data: dataUrlToBlob(signature.data), bucket: 'field-captures', ext: 'png' })
        : await queue('signature', { method: 'typed', signer_name: signerName.trim(), typed_name: signature.data, font: signature.typedFont });
    if (ok) {
      setSigning(false);
      setSignature(null);
      toast('Signature saved', 'success');
    }
  }

  async function startScan() {
    if (!videoRef.current) return;
    const abort = new AbortController();
    scanAbort.current = abort;
    setScanning(true);
    try {
      const { value, format } = await scanCode(videoRef.current, abort.signal);
      await queue('barcode', { value, format, source: 'camera' });
      toast(`Scanned ${value}`, 'success');
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) toast('Could not open the camera scanner.', 'error');
    } finally {
      setScanning(false);
    }
  }

  async function addManualCode() {
    const value = manualCode.trim();
    if (!value) return;
    if (await queue('barcode', { value, format: 'manual', source: 'manual' })) setManualCode('');
  }

  async function readNfc() {
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 20_000);
    toast('Hold the phone near the tag…', 'info');
    try {
      const tag = await readTag(abort.signal);
      await queue('nfc', tag);
      toast('Tag saved', 'success');
    } catch {
      toast('No tag read.', 'error');
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function toggleGps() {
    const next = !gps;
    if (next && !(await ensureTrailPermission())) {
      toast('Location permission is needed to share the GPS trail.', 'error');
      return;
    }
    await setTrackingEnabled(next);
    setGps(next);
  }

  async function saveForm() {
    if (!form.work_performed.trim()) {
      toast('Describe the work performed first.', 'error');
      return;
    }
    if (await queue('form', { template: 'completion_v1', answers: form })) {
      setForm({ work_performed: '', parts_used: '', system_tested: false, area_cleaned: false, customer_walkthrough: false, follow_up_needed: false, follow_up_note: '' });
      toast('Completion form saved', 'success');
    }
  }

  async function runCheck() {
    const paths = synced
      .filter((a) => a.kind === 'photo' && a.storage_bucket === 'job-evidence-photos' && a.storage_path)
      .map((a) => a.storage_path as string)
      .slice(-MAX_EVIDENCE_PHOTOS);
    if (paths.length === 0) return;
    setChecking(true);
    try {
      setVerdict(await verifyJobEvidence(jobId, paths));
    } catch {
      toast('AI check is unavailable right now.', 'error');
    } finally {
      setChecking(false);
    }
  }

  const syncedPhotos = synced.filter((a) => a.kind === 'photo').length;
  const field = 'w-full rounded-md border border-border bg-bg-primary p-2 text-sm text-text-primary';
  const check = 'flex items-center gap-2 text-sm text-text-primary';

  return (
    <section className="space-y-3 rounded-lg border border-border bg-bg-secondary p-3" aria-label="Field capture">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Field capture</h2>
        <span className="text-xs text-text-secondary">
          {synced.length} saved{queued.length > 0 ? ` · ${queued.length} waiting to upload` : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm font-medium text-text-primary">
          <Camera className="h-4 w-4" /> Take photo
          <input type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => { void onPhotos(e.target.files); e.target.value = ''; }} />
        </label>
        <label className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm font-medium text-text-primary">
          <ImagePlus className="h-4 w-4" /> From gallery
          <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => { void onPhotos(e.target.files); e.target.value = ''; }} />
        </label>
        {isVoiceSupported() && (
          <ActionButton onClick={() => void toggleVoice()} active={recording} icon={recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}>
            {recording ? `Stop · ${seconds}s` : 'Voice note'}
          </ActionButton>
        )}
        <ActionButton onClick={() => setSigning((v) => !v)} icon={<PenLine className="h-4 w-4" />}>Customer sign-off</ActionButton>
        {caps.scan && (
          <ActionButton onClick={() => (scanning ? scanAbort.current?.abort() : void startScan())} active={scanning} icon={<ScanLine className="h-4 w-4" />}>
            {scanning ? 'Stop scan' : 'Scan code'}
          </ActionButton>
        )}
        {caps.nfc && (
          <ActionButton onClick={() => void readNfc()} icon={<Nfc className="h-4 w-4" />}>Read NFC tag</ActionButton>
        )}
        <ActionButton onClick={() => void toggleGps()} active={gps} icon={<MapPin className="h-4 w-4" />}>
          {gps ? 'GPS trail on' : 'GPS trail off'}
        </ActionButton>
      </div>

      <video ref={videoRef} muted playsInline className={scanning ? 'w-full rounded-lg bg-black' : 'hidden'} />

      <div className="flex gap-2">
        <input value={manualCode} onChange={(e) => setManualCode(e.target.value)} placeholder="Type a serial / part number" className={field} />
        <button type="button" onClick={() => void addManualCode()} className="rounded-md bg-accent px-3 text-sm font-medium text-white">Add</button>
      </div>

      {signing && (
        <div className="space-y-2 rounded-lg border border-border bg-bg-primary p-3">
          <input value={signerName} onChange={(e) => setSignerName(e.target.value)} placeholder="Customer name" className={field} />
          <SignaturePad defaultName={customerName} onChange={setSignature} />
          <button type="button" disabled={!signature || !signerName.trim()} onClick={() => void saveSignature()} className="w-full rounded-md bg-accent py-2 text-sm font-semibold text-white disabled:opacity-50">
            Save signature
          </button>
        </div>
      )}

      <details className="rounded-lg border border-border bg-bg-primary p-3">
        <summary className="cursor-pointer text-sm font-medium text-text-primary">Job completion form</summary>
        <div className="mt-3 space-y-2">
          <textarea rows={3} value={form.work_performed} onChange={(e) => setForm({ ...form, work_performed: e.target.value })} placeholder="Work performed" className={field} />
          <input value={form.parts_used} onChange={(e) => setForm({ ...form, parts_used: e.target.value })} placeholder="Parts used" className={field} />
          <label className={check}><input type="checkbox" checked={form.system_tested} onChange={(e) => setForm({ ...form, system_tested: e.target.checked })} /> System tested and running</label>
          <label className={check}><input type="checkbox" checked={form.area_cleaned} onChange={(e) => setForm({ ...form, area_cleaned: e.target.checked })} /> Work area cleaned</label>
          <label className={check}><input type="checkbox" checked={form.customer_walkthrough} onChange={(e) => setForm({ ...form, customer_walkthrough: e.target.checked })} /> Walked the customer through the work</label>
          <label className={check}><input type="checkbox" checked={form.follow_up_needed} onChange={(e) => setForm({ ...form, follow_up_needed: e.target.checked })} /> Follow-up visit needed</label>
          {form.follow_up_needed && (
            <input value={form.follow_up_note} onChange={(e) => setForm({ ...form, follow_up_note: e.target.value })} placeholder="What is needed?" className={field} />
          )}
          <button type="button" onClick={() => void saveForm()} className="w-full rounded-md bg-accent py-2 text-sm font-semibold text-white">Save form</button>
        </div>
      </details>

      <FieldFormsCard jobId={jobId} />

      {queued.length > 0 && (
        <ul className="space-y-1">
          {queued.map((op) => (
            <li key={op.id} className="flex items-center justify-between rounded-md bg-bg-primary px-2 py-1.5 text-xs text-text-secondary">
              <span>
                {KIND_LABEL[op.payload.kind as Kind] ?? 'Capture'} ·{' '}
                {op.state === 'pending' ? 'waiting to upload' : op.state === 'conflict' ? 'needs review' : 'failed'}
              </span>
              {op.state !== 'pending' && (
                <button onClick={() => void dismissOp(op.id)} aria-label="Discard" className="p-1 text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
              )}
            </li>
          ))}
        </ul>
      )}

      {sync.online && syncedPhotos > 0 && (
        <div className="space-y-2">
          <button type="button" disabled={checking} onClick={() => void runCheck()} className="flex w-full items-center justify-center gap-2 rounded-md border border-accent bg-accent/10 py-2 text-sm font-semibold text-accent disabled:opacity-50">
            <CheckCircle2 className="h-4 w-4" /> {checking ? 'Checking…' : 'AI safety & quality check'}
          </button>
          {verdict && (
            <p className="rounded-md bg-bg-primary p-2 text-xs text-text-secondary">
              <span className="font-semibold text-text-primary">{verdict.verdict.replace('_', ' ')}</span> — {verdict.summary}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
