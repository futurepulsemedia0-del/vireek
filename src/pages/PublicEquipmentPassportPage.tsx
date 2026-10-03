/**
 * Public Equipment Passport — /e/:code  (the URL inside every QR / NFC tag)
 *
 * No login. Reads only the sanitised view through verify_equipment_passport():
 * public events only, serial masked, no customer data, no prices.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, Wrench } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useAuth } from '@/contexts/AuthContext';
import { EquipmentPassportView } from '@/components/passport/EquipmentPassportView';
import { fetchPublicPassport, isValidPassportCode, normalizePassportCode, type PassportData } from '@/lib/equipmentPassport';

export function PublicEquipmentPassportPage() {
  const { code = '' } = useParams<{ code: string }>();
  const { user } = useAuth();
  const normalized = normalizePassportCode(code);
  const [data, setData] = useState<PassportData | null>(null);
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
    setFailed(false);
    if (!isValidPassportCode(normalized)) {
      setData({ found: false });
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchPublicPassport(normalized)
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [normalized]);

  const notFound = !loading && !failed && data && !data.found;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-10">
        <div className="mx-auto w-full max-w-3xl space-y-5">
          {loading && <div className="h-72 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" />}

          {!loading && (failed || notFound) && (
            <div role="alert" className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle className="mx-auto text-danger" size={32} aria-hidden="true" />
              <h1 className="mt-3 text-lg font-semibold text-text-primary">
                {failed ? 'Could not load this passport' : 'Passport not found'}
              </h1>
              <p className="mt-1 text-sm text-text-secondary">
                {failed ? 'Check your connection and try again.' : 'The code is incorrect or was never issued by Vireek.'}
              </p>
            </div>
          )}

          {!loading && data?.found && (
            <>
              <EquipmentPassportView data={data} />

              <aside className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Wrench size={16} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-text-primary">Servicing this machine?</h2>
                    <p className="mt-0.5 text-sm text-text-secondary">
                      Open the passport in Vireek to see the full history, add your visit to it, and keep it with the machine for good — even if the owner changes company.
                    </p>
                    <Link
                      to={`/dashboard/equipment-passports/${normalized}`}
                      className="focus-ring mt-3 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
                    >
                      {user ? 'Open in my dashboard' : 'Sign in to Vireek'}
                    </Link>
                  </div>
                </div>
              </aside>

              <p className="text-center text-[11px] text-text-secondary">
                Personal details, addresses and prices are never shown on a public passport.
              </p>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
