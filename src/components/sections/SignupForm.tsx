import { FormEvent, useState } from 'react';
import { motion } from 'framer-motion';
import { CircleCheck as CheckCircle2, Phone, CircleAlert as AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, sectionHeadingClass, viewport } from '@/lib/motion';
import { SARAH_PHONE } from '@/lib/site';
import { supabase } from '@/lib/supabase';

type FormData = {
  fullName: string;
  email: string;
  companyName: string;
  phone: string;
  bestTimeToCall: string;
  smsConsent: boolean;
};

const INITIAL: FormData = {
  fullName: '',
  email: '',
  companyName: '',
  phone: '',
  bestTimeToCall: '',
  smsConsent: false,
};

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

export function SignupForm() {
  const [formData, setFormData] = useState<FormData>(INITIAL);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormData, boolean>>>({});

  const update = (key: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((prev) => ({ ...prev, [key]: false }));
  };

  const validate = () => {
    const errors: Partial<Record<keyof FormData, boolean>> = {};
    if (!formData.fullName.trim()) errors.fullName = true;
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) errors.email = true;
    if (!formData.companyName.trim()) errors.companyName = true;
    if (!formData.phone.trim()) errors.phone = true;
    if (!formData.smsConsent) errors.smsConsent = true;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(false);
    if (!validate()) return;
    setLoading(true);
    try {
      const { error: insertError } = await supabase.from('sales_inquiries').insert({
        full_name: formData.fullName,
        email: formData.email,
        company_name: formData.companyName || null,
        phone: formData.phone || null,
        best_time_to_call: formData.bestTimeToCall || null,
        sms_consent: formData.smsConsent,
      });
      if (insertError) {
        setError(true);
      } else {
        setSubmitted(true);
      }
    } catch (err) {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section id="contact" className="pb-28 pt-4">
      <div className="mx-auto max-w-3xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark md:p-12"
        >
          {submitted ? (
            <div className="flex flex-col items-center py-12 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10 text-success">
                <CheckCircle2 size={40} />
              </span>
              <h2 className="mt-6 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
                Thanks!
              </h2>
              <p className="mt-3 text-base leading-relaxed text-text-secondary">
                {"We'll be in touch within 24 hours."}
              </p>
            </div>
          ) : (
            <>
              <h2 className={`${sectionHeadingClass()} mt-0`}>Start Your Free Trial</h2>

              <form onSubmit={handleSubmit} noValidate className="mt-8 grid gap-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    label="Full Name"
                    required
                    error={fieldErrors.fullName}
                    id="fullName"
                  >
                    <input
                      id="fullName"
                      type="text"
                      autoComplete="name"
                      className={inputClass}
                      value={formData.fullName}
                      onChange={(e) => update('fullName', e.target.value)}
                    />
                  </Field>
                  <Field label="Email" required error={fieldErrors.email} id="email">
                    <input
                      id="email"
                      type="email"
                      autoComplete="email"
                      className={inputClass}
                      value={formData.email}
                      onChange={(e) => update('email', e.target.value)}
                    />
                  </Field>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    label="Company Name"
                    required
                    error={fieldErrors.companyName}
                    id="companyName"
                  >
                    <input
                      id="companyName"
                      type="text"
                      autoComplete="organization"
                      className={inputClass}
                      value={formData.companyName}
                      onChange={(e) => update('companyName', e.target.value)}
                    />
                  </Field>
                  <Field label="Phone" required error={fieldErrors.phone} id="phone">
                    <input
                      id="phone"
                      type="tel"
                      autoComplete="tel"
                      className={inputClass}
                      value={formData.phone}
                      onChange={(e) => update('phone', e.target.value)}
                    />
                  </Field>
                </div>

                <Field label="Best Time to Call" id="bestTimeToCall">
                  <select
                    id="bestTimeToCall"
                    className={inputClass}
                    value={formData.bestTimeToCall}
                    onChange={(e) => update('bestTimeToCall', e.target.value)}
                  >
                    <option value="">Select a time</option>
                    <option value="Morning 8-12">Morning 8-12</option>
                    <option value="Afternoon 12-5">Afternoon 12-5</option>
                    <option value="Evening 5-8">Evening 5-8</option>
                  </select>
                </Field>

                {/* SMS / TCPA consent checkbox */}
                <div>
                  <label
                    htmlFor="smsConsent"
                    className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-text-secondary"
                  >
                    <input
                      id="smsConsent"
                      type="checkbox"
                      checked={formData.smsConsent}
                      onChange={(e) => {
                        setFormData((prev) => ({ ...prev, smsConsent: e.target.checked }));
                        if (fieldErrors.smsConsent)
                          setFieldErrors((prev) => ({ ...prev, smsConsent: false }));
                      }}
                      className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded-md border border-border bg-bg-primary text-accent transition-colors focus-visible:border-accent"
                    />
                    <span>
                      I agree to receive service-related calls and SMS messages from Vireek regarding
                      my account and trial. Message and data rates may apply. Reply STOP to opt out.
                      See our{' '}
                      <Link
                        to="/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        Privacy Policy
                      </Link>{' '}
                      and{' '}
                      <Link
                        to="/terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        Terms of Service
                      </Link>
                      .
                    </span>
                  </label>
                  {fieldErrors.smsConsent && (
                    <p className="mt-1.5 text-xs text-danger">
                      You must agree to the consent terms to continue.
                    </p>
                  )}
                </div>

                {error && (
                  <p className="flex items-center gap-2 text-sm text-danger">
                    <AlertCircle size={16} />
                    Something went wrong. Please try again or call us directly.
                  </p>
                )}

                <Button type="submit" variant="primary" size="lg" disabled={loading} className="w-full">
                  {loading ? 'Sending\u2026' : 'Start Free Trial'}
                </Button>
              </form>

              <p className="mt-6 text-center text-sm text-text-secondary">
                Prefer to call? Reach Sarah at{' '}
                <a href={SARAH_PHONE} className="font-semibold text-accent hover:underline">
                  +1 (650) 910-6703
                </a>
              </p>
            </>
          )}
        </motion.div>
      </div>
    </section>
  );
}

function Field({
  label,
  required,
  error,
  id,
  children,
}: {
  label: string;
  required?: boolean;
  error?: boolean;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-text-primary">
        {label}
        {required && <span className="text-cta"> *</span>}
      </label>
      {children}
      {error && (
        <p className="mt-1.5 text-xs text-danger">Please enter a valid {label.toLowerCase()}.</p>
      )}
    </div>
  );
}
