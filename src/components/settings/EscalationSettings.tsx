import { useEffect, useState } from 'react';
import { PhoneForwarded, Users, Zap } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

/**
 * Dashboard settings card for "Escalation to a live human during a call"
 * (barge-in / warm transfer). Drop this into BusinessProfilePage.tsx (or
 * wherever call-handling settings live) — it manages its own state and
 * persists to the `escalation_enabled` / `escalation_phone` / `escalation_mode`
 * columns on `profiles` (see the migration that adds them).
 *
 * NOTE: this only saves the business's *configuration*. The actual live
 * telephony behavior (detecting a trigger mid-call and bridging the caller
 * to this number) is implemented on the voice/telephony side (Vapi
 * assistant config), not in this web app — wire this saved config into
 * that assistant's transfer-destination / trigger settings.
 */
export function EscalationSettings() {
  const { profile, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [phone, setPhone] = useState('');
  const [mode, setMode] = useState<'warm_transfer' | 'barge_in'>('warm_transfer');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setEnabled(profile.escalation_enabled ?? false);
    setPhone(profile.escalation_phone ?? '');
    setMode(profile.escalation_mode ?? 'warm_transfer');
    setDirty(false);
  }, [profile]);

  const markDirty = () => setDirty(true);

  const handleSave = async () => {
    if (!profile) return;
    if (enabled && phone.trim().length < 7) {
      toast('Add a valid phone number before turning escalation on.', 'error');
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({
        escalation_enabled: enabled,
        escalation_phone: phone.trim() || null,
        escalation_mode: mode,
      })
      .eq('id', profile.id);

    if (error) {
      toast('Could not save escalation settings. Please try again.', 'error');
    } else {
      toast('Escalation settings saved.', 'success');
      setDirty(false);
      await refreshProfile();
    }
    setSaving(false);
  };

  return (
    <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <PhoneForwarded size={16} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-text-primary">Escalation to a live person</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Let Sarah bring a real team member into a call — for a frustrated caller, a request to
            &ldquo;talk to someone,&rdquo; or anything outside what the AI should handle alone.
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4 border-t border-border/60 py-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Enable live escalation</p>
          <p className="mt-0.5 text-xs text-text-secondary">Off by default — turn on once a number is ready to take escalated calls.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => {
            setEnabled((v) => !v);
            markDirty();
          }}
          className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            enabled ? 'bg-accent' : 'bg-bg-tertiary'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {enabled && (
        <div className="space-y-5 border-t border-border/60 pt-5">
          <div>
            <label htmlFor="escalation-phone" className="text-sm font-medium text-text-primary">
              Escalation number
            </label>
            <p className="mt-0.5 text-xs text-text-secondary">
              Where Sarah connects the caller — a cell phone, a front-desk line, or a ring group.
            </p>
            <input
              id="escalation-phone"
              type="tel"
              inputMode="tel"
              placeholder="+1 (555) 123-4567"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                markDirty();
              }}
              className="focus-ring mt-2 w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/50"
            />
          </div>

          <div>
            <p className="text-sm font-medium text-text-primary">How the handoff works</p>
            <div
              role="group"
              aria-label="Escalation mode"
              className="mt-2 inline-flex w-full items-center gap-1 rounded-full border border-border bg-bg-primary p-1"
            >
              <button
                type="button"
                aria-pressed={mode === 'warm_transfer'}
                onClick={() => {
                  setMode('warm_transfer');
                  markDirty();
                }}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                  mode === 'warm_transfer'
                    ? 'bg-accent text-white shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <PhoneForwarded size={14} />
                Warm transfer
              </button>
              <button
                type="button"
                aria-pressed={mode === 'barge_in'}
                onClick={() => {
                  setMode('barge_in');
                  markDirty();
                }}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                  mode === 'barge_in'
                    ? 'bg-accent text-white shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <Users size={14} />
                Barge-in
              </button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              {mode === 'warm_transfer' ? (
                <>
                  <strong className="text-text-primary">Warm transfer:</strong> Sarah briefs whoever
                  picks up — caller name, reason for the call, anything already gathered — then
                  connects the call. The caller never has to repeat themselves.
                </>
              ) : (
                <>
                  <strong className="text-text-primary">Barge-in:</strong> a team member can drop
                  directly into a call that&rsquo;s already in progress, listening live before
                  deciding whether to speak up — useful for coaching or a fast judgment call on an
                  urgent job.
                </>
              )}
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-border bg-bg-tertiary px-4 py-3 text-xs text-text-secondary">
            <Zap size={14} className="mt-0.5 shrink-0 text-accent" />
            <span>
              Trigger conditions (caller asks for a person, repeated frustration, an emergency
              keyword) are tuned with your onboarding contact so escalation fires only when it
              should.
            </span>
          </div>
        </div>
      )}

      <div className="mt-5 flex justify-end border-t border-border/60 pt-5">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          className="focus-ring rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
