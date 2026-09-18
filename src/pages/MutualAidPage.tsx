import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { LifeBuoy, Send, HandHeart, Check, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, MutualAidRequest, MutualAidOffer, BusinessProfile } from '@/lib/supabase';
import { INDUSTRIES } from '@/lib/industries';
import { NEED_TYPE_LABELS, OFFER_STATUS_LABELS, OFFER_STATUS_COLORS, timeLeft } from '@/lib/mutualAid';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary transition-colors';

type NetworkRequest = MutualAidRequest & { business_name: string | null; my_offer_status: string | null };

export function MutualAidPage() {
  const { user } = useAuth();
  const { showToast } = useToast();

  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [myRequests, setMyRequests] = useState<(MutualAidRequest & { offers: MutualAidOffer[] })[]>([]);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ industry: '', trade_note: '', need_type: 'both' as 'overflow_calls' | 'technician_labor' | 'both' });
  const [offerDrafts, setOfferDrafts] = useState<Record<string, { offer_type: string; note: string }>>({});

  const load = useCallback(async () => {
    if (!user) return;
    const [{ data: bp }, { data: mine }, { data: network }] = await Promise.all([
      supabase.from('business_profile').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('mutual_aid_requests').select('*, offers:mutual_aid_offers(*)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10),
      supabase.rpc('get_open_mutual_aid_requests'),
    ]);
    setProfile(bp);
    setMyRequests((mine as typeof myRequests) ?? []);
    setNetworkRequests((network as NetworkRequest[]) ?? []);
    setForm((f) => ({ ...f, industry: bp?.primary_industry ?? f.industry }));
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const toggleEnabled = async (enabled: boolean) => {
    if (!user) return;
    const { error } = await supabase.from('business_profile').update({ mutual_aid_enabled: enabled }).eq('user_id', user.id);
    if (error) { showToast('Failed to save', 'error'); return; }
    setProfile((p) => (p ? { ...p, mutual_aid_enabled: enabled } : p));
    load();
  };

  const saveContactPhone = async (phone: string) => {
    if (!user) return;
    await supabase.from('business_profile').update({ mutual_aid_contact_phone: phone }).eq('user_id', user.id);
  };

  const broadcastRequest = async () => {
    if (!user || !form.trade_note.trim()) return;
    const regionKey = (profile?.service_area ?? '').trim().toLowerCase();
    if (!regionKey) { showToast('Set a service area in Business Profile first', 'error'); return; }
    const { error } = await supabase.from('mutual_aid_requests').insert({
      user_id: user.id,
      industry: form.industry || null,
      region_key: regionKey,
      trade_note: form.trade_note.trim(),
      need_type: form.need_type,
    });
    if (error) { showToast('Failed to broadcast', 'error'); return; }
    showToast('Request broadcast to the network', 'success');
    setForm((f) => ({ ...f, trade_note: '' }));
    load();
  };

  const cancelRequest = async (id: string) => {
    await supabase.from('mutual_aid_requests').update({ status: 'cancelled' }).eq('id', id);
    load();
  };

  const sendOffer = async (requestId: string) => {
    if (!user) return;
    const draft = offerDrafts[requestId] ?? { offer_type: 'overflow_calls', note: '' };
    const { data: offer, error } = await supabase
      .from('mutual_aid_offers')
      .insert({ request_id: requestId, offering_user_id: user.id, offer_type: draft.offer_type, note: draft.note || null })
      .select('id')
      .maybeSingle();
    if (error || !offer) { showToast('Failed to send offer', 'error'); return; }
    await supabase.functions.invoke('mutual-aid-notify', { body: { request_id: requestId, offer_id: offer.id, event: 'new_offer' } });
    showToast('Offer sent', 'success');
    setOfferDrafts((d) => ({ ...d, [requestId]: { offer_type: 'overflow_calls', note: '' } }));
    load();
  };

  const respondToOffer = async (offer: MutualAidOffer, requestId: string, accept: boolean) => {
    const { error } = await supabase
      .from('mutual_aid_offers')
      .update({ status: accept ? 'accepted' : 'declined', responded_at: new Date().toISOString() })
      .eq('id', offer.id);
    if (error) { showToast('Failed to update offer', 'error'); return; }
    if (accept) {
      await supabase.from('mutual_aid_requests').update({ status: 'fulfilled' }).eq('id', requestId);
      await supabase.functions.invoke('mutual-aid-notify', { body: { request_id: requestId, offer_id: offer.id, event: 'offer_accepted' } });
    }
    load();
  };

  if (loading) return <DashboardLayout activeLabel="Mutual Aid"><div className="p-8 text-text-secondary">Loading…</div></DashboardLayout>;

  return (
    <DashboardLayout activeLabel="Mutual Aid">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <LifeBuoy size={20} />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Disaster Mutual-Aid Network</h1>
            <p className="text-sm text-text-secondary">Ask nearby Vireek businesses for overflow help, or offer yours.</p>
          </div>
        </div>

        <div className="mb-6 rounded-xl border border-border bg-bg-secondary p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Join the network</h2>
              <p className="text-xs text-text-secondary">Required both to broadcast a request and to see other businesses' requests.</p>
            </div>
            <button
              onClick={() => toggleEnabled(!profile?.mutual_aid_enabled)}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${profile?.mutual_aid_enabled ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}
            >
              {profile?.mutual_aid_enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          {profile?.mutual_aid_enabled && (
            <input
              defaultValue={profile.mutual_aid_contact_phone ?? ''}
              onBlur={(e) => saveContactPhone(e.target.value)}
              placeholder="Coordination phone number (shown only after an offer is accepted)"
              className={`${inputClass} mt-3`}
            />
          )}
        </div>

        {profile?.mutual_aid_enabled && (
          <>
            <div className="mb-6 rounded-xl border border-border bg-bg-secondary p-4">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Broadcast a request</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <select value={form.industry} onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))} className={inputClass}>
                  {INDUSTRIES.map((i) => <option key={i.slug} value={i.slug}>{i.name}</option>)}
                </select>
                <select value={form.need_type} onChange={(e) => setForm((f) => ({ ...f, need_type: e.target.value as typeof form.need_type }))} className={inputClass}>
                  {Object.entries(NEED_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <textarea
                value={form.trade_note}
                onChange={(e) => setForm((f) => ({ ...f, trade_note: e.target.value }))}
                placeholder="What's happening and what you need, e.g. 'Ice storm, 40+ no-heat calls backed up, need a crew for 2-3 days.'"
                rows={3}
                className={`${inputClass} mt-3`}
              />
              <button onClick={broadcastRequest} className="mt-3 flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90">
                <Send size={14} /> Broadcast to network
              </button>
            </div>

            {myRequests.filter((r) => r.status === 'open').length > 0 && (
              <div className="mb-6 rounded-xl border border-border bg-bg-secondary p-4">
                <h2 className="mb-3 text-sm font-semibold text-text-primary">Your open requests</h2>
                <div className="space-y-3">
                  {myRequests.filter((r) => r.status === 'open').map((r) => (
                    <div key={r.id} className="rounded-lg border border-border bg-bg-primary p-3">
                      <div className="flex items-start justify-between">
                        <p className="text-sm text-text-primary">{r.trade_note}</p>
                        <button onClick={() => cancelRequest(r.id)} className="shrink-0 text-xs text-text-secondary hover:text-error-500">Cancel</button>
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">{timeLeft(r.expires_at)} · {r.offers.length} offer{r.offers.length === 1 ? '' : 's'}</p>
                      {r.offers.filter((o) => o.status === 'offered').map((o) => (
                        <div key={o.id} className="mt-2 flex items-center justify-between rounded-lg bg-bg-secondary px-3 py-2 text-xs">
                          <span>{o.offer_type} — {o.note ?? 'no note'}</span>
                          <div className="flex gap-1">
                            <button onClick={() => respondToOffer(o, r.id, true)} className="rounded p-1 text-success-500 hover:bg-success-500/10"><Check size={14} /></button>
                            <button onClick={() => respondToOffer(o, r.id, false)} className="rounded p-1 text-error-500 hover:bg-error-500/10"><X size={14} /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-xl border border-border bg-bg-secondary p-4">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Network requests</h2>
              {networkRequests.length === 0 && <p className="text-sm text-text-secondary">No open requests right now.</p>}
              <div className="space-y-3">
                {networkRequests.map((r) => {
                  const draft = offerDrafts[r.id] ?? { offer_type: 'overflow_calls', note: '' };
                  return (
                    <motion.div key={r.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-lg border border-border bg-bg-primary p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-text-primary">{r.business_name ?? 'A network business'}</span>
                        <span className="text-xs text-text-secondary">{timeLeft(r.expires_at)}</span>
                      </div>
                      <p className="mt-1 text-sm text-text-secondary">{r.trade_note}</p>
                      <p className="mt-1 text-xs text-text-secondary">{r.region_key} · {NEED_TYPE_LABELS[r.need_type]}</p>

                      {r.my_offer_status ? (
                        <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${OFFER_STATUS_COLORS[r.my_offer_status]}`}>
                          {OFFER_STATUS_LABELS[r.my_offer_status]}
                        </span>
                      ) : (
                        <div className="mt-2 flex gap-2">
                          <select
                            value={draft.offer_type}
                            onChange={(e) => setOfferDrafts((d) => ({ ...d, [r.id]: { ...draft, offer_type: e.target.value } }))}
                            className={inputClass}
                          >
                            {Object.entries(NEED_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                          </select>
                          <button onClick={() => sendOffer(r.id)} className="flex shrink-0 items-center gap-1 rounded-xl bg-accent px-3 py-2.5 text-xs font-medium text-white hover:bg-accent/90">
                            <HandHeart size={14} /> Offer help
                          </button>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
