/**
 * Trust Pack — /dashboard/trust-pack
 *
 * Data residency, customer-managed encryption keys, dedicated tenant, SLA tracking and
 * sub-processor notices for the signed-in ACCOUNT (owner + team share one view).
 * Back end: supabase/migrations/20271021000000_enterprise_trust_pack.sql.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BellRing, ExternalLink, Globe2, KeyRound } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { useAuth } from '@/contexts/AuthContext';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { EncryptionPanel } from '@/components/trust-pack/EncryptionPanel';
import { NoticesPanel } from '@/components/trust-pack/NoticesPanel';
import { ResidencyPanel } from '@/components/trust-pack/ResidencyPanel';
import { SlaPanel } from '@/components/trust-pack/SlaPanel';
import { PanelSkeleton } from '@/components/trust-pack/ui';

type Tab = 'residency' | 'encryption' | 'sla' | 'notices';

const TABS: { id: Tab; label: string; icon: typeof Globe2 }[] = [
  { id: 'residency', label: 'Residency & isolation', icon: Globe2 },
  { id: 'encryption', label: 'Encryption keys', icon: KeyRound },
  { id: 'sla', label: 'SLA & credits', icon: Activity },
  { id: 'notices', label: 'Sub-processor notices', icon: BellRing },
];

export function TrustPackPage() {
  const { user, profile, teamMember, isOwner, profileLoading } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id; // same resolution as SupportTicketsPage
const residencyOn = useFeatureFlag('data_residency_ui');
const tabs = useMemo(() => TABS.filter((t) => t.id !== 'residency' || residencyOn), [residencyOn]);
const [picked, setTab] = useState<Tab>('residency');
const tab: Tab = tabs.some((t) => t.id === picked) ? picked : tabs[0].id;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
        <BackButton />
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Trust Pack</h1>
            <p className="mt-1 text-sm text-text-secondary">{residencyOn ? 'Where your data lives, who holds the keys, and how we’re held to our uptime commitment.' : 'Who holds the keys and how we’re held to our uptime commitment.'}.</p>
          </div>
          <Link to="/trust/security" className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-accent hover:underline">
            Security portal <ExternalLink size={14} aria-hidden />
          </Link>
        </header>

        <div role="tablist" aria-label="Trust Pack sections" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
          {tabs.map((t) => (
            <button key={t.id} role="tab" id={`tp-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`tp-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`focus-ring inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}>
              <t.icon size={16} aria-hidden /> {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`tp-panel-${tab}`} aria-labelledby={`tp-tab-${tab}`}>
          {profileLoading || !user || !ownerId ? (
            <PanelSkeleton />
          ) : tab === 'residency' ? (
            <ResidencyPanel ownerId={ownerId} isOwner={isOwner} />
          ) : tab === 'encryption' ? (
            <EncryptionPanel ownerId={ownerId} isOwner={isOwner} />
          ) : tab === 'sla' ? (
            <SlaPanel ownerId={ownerId} />
          ) : (
            <NoticesPanel ownerId={ownerId} isOwner={isOwner} />
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
