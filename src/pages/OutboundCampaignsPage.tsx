import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { PhoneOutgoing } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, OutboundCampaign, OutboundCall } from '@/lib/supabase';
import {
  OUTBOUND_CAMPAIGNS,
  OutboundCampaignType,
  formatOutboundCallStatus,
} from '@/lib/outboundCampaigns';

// ============================================================
// HELPERS
// ============================================================

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-bg-tertiary text-text-secondary',
  calling: 'bg-accent/10 text-accent',
  connected: 'bg-success-500/10 text-success-500',
  no_answer: 'bg-warning-500/10 text-warning-500',
  voicemail_left: 'bg-warning-500/10 text-warning-500',
  converted: 'bg-success-500/10 text-success-500',
  opted_out: 'bg-bg-tertiary text-text-secondary',
  failed: 'bg-danger/10 text-danger',
};

// ============================================================
// CAMPAIGN CARD
// ============================================================

interface CampaignCardProps {
  type: OutboundCampaignType;
  campaign: OutboundCampaign | null;
  eligibleCount: number;
  onSave: (type: OutboundCampaignType, enabled: boolean, triggerAfterHours: number) => Promise<void>;
}

function CampaignCard({ type, campaign, eligibleCount, onSave }: CampaignCardProps) {
  const config = OUTBOUND_CAMPAIGNS.find((c) => c.type === type)!;
  const Icon = config.icon;
  const [enabled, setEnabled] = useState(campaign?.enabled ?? false);
  const [hours, setHours] = useState(campaign?.trigger_after_hours ?? config.defaultTriggerHours);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEnabled(campaign?.enabled ?? false);
    setHours(campaign?.trigger_after_hours ?? config.defaultTriggerHours);
  }, [campaign, config.defaultTriggerHours]);

  const handleToggle = async () => {
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    await onSave(type, next, hours);
    setSaving(false);
  };

  const handleHoursBlur = async () => {
    setSaving(true);
    await onSave(type, enabled, hours);
    setSaving(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Icon size={18} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{config.title}</h3>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-text-secondary">
              {config.description}
            </p>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={handleToggle}
          disabled={saving}
          className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
            enabled ? 'bg-accent' : 'bg-bg-tertiary'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          {config.triggerLabel}
          <input
            type="number"
            min={1}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            onBlur={handleHoursBlur}
            className="w-16 rounded-lg border border-border bg-bg-primary px-2 py-1 text-center text-xs text-text-primary focus-ring"
          />
          hours
        </label>

        <span className="rounded-full bg-bg-tertiary px-3 py-1 text-xs font-medium text-text-secondary">
          {eligibleCount} eligible now
        </span>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function OutboundCampaignsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<OutboundCampaign[]>([]);
  const [calls, setCalls] = useState<OutboundCall[]>([]);
  const [eligibleCounts, setEligibleCounts] = useState<Record<OutboundCampaignType, number>>({
    quote_followup: 0,
    appointment_reminder: 0,
    review_request_call: 0,
  });
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [campaignsRes, callsRes, quotedRes, scheduledRes, paidRes] = await Promise.all([
      supabase.from('outbound_campaigns').select('*'),
      supabase.from('outbound_calls').select('*').order('created_at', { ascending: false }).limit(20),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('stage', 'quoted'),
      supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('job_status', 'scheduled'),
      supabase
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('job_status', 'completed')
        .eq('invoice_status', 'paid'),
    ]);

    if (campaignsRes.error || callsRes.error) {
      toast('Failed to load outbound campaigns', 'error');
    } else {
      setCampaigns((campaignsRes.data as OutboundCampaign[]) || []);
      setCalls((callsRes.data as OutboundCall[]) || []);
    }

    setEligibleCounts({
      quote_followup: quotedRes.count ?? 0,
      appointment_reminder: scheduledRes.count ?? 0,
      review_request_call: paidRes.count ?? 0,
    });
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchAll();
  }, [user, fetchAll]);

  const campaignByType = useMemo(() => {
    const map: Partial<Record<OutboundCampaignType, OutboundCampaign>> = {};
    campaigns.forEach((c) => {
      map[c.campaign_type] = c;
    });
    return map;
  }, [campaigns]);

  const handleSave = async (type: OutboundCampaignType, enabled: boolean, triggerAfterHours: number) => {
    if (!user) return;
    const { data, error } = await supabase
      .from('outbound_campaigns')
      .upsert(
        { user_id: user.id, campaign_type: type, enabled, trigger_after_hours: triggerAfterHours },
        { onConflict: 'user_id,campaign_type' }
      )
      .select()
      .single();

    if (error) {
      toast('Could not save campaign settings', 'error');
      return;
    }

    setCampaigns((prev) => [...prev.filter((c) => c.campaign_type !== type), data as OutboundCampaign]);
    toast(enabled ? 'Campaign turned on' : 'Campaign turned off', 'success');
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <PhoneOutgoing size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Outbound Campaigns</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Let Sarah call back leads and customers instead of waiting for them to call you.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {OUTBOUND_CAMPAIGNS.map((config) => (
                <CampaignCard
                  key={config.type}
                  type={config.type}
                  campaign={campaignByType[config.type] ?? null}
                  eligibleCount={eligibleCounts[config.type]}
                  onSave={handleSave}
                />
              ))}
            </div>

            <div className="mt-8">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Recent activity</h2>
              {calls.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border py-12 text-center">
                  <PhoneOutgoing size={28} className="mx-auto mb-3 text-text-secondary" />
                  <p className="text-sm text-text-secondary">
                    No outbound calls yet — turn on a campaign above to get started.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {calls.map((call) => (
                    <motion.div
                      key={call.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium text-text-primary">{call.customer_name}</p>
                        <p className="text-xs text-text-secondary">
                          {call.customer_phone || 'No phone on file'} · {formatDateTime(call.created_at)}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-medium ${
                          STATUS_COLORS[call.status] ?? 'bg-bg-tertiary text-text-secondary'
                        }`}
                      >
                        {formatOutboundCallStatus(call.status)}
                      </span>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>

            <p className="mt-6 text-xs text-text-secondary/70">
              These settings control when Sarah calls back. The actual dialing runs through your outbound
              calling workflow (Vapi + Twilio) — this page is the control panel and activity log for it.
            </p>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
