/**
 * Public QR landing for a property's Home Passport — /h/:code (no login).
 * Shows identity-level trust signals only (city/region, status, counts, chain integrity). No history, no address.
 * Uses verify_home_passport_code(); the previous route wrongly reused the sealed-link page with an empty token.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/Card';
import { verifyCode } from '@/lib/homePassportPilot';

interface PublicCodeView {
  found: boolean;
  rate_limited?: boolean;
  passport?: { code: string; status: string; property_type: string; city?: string | null; region?: string | null; year_built?: number | null };
  stats?: { event_count?: number; service_count?: number; evidence_backed_count?: number; equipment_count?: number; last_service_at?: string | null };
  integrity?: { valid?: boolean; checked?: number };
}

export function PublicHomePassportCodePage() {
  const { code = '' } = useParams<{ code: string }>();
  const [data, setData] = useState<PublicCodeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    verifyCode(code)
      .then((r) => { if (!cancelled) setData(r as unknown as PublicCodeView); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [code]);

  const p = data?.found ? data.passport : undefined;
  const s = data?.stats;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-xl space-y-4">
          {loading && <div className="h-48 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" aria-label="Loading" />}

          {!loading && (failed || !data?.found) && (
            <Card className="text-center" role="alert">
              <AlertCircle className="mx-auto text-danger" size={32} aria-hidden="true" />
              <h1 className="mt-3 text-lg font-semibold text-text-primary">
                {failed ? 'Could not check this passport' : data?.rate_limited ? 'Too many requests' : 'Passport not found'}
              </h1>
              <p className="mt-1.5 text-sm text-text-secondary">
                {failed ? 'Please check your connection and try again.' : data?.rate_limited ? 'Please wait a few minutes and try again.' : 'The code is incorrect or was never issued by Vireek.'}
              </p>
            </Card>
          )}

          {p && (
            <Card className="p-6">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-success-500">
                <ShieldCheck size={14} aria-hidden="true" /> Home Passport registered
              </p>
              <h1 className="mt-2 text-xl font-bold text-text-primary">{[p.city, p.region].filter(Boolean).join(', ') || 'Property'}</h1>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-text-secondary">Status</dt><dd className="font-medium text-text-primary">{p.status}</dd></div>
                <div><dt className="text-text-secondary">Type</dt><dd className="font-medium text-text-primary">{p.property_type.replace('_', ' ')}</dd></div>
                <div><dt className="text-text-secondary">Records</dt><dd className="font-medium text-text-primary">{s?.event_count ?? 0}</dd></div>
                <div><dt className="text-text-secondary">Equipment</dt><dd className="font-medium text-text-primary">{s?.equipment_count ?? 0}</dd></div>
                <div><dt className="text-text-secondary">Evidence-backed</dt><dd className="font-medium text-text-primary">{s?.evidence_backed_count ?? 0}</dd></div>
                <div><dt className="text-text-secondary">History integrity</dt><dd className="font-medium text-text-primary">{data?.integrity?.valid ? 'Verified' : 'Not verified'}</dd></div>
              </dl>
              <p className="mt-4 text-xs text-text-secondary">
                The full history is shared only by the property owner through a time-limited link. This page shows no address and no history.
              </p>
            </Card>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
