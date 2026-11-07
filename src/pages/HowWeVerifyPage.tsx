import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useSEO } from '@/lib/seo';
import { supabase } from '@/lib/supabase';

interface Published { version: string; definition: Record<string, unknown> }
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function HowWeVerifyPage() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Published | null>(null);
  useSEO({
    title: 'How we verify a booked job | Vireek',
    description: 'The exact rules Vireek uses to decide whether a booked job is billable on the Results Plan, what evidence you can see, and how to dispute a charge.',
    canonical: 'https://vireek.com/how-we-verify',
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await supabase.from('results_plan_rule_versions').select('version,definition').not('published_at', 'is', null).order('published_at', { ascending: false }).limit(1).maybeSingle();
      if (alive) setRules((data as Published | null) ?? null);
    })();
    return () => { alive = false; };
  }, []);

  const d = rules?.definition ?? {};
  const days = num(d.existing_work_window_days, 0);
  const hours = num(d.cancel_window_hours, 0);
  const dup = num(d.duplicate_window_hours, 0);
  const faqs: Array<[string, string]> = [
    [t('verify.faq1.q', 'Do I pay for a job I already had?'), t('verify.faq1.a', 'No. If the same customer or address already has an open job within the existing-work window, the new booking is not billed.')],
    [t('verify.faq2.q', 'What if the customer cancels?'), t('verify.faq2.a', 'A cancellation before the billing stage is never billed. A cancellation shortly after it voids the charge automatically.')],
    [t('verify.faq3.q', 'What if I disagree with a charge?'), t('verify.faq3.a', 'Open a dispute from the job within 14 days. If the evidence cannot support the charge it is credited automatically; otherwise a person reviews it.')],
    [t('verify.faq4.q', 'Can the ledger be edited?'), t('verify.faq4.a', 'No. Each entry is chained to the previous one with a cryptographic hash, and you can run an integrity check yourself from the Results Plan page.')],
  ];
  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-20 pt-32">
        <article className="mx-auto max-w-3xl space-y-8 text-text-primary">
          <header className="space-y-3">
            <h1 className="text-4xl font-extrabold tracking-tight">{t('verify.title', 'How we verify a booked job')}</h1>
            <p className="text-lg text-text-secondary">{t('verify.lead', 'On the Results Plan you pay only for jobs that pass these rules. The rules are versioned and published.')}</p>
            <p className="text-sm text-text-secondary">{rules ? t('verify.version', 'Current rules version: {{v}}', { v: rules.version }) : t('verify.draft', 'The rules below are a draft and become binding when the Results Plan launches.')}</p>
          </header>
          <section aria-labelledby="v-rules" className="space-y-3">
            <h2 id="v-rules" className="text-2xl font-bold">{t('verify.rules', 'A job is billable only if…')}</h2>
            <ol className="list-decimal space-y-2 ps-6 text-text-secondary">
              <li>{t('verify.r1', 'Sarah handled the first meaningful contact (call, text or chat).')}</li>
              <li>{days > 0 ? t('verify.r2', 'The customer or address has no open job within the last {{n}} days — we never bill for existing work.', { n: days }) : t('verify.r2b', 'The customer or address has no open job within the existing-work window — we never bill for existing work.')}</li>
              <li>{t('verify.r3', 'It is not spam, a wrong number, a duplicate, a rework or callback visit for earlier work, an internal test, or a job you created yourself.')}{dup > 0 ? ` ${t('verify.r3b', 'Repeat bookings within {{n}} hours count as duplicates.', { n: dup })}` : ''}</li>
              <li>{t('verify.r4', 'It reaches the verification stage on your plan: Booked → Confirmed (customer confirmation, technician en route or arrived, or job started) → Completed (closed in Vireek or your CRM) → Paid (optional).')}</li>
              <li>{hours > 0 ? t('verify.r5', 'It is not cancelled within {{n}} hours after that stage; if it is, the charge is voided automatically.', { n: hours }) : t('verify.r5b', 'It is not cancelled inside the cancellation window; if it is, the charge is voided automatically.')}</li>
            </ol>
          </section>
          <section aria-labelledby="v-proof" className="space-y-3">
            <h2 id="v-proof" className="text-2xl font-bold">{t('verify.proof', 'The evidence behind every charge')}</h2>
            <p className="text-text-secondary">{t('verify.proofBody', 'Each charge opens into a chain: when the customer contacted you, an excerpt of the conversation and the recording link where recording is permitted, the booking, the confirmation and completion events, the invoice status and the exact rule that qualified it.')}</p>
          </section>
          <section aria-labelledby="v-edge" className="space-y-3">
            <h2 id="v-edge" className="text-2xl font-bold">{t('verify.edge', 'Honest edge cases')}</h2>
            <ul className="list-disc space-y-2 ps-6 text-text-secondary">
              <li>{t('verify.e1', 'If your system never records completion, we cannot verify the job at the Completed stage. We watch for sudden drops in completion marking and will contact you rather than guess.')}</li>
              <li>{t('verify.e2', 'Jobs reaching you only by text or chat are verified once those channels are connected to the ledger; today voice calls are the supported first contact.')}</li>
              <li>{t('verify.e3', 'If the evidence is incomplete, the benefit of the doubt goes to you.')}</li>
              <li>{t('verify.e5', 'If a plan bills at completion but no completion is ever recorded, a confirmed job that is never cancelled may be billed at the Confirmed stage after a published waiting period (when enabled for your plan). Every such charge is labelled and can be disputed.')}</li>
              <li>{t('verify.e6', 'A job that fails a rule such as duplicate or existing work stays rejected, even if the earlier job is closed later.')}</li>
              <li>{t('verify.e4', 'Spam or wrong-number labels you add are reviewed by our team; they do not change billing on their own.')}</li>
            </ul>
          </section>
          <section aria-labelledby="v-faq" className="space-y-3">
            <h2 id="v-faq" className="text-2xl font-bold">{t('verify.faq', 'FAQ')}</h2>
            {faqs.map(([q, a]) => (<div key={q}><h3 className="font-semibold">{q}</h3><p className="text-text-secondary">{a}</p></div>))}
          </section>
          <p><Link className="text-accent underline" to="/pricing">{t('verify.back', 'Back to pricing')}</Link></p>
        </article>
      </main>
      <Footer />
    </>
  );
}
