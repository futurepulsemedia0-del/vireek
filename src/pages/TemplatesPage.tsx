/**
 * Message Templates — /dashboard/templates
 *
 * SMS + email template library: variables, live preview, A2P/CAN-SPAM compliance check, approval workflow
 * and usage stats. Rules and security live in the database
 * (supabase/migrations/20270501000000_message_templates.sql); pure logic in lib/messageTemplates.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Lock, Mail, MessageSquare, MessageSquareText, Plus, Search, Sparkles } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { StatusPill } from '@/components/templates/StatusPill';
import { TemplateEditor } from '@/components/templates/TemplateEditor';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  DEFAULT_FILTERS,
  STARTER_TEMPLATES,
  STATUSES,
  STATUS_LABELS,
  filterTemplates,
  starterToDraft,
  summarizeTemplates,
  type MessageTemplate,
  type StarterTemplate,
  type TemplateChannel,
  type TemplateDraft,
  type TemplateFilters,
  type TemplateStats,
} from '@/lib/messageTemplates';
import {
  createMessageTemplate,
  describeTemplateError,
  fetchMessageTemplates,
  fetchTemplateStats,
} from '@/lib/messageTemplatesApi';

const CHANNEL_FILTERS: { value: TemplateFilters['channel']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
];

const SELECT_CLASS =
  'focus-ring min-h-[40px] rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary transition-colors focus-visible:border-accent';

function ChannelIcon({ channel, size = 14 }: { channel: TemplateChannel; size?: number }) {
  return channel === 'sms' ? <MessageSquare size={size} aria-hidden="true" /> : <Mail size={size} aria-hidden="true" />;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
    </div>
  );
}

export function TemplatesPage() {
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();

  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAccess = isOwner || permissions.can_edit_business_profile;
  const canReview = isOwner || permissions.can_manage_team;
  const selectedId = params.get('template');

  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [stats, setStats] = useState<Record<string, TemplateStats>>({});
  const [loadError, setLoadError] = useState(false);
  const [filters, setFilters] = useState<TemplateFilters>(DEFAULT_FILTERS);
  const [creating, setCreating] = useState<{ nonce: number; draft: TemplateDraft | null } | null>(null);
  const [showStarters, setShowStarters] = useState(false);
  const [addingStarter, setAddingStarter] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    const seq = ++loadSeq.current;
    setLoadError(false);
    const [rows, usage] = await Promise.allSettled([fetchMessageTemplates(accountOwnerId), fetchTemplateStats()]);
    if (seq !== loadSeq.current) return;
    if (rows.status === 'fulfilled') setTemplates(rows.value);
    else {
      setTemplates((prev) => prev ?? []);
      setLoadError(true);
    }
    setStats(usage.status === 'fulfilled' ? usage.value : {});
  }, [accountOwnerId, canAccess]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = () => {
    setTemplates(null);
    void load();
  };

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  const confirmDiscard = () => !dirtyRef.current || window.confirm('You have unsaved changes. Discard them?');

  const setSelectedParam = (id: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('template', id);
      else next.delete('template');
      return next;
    });

  const select = (id: string) => {
    if (id === selectedId && !creating) return;
    if (!confirmDiscard()) return;
    setCreating(null);
    setSelectedParam(id);
  };

  const closePanel = () => {
    if (!confirmDiscard()) return;
    setCreating(null);
    setSelectedParam(null);
  };

  const startNew = (draft: TemplateDraft | null) => {
    if (!confirmDiscard()) return;
    setSelectedParam(null);
    setCreating({ nonce: Date.now(), draft });
  };

  const handleSaved = useCallback(
    (saved: MessageTemplate, created: boolean) => {
      setTemplates((prev) => {
        const list = prev ?? [];
        const index = list.findIndex((t) => t.id === saved.id);
        if (index === -1) return [saved, ...list];
        const copy = [...list];
        copy[index] = saved;
        return copy;
      });
      if (created) {
        setCreating(null);
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set('template', saved.id);
          return next;
        });
      }
    },
    [setParams],
  );

  const addStarter = async (starter: StarterTemplate) => {
    if (!accountOwnerId || !confirmDiscard()) return;
    setAddingStarter(starter.id);
    try {
      const created = await createMessageTemplate(accountOwnerId, starterToDraft(starter));
      handleSaved(created, true);
      setShowStarters(false);
      toast(`"${starter.name}" added as a draft`, 'success');
    } catch (e) {
      toast(describeTemplateError(e), 'error');
    } finally {
      setAddingStarter(null);
    }
  };

  const summary = useMemo(() => summarizeTemplates(templates ?? [], stats), [templates, stats]);
  const visible = useMemo(() => filterTemplates(templates ?? [], filters), [templates, filters]);
  const selected = useMemo(() => (templates ?? []).find((t) => t.id === selectedId) ?? null, [templates, selectedId]);
  const hasFilters = filters.channel !== 'all' || filters.status !== 'active' || filters.query.trim() !== '';
  const panelOpen = creating !== null || selectedId !== null;

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Templates">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Message templates are restricted. Ask your account owner to grant you the "Edit Business Profile" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const isStarterAdded = (s: StarterTemplate) =>
    (templates ?? []).some(
      (t) => t.status !== 'archived' && t.channel === s.channel && t.name.trim().toLowerCase() === s.name.toLowerCase(),
    );

  return (
    <DashboardLayout activeLabel="Templates">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <MessageSquareText size={22} className="text-accent" aria-hidden="true" /> Message Templates
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
              Reusable SMS and email copy with variables, a live preview and a review step, checked against carrier and anti-spam rules before it can be used.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" aria-expanded={showStarters} onClick={() => setShowStarters((v) => !v)}>
              <Sparkles size={16} aria-hidden="true" /> Starter templates
            </Button>
            <Button size="sm" onClick={() => startNew(null)}>
              <Plus size={16} aria-hidden="true" /> New template
            </Button>
          </div>
        </div>

        {templates === null ? (
          <div className="mb-6">
            <SkeletonStatGrid count={4} />
          </div>
        ) : (
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Active templates" value={String(summary.active)} />
            <StatTile label="Approved" value={String(summary.approved)} />
            <StatTile label="Awaiting review" value={String(summary.pendingReview)} />
            <StatTile label="Uses (30 days)" value={String(summary.uses30d)} />
          </div>
        )}

        {showStarters && (
          <section aria-label="Starter templates" className="mb-6 rounded-2xl border border-border bg-bg-secondary p-4">
            <h2 className="text-base font-semibold text-text-primary">Starter templates</h2>
            <p className="mb-4 mt-1 text-sm text-text-secondary">
              Written to pass A2P 10DLC and CAN-SPAM checks. They are added as drafts, so nothing is sent until you review and approve it.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {STARTER_TEMPLATES.map((s) => {
                const added = isStarterAdded(s);
                return (
                  <div key={s.id} className="flex flex-col rounded-xl border border-border bg-bg-primary p-3">
                    <p className="flex items-center gap-1.5 text-xs text-text-secondary">
                      <ChannelIcon channel={s.channel} /> {CHANNEL_LABELS[s.channel]} · {CATEGORY_LABELS[s.category]}
                    </p>
                    <p className="mt-1 font-semibold text-text-primary">{s.name}</p>
                    <p className="mt-1 flex-1 text-sm text-text-secondary">{s.summary}</p>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-3 w-full"
                      disabled={added || addingStarter !== null || templates === null}
                      onClick={() => void addStarter(s)}
                    >
                      {added ? 'Added' : addingStarter === s.id ? 'Adding…' : 'Add as draft'}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <div className={panelOpen ? 'hidden lg:block' : ''}>
            <div className="mb-3 space-y-3">
              <Input
                icon={Search}
                aria-label="Search templates"
                placeholder="Search templates"
                value={filters.query}
                onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
              />
              <div className="flex flex-wrap items-center gap-2">
                <div role="group" aria-label="Filter by channel" className="flex gap-1.5">
                  {CHANNEL_FILTERS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      aria-pressed={filters.channel === c.value}
                      onClick={() => setFilters((f) => ({ ...f, channel: c.value }))}
                      className={`focus-ring min-h-[40px] rounded-xl border px-3.5 text-sm font-semibold transition-colors ${
                        filters.channel === c.value ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <select
                  aria-label="Filter by status"
                  className={SELECT_CLASS}
                  value={filters.status}
                  onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as TemplateFilters['status'] }))}
                >
                  <option value="active">Active</option>
                  <option value="all">All statuses</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {templates === null ? (
              <SkeletonCardList count={4} />
            ) : loadError && templates.length === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="We couldn't load your templates"
                description="Check your connection and try again."
                action={{ label: 'Try again', onClick: retry }}
              />
            ) : templates.length === 0 ? (
              <EmptyState
                icon={MessageSquareText}
                title="Create your first template"
                description="Start from an A2P-safe starter or write your own. Nothing is sent until a template is approved."
                action={{ label: 'Browse starters', onClick: () => setShowStarters(true) }}
                secondaryAction={{ label: 'New template', onClick: () => startNew(null) }}
              />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Search}
                title="Nothing matches these filters"
                description="Try a different search or clear the filters."
                action={hasFilters ? { label: 'Clear filters', onClick: () => setFilters(DEFAULT_FILTERS) } : undefined}
              />
            ) : (
              <ul className="space-y-2.5" aria-label="Templates">
                {visible.map((t) => {
                  const active = !creating && t.id === selectedId;
                  const uses = stats[t.id]?.uses_30d ?? 0;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => select(t.id)}
                        aria-current={active ? 'true' : undefined}
                        className={`focus-ring w-full rounded-2xl border p-4 text-left transition-colors ${
                          active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 truncate font-semibold text-text-primary">{t.name}</p>
                          <StatusPill status={t.status} className="shrink-0" />
                        </div>
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
                          <ChannelIcon channel={t.channel} /> {CHANNEL_LABELS[t.channel]} · {CATEGORY_LABELS[t.category]}
                        </p>
                        <p className="mt-2 line-clamp-2 break-words text-sm text-text-secondary">
                          {t.channel === 'email' && t.subject ? t.subject : t.body}
                        </p>
                        {uses > 0 && (
                          <p className="mt-2 text-[11px] text-text-secondary">
                            {uses} use{uses === 1 ? '' : 's'} in the last 30 days
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className={panelOpen ? '' : 'hidden lg:block'}>
            {!accountOwnerId || templates === null ? (
              panelOpen ? <SkeletonCardList count={2} /> : null
            ) : creating ? (
              <TemplateEditor
                key={`new-${creating.nonce}`}
                template={null}
                initialDraft={creating.draft}
                accountOwnerId={accountOwnerId}
                currentUserId={user?.id ?? ''}
                isOwner={isOwner}
                canReview={canReview}
                onSaved={handleSaved}
                onClose={closePanel}
                onDirtyChange={onDirtyChange}
              />
            ) : selected ? (
              <TemplateEditor
                key={selected.id}
                template={selected}
                initialDraft={null}
                accountOwnerId={accountOwnerId}
                currentUserId={user?.id ?? ''}
                isOwner={isOwner}
                canReview={canReview}
                stats={stats[selected.id]}
                onSaved={handleSaved}
                onClose={closePanel}
                onDirtyChange={onDirtyChange}
              />
            ) : selectedId ? (
              <EmptyState
                icon={AlertTriangle}
                title="That template isn't available"
                description="It may have been removed or belongs to another account."
                action={{ label: 'Back to templates', onClick: closePanel }}
              />
            ) : (
              <EmptyState
                icon={MessageSquareText}
                title="Select a template"
                description="Choose one from the list to edit, preview and review it, or create a new one."
                action={{ label: 'New template', onClick: () => startNew(null) }}
              />
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
