import { useEffect, useState } from 'react';
import { Check, X, Handshake } from 'lucide-react';
import { Header } from '@/components/Header';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import { PARTNER_STATUS_LABELS, type Partner } from '@/lib/partnerPortal';

function SEO() {
  useSEO({
    title: 'Partner Applications — Staff',
    description: 'Internal: review and approve Vireek partner applications.',
    canonical: 'https://vireek.com/staff/partners',
  });
  return null;
}

export function PartnerApplicationsAdminPage() {
  const { toast } = useToast();
  const [partners, setPartners] = useState<Partner[] | null>(null);

  const load = () => {
    supabase
      .from('partners')
      .select('*')
      .order('applied_at', { ascending: false })
      .then(({ data }) => setPartners((data as Partner[]) || []));
  };

  useEffect(load, []);

  const approve = async (id: string) => {
    const { error } = await supabase.rpc('approve_partner_application', { p_partner_id: id });
    if (error) toast(error.message, 'error');
    else {
      toast('Partner approved', 'success');
      load();
    }
  };

  const reject = async (id: string) => {
    const { error } = await supabase.rpc('reject_partner_application', { p_partner_id: id });
    if (error) toast(error.message, 'error');
    else {
      toast('Partner rejected', 'success');
      load();
    }
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-20 pt-28">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-2">
            <Handshake className="text-accent" size={22} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Partner Applications</h1>
          </div>

          {partners === null ? (
            <div className="mt-10 flex justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
            </div>
          ) : partners.length === 0 ? (
            <p className="mt-6 text-sm text-text-secondary">No applications yet.</p>
          ) : (
            <div className="mt-6 overflow-x-auto rounded-2xl border border-border">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-bg-tertiary/50 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th className="px-4 py-3">Company</th>
                    <th className="px-4 py-3">Contact</th>
                    <th className="px-4 py-3">Tier</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Applied</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {partners.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-3 text-text-primary">{p.company_name}</td>
                      <td className="px-4 py-3 text-text-secondary">
                        {p.contact_name}
                        <br />
                        <span className="text-xs">{p.contact_email}</span>
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{p.tier}</td>
                      <td className="px-4 py-3 text-text-secondary">{PARTNER_STATUS_LABELS[p.status]}</td>
                      <td className="px-4 py-3 text-text-secondary">{new Date(p.applied_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        {p.status === 'pending' && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => approve(p.id)}
                              className="focus-ring flex items-center gap-1 rounded-lg border border-success/30 bg-success/10 px-2.5 py-1.5 text-xs font-semibold text-success"
                            >
                              <Check size={13} /> Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => reject(p.id)}
                              className="focus-ring flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs font-semibold text-danger"
                            >
                              <X size={13} /> Reject
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
