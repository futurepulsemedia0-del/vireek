import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Calendar,
  Mail,
  Webhook,
  Plug,
  Check,
  Loader as Loader2,
  Link2,
  Link2Off,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Integration } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import {
  clearFailureConfig,
  getIntegrationHealth,
} from '@/lib/integrationRecovery';
import { IntegrationRecoveryBanner } from '@/components/integrations/IntegrationRecoveryBanner';
import { IntegrationRecoveryPanel } from '@/components/integrations/IntegrationRecoveryPanel';

// ============================================================
// CONSTANTS
// ============================================================

interface IntegrationDef {
  type: string;
  name: string;
  description: string;
  icon: typeof Calendar;
  color: string;
  bgColor: string;
  hasWebhook: boolean;
  /** True = no real connection exists behind this yet (no OAuth, nothing
   *  actually talks to the vendor's API). Renders a disabled "Coming soon"
   *  state instead of a Connect button that would silently do nothing. See
   *  NATIVE_INTEGRATIONS_PLAYBOOK.md for what it'd take to make this real. */
  comingSoon?: boolean;
  /** true = این کارت با ریدایرکت OAuth واقعی وصل می‌شه (نه toggle محلی) */
  oauth?: boolean;
}
const INTEGRATION_DEFS: IntegrationDef[] = [
  {
    type: 'google_calendar',
    name: 'Google Calendar',
    description: 'Sync scheduled jobs automatically to your Google Calendar.',
    icon: Calendar,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    hasWebhook: false,
    oauth: true,
  },
  {
    type: 'hubspot',
    name: 'HubSpot',
    description: 'Push leads and customer data into your HubSpot CRM.',
    icon: Mail,
    color: 'text-violet-500',
    bgColor: 'bg-violet-500/10',
    hasWebhook: false,
    oauth: true,
  },

  {
    type: 'webhook',
    name: 'Webhook',
    description:
      'Receive real-time event notifications at your own endpoint. Also works with Zapier, Make.com, or any tool that accepts an incoming webhook.',
    icon: Webhook,
    color: 'text-indigo-500',
    bgColor: 'bg-indigo-500/10',
    hasWebhook: true,
  },
];

// ============================================================
// MAIN PAGE
// ============================================================

export function IntegrationsPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading } = useAuth();
  const { toast } = useToast();

  useKeyboardShortcut({
    key: '/',
    handler: () => navigate('/dashboard'),
  });

  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);

  const loadIntegrations = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('integrations')
        .select('*')
        .order('integration_type', { ascending: true });
      if (error) throw error;
      if (data) {
        setIntegrations(data as Integration[]);
        const webhook = (data as Integration[]).find(
          (i) => i.integration_type === 'webhook',
        );
        if (
          webhook?.config &&
          typeof webhook.config === 'object' &&
          'url' in webhook.config
        ) {
          setWebhookUrl((webhook.config as Record<string, unknown>).url as string);
        }
      }
    } catch {
      // empty state
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  const getIntegration = (type: string): Integration | undefined =>
    integrations.find((i) => i.integration_type === type);

  const [searchParams, setSearchParams] = useSearchParams();
  const [connectingOAuth, setConnectingOAuth] = useState<string | null>(null);

  useEffect(() => {
    const gcal = searchParams.get('google_calendar');
    const hub = searchParams.get('hubspot');
    if (!gcal && !hub) return;
    if (gcal) toast(gcal === 'connected' ? 'Google Calendar connected.' : 'Could not connect Google Calendar — please try again.', gcal === 'connected' ? 'success' : 'error');
    if (hub) toast(hub === 'connected' ? 'HubSpot connected.' : 'Could not connect HubSpot — please try again.', hub === 'connected' ? 'success' : 'error');
    searchParams.delete('google_calendar');
    searchParams.delete('hubspot');
    searchParams.delete('reason');
    setSearchParams(searchParams, { replace: true });
    loadIntegrations();
  }, [searchParams, setSearchParams, toast, loadIntegrations]);

  const handleOAuthConnect = async (def: IntegrationDef) => {
    setConnectingOAuth(def.type);
    try {
      const fn = def.type === 'google_calendar' ? 'google-calendar-oauth-start' : 'hubspot-oauth-start';
      const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>(fn, { body: {} });
      if (error || !data?.url) throw new Error(data?.error || error?.message || `Could not connect ${def.name}.`);
      window.location.href = data.url;
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not connect ${def.name}.`, 'error');
      setConnectingOAuth(null);
    }
  };

  const handleOAuthDisconnect = async (def: IntegrationDef) => {
    const existing = getIntegration(def.type);
    if (!existing) return;
    setToggling(def.type);
    try {
      const { error } = await supabase.from('integrations').update({ status: 'disconnected' }).eq('id', existing.id);
      if (error) throw error;
      toast(`${def.name} disconnected.`, 'info');
      await loadIntegrations();
    } catch {
      toast(`Could not disconnect ${def.name}. Please try again.`, 'error');
    } finally {
      setToggling(null);
    }
  };

  const focusIntegration = (type: string) => {
    document.getElementById(`integration-${type}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  };

  const handleToggle = async (def: IntegrationDef) => {
    const existing = getIntegration(def.type);
    setToggling(def.type);
    try {
      if (existing && existing.status === 'connected') {
        // Manual disconnect — mark reason so recovery UI stays quiet
        const { error } = await supabase
          .from('integrations')
          .update({
            status: 'disconnected',
            config: {
              ...(existing.config ?? {}),
              error_code: 'manual_disconnect',
              error_message: null,
              failed_at: new Date().toISOString(),
            },
          })
          .eq('id', existing.id);
        if (error) throw error;
        toast(`${def.name} disconnected.`, 'info');
      } else if (existing) {
        // Reconnect / clear prior failure
        const { error } = await supabase
          .from('integrations')
          .update({
            status: 'connected',
            config: clearFailureConfig(existing.config),
          })
          .eq('id', existing.id);
        if (error) throw error;
        toast(`${def.name} connected.`, 'success');
      } else {
        // Create new
        const { error } = await supabase.from('integrations').insert({
          user_id: user!.id,
          integration_type: def.type,
          status: 'connected',
          config: def.hasWebhook ? { url: '' } : {},
        });
        if (error) throw error;
        toast(`${def.name} connected.`, 'success');
      }
      await loadIntegrations();
    } catch {
      toast(`Could not update ${def.name}. Please try again.`, 'error');
    } finally {
      setToggling(null);
    }
  };

  /** Explicit recovery path when status is error / auto-disconnect. */
  const handleRecover = async (def: IntegrationDef) => {
    const existing = getIntegration(def.type);
    if (!existing) {
      await handleToggle(def);
      return;
    }
    setToggling(def.type);
    try {
      const nextConfig = clearFailureConfig(existing.config);
      const { error } = await supabase
        .from('integrations')
        .update({
          status: 'connected',
          config: nextConfig,
        })
        .eq('id', existing.id);
      if (error) throw error;
      toast(`${def.name} reconnected.`, 'success');
      await loadIntegrations();

      if (def.hasWebhook) {
        const url =
          nextConfig && typeof nextConfig.url === 'string' ? nextConfig.url : '';
        if (!url) {
          focusIntegration(def.type);
        }
      }
    } catch {
      toast(`Could not recover ${def.name}. Please try again.`, 'error');
    } finally {
      setToggling(null);
    }
  };

  const handleSaveWebhook = async () => {
    const webhook = getIntegration('webhook');
    if (!webhook) return;
    setSavingWebhook(true);
    try {
      // Preserve non-URL keys; clear failure markers on a successful save
      const nextConfig = {
        ...clearFailureConfig(webhook.config),
        url: webhookUrl.trim(),
      };
      const { error } = await supabase
        .from('integrations')
        .update({
          config: nextConfig,
          // Saving a URL after an error is treated as recovery
          status:
            webhook.status === 'error' || webhook.status === 'disconnected'
              ? 'connected'
              : webhook.status,
        })
        .eq('id', webhook.id);
      if (error) throw error;
      toast('Webhook URL saved.', 'success');
      await loadIntegrations();
    } catch {
      toast('Could not save webhook URL.', 'error');
    } finally {
      setSavingWebhook(false);
    }
  };

  const inputClass =
    'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60';

  return (
    <DashboardLayout activeLabel="Integrations">
      {/* Page header */}
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Plug size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
            Integrations
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Connect Vireek to your favorite tools and automate your workflow.
          </p>
        </div>
      </div>

      {/* Recovery banner — only when something actually needs attention */}
      {!loading && (
        <IntegrationRecoveryBanner
          integrations={integrations}
          onFixClick={focusIntegration}
        />
      )}

      {/* Integration cards */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
            >
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 animate-pulse rounded-xl bg-bg-tertiary" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 animate-pulse rounded bg-bg-tertiary" />
                  <div className="h-3 w-48 animate-pulse rounded bg-bg-tertiary" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {INTEGRATION_DEFS.map((def, i) => {
            const integration = getIntegration(def.type);
            // comingSoon integrations never show as connected, even if an old
            // "connected" row exists from before this had a real distinction.
            const isConnected =
              !def.comingSoon && integration?.status === 'connected';
            const health = getIntegrationHealth(integration);
            const showRecovery = !def.comingSoon && health.needsRecovery;

            return (
              <motion.div
                key={def.type}
                id={`integration-${def.type}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.3,
                  delay: i * 0.05,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className={`rounded-2xl border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark ${
                  showRecovery
                    ? 'border-danger-500/40'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${def.bgColor} ${def.color}`}
                    >
                      <def.icon size={22} />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">
                        {def.name}
                      </h3>
                      <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
                        {def.description}
                      </p>
                    </div>
                  </div>

                  {/* Status pill */}
                  {def.comingSoon ? null : isConnected ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success-500">
                      <Check size={12} /> Connected
                    </span>
                  ) : showRecovery ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-500/10 px-2.5 py-1 text-xs font-medium text-danger-500">
                      <AlertTriangle size={12} /> {health.title}
                    </span>
                  ) : null}
                </div>

                {/* Webhook URL config — show when connected OR when recovering so user can fix URL */}
                {def.hasWebhook && (isConnected || showRecovery) && (
                  <div className="mt-4 rounded-xl border border-border bg-bg-primary p-4">
                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                      Webhook URL
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="url"
                        value={webhookUrl}
                        onChange={(e) => setWebhookUrl(e.target.value)}
                        placeholder="https://your-app.com/webhooks/vireek"
                        className={inputClass}
                      />
                      <button
                        type="button"
                        onClick={handleSaveWebhook}
                        disabled={savingWebhook}
                        className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-cta px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                      >
                        {savingWebhook ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Check size={14} />
                        )}
                        Save
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-text-secondary/60">
                      We&apos;ll POST event data (new calls, leads, jobs) to this URL
                      as JSON.
                    </p>
                  </div>
                )}

                {/* Recovery panel — reason + primary action */}
                {showRecovery && (
                  <IntegrationRecoveryPanel
                    row={integration}
                    integrationName={def.name}
                    recovering={toggling === def.type}
                    onRecover={() => handleRecover(def)}
                  />
                )}

                {/* Connect / Disconnect / Coming soon */}
                {def.comingSoon ? (
                  <div
                    className="mt-4 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm font-medium text-text-secondary"
                    title="Not connected to anything yet — no live integration exists for this one."
                  >
                    Coming soon
                  </div>
                ) : showRecovery ? null : (
                  <button
                    type="button"
                    onClick={() =>
                      def.oauth
                        ? isConnected
                          ? handleOAuthDisconnect(def)
                          : handleOAuthConnect(def)
                        : handleToggle(def)
                    }
                    disabled={toggling === def.type || connectingOAuth === def.type}
                    className={`focus-ring mt-4 flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-50 ${
                      isConnected
                        ? 'border-border text-text-secondary hover:border-danger/40 hover:text-danger'
                        : 'border-accent/30 bg-accent/5 text-accent hover:bg-accent/10'
                    }`}
                  >
                    {toggling === def.type || connectingOAuth === def.type ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : isConnected ? (
                      <>
                        <Link2Off size={16} /> Disconnect
                      </>
                    ) : (
                      <>
                        <Link2 size={16} /> Connect
                      </>
                    )}
                  </button>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </DashboardLayout>
  );
}
