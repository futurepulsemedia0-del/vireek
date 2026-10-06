/**
 * Public verification of a sealed Home Service Passport — /verify/home/:token
 *
 * No login. Reads only the sealed snapshot through verify_home_passport().
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Printer, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { HomePassportView } from '@/components/passport/HomePassportView';
import {
  RECIPIENT_LABELS,
  fetchPublicHomePassport,
  formatPassportDate,
  type PublicHomePassportResult,
} from '@/lib/homeServicePassport';

const PROBLEM_COPY: Record<'expired' | 'revoked' | 'tampered' | 'not_found', { title: string; body: string }> = {
  expired: { title: 'This passport link has expired', body: 'Ask the seller or their service provider to issue a fresh link.' },
  revoked: { title: 'This passport was revoked', body: 'The issuer withdrew access. Do not rely on any copy you may have seen earlier.' },
  tampered: { title: 'Integrity check failed', body: 'This record does not match its cryptographic seal. Do not trust it.' },
  not_found: { title: 'Passport not found', body: 'The link is incorrect or was never issued by Vireek.' },
};

export function PublicHomePassportPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [result, setResult] = useState<PublicHomePassportResult | null>(null);
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
    fetchPublicHomePassport(token)
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

  const snap = result?.status === 'valid' ? (result.snapshot ?? null) : null;
  const problem = result && result.status !== 'valid' ? PROBLEM_COPY[result.status] : null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          {loading && <div className="h-64 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" />}

          {!loading && (failed || problem || (result?.status === 'valid' && !snap)) && (
            <Card className="text-center" role="alert">
              <AlertCircle className="mx-auto text-danger" size={32} aria-hidden="true" />
              <h1 className="mt-3 text-lg font-semibold text-text-primary">
                {failed ? 'Could not verify this passport' : (problem?.title ?? 'Passport unavailable')}
              </h1>
              <p className="mt-1.5 text-sm text-text-secondary">
                {failed ? 'Please check your connection and try again.' : (problem?.body ?? 'Please try again later.')}
              </p>
            </Card>
          )}

          {snap && result && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-success-500">
                  <ShieldCheck size={14} aria-hidden="true" /> Verified by Vireek
                  {result.recipient_type ? ` · Prepared for: ${RECIPIENT_LABELS[result.recipient_type]}` : ''}
                </p>
                <Button variant="secondary" size="sm" onClick={() => window.print()}>
                  <Printer size={15} aria-hidden="true" /> Print / save as PDF
                </Button>
              </div>

              <HomePassportView data={snap} />

              <div className="rounded-2xl border border-success-500/30 bg-success-500/5 p-5 text-xs text-text-secondary">
                <p className="font-medium text-success-500">Integrity verified</p>
                <p className="mt-1">
                  Issued {formatPassportDate(result.issued_at)} with the homeowner&apos;s consent · valid until{' '}
                  {formatPassportDate(result.expires_at)}. Records are derived from the service provider&apos;s job data and
                  sealed so they cannot be altered. Cost projections are estimates. This passport is not a home inspection,
                  appraisal or warranty.
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
