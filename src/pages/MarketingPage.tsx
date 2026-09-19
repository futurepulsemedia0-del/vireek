import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Megaphone, Users, Gift, Flame, Plus, Play, Pause, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';
import {
  CAMPAIGN_TYPES,
  getCampaignTypeConfig,
  generateReferralCode,
  formatGrade,
  type MarketingSegment,
  type MarketingCampaign,
  type CampaignType,
  type LeadScore,
  type ReferralCode,
} from '@/lib/marketing';

type Tab = 'overview' | 'segments' | 'campaigns' | 'referrals';

export default function MarketingPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);

  const [segments, setSegments] = useState<MarketingSegment[]>([]);
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([]);
  const [scores, setScores] = useState<LeadScore[]>([]);
  const [referralCodes, setReferralCodes] = useState<ReferralCode[]>([]);

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [segRes, campRes, scoreRes, refRes] = await Promise.all([
      supabase.from('marketing_segments').select('*').order('created_at', { ascending: false }),
      supabase.from('marketing_campaigns').select('*').order('created_at', { ascending: false }),
      supabase.from('lead_scores').select('*').order('score', { ascending: false }).limit(50),
      supabase.from('referral_codes').select('*').order('created_at', { ascending: false }),
    ]);
    setSegments((segRes.data ?? []) as MarketingSegment[]);
    setCampaigns((campRes.data ?? []) as MarketingCampaign[]);
    setScores((scoreRes.data ?? []) as LeadScore[]);
    setReferralCodes((refRes.data ?? []) as ReferralCode[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const createSegment = async () => {
    const name = window.prompt('Segment name (e.g. "Inactive 90+ days")');
    if (!name) return;
    const { error } = await supabase.from('marketing_segments').insert({
      name,
      filter: { entity: 'customer', inactive_days: 90 },
    });
    if (error) showToast(error.message, 'error');
    else {
      showToast('Segment created — edit its filter directly in Supabase for now, or ask Claude to add a filter builder.', 'success');
      loadAll();
    }
  };

  const deleteSegment = async (id: string) => {
    if (!window.confirm('Delete this segment? Campaigns using it will keep running but stop finding new members.')) return;
    const { error } = await supabase.from('marketing_segments').delete().eq('id', id);
    if (error) showToast(error.message, 'error');
    else loadAll();
  };

  const createCampaign = async (campaign_type: CampaignType) => {
    const name = window.prompt(`Name this ${getCampaignTypeConfig(campaign_type).label.toLowerCase()}`);
    if (!name) return;
    const { error } = await supabase.from('marketing_campaigns').insert({
      name,
      campaign_type,
      trigger_type: 'segment_entry',
      status: 'draft',
    });
    if (error) showToast(error.message, 'error');
    else {
      showToast('Campaign created as a draft. Add steps and a segment, then activate it.', 'success');
      loadAll();
    }
  };

  const toggleCampaignStatus = async (campaign: MarketingCampaign) => {
    const nextStatus = campaign.status === 'active' ? 'paused' : 'active';
    const { error } = await supabase.from('marketing_campaigns').update({ status: nextStatus }).eq('id', campaign.id);
    if (error) showToast(error.message, 'error');
    else loadAll();
  };

  const deleteCampaign = async (id: string) => {
    if (!window.confirm('Delete this campaign and all its steps? This cannot be undone.')) return;
    const { error } = await supabase.from('marketing_campaigns').delete().eq('id', id);
    if (error) showToast(error.message, 'error');
    else loadAll();
  };

  const createReferralCode = async () => {
    const name = window.prompt('Customer name this referral code is for');
    if (!name) return;
    const code = generateReferralCode(name);
    const { error } = await supabase.from('referral_codes').insert({ code, reward_type: 'credit', reward_value: 25 });
    if (error) showToast(error.message, 'error');
    else {
      showToast(`Referral code ${code} created.`, 'success');
      loadAll();
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Megaphone className="w-7 h-7 text-accent" />
          <h1 className="text-2xl font-bold text-text-primary">Marketing Automation</h1>
        </div>
        <p className="text-text-secondary mb-6">
          Segments, drip/lifecycle/reactivation campaigns, lead scoring, attribution, and referrals — all running on a
          schedule against your leads and customers.
        </p>

        <div className="flex gap-2 border-b border-border mb-6">
          {(['overview', 'segments', 'campaigns', 'referrals'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
                tab === t ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-text-secondary py-12 text-center">Loading…</div>
        ) : (
          <>
            {tab === 'overview' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard icon={Users} label="Segments" value={segments.length} />
                <StatCard icon={Megaphone} label="Active campaigns" value={campaigns.filter((c) => c.status === 'active').length} />
                <StatCard icon={Gift} label="Referral codes issued" value={referralCodes.length} />
                <div className="sm:col-span-3 bg-bg-secondary border border-border rounded-xl p-5 mt-2">
                  <div className="flex items-center gap-2 mb-3">
                    <Flame className="w-5 h-5 text-warning-500" />
                    <h2 className="font-semibold text-text-primary">Hottest leads &amp; customers</h2>
                  </div>
                  {scores.length === 0 ? (
                    <p className="text-sm text-text-secondary">
                      No scores yet — they populate after <code>marketing-engine-tick</code> runs its first scheduled pass.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {scores.slice(0, 8).map((s, i) => (
                        <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-0">
                          <span className="text-text-secondary">{s.customer_id ? 'Customer' : 'Lead'} · {s.customer_id ?? s.lead_id}</span>
                          <span className="font-medium text-text-primary">{s.score} · {formatGrade(s.grade)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'segments' && (
              <div>
                <button onClick={createSegment} className="mb-4 inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium">
                  <Plus className="w-4 h-4" /> New segment
                </button>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {segments.map((s) => (
                    <motion.div key={s.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="bg-bg-secondary border border-border rounded-xl p-5">
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="font-semibold text-text-primary">{s.name}</h3>
                          <p className="text-sm text-text-secondary mt-1">{s.member_count} members · {s.is_dynamic ? 'auto-updating' : 'static'}</p>
                        </div>
                        <button onClick={() => deleteSegment(s.id)} className="text-text-secondary hover:text-danger">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                  {segments.length === 0 && <p className="text-sm text-text-secondary">No segments yet.</p>}
                </div>
              </div>
            )}

            {tab === 'campaigns' && (
              <div>
                <div className="flex flex-wrap gap-2 mb-4">
                  {CAMPAIGN_TYPES.map((c) => (
                    <button
                      key={c.type}
                      onClick={() => createCampaign(c.type)}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm font-medium text-text-primary hover:border-accent"
                    >
                      <c.icon className="w-4 h-4" /> New {c.label.toLowerCase()}
                    </button>
                  ))}
                </div>
                <div className="space-y-3">
                  {campaigns.map((c) => {
                    const config = getCampaignTypeConfig(c.campaign_type);
                    return (
                      <div key={c.id} className="bg-bg-secondary border border-border rounded-xl p-5 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <config.icon className="w-5 h-5 text-accent" />
                          <div>
                            <h3 className="font-semibold text-text-primary">{c.name}</h3>
                            <p className="text-sm text-text-secondary">{config.label} · {c.status} · trigger: {c.trigger_type}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => toggleCampaignStatus(c)} className="p-2 rounded-lg hover:bg-bg-tertiary text-text-secondary" title={c.status === 'active' ? 'Pause' : 'Activate'}>
                            {c.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                          </button>
                          <button onClick={() => deleteCampaign(c.id)} className="p-2 rounded-lg hover:bg-bg-tertiary text-text-secondary hover:text-danger">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {campaigns.length === 0 && <p className="text-sm text-text-secondary">No campaigns yet.</p>}
                </div>
              </div>
            )}

            {tab === 'referrals' && (
              <div>
                <button onClick={createReferralCode} className="mb-4 inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium">
                  <Plus className="w-4 h-4" /> Issue referral code
                </button>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {referralCodes.map((r) => (
                    <div key={r.id} className="bg-bg-secondary border border-border rounded-xl p-5">
                      <p className="font-mono font-semibold text-text-primary">{r.code}</p>
                      <p className="text-sm text-text-secondary mt-1">{r.clicks} clicks · ${r.reward_value} {r.reward_type}</p>
                    </div>
                  ))}
                  {referralCodes.length === 0 && <p className="text-sm text-text-secondary">No referral codes yet.</p>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: number }) {
  return (
    <div className="bg-bg-secondary border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 text-text-secondary text-sm mb-2">
        <Icon className="w-4 h-4" /> {label}
      </div>
      <p className="text-2xl font-bold text-text-primary">{value}</p>
    </div>
  );
}
