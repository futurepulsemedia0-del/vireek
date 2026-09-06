import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Phone, ArrowLeft, Plus, X, Trash2, Save, Clock, Briefcase, MapPin, MessageSquare, CircleHelp as HelpCircle, Sparkles, Loader as Loader2, Star } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, BusinessProfile } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';

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

// ============================================================
// MAIN PAGE
// ============================================================

export function BusinessProfilePage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading } = useAuth();
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

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const cleanFaqs = faqs.filter((f) => f.question.trim() && f.answer.trim());
      const payload = {
        user_id: user.id,
        services_offered: services.length > 0 ? services : null,
        service_area: serviceArea.trim() || null,
        google_review_url: googleReviewUrl.trim() || null,
        greeting_script: greetingScript.trim() || null,
        business_hours: hoursToDb(hours),
        faqs: cleanFaqs.length > 0 ? cleanFaqs : null,
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

      toast('Business profile saved. Sarah is updated.', 'success');
    } catch {
      toast('Could not save business profile. Please try again.', 'error');
    } finally {
      setSaving(false);
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
            This is what Sarah knows about your business. Keep it accurate so she answers calls correctly.
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
              The more detail you add, the smarter Sarah gets
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              Sarah uses your services, hours, service area, greeting script, and FAQs to answer
              caller questions accurately and book the right jobs. Take a few minutes to fill this
              out — it's the single most impactful setting in your account.
            </p>
          </div>
        </motion.div>

        {loading ? (
          <div className="space-y-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                <div className="h-5 w-40 animate-pulse rounded bg-bg-tertiary" />
                <div className="mt-4 h-10 w-full animate-pulse rounded bg-bg-tertiary" />
                <div className="mt-3 h-10 w-full animate-pulse rounded bg-bg-tertiary" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-6">
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

            {/* Greeting Script */}
            <SectionCard icon={MessageSquare} title="Greeting Script" description="What should Sarah say when she answers a call? This sets the tone for every interaction.">
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
            <SectionCard icon={HelpCircle} title="Frequently Asked Questions" description="Common questions callers ask. Sarah uses these to answer directly without transferring to you.">
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
              <button
                type="button"
                onClick={addFaq}
                className="focus-ring mt-3 flex items-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Plus size={16} /> Add FAQ
              </button>
            </SectionCard>

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
