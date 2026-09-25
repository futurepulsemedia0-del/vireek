import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { PartnerPortalLayout } from '@/components/partner-portal/PartnerPortalLayout';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import {
  formatCents,
  REFERRAL_STATUS_LABELS,
  REFERRAL_STATUS_CLASSES,
  COMMISSION_STATUS_LABELS,
  type PartnerReferral,
} from '@/lib/partnerPortal';

function SEO() {
  useSEO({
    title: 'Referral Tracking — Vireek Partner Portal',
    description: 'Every referral credited to your Vireek partner link, its conversion status, and commission owed.',
    canonical: 'https://vireek.com/partner-portal/referrals',
  });
  return null;
}

export function PartnerPortalReferralsPage() {
  const { user } = useAuth();
  const [referrals, setReferrals] = useState<PartnerReferral[] | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: partner } = await supabase.from('partners').select('id').eq('user_id', user.id).maybeSingle();
      if (!partner) {
        setReferrals([]);
        return;
      }
      const { data } = await supabase
        .from('partner_referrals')
        .select('*')
        .eq('partner_id', partner.id)
        .order('created_at', { ascending: false });
      setReferrals((data as PartnerReferral[]) || []);
    })();
  }, [user]);

  return (
    <PartnerPortalLayout>
      <SEO />
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">Referral Tracking</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Everyone who signed up through your link. Status and commission update automatically — nothing to self-report.
      </p>

      <Card className="mt-6 overflow-hidden !p-0">
        {referrals === null ? (
          <div className="flex justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
          </div>
        ) : referrals.length === 0 ? (
          <div className="p-8">
            <EmptyState
              icon={Users}
              title="No referrals yet"
              description="Once someone signs up through your referral link, they'll show up here automatically."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-bg-tertiary/50 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-5 py-3">Referred</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">MRR</th>
                  <th className="px-5 py-3">Commission</th>
                  <th className="px-5 py-3">Payout</th>
                  <th className="px-5 py-3">Since</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {referrals.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-3 text-text-primary">{r.referred_email || 'Vireek customer'}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${REFERRAL_STATUS_CLASSES[r.status]}`}>
                        {REFERRAL_STATUS_LABELS[r.status]}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{r.mrr_cents ? formatCents(r.mrr_cents) : '—'}</td>
                    <td className="px-5 py-3 text-text-secondary">{r.commission_cents ? formatCents(r.commission_cents) : '—'}</td>
                    <td className="px-5 py-3 text-text-secondary">{COMMISSION_STATUS_LABELS[r.commission_status]}</td>
                    <td className="px-5 py-3 text-text-secondary">{new Date(r.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </PartnerPortalLayout>
  );
}
