import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, ShieldCheck, ShieldAlert, ChevronRight, PhoneCall, Gauge, Lightbulb, Wrench, Mic, UserPlus, PhoneMissed, Bell, BellOff, KeyRound, Building2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { getPushState, subscribeToPush, unsubscribeFromPush, isPushSupported, type PushSupportState } from '@/lib/push';

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
function PushNotificationsCard() {
  const { toast } = useToast();
  const [state, setState] = useState<PushSupportState>('not-subscribed');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isPushSupported()) {
      setState('unsupported');
      setLoading(false);
      return;
    }
    getPushState().then((s) => {
      if (!cancelled) {
        setState(s);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (enable: boolean) => {
    setBusy(true);
    const result = enable ? await subscribeToPush() : await unsubscribeFromPush();
    if (result.success) {
      setState(enable ? 'subscribed' : 'not-subscribed');
      toast(enable ? 'Push notifications enabled on this device.' : 'Push notifications disabled on this device.', 'success');
    } else {
      toast(result.error || 'Something went wrong. Please try again.', 'error');
      if (enable) setState(await getPushState());
    }
    setBusy(false);
  };

  return (
    <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <h2 className="text-base font-semibold text-text-primary">Push notifications</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Get a real notification on this device the moment a new lead or missed call comes in —
        even with the dashboard closed. No app install required.
      </p>

      <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-bg-primary px-4 py-3.5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            {state === 'subscribed' ? <Bell size={16} /> : <BellOff size={16} />}
          </span>
          <div>
            <p className="text-sm font-medium text-text-primary">
              {state === 'unsupported' && 'Not supported in this browser'}
              {state === 'denied' && 'Blocked in browser settings'}
              {(state === 'not-subscribed' || loading) && 'Enable on this device'}
              {state === 'subscribed' && 'Enabled on this device'}
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {state === 'denied'
                ? 'You previously blocked notifications for this site — allow them in your browser settings to turn this back on.'
                : 'Applies only to the device and browser you enable it on.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state === 'subscribed'}
          disabled={loading || busy || state === 'unsupported' || state === 'denied'}
          onClick={() => handleToggle(state !== 'subscribed')}
          className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            state === 'subscribed' ? 'bg-accent' : 'bg-bg-tertiary'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
              state === 'subscribed' ? 'translate-x-[22px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
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
    notify_warranty_alert: profile?.notify_warranty_alert ?? true,
    notify_new_lead: profile?.notify_new_lead ?? true,
    notify_missed_call: profile?.notify_missed_call ?? true,
  };

  const updatePref = async (key: keyof typeof prefs, value: boolean) => {
    if (!profile) return;
    setSaving(key);
    const { error } = await supabase
      .from('profiles')
      .update({ [key]: value })
      .eq('id', profile.id);

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
            icon={UserPlus}
            label="New leads"
            description="Notify me the moment a new lead comes in."
            checked={prefs.notify_new_lead}
            disabled={saving === 'notify_new_lead'}
            onChange={(v) => updatePref('notify_new_lead', v)}
          />
          <ToggleRow
            icon={PhoneMissed}
            label="Missed calls"
            description="Notify me when a call to my business goes unanswered."
            checked={prefs.notify_missed_call}
            disabled={saving === 'notify_missed_call'}
            onChange={(v) => updatePref('notify_missed_call', v)}
          />
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
          <ToggleRow
            icon={ShieldAlert}
            label="Warranty alerts"
            description="Notify me when a customer's equipment warranty is expiring soon or has lapsed."
            checked={prefs.notify_warranty_alert}
            disabled={saving === 'notify_warranty_alert'}
            onChange={(v) => updatePref('notify_warranty_alert', v)}
          />
        </div>
      </div>
            <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <h2 className="text-base font-semibold text-text-primary">Tax &amp; invoicing</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Used to calculate VAT and the currency shown on customer invoices in Billing.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">Business country</span>
            <input
              type="text"
              maxLength={2}
              placeholder="e.g. DE"
              defaultValue={profile?.business_country ?? ''}
              onBlur={(e) => {
                if (!profile) return;
                supabase.from('profiles').update({ business_country: e.target.value.toUpperCase() || null }).eq('id', profile.id).then(() => refreshProfile());
              }}
              className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">VAT / Tax ID</span>
            <input
              type="text"
              placeholder="e.g. DE123456789"
              defaultValue={profile?.business_vat_number ?? ''}
              onBlur={(e) => {
                if (!profile) return;
                supabase.from('profiles').update({ business_vat_number: e.target.value.toUpperCase() || null }).eq('id', profile.id).then(() => refreshProfile());
              }}
              className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">Invoice currency</span>
            <select
              defaultValue={profile?.invoice_currency ?? 'USD'}
              onChange={(e) => {
                if (!profile) return;
                supabase.from('profiles').update({ invoice_currency: e.target.value }).eq('id', profile.id).then(() => refreshProfile());
              }}
              className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring"
            >
              {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'AED', 'TRY'].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <PushNotificationsCard />
      <button
        type="button"
        onClick={() => navigate('/dashboard/settings/assistant')}
        className="focus-ring mt-4 flex w-full items-center justify-between rounded-2xl border border-border bg-bg-secondary p-6 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Mic size={20} />
          </span>
          <div>
            <p className="text-sm font-semibold text-text-primary">Assistant voice &amp; persona</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              Choose your AI receptionist's name, voice, and tone.
            </p>
          </div>
        </div>
        <ChevronRight size={18} className="text-text-secondary" />
      </button>
             {isOwner && (
        <button
          type="button"
          onClick={() => navigate('/dashboard/settings/api-keys')}
          className="focus-ring mt-4 flex w-full items-center justify-between rounded-2xl border border-border bg-bg-secondary p-6 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <KeyRound size={20} />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">API keys</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                Create and manage keys for the Developer API.
              </p>
            </div>
          </div>
          <ChevronRight size={18} className="text-text-secondary" />
        </button>
      )}
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
      {isOwner && (
        <button
          type="button"
          onClick={() => navigate('/dashboard/settings/enterprise-security')}
          className="focus-ring mt-4 flex w-full items-center justify-between rounded-2xl border border-border bg-bg-secondary p-6 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Building2 size={20} />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">Enterprise Security</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                SSO/SAML, SCIM, custom roles, IP allowlist, session policy.
              </p>
            </div>
          </div>
          <ChevronRight size={18} className="text-text-secondary" />
        </button>
      )}
    </DashboardLayout>
  );
}
