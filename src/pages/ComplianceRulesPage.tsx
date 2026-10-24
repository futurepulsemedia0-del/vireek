/**
 * Compliance Rules — /dashboard/compliance-rules
 *
 * Regulation-as-code: versioned, jurisdiction-based rule packs applied to calls,
 * texts, quotes and contracts. Owners see what is in force and why (with sources
 * and effective dates), keep their license + consent records, and can simulate
 * a situation. Vireek compliance staff review and approve every rule with legal
 * counsel before it is enforced. See src/lib/complianceRules.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gavel, Loader2, Lock, Scale, ShieldCheck, TriangleAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { BusinessProfileCard } from '@/components/compliance-rules/BusinessProfileCard';
import { ConsentLedger } from '@/components/compliance-rules/ConsentLedger';
import { ReviewQueue } from '@/components/compliance-rules/ReviewQueue';
import { RulesList } from '@/components/compliance-rules/RulesList';
import { Simulator } from '@/components/compliance-rules/Simulator';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  LEGAL_DISCLAIMER, ComplianceError, canManageCompliance, fetchCatalog, fetchProfile, fetchStaffRole, saveProfile, todayKey,
  type ComplianceProfile, type LicenseEntry, type RuleVersion, type StaffRole,
} from '@/lib/complianceRules';

type Tab = 'rules' | 'check' | 'profile' | 'consent' | 'review';
const msg = (e: unknown) => (e instanceof ComplianceError ? e.message : 'Something went wrong. Please try again.');

export function ComplianceRulesPage() {
  const { isOwner, permissions, profile: authProfile, teamMember, user } = useAuth();
  const { toast } = useToast();
  const allowed = canManageCompliance(isOwner, permissions);
  const accountOwnerId = (isOwner ? authProfile?.id : teamMember?.account_owner_id) ?? null;

  const [tab, setTab] = useState<Tab>('rules');
  const [catalog, setCatalog] = useState<RuleVersion[]>([]);
  const [profile, setProfile] = useState<ComplianceProfile | null>(null);
  const [staffRole, setStaffRole] = useState<StaffRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true); setError(null);
    try {
      const [c, p, r] = await Promise.all([fetchCatalog(), fetchProfile(accountOwnerId), fetchStaffRole()]);
      setCatalog(c); setProfile(p); setStaffRole(r);
    } catch (e) { setError(msg(e)); } finally { setLoading(false); }
  }, [accountOwnerId]);

  useEffect(() => { if (allowed) void load(); else setLoading(false); }, [allowed, load]);

  const onSaveProfile = async (state: string | null, licenses: LicenseEntry[]) => {
    setSaving(true);
    try {
      await saveProfile(state, licenses);
      toast('Business profile saved.', 'success');
      if (accountOwnerId) setProfile(await fetchProfile(accountOwnerId));
    } catch (e) { toast(msg(e), 'error'); } finally { setSaving(false); }
  };

  const tabs = useMemo(() => {
    const t: Array<{ id: Tab; label: string; Icon: typeof Scale }> = [
      { id: 'rules', label: 'Rules in force', Icon: Scale },
      { id: 'check', label: 'Check a situation', Icon: ShieldCheck },
      { id: 'profile', label: 'Business profile', Icon: Lock },
      { id: 'consent', label: 'Consent ledger', Icon: ShieldCheck },
    ];
    if (staffRole) t.push({ id: 'review', label: 'Rule review (staff)', Icon: Gavel });
    return t;
  }, [staffRole]);

  const dateKey = todayKey();
  const needsState = !loading && !error && !profile?.business_state;

  return (
    <DashboardLayout activeLabel="Compliance Rules">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Compliance rules</h1>
          <p className="mt-1 text-sm text-text-secondary">
            State-by-state rules for recording consent, contact hours, consent, license display, right to cancel and required notices — applied automatically to your calls, texts, quotes and contracts.
          </p>
        </div>

        <p role="note" className="flex gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-500" aria-hidden />
          <span><strong>Rules require legal review.</strong> {LEGAL_DISCLAIMER}</span>
        </p>

        {!allowed ? (
          <EmptyState icon={Lock} title="You don't have access to compliance rules" description="Ask the account owner to give you business-profile access." />
        ) : (
          <>
            <div role="tablist" aria-label="Compliance sections" className="flex flex-wrap gap-1">
              {tabs.map(({ id, label, Icon }) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                  className={`focus-ring inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${tab === id ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}>
                  <Icon className="h-4 w-4" aria-hidden /> {label}
                </button>
              ))}
            </div>

            {needsState && tab !== 'profile' && tab !== 'review' && (
              <p className="rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-secondary">
                Your home state isn't set, so rules for your own state can't apply yet.{' '}
                <button type="button" className="focus-ring font-medium text-accent hover:underline" onClick={() => setTab('profile')}>Set it in your business profile</button>.
              </p>
            )}

            {loading ? (
              <SkeletonCardList count={4} rows={3} />
            ) : error ? (
              <EmptyState icon={TriangleAlert} title="Couldn't load compliance rules" description={error} action={{ label: 'Try again', onClick: () => void load() }} />
            ) : (
              <div role="tabpanel">
                {tab === 'rules' && <RulesList catalog={catalog} dateKey={dateKey} />}
                {tab === 'check' && <Simulator catalog={catalog} profile={profile} />}
                {tab === 'profile' && <BusinessProfileCard profile={profile} canEdit={allowed} saving={saving} onSave={onSaveProfile} />}
                {tab === 'consent' && <ConsentLedger canEdit={allowed} />}
                {tab === 'review' && staffRole && <ReviewQueue role={staffRole} userId={user?.id ?? null} />}
              </div>
            )}
            {saving && <p className="flex items-center gap-2 text-xs text-text-secondary"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving…</p>}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

export default ComplianceRulesPage;
