import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleCheck as CheckCircle2, CircleAlert as AlertCircle, Copy, Globe, Lock, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import {
  PARTNER_LABELS,
  applyProposal,
  buildReadiness,
  countActiveAreas,
  decideProposal,
  feedUrl,
  loadFeedPreview,
  loadGoogleBookingSettings,
  loadProposals,
  proposeGbpSync,
  updateGoogleBookingSettings,
  type FeedPreview,
  type GbpProposal,
  type GoogleBookingSettings,
  type PartnerStatus,
} from '@/lib/googleBooking';

const PAGE = 'Google Booking';

const APPLY_MESSAGES: Record<string, string> = {
  apply_disabled: 'Automatic apply is not enabled yet — it opens after Google grants Business Profile API access. You can apply this change manually in Google Business Profile.',
  not_connected: 'Google Business Profile is not connected yet.',
  token_unavailable: 'The Google connection expired. Reconnect and try again.',
  no_primary_category: 'Your Google profile has no primary category — set one in Google first.',
  manual_only: 'Service areas are applied manually in Google Business Profile.',
  stale: 'Your data changed since this proposal was made. Check for changes again.',
  forbidden: "You don't have permission to do this.",
};

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

function describeDesired(p: GbpProposal): string {
  const items = Array.isArray(p.desired) ? p.desired : [];
  if (p.kind === 'services') return items.filter((x): x is string => typeof x === 'string').join(', ');
  return items.map((x) => (x as { name?: string }).name).filter(Boolean).join(', ');
}

export function GoogleBookingPage() {
  const { profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();
  const ownerId = isOwner ? (profile?.id ?? null) : (teamMember?.account_owner_id ?? null);
  const canManage = isOwner || permissions.can_manage_team || teamMember?.role === 'admin';
  const canView = canManage || permissions.can_edit_business_profile;

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [settings, setSettings] = useState<GoogleBookingSettings | null>(null);
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [areaCount, setAreaCount] = useState(0);
  const [proposals, setProposals] = useState<GbpProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ownerId) return;
    setStatus('loading');
    try {
      const [s, pv, areas, props] = await Promise.all([
        loadGoogleBookingSettings(), loadFeedPreview(), countActiveAreas(ownerId), loadProposals(ownerId),
      ]);
      setSettings(s); setPreview(pv); setAreaCount(areas); setProposals(props); setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [ownerId]);

  useEffect(() => { if (canView && ownerId) void load(); }, [canView, ownerId, load]);

  const checks = useMemo(() => buildReadiness({ preview, settings, activeAreaCount: areaCount }), [preview, settings, areaCount]);
  const url = preview?.slug ? feedUrl(preview.slug) : '';

  async function save(patch: Parameters<typeof updateGoogleBookingSettings>[0], key: string) {
    setBusy(key);
    const res = await updateGoogleBookingSettings(patch);
    setBusy(null);
    if (!res.ok) {
      toast(res.reason === 'not_ready' ? 'Fix the readiness checks first — availability must be verifiable before it is published.'
        : res.reason === 'forbidden' ? "You don't have permission to change this." : 'Could not save. Please try again.', 'error');
      return;
    }
    setSettings(res.settings);
    try { setPreview(await loadFeedPreview()); } catch { /* keep previous preview */ }
  }

  async function propose() {
    setBusy('propose');
    try {
      const res = await proposeGbpSync();
      const created = res.filter((r) => r.result === 'proposed').length;
      toast(created > 0 ? `${created} change${created > 1 ? 's' : ''} ready for your review.` : 'Google Business Profile data is already up to date.', 'success');
      if (ownerId) setProposals(await loadProposals(ownerId));
    } catch {
      toast('Could not check for changes. Please try again.', 'error');
    } finally { setBusy(null); }
  }

  async function decide(p: GbpProposal, decision: 'approve' | 'reject' | 'applied_manually') {
    setBusy(p.id);
    const res = await decideProposal(p.id, decision);
    setBusy(null);
    if (!res.ok) toast(APPLY_MESSAGES[res.code ?? ''] ?? 'Could not update this proposal.', 'error');
    if (ownerId) setProposals(await loadProposals(ownerId).catch(() => proposals));
  }

  async function apply(p: GbpProposal) {
    setBusy(p.id);
    const res = await applyProposal(p.id);
    setBusy(null);
    if (res.ok) toast('Applied to Google Business Profile.', 'success');
    else toast(APPLY_MESSAGES[res.code ?? ''] ?? 'Google rejected the update. Nothing was lost — try again later.', 'error');
    if (ownerId) setProposals(await loadProposals(ownerId).catch(() => proposals));
  }

  if (profileLoading) return <DashboardLayout activeLabel={PAGE}><SkeletonCardList count={3} rows={3} /></DashboardLayout>;
  if (!canView) {
    return (
      <DashboardLayout activeLabel={PAGE}>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner to grant you the "Edit Business Profile" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Globe size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Google Booking</h1>
          <p className="text-sm text-text-secondary">Publish verified availability and keep Google Business Profile in sync — nothing changes without your approval.</p>
        </div>
      </div>

      {status === 'loading' && <SkeletonCardList count={4} rows={3} />}
      {status === 'error' && (
        <EmptyState icon={AlertTriangle} title="Couldn't load Google Booking" description="Check your connection and try again."
          action={{ label: 'Retry', onClick: () => void load() }} />
      )}

      {status === 'ready' && settings && (
        <div className="space-y-6">
          <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="gb-ready">
            <h2 id="gb-ready" className="text-base font-semibold text-text-primary">Readiness</h2>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {checks.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-sm">
                  {c.ok ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-green-500" /> : <AlertCircle size={18} className="mt-0.5 shrink-0 text-amber-500" />}
                  <span><span className="text-text-primary">{c.label}</span>{!c.ok && c.hint && <span className="block text-xs text-text-secondary">{c.hint}</span>}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="gb-pub">
            <h2 id="gb-pub" className="text-base font-semibold text-text-primary">Publishing</h2>
            <div className="mt-3 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-text-primary">Availability feed</p>
                  <p className="text-xs text-text-secondary">Real-time, capacity-checked open slots. Only verified availability is ever published.</p>
                </div>
                <Switch label="Availability feed" checked={settings.feed_enabled} disabled={!canManage || busy === 'feed'}
                  onChange={(v) => void save({ feed_enabled: v }, 'feed')} />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-text-primary">Structured data on your booking page</p>
                  <p className="text-xs text-text-secondary">schema.org markup (business, services, areas, hours, reserve action) so search and AI agents can read your page.</p>
                </div>
                <Switch label="Structured data" checked={settings.structured_data_enabled} disabled={!canManage || busy === 'ld'}
                  onChange={(v) => void save({ structured_data_enabled: v }, 'ld')} />
              </div>
              <label className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-primary">
                Publish window
                <select value={settings.horizon_days} disabled={!canManage || busy === 'hz'}
                  onChange={(e) => void save({ horizon_days: Number(e.target.value) }, 'hz')}
                  className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
                  {[7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
              </label>
              {url && (
                <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2">
                  <code className="min-w-0 flex-1 truncate text-xs text-text-secondary">{url}</code>
                  <button type="button" aria-label="Copy feed URL" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-text-primary"
                    onClick={() => { void navigator.clipboard?.writeText(url).then(() => toast('Feed URL copied.', 'success')).catch(() => toast('Could not copy.', 'error')); }}>
                    <Copy size={16} />
                  </button>
                </div>
              )}
            </div>
            <div className="mt-4">
              <p className="text-sm font-medium text-text-primary">
                {preview?.blocked ? 'Nothing is publishable yet' : `${preview?.published_slots ?? 0} verified slots in the window`}
                {preview && !preview.blocked && <span className="ml-2 text-xs font-normal text-text-secondary">({preview.capacity_mode === 'technician_capacity' ? 'technician capacity applied' : 'single shared calendar'}{preview.timezone ? ` · ${preview.timezone}` : ''})</span>}
              </p>
              {preview && preview.next_slots.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {preview.next_slots.map((s) => (
                    <li key={s.start} className="rounded-lg bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary">{s.local_date} · {s.local_time}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="gb-gbp">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="gb-gbp" className="text-base font-semibold text-text-primary">Google Business Profile sync</h2>
                <p className="text-xs text-text-secondary">Services and service areas are proposed here first. Google is only updated after you approve.</p>
              </div>
              <Button size="sm" variant="secondary" disabled={!canManage || busy === 'propose'} onClick={() => void propose()}>
                {busy === 'propose' ? 'Checking…' : 'Check for changes'}
              </Button>
            </div>
            {proposals.length === 0 ? (
              <p className="mt-4 text-sm text-text-secondary">No pending changes.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {proposals.map((p) => (
                  <li key={p.id} className="rounded-xl border border-border bg-bg-primary p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-text-primary">{p.kind === 'services' ? 'Services' : 'Service areas'}
                        <span className="ml-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-normal text-text-secondary">{p.status}</span></p>
                      <div className="flex flex-wrap gap-2">
                        {p.status === 'pending' && <Button size="sm" disabled={!canManage || busy === p.id} onClick={() => void decide(p, 'approve')}>Approve</Button>}
                        {p.status === 'approved' && p.kind === 'services' && <Button size="sm" disabled={!canManage || busy === p.id} onClick={() => void apply(p)}>Apply to Google</Button>}
                        {p.status === 'approved' && <Button size="sm" variant="secondary" disabled={!canManage || busy === p.id} onClick={() => void decide(p, 'applied_manually')}>I applied it manually</Button>}
                        {(p.status === 'pending' || p.status === 'approved') && <Button size="sm" variant="ghost" disabled={!canManage || busy === p.id} onClick={() => void decide(p, 'reject')}>Reject</Button>}
                      </div>
                    </div>
                    <p className="mt-2 break-words text-xs text-text-secondary">{describeDesired(p)}</p>
                    {p.last_error && <p className="mt-2 text-xs text-amber-500">Last attempt: {p.last_error.replace(/_/g, ' ')}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="gb-partner">
            <h2 id="gb-partner" className="text-base font-semibold text-text-primary">Google program status</h2>
            <p className="mt-1 text-xs text-text-secondary">
              Booking directly inside Google Search, Maps and AI Mode requires Google's partner approval. Until then, customers
              book on your Vireek booking page. Track where you are:
            </p>
            <select aria-label="Google partner status" value={settings.partner_status} disabled={!canManage || busy === 'partner'}
              onChange={(e) => void save({ partner_status: e.target.value as PartnerStatus }, 'partner')}
              className="focus-ring mt-3 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
              {(Object.keys(PARTNER_LABELS) as PartnerStatus[]).map((k) => <option key={k} value={k}>{PARTNER_LABELS[k]}</option>)}
            </select>
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
