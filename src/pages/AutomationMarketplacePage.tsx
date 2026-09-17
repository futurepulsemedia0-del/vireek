import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Zap, Check, Pause, Play, Trash2, Sparkles } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { supabase } from '@/lib/supabase';
import {
  AUTOMATION_TEMPLATES,
  AUTOMATION_CATEGORIES,
  AUTOMATION_TIER_LABELS,
  type AutomationInstall,
} from '@/lib/automationMarketplace';

export function AutomationMarketplacePage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [installs, setInstalls] = useState<AutomationInstall[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState('All');
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [removingSlug, setRemovingSlug] = useState<string | null>(null);

  const fetchInstalls = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('automation_installs').select('*');
    if (error) {
      toast('Failed to load your automations', 'error');
    } else {
      setInstalls((data as AutomationInstall[]) || []);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchInstalls();
  }, [user, fetchInstalls]);

  const installBySlug = useMemo(() => {
    const map = new Map<string, AutomationInstall>();
    installs.forEach((i) => map.set(i.template_slug, i));
    return map;
  }, [installs]);

  const stats = useMemo(
    () => ({
      installed: installs.length,
      active: installs.filter((i) => i.status === 'active').length,
    }),
    [installs],
  );

  const visibleTemplates =
    activeCategory === 'All'
      ? AUTOMATION_TEMPLATES
      : AUTOMATION_TEMPLATES.filter((t) => t.category === activeCategory);

  const handleInstall = async (slug: string) => {
    if (!user) return;
    setBusySlug(slug);
    const { error } = await supabase
      .from('automation_installs')
      .insert({ user_id: user.id, template_slug: slug, status: 'active' });
    setBusySlug(null);
    if (error) {
      toast('Could not install this automation', 'error');
      return;
    }
    toast('Automation installed', 'success');
    fetchInstalls();
  };

  const handleToggleStatus = async (install: AutomationInstall) => {
    setBusySlug(install.template_slug);
    const nextStatus = install.status === 'active' ? 'paused' : 'active';
    const { error } = await supabase
      .from('automation_installs')
      .update({ status: nextStatus })
      .eq('id', install.id);
    setBusySlug(null);
    if (error) {
      toast('Could not update this automation', 'error');
      return;
    }
    setInstalls((prev) => prev.map((i) => (i.id === install.id ? { ...i, status: nextStatus } : i)));
  };

  const handleRemove = async () => {
    if (!removingSlug) return;
    const install = installBySlug.get(removingSlug);
    if (!install) {
      setRemovingSlug(null);
      return;
    }
    const { error } = await supabase.from('automation_installs').delete().eq('id', install.id);
    if (error) {
      toast('Could not remove this automation', 'error');
    } else {
      setInstalls((prev) => prev.filter((i) => i.id !== install.id));
      toast('Automation removed', 'success');
    }
    setRemovingSlug(null);
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Zap size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Automation Marketplace</h1>
            <p className="mt-1 text-sm text-text-secondary">
              One-click automations built for home service businesses — install the ones that fit, pause or
              remove anytime.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-48 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-8 grid grid-cols-2 gap-3 sm:max-w-xs">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.installed}</p>
                <p className="text-xs text-text-secondary">Installed</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.active}</p>
                <p className="text-xs text-text-secondary">Active</p>
              </div>
            </div>

            <div className="mb-8 flex flex-wrap items-center gap-2.5">
              {AUTOMATION_CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setActiveCategory(category)}
                  className={`focus-ring rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                    activeCategory === category
                      ? 'border-accent bg-accent text-white'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/40 hover:text-text-primary'
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>

            <motion.div
              key={activeCategory}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
            >
              {visibleTemplates.map((template) => {
                const Icon = template.icon;
                const install = installBySlug.get(template.slug);
                const isBusy = busySlug === template.slug;

                return (
                  <Card key={template.slug} className="flex h-full flex-col p-6">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                        <Icon size={20} />
                      </span>
                      <div className="flex flex-col items-end gap-1.5">
                        {template.popular && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">
                            <Sparkles size={11} /> Popular
                          </span>
                        )}
                        <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                          {AUTOMATION_TIER_LABELS[template.tier]}
                        </span>
                      </div>
                    </div>

                    <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-text-secondary/70">
                      {template.category}
                    </p>
                    <h3 className="mt-1.5 text-lg font-semibold text-text-primary">{template.name}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{template.description}</p>

                    <div className="mt-4 space-y-1.5 rounded-xl border border-border bg-bg-tertiary/60 p-3 text-xs text-text-secondary">
                      <p>
                        <span className="font-semibold text-text-primary">Trigger:</span> {template.trigger}
                      </p>
                      <p>
                        <span className="font-semibold text-text-primary">Action:</span> {template.action}
                      </p>
                    </div>

                    <div className="mt-5 flex flex-1 items-end gap-2">
                      {!install ? (
                        <Button
                          variant="primary"
                          size="sm"
                          className="w-full"
                          disabled={isBusy}
                          onClick={() => handleInstall(template.slug)}
                        >
                          {isBusy ? 'Installing…' : 'Install'}
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            className="flex-1"
                            disabled={isBusy}
                            onClick={() => handleToggleStatus(install)}
                          >
                            {install.status === 'active' ? (
                              <>
                                <Pause size={14} /> Pause
                              </>
                            ) : (
                              <>
                                <Play size={14} /> Resume
                              </>
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRemovingSlug(template.slug)}
                            aria-label={`Remove ${template.name}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </>
                      )}
                    </div>

                    {install && (
                      <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-success-500">
                        <Check size={13} />
                        {install.status === 'active' ? 'Installed & active' : 'Installed — paused'}
                      </p>
                    )}
                  </Card>
                );
              })}
            </motion.div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!removingSlug}
        title="Remove this automation?"
        description="This turns the automation off for your business. You can reinstall it anytime from the marketplace."
        confirmLabel="Remove automation"
        onConfirm={handleRemove}
        onCancel={() => setRemovingSlug(null)}
      />
    </DashboardLayout>
  );
}
