// /transparency — published transparency reports and the public AI incident log.
// Everything shown here comes from two public RPCs that return PUBLISHED rows only
// (get_public_transparency_reports, get_public_ai_incident_log). Nothing is computed in the browser.
import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { EmptyState } from '@/components/EmptyState';
import { useSEO } from '@/lib/seo';
import { fetchPublicIncidentLog, fetchPublicReports } from '@/lib/transparencyApi';
import {
  SECTIONS, dimensionRows, findMetric, formatCount, formatMinutes, labelFor,
  type MetricRow, type PublicIncident, type PublicReport, type Section,
} from '@/lib/transparencyReport';

const SECTION_TITLE: Record<Section, string> = {
  ai_incidents: 'AI incidents',
  takedowns: 'Copyright takedown notices',
  legal_requests: 'Legal requests for customer data',
  data_requests: 'Data requests from individuals',
  outages: 'Service outages',
};

type Load<T> = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; data: T };

const fmtDate = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="text-sm font-semibold text-text-primary tabular-nums">{value}</dd>
    </div>
  );
}

function SectionBlock({ section, report }: { section: Section; report: PublicReport }) {
  const rows = report.metrics.filter((m) => m.section === section);
  if (rows.length === 0) return null;
  const k = report.suppressBelow;
  const total = (metric: string) => formatCount(findMetric(report.metrics, section, metric), k);
  const split = (metric: string, dimension: string, hideEmpty = false) =>
    dimensionRows(report.metrics, section, metric, dimension)
      .filter((r: MetricRow) => !hideEmpty || r.count !== 0)
      .map((r) => <Row key={`${metric}-${dimension}-${r.key}`} label={labelFor(r.key)} value={formatCount(r, k)} />);

  return (
    <section aria-labelledby={`tr-${report.periodLabel}-${section}`} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <h4 id={`tr-${report.periodLabel}-${section}`} className="text-base font-semibold text-text-primary">{SECTION_TITLE[section]}</h4>
      <dl className="mt-3">
        {section === 'ai_incidents' && (<>
          <Row label="Incidents recorded" value={total('received')} />
          {split('received', 'incident_type')}
          <Row label="Customers notified" value={total('customer_notified')} />
          <Row label="Regulators notified" value={total('regulator_notified')} />
        </>)}
        {section === 'takedowns' && (<>
          <Row label="Notices received" value={total('received')} />
          {split('received', 'notice_type')}
        </>)}
        {section === 'legal_requests' && (<>
          <Row label="Requests received" value={total('received')} />
          {split('received', 'request_type')}
          <Row label="Requests where data was disclosed" value={total('disclosed')} />
          <Row label="Customer accounts affected" value={total('accounts_affected')} />
          <Row label="With a nondisclosure order" value={total('nondisclosure_orders')} />
        </>)}
        {section === 'data_requests' && (<>
          <Row label="Verified requests received" value={total('received')} />
          {split('received', 'request_kind')}
          <Row label="Completed within the deadline" value={total('completed_on_time')} />
          <Row label="Completed after the deadline" value={total('completed_late')} />
        </>)}
        {section === 'outages' && (<>
          <Row label="Incidents on the status page" value={total('incidents')} />
          {split('incidents', 'impact')}
          <Row label="Still open at the end of the period" value={total('open_at_period_end')} />
          {dimensionRows(report.metrics, 'outages', 'resolved_minutes', 'impact').map((r) => (
            <Row key={r.key} label={`${labelFor(r.key)}: time to resolve (total)`} value={r.count === null ? formatCount(r, k) : formatMinutes(r.count)} />
          ))}
        </>)}
      </dl>
    </section>
  );
}

function ReportView({ report, open }: { report: PublicReport; open: boolean }) {
  return (
    <details open={open} className="rounded-2xl border border-border bg-bg-primary p-4 sm:p-6">
      <summary className="cursor-pointer text-lg font-semibold text-text-primary">Report {report.periodLabel}</summary>
      <p className="mt-2 text-sm text-text-secondary">
        Covers {fmtDate(report.periodStart)} to {fmtDate(report.periodEnd)} (UTC). Published {fmtDate(report.publishedAt)}.
        {report.counselApprovedOn ? ` Reviewed by counsel on ${fmtDate(report.counselApprovedOn)}.` : ''}
      </p>
      <p className="mt-4 whitespace-pre-line text-sm text-text-primary">{report.introText}</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">{SECTIONS.map((s) => <SectionBlock key={s} section={s} report={report} />)}</div>
      <h4 className="mt-6 text-sm font-semibold text-text-primary">How these figures are reported</h4>
      <p className="mt-1 whitespace-pre-line text-sm text-text-secondary">{report.reportingRulesText}</p>
      {report.correctionsText && (
        <p className="mt-4 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary"><strong>Correction: </strong>{report.correctionsText}</p>
      )}
    </details>
  );
}

function IncidentView({ i }: { i: PublicIncident }) {
  return (
    <li className="rounded-2xl border border-border bg-bg-primary p-4 sm:p-5">
      <p className="text-xs text-text-secondary">{i.publicRef} · {fmtDate(i.occurredOn)} · {labelFor(i.incidentType)} · Severity: {labelFor(i.severity)}</p>
      <h3 className="mt-1 text-base font-semibold text-text-primary">{i.title}</h3>
      <dl className="mt-3 space-y-2 text-sm">
        <div><dt className="font-medium text-text-primary">What happened</dt><dd className="text-text-secondary">{i.whatHappened}</dd></div>
        <div><dt className="font-medium text-text-primary">Impact</dt><dd className="text-text-secondary">{i.impact}</dd></div>
        <div><dt className="font-medium text-text-primary">What we did</dt><dd className="text-text-secondary">{i.whatWeDid}</dd></div>
      </dl>
      {i.correctionNote && <p className="mt-3 text-sm text-text-primary"><strong>Correction: </strong>{i.correctionNote}</p>}
    </li>
  );
}

export function TransparencyPage() {
  useSEO({
    title: 'Transparency | Vireek',
    description: 'Vireek’s published transparency reports and public log of AI incidents.',
    canonical: 'https://vireek.com/transparency',
  });
  const [reports, setReports] = useState<Load<PublicReport[]>>({ phase: 'loading' });
  const [log, setLog] = useState<Load<PublicIncident[]>>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    fetchPublicReports().then((data) => alive && setReports({ phase: 'ready', data })).catch(() => alive && setReports({ phase: 'error' }));
    fetchPublicIncidentLog().then((data) => alive && setLog({ phase: 'ready', data })).catch(() => alive && setLog({ phase: 'error' }));
    return () => { alive = false; };
  }, []);

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <div className="mx-auto max-w-5xl px-6 pb-16">
          <div className="py-8"><BackButton /></div>
          <h1 className="text-3xl font-bold text-text-primary">Transparency</h1>
          <p className="mt-3 max-w-3xl text-text-secondary">
            Twice a year we publish how many legal requests, takedown notices, data requests, AI incidents and outages we handled, counted from our own records.
            We also publish a log of incidents where our AI behaved in a way it should not have.
          </p>

          <section aria-labelledby="tr-reports" className="mt-10">
            <h2 id="tr-reports" className="text-xl font-semibold text-text-primary">Transparency reports</h2>
            <div className="mt-4 space-y-4" aria-live="polite">
              {reports.phase === 'loading' && <p className="text-sm text-text-secondary">Loading…</p>}
              {reports.phase === 'error' && <p role="alert" className="text-sm text-danger">The reports could not be loaded. Please try again later.</p>}
              {reports.phase === 'ready' && reports.data.length === 0 && <EmptyState compact title="No transparency report has been published yet." />}
              {reports.phase === 'ready' && reports.data.map((r, idx) => <ReportView key={r.periodLabel} report={r} open={idx === 0} />)}
            </div>
          </section>

          <section aria-labelledby="tr-log" className="mt-12">
            <h2 id="tr-log" className="text-xl font-semibold text-text-primary">AI incident log</h2>
            <p className="mt-2 max-w-3xl text-sm text-text-secondary">
              Entries are written for publication, checked for personal data and approved before they appear. They describe what happened, not who was involved.
              The log may contain fewer incidents than the counts in the reports above.
            </p>
            <div className="mt-4" aria-live="polite">
              {log.phase === 'loading' && <p className="text-sm text-text-secondary">Loading…</p>}
              {log.phase === 'error' && <p role="alert" className="text-sm text-danger">The incident log could not be loaded. Please try again later.</p>}
              {log.phase === 'ready' && log.data.length === 0 && <EmptyState compact title="No incidents have been published." />}
              {log.phase === 'ready' && log.data.length > 0 && <ul className="space-y-4">{log.data.map((i) => <IncidentView key={i.publicRef} i={i} />)}</ul>}
            </div>
          </section>
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
