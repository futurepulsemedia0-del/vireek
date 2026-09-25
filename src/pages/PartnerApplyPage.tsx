import { FormEvent, useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { Handshake, ArrowRight, Clock3, CheckCircle2, XCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import type { Partner, PartnerTier } from '@/lib/partnerPortal';
import { PARTNER_STATUS_LABELS } from '@/lib/partnerPortal';

function SEO() {
  useSEO({
    title: 'Apply to the Vireek Partner Portal',
    description: 'Apply for a Vireek partner account to get a tracked referral link, sales resources and commission on every business you bring to Vireek.',
    canonical: 'https://vireek.com/partner-portal/apply',
  });
  return null;
}

export function PartnerApplyPage() {
  const { user, profile, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [checking, setChecking] = useState(true);
  const [existing, setExisting] = useState<Partner | null>(null);

  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [channel, setChannel] = useState('');
  const [tier, setTier] = useState<PartnerTier>('affiliate');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) {
      setChecking(false);
      return;
    }
    setCompanyName(profile?.company_name || '');
    setContactName(profile?.full_name || '');
    supabase
      .from('partners')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setExisting((data as Partner) || null);
        setChecking(false);
      });
  }, [user, profile]);

  if (authLoading || checking) return null;
  if (!user) return <Navigate to="/login" state={{ from: '/partner-portal/apply' }} replace />;

  if (existing) {
    if (existing.status === 'approved') return <Navigate to="/partner-portal" replace />;
    return (
      <>
        <SEO />
        <Header />
        <main className="flex min-h-screen items-center justify-center bg-bg-primary px-6 pt-24">
          <Card className="w-full max-w-md text-center">
            {existing.status === 'pending' && <Clock3 className="mx-auto h-10 w-10 text-accent" />}
            {existing.status === 'rejected' && <XCircle className="mx-auto h-10 w-10 text-danger" />}
            {existing.status === 'suspended' && <XCircle className="mx-auto h-10 w-10 text-danger" />}
            <h1 className="mt-4 text-xl font-bold text-text-primary">
              Application {PARTNER_STATUS_LABELS[existing.status]}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              {existing.status === 'pending' &&
                'Thanks for applying — our team reviews applications within a couple of business days. You can already start the certification course while you wait.'}
              {existing.status === 'rejected' &&
                "We're not able to approve this application right now. If you think that's a mistake, reach out to ali@vireek.com."}
              {existing.status === 'suspended' &&
                'This partner account is currently suspended. Reach out to ali@vireek.com for details.'}
            </p>
            <div className="mt-6 flex justify-center gap-3">
              {existing.status === 'pending' && (
                <Link to="/partner-portal/certification">
                  <Button variant="primary">Start certification</Button>
                </Link>
              )}
              <Link to="/">
                <Button variant="secondary">Back home</Button>
              </Link>
            </div>
          </Card>
        </main>
        <Footer />
      </>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!companyName.trim() || !contactName.trim()) {
      setError('Company name and your name are required.');
      return;
    }
    setSubmitting(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('apply_for_partner_program', {
        p_company_name: companyName.trim(),
        p_contact_name: contactName.trim(),
        p_contact_email: user.email,
        p_contact_phone: contactPhone.trim() || null,
        p_channel: channel.trim() || null,
        p_tier: tier,
      });
      if (rpcError) throw rpcError;
      setExisting(data as Partner);
      toast('Application submitted', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-20 pt-28">
        <div className="mx-auto max-w-xl">
          <div className="text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
              <Handshake size={22} />
            </span>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-text-primary sm:text-3xl">
              Apply for a Partner Account
            </h1>
            <p className="mt-2 text-sm text-text-secondary">
              Get a tracked referral link, sales resources and a certification badge. Takes about a minute.
            </p>
          </div>

          <Card className="mt-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setTier('affiliate')}
                  className={`focus-ring rounded-xl border p-3 text-left text-sm transition-colors ${
                    tier === 'affiliate' ? 'border-accent bg-accent/5 text-text-primary' : 'border-border text-text-secondary hover:border-accent/30'
                  }`}
                >
                  <span className="font-semibold">Affiliate</span>
                  <p className="mt-0.5 text-xs text-text-secondary">Creator, newsletter, or an existing customer sharing a link.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setTier('agency')}
                  className={`focus-ring rounded-xl border p-3 text-left text-sm transition-colors ${
                    tier === 'agency' ? 'border-accent bg-accent/5 text-text-primary' : 'border-border text-text-secondary hover:border-accent/30'
                  }`}
                >
                  <span className="font-semibold">Agency / Reseller</span>
                  <p className="mt-0.5 text-xs text-text-secondary">You manage or resell to multiple client businesses.</p>
                </button>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="companyName">
                  Company / brand name
                </label>
                <input
                  id="companyName"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                  required
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="contactName">
                  Your name
                </label>
                <input
                  id="contactName"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                  required
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="contactPhone">
                  Phone (optional)
                </label>
                <input
                  id="contactPhone"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="channel">
                  How will you refer people to Vireek?
                </label>
                <textarea
                  id="channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  rows={3}
                  placeholder="e.g. a trades YouTube channel, a client roster of 12 contractors, a newsletter for small business owners…"
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                />
              </div>

              {error && <p className="text-sm text-danger">{error}</p>}

              <Button type="submit" variant="primary" size="lg" disabled={submitting} className="w-full">
                {submitting ? 'Submitting…' : 'Submit application'}
                {!submitting && <ArrowRight size={18} />}
              </Button>
              <p className="flex items-center justify-center gap-1.5 text-xs text-text-secondary">
                <CheckCircle2 size={13} /> Free to join. Reviewed within a couple of business days.
              </p>
            </form>
          </Card>
        </div>
      </main>
      <Footer />
    </>
  );
}
