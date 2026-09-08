import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader as Loader2,
  ArrowRight,
  ArrowLeft,
  Check,
  Phone,
  Clock,
  Sparkles,
  Building2,
  MapPin,
  Wrench,
  PartyPopper,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase, BusinessProfile } from '@/lib/supabase';
import { ThemeToggle } from '@/components/ThemeToggle';

// ============================================================
// CONSTANTS
// ============================================================

const DAYS_OF_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const SERVICE_SUGGESTIONS = [
  'Plumbing',
  'HVAC',
  'Electrical',
  'Roofing',
  'Landscaping',
  'Cleaning',
  'Painting',
  'Appliance Repair',
  'General Contracting',
  'Pest Control',
];

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

const chipClass = (active: boolean) =>
  `focus-ring cursor-pointer rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all ${
    active
      ? 'border-accent bg-accent/10 text-accent'
      : 'border-border bg-bg-primary text-text-secondary hover:border-accent/30 hover:text-text-primary'
  }`;

// ============================================================
// MAIN COMPONENT
// ============================================================

export function OnboardingPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Step 1: Business info
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [forwardingNumber, setForwardingNumber] = useState('');
  const [serviceArea, setServiceArea] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [customService, setCustomService] = useState('');

  // Step 2: Business hours
  const [hours, setHours] = useState<Record<string, { open: string; close: string }>>({});

  useEffect(() => {
    if (!profileLoading && profile?.onboarding_completed) {
      navigate('/dashboard', { replace: true });
    }
    if (profile) {
      setFullName(profile.full_name ?? '');
      setCompanyName(profile.company_name ?? '');
      setPhone(profile.phone ?? '');
      setForwardingNumber(profile.forwarding_number ?? '');
    }
  }, [profile, profileLoading, navigate]);

  // Load existing business profile if any
  const loadExistingProfile = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('business_profile')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    if (data) {
      const bp = data as BusinessProfile;
      if (bp.services_offered) setServices(bp.services_offered);
      if (bp.service_area) setServiceArea(bp.service_area);
      if (bp.business_hours) setHours(bp.business_hours as Record<string, { open: string; close: string }>);
    }
  }, [user]);

  useEffect(() => {
    loadExistingProfile();
  }, [loadExistingProfile]);

  const toggleService = (svc: string) => {
    setServices((prev) =>
      prev.includes(svc) ? prev.filter((s) => s !== svc) : [...prev, svc],
    );
  };

  const addCustomService = () => {
    const trimmed = customService.trim();
    if (trimmed && !services.includes(trimmed)) {
      setServices((prev) => [...prev, trimmed]);
    }
    setCustomService('');
  };

  const toggleDay = (day: string) => {
    setHours((prev) => {
      const next = { ...prev };
      if (next[day]) {
        delete next[day];
      } else {
        next[day] = { open: '08:00', close: '17:00' };
      }
      return next;
    });
  };

  const updateHours = (day: string, field: 'open' | 'close', value: string) => {
    setHours((prev) => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }));
  };

  const saveBusinessProfile = async () => {
    if (!user) return;
    const payload = {
      user_id: user.id,
      services_offered: services.length > 0 ? services : null,
      service_area: serviceArea.trim() || null,
      business_hours: Object.keys(hours).length > 0 ? hours : null,
    };
    const { error } = await supabase.from('business_profile').upsert(payload, {
      onConflict: 'user_id',
    });
    if (error) throw error;
  };

  const handleFinish = async () => {
    if (!user) return;
    if (!fullName.trim() || !companyName.trim()) {
      toast('Please fill in your name and company name.', 'error');
      setStep(0);
      return;
    }
    setSubmitting(true);
    try {
      // Save profile
      const { error: profError } = await supabase
        .from('profiles')
        .update({
          full_name: fullName.trim(),
          company_name: companyName.trim(),
          phone: phone.trim(),
          forwarding_number: forwardingNumber.trim(),
          onboarding_completed: true,
        })
        .eq('id', user.id);
      if (profError) throw profError;

      // Save business profile (services, hours, service area)
      await saveBusinessProfile();

      await refreshProfile();
      toast('Welcome to Vireek! Your dashboard is ready.', 'success');
      navigate('/dashboard', { replace: true });
    } catch {
      toast('Could not save your setup. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkipToFinish = () => {
    setStep(2);
  };

  const canProceedStep1 = fullName.trim() && companyName.trim();

  const steps = [
    { label: 'Business Info', icon: Building2 },
    { label: 'Hours', icon: Clock },
    { label: 'Confirm', icon: Check },
  ];

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-noise bg-gradient-mesh px-4 py-12 sm:px-6">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 py-4 sm:px-6">
        <span className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
            <Phone size={16} strokeWidth={2.5} />
          </span>
          <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
        </span>
        <ThemeToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-lg"
      >
        <div className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card backdrop-blur-md dark:shadow-card-dark sm:p-8 md:p-10">
          {/* Step indicator */}
          <div className="mb-6 flex items-center justify-center gap-2">
            {steps.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-all ${
                    i === step
                      ? 'bg-accent text-white ring-4 ring-accent/20'
                      : i < step
                        ? 'bg-success-500 text-white'
                        : 'bg-bg-tertiary text-text-secondary'
                  }`}
                >
                  {i < step ? <Check size={14} /> : i + 1}
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={`h-0.5 w-8 rounded-full transition-colors sm:w-12 ${
                      i < step ? 'bg-success-500' : 'bg-bg-tertiary'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>

          <AnimatePresence mode="wait">
            {/* STEP 1: Business Info */}
            {step === 0 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="text-center">
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                    <Building2 size={24} />
                  </span>
                  <h1 className="mt-4 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
                    Tell Sarah about your business
                  </h1>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    This helps Sarah answer calls accurately. You can change everything later.
                  </p>
                </div>

                <div className="mt-6 grid gap-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">
                      Full Name <span className="text-cta">*</span>
                    </label>
                    <input
                      type="text"
                      autoComplete="name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-primary">
                      Company Name <span className="text-cta">*</span>
                    </label>
                    <input
                      type="text"
                      autoComplete="organization"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">Phone Number</label>
                      <input
                        type="tel"
                        autoComplete="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary">Forwarding Number</label>
                      <input
                        type="tel"
                        placeholder="Number to forward to Sarah"
                        value={forwardingNumber}
                        onChange={(e) => setForwardingNumber(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>

                  {/* Services */}
                  <div>
                    <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
                      <Wrench size={14} className="text-accent" /> Services You Offer
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {SERVICE_SUGGESTIONS.map((svc) => (
                        <button
                          key={svc}
                          type="button"
                          onClick={() => toggleService(svc)}
                          className={chipClass(services.includes(svc))}
                        >
                          {svc}
                        </button>
                      ))}
                      {services
                        .filter((s) => !SERVICE_SUGGESTIONS.includes(s))
                        .map((svc) => (
                          <button
                            key={svc}
                            type="button"
                            onClick={() => toggleService(svc)}
                            className={chipClass(true)}
                          >
                            {svc}
                          </button>
                        ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={customService}
                        onChange={(e) => setCustomService(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addCustomService();
                          }
                        }}
                        placeholder="Add a custom service…"
                        className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60"
                      />
                      <button
                        type="button"
                        onClick={addCustomService}
                        className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:border-accent/40"
                      >
                        Add
                      </button>
                    </div>
                  </div>

                  {/* Service area */}
                  <div>
                    <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-text-primary">
                      <MapPin size={14} className="text-accent" /> Service Area
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Greater Austin, TX"
                      value={serviceArea}
                      onChange={(e) => setServiceArea(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>

                <div className="mt-6 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={handleSkipToFinish}
                    className="focus-ring rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
                  >
                    Skip to finish
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    disabled={!canProceedStep1}
                    className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                  >
                    Continue <ArrowRight size={16} />
                  </button>
                </div>
              </motion.div>
            )}

            {/* STEP 2: Business Hours */}
            {step === 1 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="text-center">
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                    <Clock size={24} />
                  </span>
                  <h1 className="mt-4 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
                    When are you open?
                  </h1>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    Sarah will know when to book jobs and when to take messages.
                  </p>
                </div>

                <div className="mt-6 space-y-2">
                  {DAYS_OF_WEEK.map((day) => {
                    const isActive = !!hours[day];
                    return (
                      <div
                        key={day}
                        className={`rounded-xl border p-3 transition-colors ${
                          isActive ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-primary'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <button
                            type="button"
                            onClick={() => toggleDay(day)}
                            className="flex items-center gap-3"
                          >
                            <span
                              className={`flex h-5 w-5 items-center justify-center rounded-md border transition-all ${
                                isActive
                                  ? 'border-accent bg-accent text-white'
                                  : 'border-border bg-bg-secondary'
                              }`}
                            >
                              {isActive && <Check size={12} />}
                            </span>
                            <span className="text-sm font-medium text-text-primary">{DAY_LABELS[day]}</span>
                          </button>
                          {isActive && (
                            <div className="flex items-center gap-2">
                              <input
                                type="time"
                                value={hours[day].open}
                                onChange={(e) => updateHours(day, 'open', e.target.value)}
                                className="focus-ring rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary"
                              />
                              <span className="text-xs text-text-secondary">to</span>
                              <input
                                type="time"
                                value={hours[day].close}
                                onChange={(e) => updateHours(day, 'close', e.target.value)}
                                className="focus-ring rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary"
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-6 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setStep(0)}
                    className="focus-ring flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSkipToFinish}
                      className="focus-ring rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep(2)}
                      className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
                    >
                      Continue <ArrowRight size={16} />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* STEP 3: Confirmation */}
            {step === 2 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="text-center">
                  <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                    <PartyPopper size={28} />
                  </span>
                  <h1 className="mt-4 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
                    You're all set!
                  </h1>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    Here's what Sarah knows so far. You can refine everything from your dashboard settings.
                  </p>
                </div>

                {/* Summary card */}
                <div className="mt-6 space-y-3">
                  <div className="rounded-xl border border-border bg-bg-primary p-4">
                    <div className="flex items-center gap-2">
                      <Building2 size={14} className="text-accent" />
                      <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Business</span>
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-text-primary">
                      {companyName || 'Not set'} — {fullName || 'Not set'}
                    </p>
                    {services.length > 0 && (
                      <p className="mt-1 text-xs text-text-secondary">
                        Services: {services.join(', ')}
                      </p>
                    )}
                    {serviceArea && (
                      <p className="mt-0.5 text-xs text-text-secondary">Area: {serviceArea}</p>
                    )}
                  </div>

                  <div className="rounded-xl border border-border bg-bg-primary p-4">
                    <div className="flex items-center gap-2">
                      <Clock size={14} className="text-accent" />
                      <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Hours</span>
                    </div>
                    {Object.keys(hours).length > 0 ? (
                      <div className="mt-1.5 space-y-0.5">
                        {DAYS_OF_WEEK.filter((d) => hours[d]).map((day) => (
                          <p key={day} className="text-xs text-text-secondary">
                            {DAY_LABELS[day]}: {hours[day].open} – {hours[day].close}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1.5 text-xs text-text-secondary">Hours not set — Sarah will ask callers to leave a message.</p>
                    )}
                  </div>
                </div>

                <div className="mt-6 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="focus-ring flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                  <button
                    type="button"
                    onClick={handleFinish}
                    disabled={submitting}
                    className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                  >
                    {submitting ? (
                      <>
                        <Loader2 size={16} className="animate-spin" /> Saving…
                      </>
                    ) : (
                      <>
                        <Sparkles size={16} /> Go to Dashboard
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
