import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Mic, Upload, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { uploadVoiceSample, triggerVoiceCloning } from '@/lib/voiceCloning';

type VoiceStatus = 'none' | 'processing' | 'ready' | 'failed';

const STATUS_LABELS: Record<VoiceStatus, string> = {
  none: 'No custom voice yet',
  processing: 'Cloning your voice…',
  ready: 'Custom voice ready',
  failed: 'Cloning failed',
};

/**
 * Dashboard card for real voice cloning (ElevenLabs), as an alternative to
 * the built-in voice presets above it. Manages its own state against
 * `business_profile.custom_voice_id` / `custom_voice_status` / `custom_voice_error`.
 *
 * NOTE: uploading kicks off the `clone-voice` edge function, which needs an
 * ELEVENLABS_API_KEY secret set on the Supabase project. Once
 * `custom_voice_status` is 'ready', wire `custom_voice_id` into the Vapi
 * assistant's voice config — that hookup is outside this web app.
 */
export function VoiceCloningCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<VoiceStatus>('none');
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('business_profile')
      .select('custom_voice_id, custom_voice_status, custom_voice_error')
      .eq('user_id', user.id)
      .maybeSingle();

    if (data) {
      setStatus((data.custom_voice_status as VoiceStatus) ?? 'none');
      setVoiceId(data.custom_voice_id ?? null);
      setErrorMsg(data.custom_voice_error ?? null);
    }
  }, [user]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll while a clone is in progress, since the edge function runs in the background.
  useEffect(() => {
    if (status !== 'processing') return;
    const interval = setInterval(fetchStatus, 4000);
    return () => clearInterval(interval);
  }, [status, fetchStatus]);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !user) return;

    if (file.size > 10 * 1024 * 1024) {
      toast('Please upload a sample under 10MB.', 'error');
      return;
    }

    setUploading(true);
    try {
      const storagePath = await uploadVoiceSample(user.id, file);
      setStatus('processing');
      const { error } = await triggerVoiceCloning(storagePath);
      if (error) {
        setStatus('failed');
        setErrorMsg(error);
        toast('Could not start voice cloning', 'error');
      } else {
        toast('Voice sample uploaded — cloning in progress', 'success');
      }
    } catch {
      toast('Could not upload the voice sample', 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Mic size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Clone Your Own Voice</h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            Upload a clean ~1-minute sample of a real voice and Sarah can speak in it instead of a preset.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-4 py-3">
        <div className="flex items-center gap-2">
          {status === 'ready' && <CheckCircle2 size={16} className="text-success-500" />}
          {status === 'processing' && <Loader2 size={16} className="animate-spin text-accent" />}
          {status === 'failed' && <AlertCircle size={16} className="text-danger" />}
          <div>
            <p className="text-sm font-medium text-text-primary">{STATUS_LABELS[status]}</p>
            {status === 'ready' && voiceId && <p className="text-xs text-text-secondary/70">Voice ID: {voiceId}</p>}
            {status === 'failed' && errorMsg && <p className="text-xs text-danger">{errorMsg}</p>}
          </div>
        </div>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || status === 'processing'}
          className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
        >
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {status === 'ready' ? 'Replace sample' : 'Upload sample'}
        </button>
        <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileChange} className="hidden" />
      </div>
    </div>
  );
}
