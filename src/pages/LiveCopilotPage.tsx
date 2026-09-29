import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Radio, Video, VideoOff, Mic, Square, Camera, Flashlight, Volume2, VolumeX, LifeBuoy, Send,
  ShieldAlert, ListChecks, PackageSearch, BookOpen, History, X, Loader2, ScanLine, Ear, Eye,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import { DIAGNOSIS_SEVERITY_META } from '@/lib/diagnosisCopilot';
import { useLiveCapture } from '@/hooks/useLiveCapture';
import {
  LIVE_LIMITS, SOUND_LABELS, analyzeLiveTurn, escalateLiveSession, finishLiveSession,
  speak, speechSupported, stopSpeaking, type LiveTurnResponse,
} from '@/lib/liveCopilot';

interface JobOption { id: string; customer_name: string; customer_id: string | null; service_type: string | null }
interface EquipmentOption { id: string; equipment_type: string; make: string | null; model: string | null; serial_number: string | null }
interface TrayFrame { id: string; blob: Blob; url: string }

function SectionTitle({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-text-primary">{icon}{children}</p>;
}

export function LiveCopilotPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const cam = useLiveCapture();

  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [equipmentOptions, setEquipmentOptions] = useState<EquipmentOption[]>([]);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState('');

  const [question, setQuestion] = useState('');
  const [tray, setTray] = useState<TrayFrame[]>([]);
  const trayRef = useRef<TrayFrame[]>([]);
  const lastCaptureRef = useRef<{ frame: Blob | null; rawAudio: Blob | null }>({ frame: null, rawAudio: null });

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurnResponse[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(false);

  const latest = turns[0] ?? null;
  const sessionActive = sessionId !== null || turns.length > 0;

  // ---- Job + equipment pickers (same sources as Diagnosis Copilot) ----------
  useEffect(() => {
    supabase
      .from('jobs')
      .select('id, customer_name, customer_id, service_type')
      .neq('job_status', 'completed')
      .order('scheduled_datetime', { ascending: false })
      .limit(100)
      .then(({ data }) => {
        const list = (data as JobOption[]) ?? [];
        setJobs(list);
        // Deep link: /dashboard/live-copilot?job=<jobId> (e.g. from the technician Job Brief).
        const preset = new URLSearchParams(window.location.search).get('job');
        if (preset && list.some((j) => j.id === preset)) setSelectedJobId(preset);
      });
  }, []);

  useEffect(() => {
    setSelectedEquipmentId('');
    const job = jobs.find((j) => j.id === selectedJobId);
    if (!job?.customer_id) { setEquipmentOptions([]); return; }
    supabase
      .from('equipment')
      .select('id, equipment_type, make, model, serial_number')
      .eq('customer_id', job.customer_id)
      .eq('status', 'active')
      .then(({ data }) => setEquipmentOptions((data as EquipmentOption[]) ?? []));
  }, [selectedJobId, jobs]);

  // ---- Frame tray ---------------------------------------------------------------
  useEffect(() => { trayRef.current = tray; }, [tray]);
  useEffect(() => () => {
    trayRef.current.forEach((f) => URL.revokeObjectURL(f.url));
    stopSpeaking();
  }, []);

  const clearTray = useCallback(() => {
    setTray((prev) => {
      prev.forEach((f) => URL.revokeObjectURL(f.url));
      return [];
    });
  }, []);

  const removeFrame = (id: string) =>
    setTray((prev) => {
      prev.filter((f) => f.id === id).forEach((f) => URL.revokeObjectURL(f.url));
      return prev.filter((f) => f.id !== id);
    });

  const addFrame = async () => {
    if (tray.length >= LIVE_LIMITS.frames) {
      toast(`Up to ${LIVE_LIMITS.frames} views per question.`, 'error');
      return;
    }
    const blob = await cam.captureFrame();
    if (!blob) {
      toast('Could not capture a frame yet. Wait for the camera to focus.', 'error');
      return;
    }
    setTray((prev) => [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, blob, url: URL.createObjectURL(blob) }]);
  };

  useEffect(() => { if (!voiceReplies) stopSpeaking(); }, [voiceReplies]);

  // ---- Analyze -------------------------------------------------------------------
  const busy = analyzing || cam.recording || cam.processing;
  const canAnalyze = !busy && (tray.length > 0 || cam.clip !== null || question.trim().length >= 3 || cam.status === 'live');

  const analyze = async () => {
    if (!user || !canAnalyze) return;
    setAnalyzing(true);
    stopSpeaking();
    try {
      let frames = tray.map((f) => f.blob);
      if (frames.length === 0 && cam.status === 'live') {
        const auto = await cam.captureFrame();
        if (auto) frames = [auto];
      }
      if (frames.length === 0 && !cam.clip && question.trim().length < 3) {
        toast('Point the camera at the equipment, record a clip, or type a question.', 'error');
        return;
      }
      const res = await analyzeLiveTurn({
        userId: user.id,
        sessionId,
        jobId: selectedJobId || null,
        equipmentId: selectedEquipmentId || null,
        question,
        frames,
        audio: cam.clip?.wav ?? null,
      });
      lastCaptureRef.current = { frame: frames[0] ?? null, rawAudio: cam.clip?.raw ?? null };
      setSessionId(res.session_id);
      setTurns((prev) => [res, ...prev]);
      clearTray();
      cam.clearClip();
      setQuestion('');

      if (res.equipment.auto_matched && res.equipment.id) {
        const matchedId = res.equipment.id;
        if (equipmentOptions.some((e) => e.id === matchedId)) setSelectedEquipmentId(matchedId);
        toast(`Matched saved equipment: ${res.equipment.label ?? 'unit on file'}`, 'success');
      }
      if (voiceReplies) speak(res.result.spoken_answer);
      if (res.result.severity === 'emergency') navigator.vibrate?.([250, 120, 250]);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not analyze this capture.', 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  // ---- Human expert hand-off (reuses Expert Assist) ------------------------------
  const escalate = async () => {
    if (!user || !latest) return;
    setEscalating(true);
    try {
      const requestId = await escalateLiveSession({
        userId: user.id,
        sessionId,
        jobId: selectedJobId || null,
        turn: latest,
        frame: lastCaptureRef.current.frame,
        rawAudio: lastCaptureRef.current.rawAudio,
      });
      toast('Expert request sent with your latest capture.', 'success');
      stopSpeaking();
      cam.stop();
      navigate(`/dashboard/expert-assist/${requestId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not reach an expert.', 'error');
    } finally {
      setEscalating(false);
    }
  };

  const endSession = async () => {
    stopSpeaking();
    cam.stop();
    if (sessionId) await finishLiveSession(sessionId, 'completed').catch(() => undefined);
    setSessionId(null);
    setTurns([]);
    setQuestion('');
    clearTray();
    cam.clearClip();
    toast('Session ended.', 'success');
  };

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const np = latest?.perception.nameplate;
  const sev = latest ? DIAGNOSIS_SEVERITY_META[latest.result.severity] : null;

  return (
    <DashboardLayout activeLabel="Live Copilot">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Radio size={24} /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-text-primary">Live Multimodal Copilot</h1>
          <p className="text-sm text-text-secondary">Show it the unit, let it hear the machine, ask out loud. It reads the nameplate, checks history and manuals, and can bring in a human expert.</p>
        </div>
        {sessionActive && (
          <button type="button" onClick={endSession} className="focus-ring shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
            End session
          </button>
        )}
      </div>

      {/* ---- Setup ---- */}
      <div className="mb-4 grid gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:grid-cols-2">
        <div>
          <label htmlFor="live-job" className="mb-1 block text-xs font-medium text-text-secondary">Job (optional)</label>
          <select id="live-job" value={selectedJobId} onChange={(e) => setSelectedJobId(e.target.value)} disabled={sessionActive} className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm disabled:opacity-50">
            <option value="">No job selected…</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.customer_name}{j.service_type ? ` — ${j.service_type}` : ''}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="live-equipment" className="mb-1 block text-xs font-medium text-text-secondary">Equipment on file (optional — auto-detected from the nameplate)</label>
          <select id="live-equipment" value={selectedEquipmentId} onChange={(e) => setSelectedEquipmentId(e.target.value)} disabled={sessionActive || equipmentOptions.length === 0} className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm disabled:opacity-50">
            <option value="">{equipmentOptions.length ? 'Detect automatically…' : 'No equipment on file for this job'}</option>
            {equipmentOptions.map((eq) => <option key={eq.id} value={eq.id}>{[eq.equipment_type, eq.make, eq.model].filter(Boolean).join(' ')}</option>)}
          </select>
        </div>
      </div>

      {/* ---- Camera ---- */}
      <div className="mb-4 rounded-2xl border border-border bg-bg-secondary p-4">
        <div className="relative overflow-hidden rounded-xl bg-black">
          <video ref={cam.videoRef} muted playsInline autoPlay className="aspect-[4/3] w-full object-cover" aria-label="Live camera preview" />
          {cam.status !== 'live' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-4 text-center">
              {cam.status === 'starting' ? (
                <Loader2 className="animate-spin text-white" size={28} />
              ) : (
                <button type="button" onClick={cam.start} className="focus-ring flex min-h-[44px] items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">
                  <Video size={16} /> Start camera &amp; microphone
                </button>
              )}
              <p className="max-w-xs text-xs text-white/80">Point at the data plate, the fault, or the moving part. Audio is captured unfiltered so the machine noise is preserved.</p>
            </div>
          )}
          {cam.recording && (
            <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium text-white" role="status">
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger-500" /> Recording {cam.elapsed}s / {LIVE_LIMITS.audioSeconds}s
            </div>
          )}
        </div>
        {cam.error && <p role="alert" className="mt-2 text-xs text-danger-500">{cam.error}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {cam.status === 'live' ? (
            <>
              <button type="button" onClick={addFrame} disabled={busy} className="focus-ring flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-text-primary disabled:opacity-50">
                <Camera size={15} /> Add view ({tray.length}/{LIVE_LIMITS.frames})
              </button>
              {cam.recording ? (
                <button type="button" onClick={cam.stopRecording} className="focus-ring flex min-h-[44px] items-center gap-1.5 rounded-lg bg-danger-500 px-3 py-2 text-sm font-medium text-white">
                  <Square size={14} /> Stop recording
                </button>
              ) : (
                <button type="button" onClick={cam.startRecording} disabled={analyzing || cam.processing} className="focus-ring flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-text-primary disabled:opacity-50">
                  {cam.processing ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />} Record sound / speak
                </button>
              )}
              {cam.torchSupported && (
                <button type="button" onClick={cam.toggleTorch} aria-pressed={cam.torchOn} aria-label="Toggle flashlight" className={`focus-ring flex min-h-[44px] items-center justify-center rounded-lg border px-3 py-2 ${cam.torchOn ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
                  <Flashlight size={15} />
                </button>
              )}
              <button type="button" onClick={cam.stop} aria-label="Stop camera" className="focus-ring flex min-h-[44px] items-center justify-center rounded-lg border border-border px-3 py-2 text-text-secondary hover:text-text-primary">
                <VideoOff size={15} />
              </button>
            </>
          ) : null}
          {speechSupported() && (
            <button type="button" onClick={() => setVoiceReplies((v) => !v)} aria-pressed={voiceReplies} className={`focus-ring ml-auto flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${voiceReplies ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
              {voiceReplies ? <Volume2 size={15} /> : <VolumeX size={15} />} Voice replies
            </button>
          )}
        </div>

        {(tray.length > 0 || cam.clip) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {tray.map((f) => (
              <div key={f.id} className="relative h-16 w-16 overflow-hidden rounded-lg border border-border">
                <img src={f.url} alt="Captured view" className="h-full w-full object-cover" />
                <button type="button" onClick={() => removeFrame(f.id)} aria-label="Remove view" className="focus-ring absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 text-white"><X size={10} /></button>
              </div>
            ))}
            {cam.clip && (
              <span className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-secondary">
                <Ear size={12} /> Clip ready ({cam.clip.seconds}s)
                <button type="button" onClick={cam.clearClip} aria-label="Remove clip" className="focus-ring hover:text-danger-500"><X size={12} /></button>
              </span>
            )}
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void analyze(); } }}
            maxLength={LIVE_LIMITS.questionChars}
            aria-label="Your question"
            placeholder="e.g. This is the compressor noise — what's wrong?"
            className="min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm"
          />
          <button type="button" onClick={analyze} disabled={!canAnalyze} className="focus-ring flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {analyzing ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {analyzing ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      </div>

      {/* ---- Latest answer ---- */}
      {latest && sev && (
        <div className="mb-6 space-y-4 rounded-2xl border border-border bg-bg-secondary p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${sev.className}`}>
              {(latest.result.severity === 'emergency' || latest.result.severity === 'high') && <ShieldAlert size={12} />} {sev.label}
            </span>
            <span className="text-xs text-text-secondary">Confidence: {pct(latest.result.confidence)}</span>
            <span className="text-xs text-text-secondary">Turn {latest.seq} · {(latest.latency_ms / 1000).toFixed(1)}s</span>
            {latest.equipment.label && (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
                {latest.equipment.label}{latest.equipment.matched_by ? ` · matched by ${latest.equipment.matched_by}` : ''}
              </span>
            )}
          </div>

          <p className="text-base font-semibold text-text-primary">{latest.result.headline}</p>

          {latest.result.safety_warnings.length > 0 && (
            <div className="rounded-lg border border-danger-500/30 bg-danger-500/5 p-3">
              <SectionTitle icon={<ShieldAlert size={12} className="text-danger-500" />}><span className="text-danger-500">Safety</span></SectionTitle>
              <ul className="space-y-1">
                {latest.result.safety_warnings.map((w, i) => <li key={i} className="text-xs text-danger-500">• {w}</li>)}
              </ul>
            </div>
          )}

          {latest.result.escalate.recommended && (
            <div className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-text-primary"><span className="font-semibold">Bring in an expert.</span> {latest.result.escalate.reason}</p>
              <button type="button" onClick={escalate} disabled={escalating} className="focus-ring flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
                {escalating ? <Loader2 size={15} className="animate-spin" /> : <LifeBuoy size={15} />} Call an expert
              </button>
            </div>
          )}

          {/* What the copilot saw / heard */}
          <div className="rounded-lg border border-border bg-bg-primary p-3">
            <SectionTitle icon={<Eye size={12} />}>What I saw &amp; heard</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {np?.legible && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
                  <ScanLine size={11} /> {[np.brand, np.model, np.serial ? `SN ${np.serial}` : ''].filter(Boolean).join(' ') || 'Nameplate read'}
                </span>
              )}
              {latest.perception.sound.class !== 'none_detected' && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
                  <Ear size={11} /> {SOUND_LABELS[latest.perception.sound.class]}
                </span>
              )}
              {latest.perception.error_codes.map((c) => (
                <span key={c} className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-500">Code {c}</span>
              ))}
            </div>
            {np?.legible && (np.ratings || np.refrigerant || np.manufacture_date) && (
              <p className="mt-1.5 text-xs text-text-secondary">{[np.ratings, np.refrigerant && `Refrigerant ${np.refrigerant}`, np.manufacture_date && `Mfg ${np.manufacture_date}`].filter(Boolean).join(' · ')}</p>
            )}
            {latest.perception.sound.description && <p className="mt-1.5 text-xs text-text-secondary">Sound: {latest.perception.sound.description}</p>}
            {latest.perception.visual_findings.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {latest.perception.visual_findings.map((v, i) => <li key={i} className="text-xs text-text-secondary">• {v}</li>)}
              </ul>
            )}
            {latest.perception.transcript && <p className="mt-1.5 text-xs italic text-text-secondary">You said: “{latest.perception.transcript}”</p>}
          </div>

          {latest.result.probable_causes.length > 0 && (
            <div>
              <SectionTitle>Probable causes</SectionTitle>
              <div className="space-y-2">
                {latest.result.probable_causes.map((c, i) => (
                  <div key={i} className="rounded-lg border border-border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-text-primary">{c.cause}</span>
                      <span className="text-xs text-text-secondary">{pct(c.likelihood)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-bg-tertiary" aria-hidden="true">
                      <div className="h-1.5 rounded-full bg-accent" style={{ width: pct(c.likelihood) }} />
                    </div>
                    {c.reasoning && <p className="mt-1 text-xs text-text-secondary">{c.reasoning}</p>}
                    {c.evidence.length > 0 && <p className="mt-0.5 text-xs text-text-secondary/80">Evidence: {c.evidence.join(' · ')}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {latest.result.test_steps.length > 0 && (
            <div>
              <SectionTitle icon={<ListChecks size={12} />}>Test next</SectionTitle>
              <ol className="space-y-1.5">
                {latest.result.test_steps.map((t, i) => (
                  <li key={i} className="text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">{i + 1}. {t.step}</span>
                    {t.tool_needed && <span> — tool: {t.tool_needed}</span>}
                    {t.expected_result && <span className="block">Expected: {t.expected_result}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {latest.result.next_capture && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
              <p className="flex items-center gap-1 text-xs font-semibold text-accent"><Camera size={12} /> Show me next</p>
              <p className="mt-0.5 text-xs text-text-primary">{latest.result.next_capture}</p>
            </div>
          )}

          {latest.result.parts_needed.length > 0 && (
            <div>
              <SectionTitle icon={<PackageSearch size={12} />}>Parts to have ready</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {latest.result.parts_needed.map((p, i) => (
                  <span key={i} className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
                    {p.quantity}× {p.name} <span className="text-text-secondary/70">({p.necessity.replace('_', ' ')})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {latest.result.history_insights.length > 0 && (
            <div>
              <SectionTitle icon={<History size={12} />}>Equipment history</SectionTitle>
              <ul className="space-y-1">
                {latest.result.history_insights.map((h, i) => <li key={i} className="text-xs text-text-secondary">• {h}</li>)}
              </ul>
            </div>
          )}

          {latest.result.manual_refs.length > 0 && (
            <div>
              <SectionTitle icon={<BookOpen size={12} />}>From your manuals</SectionTitle>
              <ul className="space-y-1">
                {latest.result.manual_refs.map((m) => (
                  <li key={m.id} className="text-xs text-text-secondary"><span className="font-medium text-text-primary">{m.title}</span>{m.why ? ` — ${m.why}` : ''}</li>
                ))}
              </ul>
            </div>
          )}

          {latest.result.missing_info.length > 0 && (
            <div>
              <SectionTitle>Would help narrow this down</SectionTitle>
              <ul className="space-y-1">
                {latest.result.missing_info.map((m, i) => <li key={i} className="text-xs text-text-secondary">• {m}</li>)}
              </ul>
            </div>
          )}

          {!latest.result.escalate.recommended && (
            <button type="button" onClick={escalate} disabled={escalating} className="focus-ring flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50">
              {escalating ? <Loader2 size={15} className="animate-spin" /> : <LifeBuoy size={15} />} Ask a human expert anyway
            </button>
          )}

          {latest.result.warnings.map((w, i) => <p key={i} className="text-xs text-warning-500">{w}</p>)}
        </div>
      )}

      {/* ---- Earlier turns ---- */}
      {turns.length > 1 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Earlier in this session</h2>
          <div className="space-y-2">
            {turns.slice(1).map((t) => (
              <details key={t.seq} className="rounded-2xl border border-border bg-bg-secondary p-3">
                <summary className="cursor-pointer text-sm text-text-primary">Turn {t.seq}: {t.result.headline}</summary>
                <p className="mt-1 text-xs text-text-secondary">
                  {DIAGNOSIS_SEVERITY_META[t.result.severity].label}
                  {t.result.probable_causes[0] ? ` · top suspect: ${t.result.probable_causes[0].cause} (${pct(t.result.probable_causes[0].likelihood)})` : ''}
                </p>
              </details>
            ))}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
