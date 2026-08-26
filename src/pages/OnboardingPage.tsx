import { useState, FormEvent, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Loader as Loader2, ArrowRight, Check, Phone } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { BackButton } from '@/components/BackButton';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

export function OnboardingPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [forwardingNumber, setForwardingNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !companyName.trim()) {
      toast('Please fill in your name and company name.', 'error');
      return;
    }
    if (!user) return;
    setSubmitting(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: fullName.trim(),
          company_name: companyName.trim(),
          phone: phone.trim(),
          forwarding_number: forwardingNumber.trim(),
          onboarding_completed: true,
        })
        .eq('id', user.id);
      if (error) throw error;
      await refreshProfile();
      toast('Onboarding complete! Welcome to Vireek.', 'success');
      navigate('/dashboard', { replace: true });
    } catch {
      toast('Could not save your profile. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-noise bg-gradient-mesh px-6 py-12">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
              <Phone size={16} strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
          </span>
          <BackButton fallback="/login" to="/login" />
        </div>
        <ThemeToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-lg"
      >
        <div className="rounded-2xl border border-border bg-bg-secondary/90 p-8 shadow-card backdrop-blur-md dark:shadow-card-dark md:p-10">
          <div className="text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Check size={24} />
            </span>
            <h1 className="mt-5 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
              Tell Sarah about your business
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
              This information helps Sarah answer calls accurately on your behalf. You can change
              it anytime in your dashboard settings.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-8 grid gap-5">
            <div>
              <label htmlFor="fullName" className="mb-2 block text-sm font-medium text-text-primary">
                Full Name <span className="text-cta">*</span>
              </label>
              <input
                id="fullName"
                type="text"
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="companyName" className="mb-2 block text-sm font-medium text-text-primary">
                Company Name <span className="text-cta">*</span>
              </label>
              <input
                id="companyName"
                type="text"
                autoComplete="organization"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="phone" className="mb-2 block text-sm font-medium text-text-primary">
                  Phone Number
                </label>
                <input
                  id="phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="forwardingNumber" className="mb-2 block text-sm font-medium text-text-primary">
                  Forwarding Number
                </label>
                <input
                  id="forwardingNumber"
                  type="tel"
                  placeholder="Number to forward to Sarah"
                  value={forwardingNumber}
                  onChange={(e) => setForwardingNumber(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            <Button type="submit" variant="primary" size="lg" disabled={submitting} className="w-full">
              {submitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  Complete setup
                  <ArrowRight size={18} />
                </>
              )}
            </Button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
