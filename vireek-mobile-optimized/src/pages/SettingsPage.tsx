import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, ShieldCheck, ChevronRight, PhoneCall, Gauge, Lightbulb, Wrench } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

interface ToggleRowProps {
  icon: typeof PhoneCall;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

function ToggleRow({ icon: Icon, label, description, checked, onChange, disabled }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
          <Icon size={16} />
        </span>
        <div>
          <p className="text-sm font-medium text-text-primary">{label}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          checked ? 'bg-accent' : 'bg-bg-tertiary'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const { profile, isOwner, refreshProfile } = useAuth();
  const { toast } = useToast();
  const [saving, setSaving] = useState<string | null>(null);

  const prefs = {
    notify_emergency_call: profile?.notify_emergency_call ?? true,
    notify_usage_alert: profile?.notify_usage_alert ?? true,
    notify_ai_insight: profile?.notify_ai_insight ?? true,
    notify_job_update: profile?.notify_job_update ?? true,
  };

  const updatePref = async (key: keyof typeof prefs, value: boolean) => {
    if (!profile) return;
    setSaving(key);
    const { error } = await supabase.from('profiles').update({ [key]: value }).eq('id', profile.id);
    if (error) {
      toast('Could not save that preference. Please try again.', 'error');
    } else {
      await refreshProfile();
    }
    setSaving(null);
  };

  return (
    <DashboardLayout activeLabel="Settings">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <SettingsIcon size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Settings</h1>
          <p className="mt-1 text-sm text-text-secondary">Notification preferences and account security.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <h2 className="text-base font-semibold text-text-primary">Notification preferences</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Choose which events create a notification. Turning one off stops it from being created at all — not
          just from being shown.
        </p>
        <div className="mt-2 divide-y divide-border/60">
          <ToggleRow
            icon={PhoneCall}
            label="Emergency calls"
            description="Notify me when a new emergency call comes in."
            checked={prefs.notify_emergency_call}
            disabled={saving === 'notify_emergency_call'}
            onChange={(v) => updatePref('notify_emergency_call', v)}
          />
          <ToggleRow
            icon={Gauge}
            label="Usage alerts"
            description="Notify me when I'm approaching my monthly minutes limit."
            checked={prefs.notify_usage_alert}
            disabled={saving === 'notify_usage_alert'}
            onChange={(v) => updatePref('notify_usage_alert', v)}
          />
          <ToggleRow
            icon={Lightbulb}
            label="AI insights"
            description="Notify me when Vireek spots a new pattern or suggestion."
            checked={prefs.notify_ai_insight}
            disabled={saving === 'notify_ai_insight'}
            onChange={(v) => updatePref('notify_ai_insight', v)}
          />
          <ToggleRow
            icon={Wrench}
            label="Job updates"
            description="Notify me when a job is cancelled or is stuck past its scheduled time."
            checked={prefs.notify_job_update}
            disabled={saving === 'notify_job_update'}
            onChange={(v) => updatePref('notify_job_update', v)}
          />
        </div>
      </div>

      {isOwner && (
        <button
          type="button"
          onClick={() => navigate('/dashboard/settings/security')}
          className="focus-ring mt-4 flex w-full items-center justify-between rounded-2xl border border-border bg-bg-secondary p-6 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ShieldCheck size={20} />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">Security</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                Two-factor authentication, active sessions, and the audit log.
              </p>
            </div>
          </div>
          <ChevronRight size={18} className="text-text-secondary" />
        </button>
      )}
    </DashboardLayout>
  );
}
