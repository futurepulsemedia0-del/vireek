import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { Mic, Upload, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { uploadVoiceSample, triggerVoiceCloning } from '@/lib/voiceCloning';
import { latestConsent, revokeConsent, startConsent, syncVoice, type ConsentRow } from '@/lib/voiceStudioApi';
import { CONSENT_TEXT_V1 } from '../../../supabase/functions/_shared/voice-studio/consent';

type Rel = 'self' | 'employee_written_consent';
type Phase = 'loading' | 'form' | 'record' | 'processing' | 'ready' | 'failed';

export function CloneConsentCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>('loading');
  const [consent, setConsent] = useState<ConsentRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [rel, setRel] = useState<Rel>('self');
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const [c, bp] = await Promise.all([
        latestConsent(),
        supabase.from('business_profile').select('custom_voice_status,custom_voice_error').eq('user_id', user.id).maybeSingle(),
      ]);
      setConsent(c);
      const st = bp.data?.custom_voice_status as string | undefined;
      setError(bp.data?.custom_voice_error ?? null);
      if (st === 'processing') setPhase('processing');
      else if (c?.status === 'approved' && st === 'ready') setPhase('ready');
      else if (c?.status === 'pending' && Date.now() - Date.parse(c.created_at) < 30 * 60 * 1000) setPhase('record');
      else setPhase(st === 'failed' ? 'failed' : 'form');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load voice cloning.');
      setPhase('failed');
    }
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (phase !== 'processing') return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [phase, refresh]);

  const onStart = async () => {
    setBusy(true);
    try {
      await startConsent({ voiceOwnerName: name.trim(), relationship: rel, attested: true });
      await refresh();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not start.', 'error'); } finally { setBusy(false); }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !user || !consent) return;
    if (file.size > 10 * 1024 * 1024) { toast('Please upload a sample under 10 MB.', 'error'); return; }
    setBusy(true);
    try {
      const path = await uploadVoiceSample(user.id, file);
      setPhase('processing');
      const { error: err } = await triggerVoiceCloning(path, consent.id);
      if (err) { setError(err); setPhase('failed'); toast('Cloning did not start', 'error'); }
    } catch { toast('Could not upload the sample', 'error'); setPhase('record'); } finally { setBusy(false); }
  };

  const onRevoke = async () => {
    if (!consent) return;
    setBusy(true);
    try {
      await revokeConsent(consent.id);
      // The deleted voice must leave live calls immediately.
      await syncVoice(true, false).catch(() => toast('Voice deleted. Re-apply your voice in Voice Studio to update live calls.', 'error'));
      toast('Consent revoked and voice deleted', 'success');
      setConfirmRevoke(false);
      await refresh();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not revoke.', 'error'); } finally { setBusy(false); }
  };

  const onApply = async () => {
    setBusy(true);
    try {
      const r = await syncVoice(true, true);
      toast(r.verified ? 'Your cloned voice is live' : 'Applied, but could not be verified', r.verified ? 'success' : 'error');
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not apply.', 'error'); } finally { setBusy(false); }
  };

  const btn = 'focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50';

  return (
    <Card interactive={false} aria-labelledby="clone-h">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><Mic size={18} /></span>
        <div>
          <h3 id="clone-h" className="text-sm font-semibold text-text-primary">Clone a voice (with consent)</h3>
          <p className="text-xs text-text-secondary">Only the account owner on the Business plan. Calls always say the assistant is AI.</p>
        </div>
      </div>

      {phase === 'loading' && <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
      {error && phase !== 'ready' && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      {phase === 'form' || phase === 'failed' ? (
        <div className="space-y-3">
          <label className="block text-xs font-medium text-text-secondary">Voice owner's full name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
              className="focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm" />
          </label>
          <label className="block text-xs font-medium text-text-secondary">This voice belongs to
            <select value={rel} onChange={(e) => setRel(e.target.value as Rel)}
              className="focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
              <option value="self">Me</option>
              <option value="employee_written_consent">A team member who gave written permission</option>
            </select>
          </label>
          <p className="rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">{CONSENT_TEXT_V1}</p>
          <label className="flex items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-1" />
            I have read and accept this statement.
          </label>
          <button type="button" className={btn} disabled={busy || name.trim().length < 2 || !attested} onClick={onStart}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Continue
          </button>
        </div>
      ) : null}

      {phase === 'record' && consent && (
        <div className="space-y-3">
          <p className="text-sm text-text-primary">Record about a minute of clear speech that includes this phrase, then upload it within 30 minutes:</p>
          <p className="rounded-xl bg-accent/10 p-3 text-center text-lg font-semibold text-accent" aria-live="polite">{consent.liveness_phrase}</p>
          <button type="button" className={btn} disabled={busy} onClick={() => document.getElementById('clone-file')?.click()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload recording
          </button>
          <input id="clone-file" type="file" accept="audio/*" className="hidden" onChange={onFile} />
        </div>
      )}

      {phase === 'processing' && <p className="flex items-center gap-2 text-sm text-text-primary" role="status"><Loader2 size={14} className="animate-spin text-accent" /> Checking your recording and cloning the voice…</p>}

      {phase === 'ready' && consent && (
        <div className="space-y-3">
          <p className="text-sm text-text-primary" role="status">Cloned voice ready for {consent.voice_owner_name}.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn} disabled={busy} onClick={onApply}>Use on live calls</button>
            {!confirmRevoke ? (
              <button type="button" className={btn} onClick={() => setConfirmRevoke(true)}><Trash2 size={14} /> Revoke and delete</button>
            ) : (
              <button type="button" className={`${btn} border-danger text-danger`} disabled={busy} onClick={onRevoke}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Confirm: delete this voice
              </button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
