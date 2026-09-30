/**
 * Public verification of a portable Technician Passport — /verify/technician/:token
 *
 * No login. Reads only the sealed snapshot through verify_technician_passport().
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Fingerprint, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import {
  CertificationList,
  ConfidenceList,
  IndexRing,
  InsuranceList,
  MetricTile,
  TierBadge,
} from '@/components/passport/PassportParts';
import { formatRate, rateColor } from '@/lib/trustPassport';
import { fetchPublicPassport, formatDate, type PublicPassportResult } from '@/lib/technicianIdentity';

const PROBLEM_COPY: Record<'expired' | 'revoked' | 'tampered' | 'not_found', { title: string; body: string }> = {
  expired: { title: 'This passport link has expired', body: 'Ask the technician to issue a fresh link.' },
  revoked: { title: 'This passport was revoked', body: 'The issuer withdrew access. Do not rely on any copy you may have seen earlier.' },
  tampered: { title: 'Integrity check failed', body: 'This record does not match its cryptographic seal. Do not trust it.' },
  not_found: { title: 'Passport not found', body: 'The link is incorrect or was never issued by Vireek.' },
};

export function PublicTechnicianPassportPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [result, setResult] = useState<PublicPassportResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetchPublicPassport(token)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const snap = result?.status === 'valid' ? result.snapshot ?? null : null;
  const problem = result && result.status !== 'valid' ? PROBLEM_COPY[result.status] : null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {loading && <div className="h-64 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" />}

          {!loading && (failed || problem || (result?.status === 'valid' && !snap)) && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark" role="alert">
              <AlertCircle className="mx-auto text-danger" size={32} />
              <h1 className="mt-3 text-lg font-semibold text-text-primary">
                {failed ? 'Could not verify this passport' : problem?.title ?? 'Passport unavailable'}
              </h1>
              <p className="mt-1.5 text-sm text-text-secondary">
                {failed ? 'Please check your connection and try again.' : problem?.body ?? 'Please try again later.'}
              </p>
            </div>
          )}

          {snap && result && (
            <>
              <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
                  <IndexRing score={snap.index} tier={snap.tier} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-success-500">
                      <ShieldCheck size={14} /> Verified by Vireek
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <h1 className="text-2xl font-bold text-text-primary">{snap.display_name}</h1>
                      <TierBadge tier={snap.tier} />
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">
                      {snap.issuer_company ? `Employer of record: ${snap.issuer_company} · ` : ''}
                      {snap.metrics.lifetime_jobs} jobs completed
                    </p>
                    <p className="mt-2 text-xs text-text-secondary">
                      Every figure is computed from real job outcomes — none is self-reported. Window: last {snap.window_days} days.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Fingerprint size={16} className="text-accent" /> Verified performance
                </h2>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <MetricTile label="First-time fix" value={formatRate(snap.metrics.first_time_fix_rate)} valueClass={rateColor(snap.metrics.first_time_fix_rate, 90)} />
                  <MetricTile
                    label="Customer satisfaction"
                    value={snap.metrics.customer_rating_avg === null ? '—' : `${snap.metrics.customer_rating_avg.toFixed(1)}/5`}
                    hint={`${snap.metrics.rated_jobs} rated jobs`}
                  />
                  <MetricTile label="Diagnosis accuracy" value={formatRate(snap.metrics.diagnosis_accuracy)} valueClass={rateColor(snap.metrics.diagnosis_accuracy, 90)} />
                  <MetricTile label="Response reliability" value={formatRate(snap.metrics.response_reliability)} valueClass={rateColor(snap.metrics.response_reliability, 90)} />
                  <MetricTile label="Safety record" value={formatRate(snap.metrics.safety_compliance_rate)} valueClass={rateColor(snap.metrics.safety_compliance_rate, 95)} />
                  <MetricTile label="Verified jobs" value={String(snap.metrics.lifetime_verified_jobs)} hint="Photo/evidence verified" />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                  <h2 className="mb-4 text-sm font-semibold text-text-primary">Skill confidence</h2>
                  <ConfidenceList items={snap.skills} emptyText="Not enough completed jobs yet." />
                </div>
                <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                  <h2 className="mb-4 text-sm font-semibold text-text-primary">Equipment expertise</h2>
                  <ConfidenceList items={snap.equipment_expertise} emptyText="No equipment history yet." />
                </div>
                <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                  <h2 className="mb-4 text-sm font-semibold text-text-primary">Certifications</h2>
                  <CertificationList items={snap.certifications} />
                </div>
                <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                  <h2 className="mb-4 text-sm font-semibold text-text-primary">Insurance</h2>
                  <InsuranceList items={snap.insurance} />
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary shadow-card dark:shadow-card-dark">
                <p>
                  <span className="font-medium text-text-primary">Languages:</span> {snap.languages.length ? snap.languages.join(', ') : '—'}
                </p>
                <p className="mt-1">
                  <span className="font-medium text-text-primary">Regions:</span> {snap.regions.length ? snap.regions.join(', ') : '—'}
                </p>
                <p className="mt-1">
                  <span className="font-medium text-text-primary">Training (not real jobs):</span> {snap.training.lessons_completed} lessons ·
                  simulator {snap.training.simulator_passed}/{snap.training.simulator_attempts} passed
                </p>
              </div>

              <div className="rounded-2xl border border-success-500/30 bg-success-500/5 p-5 text-xs text-text-secondary">
                <p className="font-medium text-success-500">Integrity verified</p>
                <p className="mt-1">
                  Issued {formatDate(result.issued_at)} by the {result.issued_by_role === 'technician' ? 'technician' : 'employer'} · valid until{' '}
                  {formatDate(result.expires_at)}. This snapshot is sealed and cannot be altered.
                </p>
                <p className="mt-1.5 break-all font-mono text-[10px]">SHA-256 {result.snapshot_hash}</p>
              </div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
