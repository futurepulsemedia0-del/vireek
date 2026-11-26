// /data-promise — what a customer can take with them, in which formats, and what is not included.
// All availability statements come from src/lib/dataPromise.ts (backed by the real export lists and tested).
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { useSEO } from '@/lib/seo';
import { DATA_PROMISE_SLA, NOT_INCLUDED, SCHEMA_URL, categoryClaims } from '@/lib/dataPromise';

export function DataPromisePage() {
  useSEO({
    title: 'Data promise | Vireek',
    description: 'What you can export from Vireek, in which open formats, how it is checked, and what is not included.',
    canonical: 'https://vireek.com/data-promise',
  });
  const claims = categoryClaims();
  const available = claims.filter((c) => c.available);
  const later = claims.filter((c) => !c.available);
  const days = DATA_PROMISE_SLA.assistedExportDays;

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <div className="mx-auto max-w-3xl px-6 pb-16">
          <div className="py-8"><BackButton /></div>
          <h1 className="text-3xl font-bold text-text-primary">Data promise</h1>
          <p className="mt-3 text-text-secondary">
            Your business data belongs to you. Owners and admins can download it themselves, in open formats any tool can read, without asking us.
          </p>

          <section aria-labelledby="dp-what" className="mt-10">
            <h2 id="dp-what" className="text-xl font-semibold text-text-primary">What you get today</h2>
            {available.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">The self-serve export is being rolled out. Contact us to request your data.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {available.map((c) => (
                  <li key={c.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                    <p className="font-medium text-text-primary">{c.label}</p>
                    <p className="mt-1 text-sm text-text-secondary">{c.description}</p>
                  </li>
                ))}
              </ul>
            )}
            {later.length > 0 && (
              <>
                <h3 className="mt-6 text-base font-semibold text-text-primary">Not in the self-serve export yet</h3>
                <ul className="mt-2 list-disc ps-5 text-sm text-text-secondary">
                  {later.map((c) => <li key={c.id}>{c.label}</li>)}
                </ul>
              </>
            )}
            <p className="mt-4 text-sm text-text-secondary">
              This is not a promise that every record we hold about you is included. Some internal and analytics data has not been reviewed for export yet.
            </p>
          </section>

          <section aria-labelledby="dp-format" className="mt-10">
            <h2 id="dp-format" className="text-xl font-semibold text-text-primary">Formats</h2>
            <p className="mt-3 text-sm text-text-secondary">
              The export is an archive of newline-delimited JSON files (NDJSON, one record per line) plus a manifest that lists every file with its row count and SHA-256 checksum.
              Large accounts are exported in resumable parts. Each table’s columns are documented in the{' '}
              <a className="text-accent underline" href={SCHEMA_URL}>machine-readable schema</a>.
            </p>
          </section>

          <section aria-labelledby="dp-not" className="mt-10">
            <h2 id="dp-not" className="text-xl font-semibold text-text-primary">What is not included</h2>
            <ul className="mt-3 list-disc ps-5 text-sm text-text-secondary">{NOT_INCLUDED.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>

          <section aria-labelledby="dp-time" className="mt-10">
            <h2 id="dp-time" className="text-xl font-semibold text-text-primary">How long it takes</h2>
            <p className="mt-3 text-sm text-text-secondary">
              The self-serve export starts when you ask for it and runs in the browser, so the time depends on how much data your account holds.
              {days === null
                ? ' We have not yet published a delivery commitment for exports we prepare for you.'
                : ` If you ask us to prepare the export for you, we deliver it within ${days} calendar days.`}
            </p>
          </section>

          <section aria-labelledby="dp-how" className="mt-10">
            <h2 id="dp-how" className="text-xl font-semibold text-text-primary">How to export</h2>
            <p className="mt-3 text-sm text-text-secondary">
              Signed-in owners and admins can start the export from <Link className="text-accent underline" to="/dashboard/exports">Exports</Link> in the dashboard.
              To ask for a copy of your personal data as an individual, use the <Link className="text-accent underline" to="/data-request">data request form</Link>.
              Other questions: <Link className="text-accent underline" to="/contact">contact us</Link>.
            </p>
          </section>
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
