import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Calendar,
  Mail,
  Webhook,
  Zap,
  Plug,
  Check,
  X,
  Loader as Loader2,
  Link2,
  Link2Off,
  Copy,
  ArrowLeft,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Integration } from '@/lib/supabase';

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
  },
  {
    type: 'hubspot',
    name: 'HubSpot',
    description: 'Push leads and customer data into your HubSpot CRM.',
    icon: Mail,
    color: 'text-orange-500',
    bgColor: 'bg-orange-500/10',
    hasWebhook: false,
  },
  {
    type: 'zapier',
    name: 'Zapier',
    description: 'Connect Vireek to 5,000+ apps through Zapier workflows.',
    icon: Zap,
    color: 'text-accent',
    bgColor: 'bg-accent/10',
    hasWebhook: false,
  },
  {
    type: 'webhook',
    name: 'Webhook',
    description: 'Receive real-time event notifications at your own endpoint.',
    icon: Webhook,
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
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
        const webhook = (data as Integration[]).find((i) => i.integration_type === 'webhook');
        if (webhook?.config && typeof webhook.config === 'object' && 'url' in webhook.config) {
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

  const handleToggle = async (def: IntegrationDef) => {
    const existing = getIntegration(def.type);
    setToggling(def.type);
    try {
      if (existing && existing.status === 'connected') {
        // Disconnect
        const { error } = await supabase
          .from('integrations')
          .update({ status: 'disconnected' })
          .eq('id', existing.id);
        if (error) throw error;
        toast(`${def.name} disconnected.`, 'info');
      } else if (existing) {
        // Reconnect
        const { error } = await supabase
          .from('integrations')
          .update({ status: 'connected' })
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

  const handleSaveWebhook = async () => {
    const webhook = getIntegration('webhook');
    if (!webhook) return;
    setSavingWebhook(true);
    try {
      const { error } = await supabase
        .from('integrations')
        .update({ config: { url: webhookUrl.trim() } })
        .eq('id', webhook.id);
      if (error) throw error;
      toast('Webhook URL saved.', 'success');
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
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Integrations</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Connect Vireek to your favorite tools and automate your workflow.
          </p>
        </div>
      </div>

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
            const isConnected = integration?.status === 'connected';
            return (
              <motion.div
                key={def.type}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${def.bgColor} ${def.color}`}>
                      <def.icon size={22} />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">{def.name}</h3>
                      <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{def.description}</p>
                    </div>
                  </div>
                  {isConnected && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success-500">
                      <Check size={12} /> Connected
                    </span>
                  )}
                </div>

                {/* Webhook URL config */}
                {def.hasWebhook && isConnected && (
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
                        {savingWebhook ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Save
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-text-secondary/60">
                      We'll POST event data (new calls, leads, jobs) to this URL as JSON.
                    </p>
                  </div>
                )}

                {/* Connect/Disconnect button */}
                <button
                  type="button"
                  onClick={() => handleToggle(def)}
                  disabled={toggling === def.type}
                  className={`focus-ring mt-4 flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-50 ${
                    isConnected
                      ? 'border-border text-text-secondary hover:border-danger/40 hover:text-danger'
                      : 'border-accent/30 bg-accent/5 text-accent hover:bg-accent/10'
                  }`}
                >
                  {toggling === def.type ? (
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
              </motion.div>
            );
          })}
        </div>
      )}
    </DashboardLayout>
  );
}
