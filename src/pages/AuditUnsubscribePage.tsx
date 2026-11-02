import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { auditCall } from '@/lib/audit/api';
import { useSEO } from '@/lib/seo';

export function AuditUnsubscribePage() {
  const { ut = '' } = useParams();
  useSEO({ title: 'Unsubscribe | Vireek', description: 'Unsubscribe from Missed-Call Audit emails.', canonical: 'https://vireek.com/audit', robots: 'noindex, nofollow' });
  const [state, setState] = useState<'working' | 'done' | 'bad'>('working');
  useEffect(() => { auditCall('unsubscribe', { t: ut }).then(() => setState('done')).catch(() => setState('bad')); }, [ut]);
  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pt-32 text-center" aria-live="polite">
        <h1 className="text-3xl font-bold text-text-primary">{state === 'done' ? "You're unsubscribed" : state === 'bad' ? "This link isn't valid" : 'Unsubscribing…'}</h1>
        <p className="mt-4 text-text-secondary">{state === 'done' ? "We won't send you any more audit follow-ups. You can still open your report from your original email." : state === 'bad' ? 'The link may be incomplete. Use the unsubscribe link from the latest email.' : 'One moment.'}</p>
        <div className="mt-6"><Link to="/" className="text-accent underline">Back to Vireek</Link></div>
      </main>
      <Footer />
    </>
  );
}
