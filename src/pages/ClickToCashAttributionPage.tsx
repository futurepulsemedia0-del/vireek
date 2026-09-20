import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Lock,
  MousePointerClick,
  Download,
  Plus,
  Trash2,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, Job, Lead, Call } from '@/lib/supabase';
import { fetchProfitabilityRows, type JobProfitability } from '@/lib/jobCosting';
import { exportToCsv } from '@/lib/csvExport';
import {
  computeClickToCash,
  fetchAttributionTouches,
  fetchChannelSpend,
  saveChannelSpend,
  deleteChannelSpend,
  EMPTY_CHANNEL_SPEND_FORM,
  type AttributionTouch,
  type ChannelSpend,
  type ChannelSpendFormState,
  type ChannelFunnel,
} from '@/lib/clickToCashAttribution';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';

// ============================================================
// HELPERS
// ============================================================

type RangePreset = '30d' | '90d' | '365d';

function getRange(preset: RangePreset) {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const days = preset === '30d' ? 30 : preset === '90d' ? 90 : 365;
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function channelLabel(channel: string): string {
  if (channel === 'Unknown / Direct') return channel;
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function roiBadgeClasses(roiPct: number | null): string {
  if (roiPct === null) return 'bg-bg-tertiary text-text-secondary';
  if (roiPct >= 100) return 'bg-success-500/10 text-success-500';
  if (roiPct >= 0) return 'bg-warning-500/10 text-warning-500';
  return 'bg-danger/10 text-danger';
}

// ============================================================
// SPEND FORM
// ============================================================

function SpendForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [form, setForm] = useState<ChannelSpendFormState>(EMPTY_CHANNEL_SPEND_FORM);
  const [saving, setSaving] = useState(false);

  const inputClass =
    'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary';

  const handleSave = async () => {
    if (!user) return;
    if (!form.channel.trim() || !form.period_start || !form.period_end || !form.spend) {
      toast('Channel, period and spend amount are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      await saveChannelSpend(form, user.id);
      toast('Spend logged.', 'success');
      setForm(EMPTY_CHANNEL_SPEND_FORM);
      onSaved();
    } catch {
      toast('Could not save this spend entry.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      <input
        type="text"
        placeholder="Channel (e.g. google)"
        value={form.channel}
        onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value }))}
        className={inputClass}
      />
      <input
        type="text"
        placeholder="Campaign (optional)"
        value={form.campaign}
        onChange={(e) => setForm((f) => ({ ...f, campaign: e.target.value }))}
        className={inputClass}
      />
      <input
        type="date"
        value={form.period_start}
        onChange={(e) => setForm((f) => ({ ...f, period_start: e.target.value }))}
        className={inputClass}
      />
      <input
        type="date"
        value={form.period_end}
        onChange={(e) => setForm((f) => ({ ...f, period_end: e.target.value }))}
        className={inputClass}
      />
      <input
        type="number"
        min={0}
        step="0.01"
        placeholder="Spend ($)"
        value={form.spend}
        onChange={(e) => setForm((f) => ({ ...f, spend: e.target.value }))}
        className={inputClass}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Plus size={14} /> Log
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring rounded-xl border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function ClickToCashAttributionPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_billing;

  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [allTouches, setAllTouches] = useState<AttributionTouch[]>([]);
  const [allSpend, setAllSpend] = useState<ChannelSpend[]>([]);
  const [allProfitability, setAllProfitability] = useState<JobProfitability[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [preset, setPreset] = useState<RangePreset>('90d');
  const [showSpendForm, setShowSpendForm] = useState(false);
  const [deletingSpendId, setDeletingSpendId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!user || !canAccess) return;
    setDataLoading(true);
    try {
      const [jobsRes, leadsRes, callsRes, touches, spend, profitability] = await Promise.all([
        supabase.from('jobs').select('*'),
        supabase.from('leads').select('*'),
        supabase.from('calls').select('*'),
        fetchAttributionTouches(),
        fetchChannelSpend(),
        fetchProfitabilityRows(),
      ]);
      if (jobsRes.error) throw jobsRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (callsRes.error) throw callsRes.error;
      setAllJobs((jobsRes.data as Job[]) ?? []);
      setAllLeads((leadsRes.data as Lead[]) ?? []);
      setAllCalls((callsRes.data as Call[]) ?? []);
      setAllTouches(touches);
      setAllSpend(spend);
      setAllProfitability(profitability);
    } catch {
      // empty state below
    } finally {
      setDataLoading(false);
    }
  }, [user, canAccess]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const range = useMemo(() => getRange(preset), [preset]);

  const result = useMemo(
    () => computeClickToCash(allJobs, allLeads, allCalls, allTouches, allSpend, allProfitability, range.start, range.end),
    [allJobs, allLeads, allCalls, allTouches, allSpend, allProfitability, range],
  );

  const handleDeleteSpend = async (id: string) => {
    try {
      await deleteChannelSpend(id);
      setAllSpend((prev) => prev.filter((s) => s.id !== id));
      toast('Spend entry deleted.', 'success');
    } catch {
      toast('Could not delete this entry.', 'error');
    } finally {
      setDeletingSpendId(null);
    }
  };

  const handleExport = () => {
    exportToCsv(
      result.channels,
      [
        { header: 'Channel', accessor: (c: ChannelFunnel) => channelLabel(c.channel) },
        { header: 'Clicks/Calls', accessor: (c: ChannelFunnel) => c.clicksOrCalls },
        { header: 'Leads', accessor: (c: ChannelFunnel) => c.leads },
        { header: 'Jobs Booked', accessor: (c: ChannelFunnel) => c.jobsBooked },
        { header: 'Jobs Paid', accessor: (c: ChannelFunnel) => c.jobsPaid },
        { header: 'Revenue', accessor: (c: ChannelFunnel) => (c.revenueCents / 100).toFixed(2) },
        { header: 'Gross Profit', accessor: (c: ChannelFunnel) => (c.grossProfitCents / 100).toFixed(2) },
        { header: 'Spend', accessor: (c: ChannelFunnel) => (c.spendCents / 100).toFixed(2) },
        { header: 'ROI %', accessor: (c: ChannelFunnel) => c.roiPct ?? '' },
        { header: 'Cost per Lead', accessor: (c: ChannelFunnel) => (c.costPerLeadCents ? (c.costPerLeadCents / 100).toFixed(2) : '') },
        { header: 'Cost per Acquisition', accessor: (c: ChannelFunnel) => (c.costPerAcquisitionCents ? (c.costPerAcquisitionCents / 100).toFixed(2) : '') },
      ],
      'click-to-cash-attribution.csv',
    );
    toast('Attribution exported as CSV.', 'success');
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Click-to-Cash">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Click-to-Cash access is restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const hasData = result.channels.length > 0;

  return (
    <DashboardLayout activeLabel="Click-to-Cash">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <MousePointerClick size={22} className="text-accent" />
              Marketing ROI Attribution
            </h1>
            <p className="text-sm text-text-secondary">
              Click-to-cash: every channel's full path from click or call to lead, job, payment and real gross margin.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-border bg-bg-secondary p-1">
            {(['30d', '90d', '365d'] as RangePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  preset === p ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {p === '30d' ? '30 days' : p === '90d' ? '90 days' : '12 months'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleExport}
            disabled={!hasData}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {dataLoading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            {/* Spend log */}
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-text-primary">Ad spend by channel</h2>
                {!showSpendForm && (
                  <button
                    type="button"
                    onClick={() => setShowSpendForm(true)}
                    className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs font-semibold text-text-secondary hover:text-text-primary"
                  >
                    <Plus size={14} /> Log spend
                  </button>
                )}
              </div>
              <p className="mt-1 text-sm text-text-secondary">
                ROI can't be calculated without a cost side. Log what you actually paid per channel and period here.
              </p>
              {showSpendForm && (
                <div className="mt-4">
                  <SpendForm
                    onSaved={() => {
                      setShowSpendForm(false);
                      loadData();
                    }}
                    onCancel={() => setShowSpendForm(false)}
                  />
                </div>
              )}
              {allSpend.length > 0 && (
                <div className="mt-4 space-y-1.5">
                  {allSpend.slice(0, 8).map((s) => (
                    <div key={s.id} className="flex items-center justify-between rounded-xl border border-border/60 bg-bg-tertiary/30 px-4 py-2 text-sm">
                      <span className="text-text-primary">
                        {channelLabel(s.channel)}
                        {s.campaign ? ` · ${s.campaign}` : ''}
                        <span className="ml-2 text-xs text-text-secondary">
                          {s.period_start} → {s.period_end}
                        </span>
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-text-primary">{formatCents(s.spend_cents)}</span>
                        <button
                          type="button"
                          onClick={() => setDeletingSpendId(s.id)}
                          className="focus-ring text-text-secondary hover:text-danger"
                          aria-label="Delete spend entry"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Funnel table */}
            {!hasData ? (
              <EmptyState
                icon={MousePointerClick}
                title="No attributed activity in this period"
                description="Once leads and jobs come in with a traceable source, their full click-to-cash path will show up here."
              />
            ) : (
              <Card className="p-6">
                <h2 className="text-base font-semibold text-text-primary">Channel performance</h2>
                <p className="mt-1 text-sm text-text-secondary">Sorted by real gross profit, highest first.</p>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[900px] text-sm">
                    <thead>
                      <tr className="border-b border-border/70 text-left text-xs text-text-secondary">
                        <th className="py-2 pr-3 font-medium">Channel</th>
                        <th className="py-2 pr-3 font-medium">Clicks/Calls</th>
                        <th className="py-2 pr-3 font-medium">Leads</th>
                        <th className="py-2 pr-3 font-medium">Jobs Booked</th>
                        <th className="py-2 pr-3 font-medium">Jobs Paid</th>
                        <th className="py-2 pr-3 font-medium">Revenue</th>
                        <th className="py-2 pr-3 font-medium">Gross Profit</th>
                        <th className="py-2 pr-3 font-medium">Spend</th>
                        <th className="py-2 pr-3 font-medium">ROI</th>
                        <th className="py-2 pr-3 font-medium">CPL</th>
                        <th className="py-2 pr-3 font-medium">CPA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.channels.map((c) => (
                        <tr key={c.channel} className="border-b border-border/40 last:border-0">
                          <td className="py-2.5 pr-3 font-medium text-text-primary">{channelLabel(c.channel)}</td>
                          <td className="py-2.5 pr-3 text-text-secondary">{c.clicksOrCalls}</td>
                          <td className="py-2.5 pr-3 text-text-secondary">{c.leads}</td>
                          <td className="py-2.5 pr-3 text-text-secondary">{c.jobsBooked}</td>
                          <td className="py-2.5 pr-3 text-text-secondary">{c.jobsPaid}</td>
                          <td className="py-2.5 pr-3 text-text-primary">{formatCents(c.revenueCents)}</td>
                          <td className="py-2.5 pr-3 text-text-primary">{formatCents(c.grossProfitCents)}</td>
                          <td className="py-2.5 pr-3 text-text-secondary">{c.spendCents > 0 ? formatCents(c.spendCents) : '—'}</td>
                          <td className="py-2.5 pr-3">
                            <span className={`flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${roiBadgeClasses(c.roiPct)}`}>
                              {c.roiPct !== null && (c.roiPct >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />)}
                              {c.roiPct === null ? 'No spend logged' : `${c.roiPct}%`}
                            </span>
                          </td>
                          <td className="py-2.5 pr-3 text-text-secondary">{c.costPerLeadCents ? formatCents(c.costPerLeadCents) : '—'}</td>
                          <td className="py-2.5 pr-3 text-text-secondary">{c.costPerAcquisitionCents ? formatCents(c.costPerAcquisitionCents) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.unattributedRevenueCents > 0 && (
                  <p className="mt-4 text-xs text-text-secondary">
                    {formatCents(result.unattributedRevenueCents)} in paid revenue this period couldn't be traced to any channel
                    (no matching touch, call source, or booking channel on the job).
                  </p>
                )}
              </Card>
            )}
          </div>
        </FadeIn>
      )}

      <ConfirmDialog
        open={!!deletingSpendId}
        title="Delete this spend entry?"
        description="This removes it from every ROI calculation that covers its period. This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => deletingSpendId && handleDeleteSpend(deletingSpendId)}
        onCancel={() => setDeletingSpendId(null)}
      />
    </DashboardLayout>
  );
}
