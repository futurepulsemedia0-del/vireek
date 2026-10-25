// /dashboard/pay — owner/admin hub for Vireek Pay & Capital.
import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { SkeletonCardList } from '@/components/Skeleton';
import { PayCapitalPanel } from '@/components/pay/PayCapitalPanel';
import { PayCardsPanel } from '@/components/pay/PayCardsPanel';
import { PayTransfersPanel } from '@/components/pay/PayTransfersPanel';
import { Pill, SandboxBanner, UnavailableNotice } from '@/components/pay/PayShared';
import { fetchAvailability } from '@/lib/payApi';
import { PRODUCT_LABEL, type PayProduct, type ProductAvailability } from '@/lib/pay';
import { useSEO } from '@/lib/seo';

const TABS: { id: 'payouts' | 'cards' | 'capital'; label: string; products: PayProduct[] }[] = [
  { id: 'payouts', label: 'Payouts', products: ['instant_payouts', 'earned_wage_access'] },
  { id: 'cards', label: 'Spend cards', products: ['spend_cards'] },
  { id: 'capital', label: 'Capital', products: ['capital'] },
];

export function PayCapitalPage() {
  useSEO({ title: 'Vireek Pay & Capital', description: 'Instant payouts, spend cards and working capital.' });
  const [avail, setAvail] = useState<ProductAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('payouts');

  useEffect(() => { fetchAvailability().then(setAvail).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load.')); }, []);

  const current = TABS.find((t) => t.id === tab)!;
  const states = (avail ?? []).filter((a) => current.products.includes(a.product));
  const usable = states.some((s) => s.available);
  const sandbox = states.some((s) => s.available && s.mode === 'sandbox');

  return (
    <div className="min-h-screen bg-bg-primary">
      <Header />
      <main className="mx-auto max-w-4xl space-y-4 px-4 py-8">
        <h1 className="text-2xl font-bold text-text-primary">Vireek Pay & Capital</h1>
        <div role="tablist" className="flex gap-2 overflow-x-auto">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={`focus-ring whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium ${tab === t.id ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary'}`}>{t.label}</button>
          ))}
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!avail && !error && <SkeletonCardList count={2} rows={3} />}
        {avail && (
          <>
            <SandboxBanner show={sandbox} />
            <div className="flex flex-wrap gap-2 text-xs">
              {states.map((s) => <span key={s.product} className="flex items-center gap-1 text-text-secondary">{PRODUCT_LABEL[s.product]} <Pill tone={s.available ? (s.mode === 'live' ? 'success' : 'warning') : 'neutral'}>{s.available ? s.mode : 'off'}</Pill></span>)}
            </div>
            {!usable ? <UnavailableNotice reason={states[0]?.reason} /> : (
              <>
                {tab === 'payouts' && <PayTransfersPanel />}
                {tab === 'cards' && <PayCardsPanel sandbox={sandbox} />}
                {tab === 'capital' && <PayCapitalPanel />}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
