import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { GraduationCap, Printer } from 'lucide-react';
import { Header } from '@/components/Header';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import { getAllLessonIds } from '@/lib/academy';

function SEO() {
  useSEO({
    title: 'Your Vireek Academy Certificate',
    description: 'Certificate of completion for the Vireek Academy self-service onboarding course.',
    canonical: 'https://vireek.com/academy/certificate',
  });
  return null;
}

const TOTAL_LESSONS = getAllLessonIds().length;

export function AcademyCertificatePage() {
  const { user, loading: authLoading } = useAuth();
  const [companyName, setCompanyName] = useState('');
  const [completedCount, setCompletedCount] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      supabase.from('profiles').select('company_name, full_name').eq('id', user.id).maybeSingle(),
      supabase.from('academy_progress').select('lesson_id', { count: 'exact', head: true }).eq('user_id', user.id),
    ]).then(([profileRes, countRes]) => {
      setCompanyName(profileRes.data?.company_name || profileRes.data?.full_name || '');
      setCompletedCount(countRes.count ?? 0);
    });
  }, [user]);

  if (authLoading) return null;
  if (!user) return <Navigate to="/login" state={{ from: '/academy/certificate' }} replace />;
  if (completedCount !== null && completedCount < TOTAL_LESSONS) return <Navigate to="/academy" replace />;

  return (
    <>
      <SEO />
      <Header />
      <main className="flex min-h-screen items-center justify-center bg-bg-primary px-6 pt-24">
        <div className="w-full max-w-2xl rounded-3xl border-4 border-double border-accent/40 bg-bg-secondary p-12 text-center shadow-card-hover print:shadow-none">
          <GraduationCap className="mx-auto mb-4 h-12 w-12 text-accent" />
          <p className="text-sm font-semibold uppercase tracking-widest text-text-secondary">Certificate of Completion</p>
          <h1 className="mt-4 text-3xl font-extrabold text-text-primary">Vireek Academy</h1>
          <p className="mt-6 text-lg text-text-secondary">This certifies that</p>
          <p className="mt-2 text-2xl font-bold text-accent">{companyName || 'a Vireek customer'}</p>
          <p className="mt-6 text-sm leading-relaxed text-text-secondary">
            has completed all {TOTAL_LESSONS} lessons of the Vireek self-service onboarding course, covering account
            setup, call handling, dispatch, and day-to-day use of the platform.
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
            <Link to="/dashboard" className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary">
              Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
