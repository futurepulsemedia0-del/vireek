// Recreated: verify against original intent
// /dashboard/promo-codes
// TODO(vireek): backend missing. The promo-code tables / RPCs this page managed (create, pause, usage limits,
// redemption history) do not exist in this repository, so the page cannot list or create codes. It says so plainly
// instead of showing an editor that would pretend to save. Restore the backend, then rebuild the management UI.

import { Link } from 'react-router-dom';
import { TicketPercent } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { promoReasonMessage } from '@/lib/promoCodes';

export function PromoCodesPage() {
  return (
    <DashboardLayout activeLabel="Promo Codes">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><TicketPercent size={22} aria-hidden="true" /> Promo codes</h1>
        <p className="mt-1 text-sm text-text-secondary">Discount codes for quotes, invoices and online booking.</p>
      </div>
      <section className="rounded-2xl border border-border bg-bg-secondary p-6" aria-labelledby="pc-status">
        <h2 id="pc-status" className="text-base font-semibold text-text-primary">Not available in this deployment</h2>
        <p className="mt-2 text-sm text-text-secondary">Creating and managing promo codes needs a service that is not set up here, so no codes can be created or applied. Existing quotes and invoices keep any discount they already carry.</p>
        <p className="mt-3 text-xs text-text-secondary">What customers see when they try a code: “{promoReasonMessage('unavailable')}”</p>
        <p className="mt-4 text-sm"><Link to="/dashboard/quotes" className="focus-ring font-semibold text-accent underline">Back to quotes</Link></p>
      </section>
    </DashboardLayout>
  );
}
