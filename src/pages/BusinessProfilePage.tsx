import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CallSourcesManager } from '@/components/CallSourcesManager';
import { Phone, ArrowLeft, Plus, X, Trash2, Save, Clock, Briefcase, MapPin, MessageSquare, CircleHelp as HelpCircle, Sparkles, Loader as Loader2, Star, Calendar, PhoneForwarded, Mic, CalendarClock, CreditCard, ShieldCheck, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, BusinessProfile, BusinessProfileHoliday, BusinessProfileEscalationRule } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import { EscalationSettings } from '@/components/settings/EscalationSettings';
import { AgentOrchestrationSettings } from '@/components/settings/AgentOrchestrationSettings';
import { VoiceCloningCard } from '@/components/settings/VoiceCloningCard';
import { EmbedWidgetCard } from '@/components/EmbedWidgetCard';
import { SkeletonCardList } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { isTollFreeNumber, TOLL_FREE_STATUS_LABELS, TOLL_FREE_STATUS_STYLES, TollFreeVerificationStatus } from '@/lib/telephony';

// ============================================================
// CONSTANTS
// ============================================================

const DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
] as const;

type DayKey = (typeof DAYS)[number]['key'];

interface DayHours {
  open: string;
  close: string;
  closed: boolean;
}

type HoursState = Record<DayKey, DayHours>;

function defaultHours(): HoursState {
  const base: HoursState = {
    mon: { open: '08:00', close: '17:00', closed: false },
    tue: { open: '08:00', close: '17:00', closed: false },
    wed: { open: '08:00', close: '17:00', closed: false },
    thu: { open: '08:00', close: '17:00', closed: false },
    fri: { open: '08:00', close: '17:00', closed: false },
    sat: { open: '09:00', close: '14:00', closed: false },
    sun: { open: '09:00', close: '14:00', closed: true },
  };
  return base;
}

function hoursFromDb(db: BusinessProfile['business_hours']): HoursState {
  const base = defaultHours();
  if (!db) return base;
  for (const day of DAYS) {
    const entry = db[day.key];
    if (entry) {
      base[day.key] = { open: entry.open, close: entry.close, closed: false };
    } else {
      base[day.key] = { ...base[day.key], closed: true };
    }
  }
  return base;
}

function hoursToDb(hours: HoursState): Record<string, { open: string; close: string }> {
  const result: Record<string, { open: string; close: string }> = {};
  for (const day of DAYS) {
    const h = hours[day.key];
    if (!h.closed) {
      result[day.key] = { open: h.open, close: h.close };
    }
  }
  return result;
}

const TRIGGER_LABELS: Record<BusinessProfileEscalationRule['trigger'], string> = {
  emergency: 'Emergency call detected',
  after_hours: 'Call comes in after hours',
  no_answer: 'No one answers / picks up',
  human_request: 'Caller asks for a live person',
};

const ACTION_LABELS: Record<BusinessProfileEscalationRule['action'], string> = {
  transfer: 'Warm-transfer the call',
  sms: 'Send an SMS alert',
  email: 'Send an email alert',
};

const ACTION_TARGET_PLACEHOLDER: Record<BusinessProfileEscalationRule['action'], string> = {
  transfer: '(555) 555-5555',
  sms: '(555) 555-5555',
  email: 'oncall@yourbusiness.com',
};

function newId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

// ============================================================
// ASSISTANT PERSONA PRESETS
// ============================================================

const TONE_PRESETS = [
  {
    key: 'friendly_professional',
    label: 'Friendly & Professional',
    description: 'Warm but businesslike — the default. Fits most home-service calls.',
  },
  {
    key: 'warm_casual',
    label: 'Warm & Casual',
    description: 'Relaxed and conversational, like talking to a helpful neighbor.',
  },
  {
    key: 'direct_efficient',
    label: 'Direct & Efficient',
    description: 'Short, to-the-point answers. Good for high call volume.',
  },
  {
    key: 'upbeat_energetic',
    label: 'Upbeat & Energetic',
    description: 'Enthusiastic and high-energy. Good for sales-driven teams.',
  },
] as const;

const VOICE_PRESETS = [
  { key: 'sarah_warm_us_f', name: 'Sarah', label: 'Warm — US, Female' },
  { key: 'olivia_bright_us_f', name: 'Olivia', label: 'Bright — US, Female' },
  { key: 'grace_calm_uk_f', name: 'Grace', label: 'Calm — UK, Female' },
  { key: 'ethan_confident_us_m', name: 'Ethan', label: 'Confident — US, Male' },
  { key: 'marcus_friendly_us_m', name: 'Marcus', label: 'Friendly — US, Male' },
] as const;

const DEFAULT_ASSISTANT_NAME = 'Sarah';
const DEFAULT_ASSISTANT_TONE = 'friendly_professional';
const DEFAULT_ASSISTANT_VOICE = 'sarah_warm_us_f';

// ============================================================
// MAIN PAGE
// ============================================================

export function BusinessProfilePage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);

  const [services, setServices] = useState<string[]>([]);
  const [newService, setNewService] = useState('');
  const [serviceArea, setServiceArea] = useState('');
  const [googleReviewUrl, setGoogleReviewUrl] = useState('');
  const [greetingScript, setGreetingScript] = useState('');
  const [hours, setHours] = useState<HoursState>(defaultHours());
  const [faqs, setFaqs] = useState<{ question: string; answer: string }[]>([]);
  const [assistantName, setAssistantName] = useState(DEFAULT_ASSISTANT_NAME);
  const [assistantTone, setAssistantTone] = useState<string>(DEFAULT_ASSISTANT_TONE);
  const [assistantVoice, setAssistantVoice] = useState<string>(DEFAULT_ASSISTANT_VOICE);
  const [holidays, setHolidays] = useState<BusinessProfileHoliday[]>([]);
  const [escalationRules, setEscalationRules] = useState<BusinessProfileEscalationRule[]>([]);
  const [financingPartnerName, setFinancingPartnerName] = useState('');
  const [financingNote, setFinancingNote] = useState('');
  const [allowSelfReschedule, setAllowSelfReschedule] = useState(false);

  // Phone Number & Compliance (Step 58 — lives on `profiles`, not
  // `business_profile`, since forwarding_number always has)
  const [forwardingNumber, setForwardingNumber] = useState('');
  const [tollFreeStatus, setTollFreeStatus] = useState<TollFreeVerificationStatus>('not_applicable');
  const [a2pCampaignStatus, setA2pCampaignStatus] = useState<string>('not_started');
  const [legalBusinessName, setLegalBusinessName] = useState('');
  const [ein, setEin] = useState('');
  const [smsSampleMessage, setSmsSampleMessage] = useState('');
  const [smsOptInDescription, setSmsOptInDescription] = useState('');
  const [savingA2p, setSavingA2p] = useState(false);
  const [savingNumber, setSavingNumber] = useState(false);
  const [showTfvInfo, setShowTfvInfo] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setForwardingNumber(profile.forwarding_number ?? '');
    setTollFreeStatus(profile.toll_free_verification_status ?? 'not_applicable');

    setA2pCampaignStatus(profile.a2p_campaign_status ?? 'not_started');
    setLegalBusinessName(profile.legal_business_name ?? '');
    setEin(profile.ein ?? '');
    setSmsSampleMessage(profile.sms_sample_message ?? '');
    setSmsOptInDescription(profile.sms_opt_in_description ?? '');
      }, [profile]);

  const loadProfile = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('business_profile')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        const bp = data as BusinessProfile;
        setProfileId(bp.id);
        setServices(bp.services_offered ?? []);
        setServiceArea(bp.service_area ?? '');
        setGoogleReviewUrl(bp.google_review_url ?? '');
        setGreetingScript(bp.greeting_script ?? '');
        setHours(hoursFromDb(bp.business_hours));
        setFaqs(bp.faqs ?? []);
        setAssistantName(bp.assistant_name || DEFAULT_ASSISTANT_NAME);
        setAssistantTone(bp.assistant_tone || DEFAULT_ASSISTANT_TONE);
        setAssistantVoice(bp.assistant_voice || DEFAULT_ASSISTANT_VOICE);
        setHolidays(bp.holidays ?? []);
        setEscalationRules(bp.escalation_rules ?? []);
        setFinancingPartnerName(bp.financing_partner_name ?? '');
        setFinancingNote(bp.financing_note ?? '');
        setAllowSelfReschedule(bp.allow_customer_self_reschedule ?? false);
      }
    } catch {
      // empty state — user will create on save
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  useKeyboardShortcut({
    key: 'Escape',
    handler: () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    },
  });

  const addService = () => {
    const trimmed = newService.trim();
    if (!trimmed || services.includes(trimmed)) return;
    setServices((prev) => [...prev, trimmed]);
    setNewService('');
  };

  const removeService = (svc: string) => {
    setServices((prev) => prev.filter((s) => s !== svc));
  };

  const addFaq = () => {
    setFaqs((prev) => [...prev, { question: '', answer: '' }]);
  };

  const updateFaq = (index: number, field: 'question' | 'answer', value: string) => {
    setFaqs((prev) => prev.map((f, i) => (i === index ? { ...f, [field]: value } : f)));
  };

  const removeFaq = (index: number) => {
    setFaqs((prev) => prev.filter((_, i) => i !== index));
  };

  const updateHours = (day: DayKey, field: keyof DayHours, value: string | boolean) => {
    setHours((prev) => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }));
  };

  const addHoliday = () => {
    setHolidays((prev) => [...prev, { id: newId(), date: '', label: '', message: '' }]);
  };

  const updateHoliday = (id: string, field: keyof BusinessProfileHoliday, value: string) => {
    setHolidays((prev) => prev.map((h) => (h.id === id ? { ...h, [field]: value } : h)));
  };

  const removeHoliday = (id: string) => {
    setHolidays((prev) => prev.filter((h) => h.id !== id));
  };

  const addEscalationRule = () => {
    setEscalationRules((prev) => [
      ...prev,
      { id: newId(), trigger: 'emergency', action: 'transfer', target: '', note: '' },
    ]);
  };

  const updateEscalationRule = (
    id: string,
    field: keyof BusinessProfileEscalationRule,
    value: string
  ) => {
    setEscalationRules((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const removeEscalationRule = (id: string) => {
    setEscalationRules((prev) => prev.filter((r) => r.id !== id));
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const cleanFaqs = faqs.filter((f) => f.question.trim() && f.answer.trim());
      const cleanHolidays = holidays
        .filter((h) => h.date.trim() && h.label.trim())
        .map((h) => ({ id: h.id, date: h.date, label: h.label.trim(), message: h.message?.trim() || undefined }));
      const cleanEscalationRules = escalationRules
        .filter((r) => r.target.trim())
        .map((r) => ({ id: r.id, trigger: r.trigger, action: r.action, target: r.target.trim(), note: r.note?.trim() || undefined }));
      const payload = {
        user_id: user.id,
        services_offered: services.length > 0 ? services : null,
        service_area: serviceArea.trim() || null,
        google_review_url: googleReviewUrl.trim() || null,
        greeting_script: greetingScript.trim() || null,
        business_hours: hoursToDb(hours),
        faqs: cleanFaqs.length > 0 ? cleanFaqs : null,
        assistant_name: assistantName.trim() || DEFAULT_ASSISTANT_NAME,
        assistant_tone: assistantTone,
        assistant_voice: assistantVoice,
        holidays: cleanHolidays.length > 0 ? cleanHolidays : null,
        escalation_rules: cleanEscalationRules.length > 0 ? cleanEscalationRules : null,
        financing_partner_name: financingPartnerName.trim() || null,
        financing_note: financingNote.trim() || null,
        allow_customer_self_reschedule: allowSelfReschedule,
      };

      if (profileId) {
        const { error } = await supabase
          .from('business_profile')
          .update(payload)
          .eq('id', profileId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('business_profile')
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;
        if (data) setProfileId(data.id);
      }

      toast(`Business profile saved. ${assistantName.trim() || DEFAULT_ASSISTANT_NAME} is updated.`, 'success');
    } catch {
      toast('Could not save business profile. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const numberIsTollFree = isTollFreeNumber(forwardingNumber);

  const handleSaveNumber = async () => {
    if (!user) return;
    setSavingNumber(true);
    try {
      // If the number just changed and is now toll-free but was never
      // reviewed, reset status to "not_started" rather than silently
      // keeping a stale "verified" carried over from a different number.
      const nextStatus: TollFreeVerificationStatus = numberIsTollFree
        ? tollFreeStatus === 'not_applicable'
          ? 'not_started'
          : tollFreeStatus
        : 'not_applicable';

      const { error } = await supabase
        .from('profiles')
        .update({ forwarding_number: forwardingNumber.trim() || null, toll_free_verification_status: nextStatus })
        .eq('id', user.id);
      if (error) throw error;

      setTollFreeStatus(nextStatus);
      await refreshProfile();
      toast('Forwarding number updated.', 'success');
    } catch {
      toast('Could not save your number. Please try again.', 'error');
    } finally {
      setSavingNumber(false);
    }
  };

  const handleStartVerification = async () => {
    if (!user) return;
    setSavingNumber(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ toll_free_verification_status: 'pending', toll_free_verification_requested_at: new Date().toISOString() })
        .eq('id', user.id);
      if (error) throw error;

      setTollFreeStatus('pending');
      await refreshProfile();
      toast('Verification requested — our team will follow up by email.', 'success');
      window.location.href = `mailto:ali@vireek.com?subject=Toll-Free%20Verification%20Request&body=Please%20start%20Toll-Free%20Verification%20for%3A%0ABusiness%3A%20${encodeURIComponent(
        profile?.company_name ?? ''
      )}%0ANumber%3A%20${encodeURIComponent(forwardingNumber)}%0AAccount%20email%3A%20${encodeURIComponent(user.email ?? '')}`;
    } catch {
      toast('Could not start verification. Please try again.', 'error');
    } finally {
      setSavingNumber(false);
    }
  };

       const handleSubmitA2pRegistration = async () => {
    if (!user) return;
    if (!legalBusinessName.trim() || !ein.trim() || !smsSampleMessage.trim() || !smsOptInDescription.trim()) {
      toast('Fill in legal business name, EIN, sample message, and opt-in description first.', 'error');
      return;
    }
    setSavingA2p(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          legal_business_name: legalBusinessName.trim(),
          ein: ein.trim(),
          sms_sample_message: smsSampleMessage.trim(),
          sms_opt_in_description: smsOptInDescription.trim(),
          a2p_brand_status: 'pending',
          a2p_campaign_status: 'pending',
          a2p_requested_at: new Date().toISOString(),
        })
        .eq('id', user.id);
      if (error) throw error;

      setA2pCampaignStatus('pending');
      await refreshProfile();
      toast('A2P 10DLC registration submitted — carrier review usually takes 1-5 business days.', 'success');
      window.location.href = `mailto:ali@vireek.com?subject=A2P%2010DLC%20Brand%20Registration&body=Business%3A%20${encodeURIComponent(
        legalBusinessName
      )}%0AEIN%3A%20${encodeURIComponent(ein)}%0AAccount%20email%3A%20${encodeURIComponent(user.email ?? '')}`;
    } catch {
      toast('Could not submit registration. Please try again.', 'error');
    } finally {
      setSavingA2p(false);
    }
  };

  const inputClass =
    'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

  return (
    <DashboardLayout activeLabel="Business Profile">
      {/* Back button */}
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </button>

        {/* Page title */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
            Business Profile
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            This is what {assistantName || DEFAULT_ASSISTANT_NAME} knows about your business. Keep it accurate so
            she answers calls correctly.
          </p>
        </div>

        {/* Intro banner */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="mb-8 flex items-start gap-4 rounded-2xl border border-accent/20 bg-accent/5 p-5"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Sparkles size={22} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              The more detail you add, the smarter {assistantName || DEFAULT_ASSISTANT_NAME} gets
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              {assistantName || DEFAULT_ASSISTANT_NAME} uses your services, hours, service area, greeting script,
              and FAQs to answer caller questions accurately and book the right jobs. Take a few minutes to fill
              this out — it's the single most impactful setting in your account.
            </p>
          </div>
        </motion.div>

        {loading ? (
          <SkeletonCardList count={5} rows={2} />
        ) : (
          <div className="space-y-6">
            {/* Assistant Persona */}
            <SectionCard
              icon={Mic}
              title="Assistant Persona"
              description="Your AI receptionist's name, voice, and conversational tone on every call."
            >
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-secondary">Assistant name</label>
                  <input
                    type="text"
                    value={assistantName}
                    onChange={(e) => setAssistantName(e.target.value)}
                    placeholder="e.g. Sarah"
                    maxLength={40}
                    className={inputClass}
                  />
                  <p className="mt-1.5 text-xs text-text-secondary/60">
                    What your assistant calls itself when it answers a call — e.g. "Thanks for calling Bright
                    Plumbing, this is {assistantName.trim() || 'Sarah'}."
                  </p>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-secondary">Voice</label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {VOICE_PRESETS.map((voice) => (
                      <button
                        key={voice.key}
                        type="button"
                        onClick={() => setAssistantVoice(voice.key)}
                        className={`focus-ring flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                          assistantVoice === voice.key
                            ? 'border-accent bg-accent/5'
                            : 'border-border bg-bg-primary hover:border-accent/40'
                        }`}
                      >
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                            assistantVoice === voice.key ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary'
                          }`}
                        >
                          <Mic size={16} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-text-primary">{voice.name}</span>
                          <span className="block truncate text-xs text-text-secondary">{voice.label}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-text-secondary/60">
                    The voice callers hear. Voice previews aren't available in this dashboard yet — this selects
                    which voice profile is used on live calls.
                  </p>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-secondary">Conversational tone</label>
                  <select
                    value={assistantTone}
                    onChange={(e) => setAssistantTone(e.target.value)}
                    className={`${inputClass} cursor-pointer`}
                  >
                    {TONE_PRESETS.map((tone) => (
                      <option key={tone.key} value={tone.key}>
                        {tone.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-xs text-text-secondary/60">
                    {TONE_PRESETS.find((t) => t.key === assistantTone)?.description}
                  </p>
                </div>
              </div>
            </SectionCard>

            <div className="mt-6">
              <VoiceCloningCard />
            </div>

            {/* Phone Number & Compliance */}
            <SectionCard
              icon={PhoneForwarded}
              title="Phone Number & Compliance"
              description="The number calls forward from, and whether it's clear to send SMS."
            >
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-secondary">Forwarding number</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="tel"
                      value={forwardingNumber}
                      onChange={(e) => setForwardingNumber(e.target.value)}
                      placeholder="+1 (555) 123-4567"
                      className={inputClass}
                    />
                    <button
                      type="button"
                      onClick={handleSaveNumber}
                      disabled={savingNumber || forwardingNumber.trim() === (profile?.forwarding_number ?? '')}
                      className="focus-ring flex shrink-0 items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-50"
                    >
                      {savingNumber ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                      Save
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-text-secondary/60">
                    The existing business number calls get forwarded from before reaching {assistantName || DEFAULT_ASSISTANT_NAME}.
                  </p>
                </div>

                {numberIsTollFree && (
                  <div className="rounded-xl border border-border bg-bg-primary p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">Toll-Free Verification</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TOLL_FREE_STATUS_STYLES[tollFreeStatus]}`}>
                        {TOLL_FREE_STATUS_LABELS[tollFreeStatus]}
                      </span>
                    </div>

                    {tollFreeStatus !== 'verified' && (
                      <div className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-text-secondary">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" />
                        <p>
                          This number is toll-free. Carriers filter or block SMS from unverified
                          toll-free numbers, which can stop automated booking confirmations from
                          reaching customers.
                        </p>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => setShowTfvInfo((v) => !v)}
                      className="focus-ring mt-2 text-xs font-semibold text-accent hover:underline"
                    >
                      {showTfvInfo ? 'Hide details' : 'What is this?'}
                    </button>
                    {showTfvInfo && (
                      <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                        Toll-free numbers (800, 833, 844, 855, 866, 877, 888) need a one-time
                        review by carriers before they can send SMS reliably — separate from
                        10DLC, which covers local numbers. It typically takes a few business
                        days once submitted and requires your business name, address, and how
                        you use the number to text customers.
                      </p>
                    )}

                    {(tollFreeStatus === 'not_started' || tollFreeStatus === 'rejected') && (
                      <button
                        type="button"
                        onClick={handleStartVerification}
                        disabled={savingNumber}
                        className="focus-ring mt-3 flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                      >
                        <ShieldCheck size={13} />
                        {tollFreeStatus === 'rejected' ? 'Resubmit for Verification' : 'Start Verification'}
                      </button>
                    )}
                    {tollFreeStatus === 'pending' && (
                      <p className="mt-3 text-xs text-text-secondary">
                        We've received your request and will follow up by email once carrier
                        review is complete.
                      </p>
                    )}
                  </div>
                )}
              </div>
                            <div className="mt-6 rounded-xl border border-border bg-bg-primary p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-text-primary">SMS Carrier Registration (A2P 10DLC)</p>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    a2pCampaignStatus === 'approved'
                      ? 'bg-success-500/15 text-success-500'
                      : a2pCampaignStatus === 'rejected'
                      ? 'bg-danger/10 text-danger'
                      : a2pCampaignStatus === 'pending'
                      ? 'bg-accent/10 text-accent'
                      : 'bg-warning-500/15 text-warning-500'
                  }`}>
                    {a2pCampaignStatus === 'approved' ? 'Approved' : a2pCampaignStatus === 'rejected' ? 'Rejected' : a2pCampaignStatus === 'pending' ? 'Pending carrier review' : 'Not started'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  Required by carriers (AT&T, T-Mobile, Verizon) before any SMS can be delivered. Unregistered traffic is blocked, not filtered.
                </p>
                {a2pCampaignStatus !== 'approved' && (
                  <div className="mt-4 space-y-3">
                    <input value={legalBusinessName} onChange={(e) => setLegalBusinessName(e.target.value)} placeholder="Legal business name (as registered)" className={inputClass} />
                    <input value={ein} onChange={(e) => setEin(e.target.value)} placeholder="EIN (XX-XXXXXXX)" className={inputClass} />
                    <textarea value={smsSampleMessage} onChange={(e) => setSmsSampleMessage(e.target.value)} placeholder="Sample SMS message customers will receive" rows={2} className={inputClass} />
                    <textarea value={smsOptInDescription} onChange={(e) => setSmsOptInDescription(e.target.value)} placeholder="How customers opt in (e.g. checkbox on booking form)" rows={2} className={inputClass} />
                    <Button variant="secondary" size="sm" onClick={handleSubmitA2pRegistration} disabled={savingA2p}>
                      {savingA2p ? 'Submitting…' : a2pCampaignStatus === 'rejected' ? 'Resubmit Registration' : 'Submit for Carrier Registration'}
                    </Button>
                  </div>
                )}
              </div>
            </SectionCard>

            {/* Services Offered */}
            <SectionCard icon={Briefcase} title="Services Offered" description="What services does your business provide? Add one per line.">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newService}
                  onChange={(e) => setNewService(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addService();
                    }
                  }}
                  placeholder="e.g. Drain cleaning"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={addService}
                  disabled={!newService.trim()}
                  className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:opacity-90 disabled:opacity-40"
                >
                  <Plus size={16} /> Add
                </button>
              </div>
              {services.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {services.map((svc) => (
                    <span
                      key={svc}
                      className="flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary"
                    >
                      {svc}
                      <button
                        type="button"
                        onClick={() => removeService(svc)}
                        className="focus-ring rounded-full p-0.5 text-text-secondary transition-colors hover:text-danger"
                        aria-label={`Remove ${svc}`}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {services.length === 0 && (
                <p className="mt-3 text-xs text-text-secondary/60">No services added yet.</p>
              )}
            </SectionCard>

            {/* Service Area */}
            <SectionCard icon={MapPin} title="Service Area" description="The geographic area your business serves.">
              <input
                type="text"
                value={serviceArea}
                onChange={(e) => setServiceArea(e.target.value)}
                placeholder="e.g. Greater Austin Metro, TX — within 30 miles of downtown"
                className={inputClass}
              />
            </SectionCard>

            {/* Google Review Link */}
            <SectionCard
              icon={Star}
              title="Google Review Link"
              description="Used to text customers a review request after a job is marked completed (see the Reviews page)."
            >
              <input
                type="url"
                value={googleReviewUrl}
                onChange={(e) => setGoogleReviewUrl(e.target.value)}
                placeholder="https://g.page/r/your-business/review"
                className={inputClass}
              />
            </SectionCard>

            {/* Business Hours */}
            <SectionCard icon={Clock} title="Business Hours" description="When are you available to take calls and schedule jobs?">
              <div className="space-y-2">
                {DAYS.map((day) => {
                  const h = hours[day.key];
                  return (
                    <div
                      key={day.key}
                      className="flex flex-col gap-2 rounded-xl border border-border bg-bg-primary p-3 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="flex items-center justify-between sm:w-32 sm:shrink-0">
                        <span className="text-sm font-medium text-text-primary">{day.label}</span>
                        <label className="flex cursor-pointer items-center gap-1.5 sm:ml-auto">
                          <input
                            type="checkbox"
                            checked={!h.closed}
                            onChange={(e) => updateHours(day.key, 'closed', !e.target.checked)}
                            className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
                          />
                          <span className="text-xs text-text-secondary">Open</span>
                        </label>
                      </div>
                      {h.closed ? (
                        <span className="flex-1 text-sm text-text-secondary/60">Closed</span>
                      ) : (
                        <div className="flex items-center gap-2 sm:flex-1">
                          <input
                            type="time"
                            value={h.open}
                            onChange={(e) => updateHours(day.key, 'open', e.target.value)}
                            className={`${inputClass} sm:max-w-[140px]`}
                          />
                          <span className="text-xs text-text-secondary">to</span>
                          <input
                            type="time"
                            value={h.close}
                            onChange={(e) => updateHours(day.key, 'close', e.target.value)}
                            className={`${inputClass} sm:max-w-[140px]`}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </SectionCard>

            {/* Holidays / Closures */}
            <SectionCard
              icon={Calendar}
              title="Holidays & Closures"
              description="One-off dates that override your regular business hours above — Sarah lets callers know you're closed and won't schedule jobs for that day."
            >
              {holidays.length > 0 && (
                <div className="space-y-3">
                  {holidays.map((h) => (
                    <div key={h.id} className="rounded-xl border border-border bg-bg-primary p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="grid flex-1 gap-2 sm:grid-cols-2">
                          <input
                            type="date"
                            value={h.date}
                            onChange={(e) => updateHoliday(h.id, 'date', e.target.value)}
                            className={inputClass}
                          />
                          <input
                            type="text"
                            value={h.label}
                            onChange={(e) => updateHoliday(h.id, 'label', e.target.value)}
                            placeholder="e.g. Christmas Day"
                            className={inputClass}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeHoliday(h.id)}
                          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger"
                          aria-label="Remove holiday"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <input
                        type="text"
                        value={h.message ?? ''}
                        onChange={(e) => updateHoliday(h.id, 'message', e.target.value)}
                        placeholder="Optional: what Sarah should tell callers, e.g. “We're closed for the holiday, back Monday at 8am.”"
                        className={`${inputClass} mt-2`}
                      />
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={addHoliday}
                className="focus-ring mt-3 flex items-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Plus size={16} /> Add Holiday
              </button>
              {holidays.length === 0 && (
                <p className="mt-3 text-xs text-text-secondary/60">No holidays added yet.</p>
              )}
            </SectionCard>

            {/* Financing Mention */}
            <SectionCard
              icon={CreditCard}
              title="Financing"
              description="If you offer on-the-spot financing (Wisetack or similar) on bigger jobs, add it here — it shows up as a reminder on your Quotes page when following up."
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  type="text"
                  value={financingPartnerName}
                  onChange={(e) => setFinancingPartnerName(e.target.value)}
                  placeholder="Financing partner, e.g. Wisetack"
                  className={inputClass}
                />
                <input
                  type="text"
                  value={financingNote}
                  onChange={(e) => setFinancingNote(e.target.value)}
                  placeholder="e.g. 0% APR for 12 months on jobs over $500"
                  className={inputClass}
                />
              </div>
            </SectionCard>

            {/* Call Sources (Lead Attribution) */}
            <SectionCard
              icon={Target}
              title="Call Sources"
              description="Track which channel each call came from — Google, a specific ad, a referral partner — by mapping additional Vapi phone numbers to a channel name."
            >
              <CallSourcesManager />
            </SectionCard>

            {/* Call Routing & Escalation Rules */}
            <SectionCard
              icon={PhoneForwarded}
              title="Call Routing & Escalation Rules"
              description="What should Sarah actually do in each situation? These are real settings Sarah follows, not just a description of the feature."
            >
              {escalationRules.length > 0 && (
                <div className="space-y-3">
                  {escalationRules.map((rule) => (
                    <div key={rule.id} className="rounded-xl border border-border bg-bg-primary p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="grid flex-1 gap-2 sm:grid-cols-2">
                          <select
                            value={rule.trigger}
                            onChange={(e) => updateEscalationRule(rule.id, 'trigger', e.target.value)}
                            className={inputClass}
                          >
                            {(Object.keys(TRIGGER_LABELS) as BusinessProfileEscalationRule['trigger'][]).map((t) => (
                              <option key={t} value={t}>
                                {TRIGGER_LABELS[t]}
                              </option>
                            ))}
                          </select>
                          <select
                            value={rule.action}
                            onChange={(e) => updateEscalationRule(rule.id, 'action', e.target.value)}
                            className={inputClass}
                          >
                            {(Object.keys(ACTION_LABELS) as BusinessProfileEscalationRule['action'][]).map((a) => (
                              <option key={a} value={a}>
                                {ACTION_LABELS[a]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeEscalationRule(rule.id)}
                          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger"
                          aria-label="Remove rule"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <input
                          type="text"
                          value={rule.target}
                          onChange={(e) => updateEscalationRule(rule.id, 'target', e.target.value)}
                          placeholder={ACTION_TARGET_PLACEHOLDER[rule.action]}
                          className={inputClass}
                        />
                        <input
                          type="text"
                          value={rule.note ?? ''}
                          onChange={(e) => updateEscalationRule(rule.id, 'note', e.target.value)}
                          placeholder="Optional note, e.g. “on-call tech”"
                          className={inputClass}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={addEscalationRule}
                className="focus-ring mt-3 flex items-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Plus size={16} /> Add Rule
              </button>
              {escalationRules.length === 0 && (
                <p className="mt-3 text-xs text-text-secondary/60">
                  No routing rules yet — calls follow default handling.
                </p>
              )}
            </SectionCard>

            {/* Greeting Script */}
            <SectionCard
              icon={MessageSquare}
              title="Greeting Script"
              description={`What should ${assistantName.trim() || DEFAULT_ASSISTANT_NAME} say when she answers a call? This sets the tone for every interaction.`}
            >
              <textarea
                value={greetingScript}
                onChange={(e) => setGreetingScript(e.target.value)}
                placeholder="e.g. Thank you for calling Bright Plumbing, this is Sarah. How can I help you today?"
                rows={3}
                className={`${inputClass} resize-none`}
              />
              <p className="mt-2 text-xs text-text-secondary/60">
                Tip: Include your business name and a friendly, professional greeting.
              </p>
            </SectionCard>

            {/* FAQs */}
            <SectionCard
              icon={HelpCircle}
              title="Frequently Asked Questions"
              description={`Common questions callers ask. ${assistantName.trim() || DEFAULT_ASSISTANT_NAME} uses these to answer directly without transferring to you.`}
            >
              {faqs.length > 0 && (
                <div className="space-y-3">
                  {faqs.map((faq, i) => (
                    <div
                      key={i}
                      className="rounded-xl border border-border bg-bg-primary p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="mt-1 text-xs font-semibold text-text-secondary">Q&amp;A #{i + 1}</span>
                        <button
                          type="button"
                          onClick={() => removeFaq(i)}
                          className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger"
                          aria-label="Remove FAQ"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <input
                        type="text"
                        value={faq.question}
                        onChange={(e) => updateFaq(i, 'question', e.target.value)}
                        placeholder="Question: e.g. Do you offer emergency service?"
                        className={`${inputClass} mt-2`}
                      />
                      <textarea
                        value={faq.answer}
                        onChange={(e) => updateFaq(i, 'answer', e.target.value)}
                        placeholder="Answer: e.g. Yes, we offer 24/7 emergency plumbing service within our service area."
                        rows={2}
                        className={`${inputClass} mt-2 resize-none`}
                      />
                    </div>
                  ))}
                </div>
              )}
              {faqs.length === 0 && (
                <EmptyState
                  icon={HelpCircle}
                  title="No FAQs yet"
                  description="Add common questions so your assistant can answer callers instantly instead of transferring them."
                  className="mt-3"
                />
              )}
              <button
                type="button"
                onClick={addFaq}
                className="focus-ring mt-3 flex items-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Plus size={16} /> Add FAQ
              </button>
            </SectionCard>

            {/* Trust Badge — embeddable widget for the customer's own website */}
            <div className="mt-6">
              <EmbedWidgetCard />
            </div>
            <div className="mt-6">
              <EscalationSettings />
              <AgentOrchestrationSettings />
            </div>

            <div className="mt-6">
              <SectionCard
                icon={CalendarClock}
                title="Customer Self-Reschedule"
                description="Let customers reschedule their own appointment from a link, without calling in."
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Allow self-reschedule</p>
                    <p className="text-xs text-text-secondary">
                      Each scheduled job gets a private link. Sarah (or your own texts) can send it.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={allowSelfReschedule}
                    onClick={() => setAllowSelfReschedule((v) => !v)}
                    className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      allowSelfReschedule ? 'bg-accent' : 'bg-bg-tertiary'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                        allowSelfReschedule ? 'translate-x-[22px]' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
              </SectionCard>
            </div>

            {/* Save bar */}
            <div className="sticky bottom-4 z-10 flex items-center justify-end gap-3 rounded-2xl border border-border bg-bg-secondary/95 p-4 shadow-card backdrop-blur-md dark:shadow-card-dark">
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="focus-ring rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                {saving ? 'Saving…' : 'Save Profile'}
              </button>
            </div>
          </div>
        )}
    </DashboardLayout>
  );
}

// ============================================================
// SECTION CARD
// ============================================================

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Phone;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Icon size={20} />
        </span>
        <div>
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <p className="mt-0.5 text-sm text-text-secondary">{description}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </motion.div>
  );
}
