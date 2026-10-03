// Skill Liquidity Network — find the best verified technician in the WHOLE Vireek network.
//
// Job -> required equipment level + diagnostic skill -> every opted-in technician ->
// distance, skill confidence, equipment experience, historical outcome, availability,
// price, trust -> ranked, explainable list -> request -> accept -> outcome feeds back
// into future rankings (the network effect).
// See supabase/migrations/20270301000000_skill_liquidity_network.sql.
import { useState } from 'react';
import { Globe2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkillOffersPanel } from '@/components/skillmarket/SkillOffersPanel';
import { SkillSearchPanel } from '@/components/skillmarket/SkillSearchPanel';
import { SkillTeamPanel } from '@/components/skillmarket/SkillTeamPanel';
import { useAuth } from '@/contexts/AuthContext';

type Tab = 'find' | 'requests' | 'team';

const TAB_LABELS: Record<Tab, string> = {
  find: 'Find a technician',
  requests: 'Requests',
  team: 'My team',
};

export function SkillMarketPage() {
  const { isOwner, permissions, profile } = useAuth();
  // Mirrors public.identity_is_manager(): owner/admin or billing permission.
  const isManager = isOwner || profile?.role === 'admin' || permissions.can_view_billing === true;
  const tabs: Tab[] = isManager ? ['find', 'requests', 'team'] : ['team'];

  const [tab, setTab] = useState<Tab>(tabs[0]);
  const [offersKey, setOffersKey] = useState(0);

  return (
    <DashboardLayout activeLabel="Skill Market">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-text-primary sm:text-2xl">
            <Globe2 size={22} className="text-accent" /> Skill Market
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            The best technician for the job — not just inside one company, but across the entire Vireek network. Ranked on verified
            outcomes, never self-reported claims.
          </p>
        </div>

        {tabs.length > 1 && (
          <div role="tablist" aria-label="Skill Market sections" className="flex flex-wrap gap-2">
            {tabs.map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                id={`sm-tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`sm-panel-${t}`}
                onClick={() => setTab(t)}
                className={`focus-ring rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                  tab === t ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
                }`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
        )}

        <div role="tabpanel" id={`sm-panel-${tab}`} aria-labelledby={`sm-tab-${tab}`}>
          {tab === 'find' && <SkillSearchPanel onOfferSent={() => setOffersKey((k) => k + 1)} />}
          {tab === 'requests' && <SkillOffersPanel refreshKey={offersKey} />}
          {tab === 'team' && <SkillTeamPanel isManager={isManager} />}
        </div>
      </div>
    </DashboardLayout>
  );
}
