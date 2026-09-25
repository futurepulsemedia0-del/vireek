import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { Award, Printer } from 'lucide-react';
import { Header } from '@/components/Header';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';

function SEO() {
  useSEO({
    title: 'Your Vireek Partner Certificate',
    description: 'Certificate of completion for the Vireek Partner Certification course.',
    canonical: 'https://vireek.com/partner-portal/certificate',
  });
  return null;
}

export function PartnerCertificatePage() {
  const { user, loading: authLoading } = useAuth();
  const [companyName, setCompanyName] = useState('');
  const [checked, setChecked] = useState(false);
  const [passed, setPassed] = useState(false);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      supabase.from('partners').select('company_name, contact_name').eq('user_id', user.id).maybeSingle(),
      supabase.from('partner_certifications').select('user_id').eq('user_id', user.id).maybeSingle(),
    ]).then(([partnerRes, certRes]) => {
      setCompanyName(partnerRes.data?.company_name || partnerRes.data?.contact_name || '');
      setPassed(Boolean(certRes.data));
      setChecked(true);
    });
  }, [user]);

  if (authLoading || !checked) return null;
  if (!user) return <Navigate to="/login" state={{ from: '/partner-portal/certificate' }} replace />;
  if (!passed) return <Navigate to="/partner-portal/certification" replace />;

  return (
    <>
      <SEO />
      <Header />
      <main className="flex min-h-screen items-center justify-center bg-bg-primary px-6 pt-24">
        <div className="w-full max-w-2xl rounded-3xl border-4 border-double border-accent/40 bg-bg-secondary p-12 text-center shadow-card-hover print:shadow-none">
          <Award className="mx-auto mb-4 h-12 w-12 text-accent" />
          <p className="text-sm font-semibold uppercase tracking-widest text-text-secondary">Certificate of Completion</p>
          <h1 className="mt-4 text-3xl font-extrabold text-text-primary">Vireek Partner Certification</h1>
          <p className="mt-6 text-lg text-text-secondary">This certifies that</p>
          <p className="mt-2 text-2xl font-bold text-accent">{companyName || 'a Vireek Partner'}</p>
          <p className="mt-6 text-sm leading-relaxed text-text-secondary">
            has completed the Vireek Partner Certification course, covering the Vireek pitch, pricing and referral
            mechanics, and is certified to refer businesses to Vireek.
          </p>
          <p className="mt-8 text-xs text-text-secondary">
            Issued {new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>

          <div className="mt-8 flex justify-center gap-3 print:hidden">
            <button
              type="button"
              onClick={() => window.print()}
              className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
            >
              <Printer size={16} /> Print / save as PDF
            </button>
            <Link to="/partner-portal" className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary">
              Back to portal
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
