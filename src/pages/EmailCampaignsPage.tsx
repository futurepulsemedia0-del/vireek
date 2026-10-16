import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  CalendarClock,
  Copy,
  FileText,
  Lock,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldOff,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { supabase } from '@/lib/supabase';
import {
  EXCLUSION_LABELS,
  PLACEHOLDERS,
  STATUS_META,
  bounceRate,
  callEmailCampaigns,
  clickRate,
  formatPct,
  isoToLocalInput,
  localInputToIso,
  openRate,
  previewEmail,
  progress,
  unsubscribeRate,
  validateDraft,
  validateSchedule,
  type AudiencePreview,
  type EmailCampaign,
  type EmailCampaignLink,
  type EmailSuppression,
  type EmailTemplate,
  type ExclusionReason,
} from '@/lib/emailCampaigns';

type Tab = 'campaigns' | 'templates' | 'suppressions';
interface SegmentOption {
  id: string;
  name: string;
  member_count: number;
}
type Form = Pick<
  EmailCampaign,
  'name' | 'subject' | 'preheader' | 'body' | 'from_name' | 'reply_to' | 'sender_address' | 'audience' | 'segment_id'
>;

const EMPTY_FORM: Form = {
  name: '',
  subject: '',
  preheader: '',
  body: '',
  from_name: '',
  reply_to: '',
  sender_address: '',
  audience: 'all_opted_in',
  segment_id: null,
};

const POLL_MS = 10_000;

const toneClass = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
} as const;

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export default function EmailCampaignsPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();

  // All rows are keyed by the ACCOUNT OWNER's id (differs from user.id for team members).
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_view_billing;
  const companyName = profile?.company_name || 'Your company';

  const [tab, setTab] = useState<Tab>('campaigns');
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [segments, setSegments] = useState<SegmentOption[]>([]);
  const [suppressions, setSuppressions] = useState<EmailSuppression[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [builder, setBuilder] = useState<{ campaign: EmailCampaign | null; seed: Form } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'campaign' | 'template'; id: string; name: string } | null>(null);
  const [pendingCancel, setPendingCancel] = useState<EmailCampaign | null>(null);

  const loadAll = useCallback(
    async (silent = false) => {
      if (!ownerId) return;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const [c, t, s] = await Promise.all([
        supabase.from('email_campaigns').select('*').eq('user_id', ownerId).order('created_at', { ascending: false }),
        supabase.from('email_templates').select('*').eq('user_id', ownerId).order('created_at', { ascending: false }),
        supabase.from('marketing_segments').select('id, name, member_count').eq('user_id', ownerId).order('name'),
      ]);
      const failure = c.error ?? t.error ?? s.error;
      if (failure) {
        if (!silent) setError(failure.message);
      } else {
        setCampaigns((c.data ?? []) as EmailCampaign[]);
        setTemplates((t.data ?? []) as EmailTemplate[]);
        setSegments((s.data ?? []) as SegmentOption[]);
      }
      if (!silent) setLoading(false);
    },
    [ownerId],
  );

  useEffect(() => {
    if (canAccess) void loadAll();
  }, [canAccess, loadAll]);

  // Live progress while anything is in flight.
  const inFlight = campaigns.some((c) => c.status === 'sending' || c.status === 'scheduled');
  useEffect(() => {
    if (!inFlight || !canAccess) return;
    const id = window.setInterval(() => void loadAll(true), POLL_MS);
    return () => window.clearInterval(id);
  }, [inFlight, canAccess, loadAll]);

  useEffect(() => {
    if (tab !== 'suppressions' || !ownerId || suppressions) return;
    void supabase
      .from('email_suppressions')
      .select('id, email, reason, created_at')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(500)
      .then(({ data, error: e }) => {
        if (e) toast(e.message, 'error');
        else setSuppressions((data ?? []) as EmailSuppression[]);
      });
  }, [tab, ownerId, suppressions, toast]);

  const act = async (c: EmailCampaign, action: 'pause' | 'resume' | 'cancel' | 'unschedule') => {
    try {
      await callEmailCampaigns(action, c.id);
      toast(`Campaign ${action === 'unschedule' ? 'moved back to draft' : action + (action.endsWith('e') ? 'd' : 'ed')}.`, 'success');
      void loadAll(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed.', 'error');
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || !ownerId) return;
    const table = pendingDelete.kind === 'campaign' ? 'email_campaigns' : 'email_templates';
    const { error: e } = await supabase.from(table).delete().eq('id', pendingDelete.id).eq('user_id', ownerId);
    if (e) return toast(e.message, 'error');
    toast('Deleted.', 'success');
    setPendingDelete(null);
    void loadAll(true);
  };

  const confirmCancel = async () => {
    if (!pendingCancel) return;
    await act(pendingCancel, 'cancel');
    setPendingCancel(null);
  };

  const duplicate = (c: EmailCampaign) =>
    setBuilder({
      campaign: null,
      seed: { ...EMPTY_FORM, ...pickForm(c), name: `${c.name} (copy)` },
    });

  // ---------- gates ----------
  if (authLoading || profileLoading) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-6xl space-y-4 px-4 py-8" aria-busy="true">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full" />
        </div>
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-2xl px-4 py-16">
          <EmptyState
            icon={Lock}
            title="You don't have access to Email Campaigns"
            description="Bulk email reaches your customers directly, so it's limited to the account owner and roles with billing access. Ask your account owner to grant access."
          />
        </div>
      </DashboardLayout>
    );
  }

  if (builder) {
    return (
      <DashboardLayout>
        <CampaignBuilder
          key={builder.campaign?.id ?? 'new'}
          ownerId={ownerId as string}
          campaign={builder.campaign}
          seed={builder.seed}
          templates={templates}
          segments={segments}
          companyName={companyName}
          onTemplatesChanged={() => void loadAll(true)}
          onClose={() => {
            setBuilder(null);
            void loadAll(true);
          }}
        />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <Mail className="h-7 w-7 text-accent" aria-hidden />
              <h1 className="text-2xl font-bold text-text-primary">Email Campaigns</h1>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Send newsletters and offers to customers who opted in. Every email includes your address and a one-click
              unsubscribe, and anyone who unsubscribes, bounces or complains is never emailed again.
            </p>
          </div>
          <Button onClick={() => setBuilder({ campaign: null, seed: EMPTY_FORM })}>
            <Plus className="h-4 w-4" aria-hidden /> New campaign
          </Button>
        </header>

        <div role="tablist" aria-label="Email campaigns sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
          {(
            [
              ['campaigns', 'Campaigns'],
              ['templates', 'Templates'],
              ['suppressions', 'Do-not-email list'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`focus-ring -mb-px min-h-[44px] shrink-0 border-b-2 px-4 text-sm font-medium transition-colors ${
                tab === id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : error ? (
          <Card className="p-5 hover:translate-y-0">
            <p className="flex items-start gap-2 text-sm text-danger">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
            </p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => void loadAll()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Retry
            </Button>
          </Card>
        ) : tab === 'campaigns' ? (
          campaigns.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No campaigns yet"
              description="Write your first email, pick who should get it, and send it now or schedule it."
              action={{ label: 'Create a campaign', onClick: () => setBuilder({ campaign: null, seed: EMPTY_FORM }) }}
            />
          ) : (
            <ul className="space-y-4">
              {campaigns.map((c) => (
                <li key={c.id}>
                  <CampaignCard
                    c={c}
                    expanded={detailId === c.id}
                    onToggle={() => setDetailId(detailId === c.id ? null : c.id)}
                    onEdit={() => setBuilder({ campaign: c, seed: pickForm(c) })}
                    onDuplicate={() => duplicate(c)}
                    onDelete={() => setPendingDelete({ kind: 'campaign', id: c.id, name: c.name })}
                    onAction={(a) => (a === 'cancel' ? setPendingCancel(c) : void act(c, a))}
                  />
                </li>
              ))}
            </ul>
          )
        ) : tab === 'templates' ? (
          <TemplatesTab
            ownerId={ownerId as string}
            templates={templates}
            onChanged={() => void loadAll(true)}
            onUse={(t) =>
              setBuilder({ campaign: null, seed: { ...EMPTY_FORM, name: t.name, subject: t.subject, preheader: t.preheader ?? '', body: t.body } })
            }
            onDelete={(t) => setPendingDelete({ kind: 'template', id: t.id, name: t.name })}
          />
        ) : suppressions === null ? (
          <Skeleton className="h-40 w-full" />
        ) : suppressions.length === 0 ? (
          <EmptyState
            icon={ShieldOff}
            title="Nobody is on the do-not-email list"
            description="Addresses that unsubscribe, hard-bounce or report spam are added automatically and are skipped in every future campaign."
          />
        ) : (
          <Card className="p-0 hover:translate-y-0">
            <ul className="divide-y divide-border">
              {suppressions.map((s) => (
                <li key={s.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="truncate text-sm text-text-primary">{s.email}</span>
                  <span className="flex items-center gap-3 text-xs text-text-secondary">
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 capitalize">{s.reason}</span>
                    {fmtDate(s.created_at)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-border px-4 py-3 text-xs text-text-secondary">
              These addresses can only re-subscribe themselves; they can't be removed from here.
            </p>
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete this ${pendingDelete?.kind ?? 'item'}?`}
        description={`"${pendingDelete?.name ?? ''}" will be permanently removed${pendingDelete?.kind === 'campaign' ? ', along with its delivery and tracking history' : ''}.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={!!pendingCancel}
        title="Cancel this campaign?"
        description={`Emails that haven't gone out yet will not be sent. Messages already delivered can't be recalled.`}
        confirmLabel="Cancel campaign"
        onConfirm={confirmCancel}
        onCancel={() => setPendingCancel(null)}
      />
    </DashboardLayout>
  );
}

function pickForm(c: EmailCampaign): Form {
  return {
    name: c.name,
    subject: c.subject,
    preheader: c.preheader ?? '',
    body: c.body,
    from_name: c.from_name ?? '',
    reply_to: c.reply_to ?? '',
    sender_address: c.sender_address ?? '',
    audience: c.audience,
    segment_id: c.segment_id,
  };
}

// ============================================================
// Campaign card + details
// ============================================================

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-text-primary" title={hint}>
        {value}
      </p>
    </div>
  );
}

function CampaignCard({
  c,
  expanded,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
  onAction,
}: {
  c: EmailCampaign;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAction: (a: 'pause' | 'resume' | 'cancel' | 'unschedule') => void;
}) {
  const meta = STATUS_META[c.status];
  const started = c.recipient_count > 0;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="space-y-4 p-4 hover:translate-y-0 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-text-primary">{c.name}</h2>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${toneClass[meta.tone]}`}>{meta.label}</span>
            </div>
            <p className="mt-0.5 truncate text-sm text-text-secondary">{c.subject || 'No subject yet'}</p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {c.status === 'scheduled'
                ? `Sends ${fmtDate(c.scheduled_at)}`
                : c.completed_at
                  ? `Finished ${fmtDate(c.completed_at)}`
                  : c.started_at
                    ? `Started ${fmtDate(c.started_at)}`
                    : `Created ${fmtDate(c.created_at)}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {c.status === 'draft' && (
              <Button size="sm" variant="secondary" onClick={onEdit}>
                Edit
              </Button>
            )}
            {c.status === 'scheduled' && (
              <Button size="sm" variant="secondary" onClick={() => onAction('unschedule')}>
                Unschedule
              </Button>
            )}
            {c.status === 'sending' && (
              <Button size="sm" variant="secondary" onClick={() => onAction('pause')}>
                <Pause className="h-4 w-4" aria-hidden /> Pause
              </Button>
            )}
            {c.status === 'paused' && (
              <Button size="sm" variant="secondary" onClick={() => onAction('resume')}>
                <Play className="h-4 w-4" aria-hidden /> Resume
              </Button>
            )}
            {['scheduled', 'sending', 'paused'].includes(c.status) && (
              <Button size="sm" variant="ghost" onClick={() => onAction('cancel')}>
                <X className="h-4 w-4" aria-hidden /> Cancel
              </Button>
            )}
            {started && (
              <Button size="sm" variant="ghost" onClick={onToggle} aria-expanded={expanded}>
                {expanded ? 'Hide details' : 'Details'}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDuplicate} aria-label={`Duplicate ${c.name}`}>
              <Copy className="h-4 w-4" aria-hidden />
            </Button>
            {c.status !== 'sending' && (
              <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete ${c.name}`}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
        </div>

        {c.last_error && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {c.last_error}
          </p>
        )}

        {started && (
          <>
            {(c.status === 'sending' || c.status === 'paused') && (
              <div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-bg-tertiary"
                  role="progressbar"
                  aria-label="Sending progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress(c) * 100)}
                >
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress(c) * 100}%` }} />
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  {(c.sent_count + c.failed_count).toLocaleString()} of {c.recipient_count.toLocaleString()} processed
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Recipients" value={c.recipient_count.toLocaleString()} />
              <Stat label="Sent" value={c.sent_count.toLocaleString()} hint={c.failed_count ? `${c.failed_count} failed` : undefined} />
              <Stat label="Opened" value={formatPct(openRate(c))} hint="Approximate — some mail apps pre-load images" />
              <Stat label="Clicked" value={formatPct(clickRate(c))} />
              <Stat label="Unsubscribed" value={formatPct(unsubscribeRate(c))} />
              <Stat label="Bounced" value={formatPct(bounceRate(c))} />
            </div>
          </>
        )}

        {expanded && <CampaignDetails c={c} />}
      </Card>
    </motion.div>
  );
}

function CampaignDetails({ c }: { c: EmailCampaign }) {
  const [links, setLinks] = useState<EmailCampaignLink[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('email_campaign_links')
      .select('id, url, click_count')
      .eq('campaign_id', c.id)
      .eq('user_id', c.user_id)
      .order('click_count', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setErr(error.message);
        else setLinks((data ?? []) as EmailCampaignLink[]);
      });
    return () => {
      cancelled = true;
    };
  }, [c.id, c.user_id]);

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-text-secondary">Delivered</dt><dd className="font-medium text-text-primary">{c.delivered_count.toLocaleString()}</dd></div>
        <div><dt className="text-xs text-text-secondary">Failed to send</dt><dd className="font-medium text-text-primary">{c.failed_count.toLocaleString()}</dd></div>
        <div><dt className="text-xs text-text-secondary">Unique opens</dt><dd className="font-medium text-text-primary">{c.unique_opens.toLocaleString()}</dd></div>
        <div><dt className="text-xs text-text-secondary">Unique clicks</dt><dd className="font-medium text-text-primary">{c.unique_clicks.toLocaleString()}</dd></div>
      </dl>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">Link clicks</h3>
        {err ? (
          <p className="text-sm text-danger">{err}</p>
        ) : links === null ? (
          <Skeleton className="h-10 w-full" />
        ) : links.length === 0 ? (
          <p className="text-sm text-text-secondary">This email had no links.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {links.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="truncate text-text-primary" title={l.url}>{l.url}</span>
                <span className="shrink-0 tabular-nums text-text-secondary">{l.click_count.toLocaleString()} clicks</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-text-secondary">Opens are approximate: some mail apps pre-load images, which can inflate them.</p>
      </div>
    </div>
  );
}

// ============================================================
// Templates
// ============================================================

function TemplatesTab({
  ownerId,
  templates,
  onChanged,
  onUse,
  onDelete,
}: {
  ownerId: string;
  templates: EmailTemplate[];
  onChanged: () => void;
  onUse: (t: EmailTemplate) => void;
  onDelete: (t: EmailTemplate) => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<{ id: string | null; name: string; subject: string; preheader: string; body: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) return toast('Name the template first.', 'error');
    setSaving(true);
    const payload = {
      name: editing.name.trim(),
      subject: editing.subject.trim(),
      preheader: editing.preheader.trim() || null,
      body: editing.body,
      updated_at: new Date().toISOString(),
    };
    const { error } = editing.id
      ? await supabase.from('email_templates').update(payload).eq('id', editing.id).eq('user_id', ownerId)
      : await supabase.from('email_templates').insert({ ...payload, user_id: ownerId });
    setSaving(false);
    if (error) return toast(error.message, 'error');
    toast('Template saved.', 'success');
    setEditing(null);
    onChanged();
  };

  if (editing) {
    return (
      <Card className="space-y-4 p-5 hover:translate-y-0">
        <Input label="Template name" value={editing.name} maxLength={120} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        <Input label="Subject" value={editing.subject} maxLength={200} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
        <Input label="Preview text (optional)" value={editing.preheader} maxLength={200} onChange={(e) => setEditing({ ...editing, preheader: e.target.value })} />
        <Textarea label="Body" rows={8} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} helperText={`Personalise with ${PLACEHOLDERS.join(', ')}.`} />
        <div className="flex gap-2">
          <Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save template'}</Button>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      </Card>
    );
  }

  return (
    <div>
      <Button variant="secondary" size="sm" className="mb-4" onClick={() => setEditing({ id: null, name: '', subject: '', preheader: '', body: '' })}>
        <Plus className="h-4 w-4" aria-hidden /> New template
      </Button>
      {templates.length === 0 ? (
        <EmptyState icon={FileText} title="No templates yet" description="Save an email you send often as a template, or build one here, and start new campaigns from it." />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {templates.map((t) => (
            <li key={t.id}>
              <Card className="flex h-full flex-col gap-3 p-4 hover:translate-y-0">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold text-text-primary">{t.name}</h2>
                  <p className="truncate text-sm text-text-secondary">{t.subject || 'No subject'}</p>
                  <p className="mt-2 line-clamp-2 text-xs text-text-secondary">{t.body}</p>
                </div>
                <div className="mt-auto flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => onUse(t)}>Use</Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing({ id: t.id, name: t.name, subject: t.subject, preheader: t.preheader ?? '', body: t.body })}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => onDelete(t)} aria-label={`Delete ${t.name}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// Builder
// ============================================================

function CampaignBuilder({
  ownerId,
  campaign,
  seed,
  templates,
  segments,
  companyName,
  onTemplatesChanged,
  onClose,
}: {
  ownerId: string;
  campaign: EmailCampaign | null;
  seed: Form;
  templates: EmailTemplate[];
  segments: SegmentOption[];
  companyName: string;
  onTemplatesChanged: () => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(seed);
  const [savedId, setSavedId] = useState<string | null>(campaign?.id ?? null);
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'review' | 'send' | 'template'>(null);
  const [review, setReview] = useState<AudiencePreview | null>(null);
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [when, setWhen] = useState(() => isoToLocalInput(new Date(Date.now() + 3_600_000).toISOString()));
  const [ack, setAck] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setReview(null); // any edit invalidates the audience review
  };

  const errors = useMemo(() => validateDraft({ ...form, reply_to: form.reply_to || null }), [form]);
  const preview = useMemo(
    () => previewEmail({ subject: form.subject, preheader: form.preheader, body: form.body, sender_address: form.sender_address }, companyName),
    [form.subject, form.preheader, form.body, form.sender_address, companyName],
  );

  const insertPlaceholder = (token: string) => {
    const el = bodyRef.current;
    if (!el) return set('body', form.body + token);
    const { selectionStart: a, selectionEnd: b } = el;
    set('body', form.body.slice(0, a) + token + form.body.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };

  const payload = () => ({
    name: form.name.trim(),
    subject: form.subject.trim(),
    preheader: form.preheader?.trim() || null,
    body: form.body,
    from_name: form.from_name?.trim() || null,
    reply_to: form.reply_to?.trim().toLowerCase() || null,
    sender_address: form.sender_address?.trim() || null,
    audience: form.audience,
    segment_id: form.audience === 'segment' ? form.segment_id : null,
    updated_at: new Date().toISOString(),
  });

  /** Persists the draft (insert or update) and returns its id. */
  const persist = async (): Promise<string | null> => {
    if (!form.name.trim()) {
      toast('Give the campaign a name first.', 'error');
      return null;
    }
    if (savedId) {
      const { error } = await supabase.from('email_campaigns').update(payload()).eq('id', savedId).eq('user_id', ownerId);
      if (error) {
        toast(error.message, 'error');
        return null;
      }
      return savedId;
    }
    const { data, error } = await supabase.from('email_campaigns').insert({ ...payload(), user_id: ownerId }).select('id').single();
    if (error || !data) {
      toast(error?.message ?? 'Could not save the draft.', 'error');
      return null;
    }
    setSavedId(data.id);
    return data.id as string;
  };

  const saveDraft = async () => {
    setBusy('save');
    const id = await persist();
    setBusy(null);
    if (id) toast('Draft saved.', 'success');
  };

  const sendTest = async () => {
    setBusy('test');
    try {
      const id = await persist();
      if (!id) return;
      const res = await callEmailCampaigns<{ sentTo: string }>('test', id);
      toast(`Test email sent to ${res.sentTo}.`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Test send failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const startReview = async () => {
    if (errors.length) return toast(errors[0], 'error');
    setBusy('review');
    try {
      const id = await persist();
      if (!id) return;
      setReview(await callEmailCampaigns<AudiencePreview>('preview', id));
      setAck(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not check the audience.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const scheduleError = mode === 'later' ? (when ? validateSchedule(localInputToIso(when)) : 'Pick a valid date and time.') : null;

  const confirmSend = async () => {
    if (!savedId || !ack || scheduleError) return;
    setBusy('send');
    try {
      const res = await callEmailCampaigns<{ status: string }>('send', savedId, {
        ack: true,
        scheduledAt: mode === 'later' ? localInputToIso(when) : null,
      });
      toast(res.status === 'scheduled' ? 'Campaign scheduled.' : 'Campaign is sending.', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the campaign.', 'error');
      setBusy(null);
    }
  };

  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setForm((f) => ({ ...f, subject: t.subject, preheader: t.preheader ?? '', body: t.body }));
    setReview(null);
  };

  const saveAsTemplate = async () => {
    const name = window.prompt('Template name', form.name || 'My template')?.trim();
    if (!name) return;
    setBusy('template');
    const { error } = await supabase
      .from('email_templates')
      .insert({ user_id: ownerId, name, subject: form.subject.trim(), preheader: form.preheader?.trim() || null, body: form.body });
    setBusy(null);
    if (error) return toast(error.message, 'error');
    toast('Saved as a template.', 'success');
    onTemplatesChanged();
  };

  const eligibleLabel = review ? `${review.eligible.toLocaleString()} of ${review.total.toLocaleString()} contacts will receive this email` : '';

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-text-primary sm:text-2xl">{savedId ? 'Edit campaign' : 'New campaign'}</h1>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden /> Close
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <Card className="space-y-4 p-5 hover:translate-y-0">
            <Input label="Campaign name (internal)" value={form.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
            {templates.length > 0 && (
              <div>
                <label htmlFor="tpl" className="mb-1.5 block text-sm font-medium text-text-primary">Start from a template</label>
                <select
                  id="tpl"
                  defaultValue=""
                  onChange={(e) => {
                    applyTemplate(e.target.value);
                    e.target.value = '';
                  }}
                  className="focus-ring min-h-[48px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary"
                >
                  <option value="">Choose a template…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}
            <Input label="Subject" required value={form.subject} maxLength={200} onChange={(e) => set('subject', e.target.value)} />
            <Input label="Preview text (optional)" value={form.preheader ?? ''} maxLength={200} onChange={(e) => set('preheader', e.target.value)} helperText="Shown next to the subject in most inboxes." />
            <div>
              <Textarea
                ref={bodyRef}
                label="Message"
                required
                rows={10}
                value={form.body}
                onChange={(e) => set('body', e.target.value)}
                helperText="Blank line = new paragraph. Links are tracked automatically."
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {PLACEHOLDERS.map((p) => (
                  <button key={p} type="button" onClick={() => insertPlaceholder(p)} className="focus-ring min-h-[36px] rounded-full border border-border px-3 font-mono text-xs text-text-secondary hover:border-accent hover:text-text-primary">
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <Card className="space-y-4 p-5 hover:translate-y-0">
            <h2 className="text-base font-semibold text-text-primary">Audience</h2>
            <div>
              <label htmlFor="aud" className="mb-1.5 block text-sm font-medium text-text-primary">Send to</label>
              <select
                id="aud"
                value={form.audience === 'segment' ? form.segment_id ?? '' : 'all'}
                onChange={(e) => {
                  if (e.target.value === 'all') setForm((f) => ({ ...f, audience: 'all_opted_in', segment_id: null }));
                  else setForm((f) => ({ ...f, audience: 'segment', segment_id: e.target.value || null }));
                  setReview(null);
                }}
                className="focus-ring min-h-[48px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary"
              >
                <option value="all">All customers who opted in to marketing</option>
                {form.audience === 'segment' && !form.segment_id && <option value="">Choose a saved audience…</option>}
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.member_count.toLocaleString()})</option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-text-secondary">
                Build audiences on the Audiences page. Only customers who opted in are emailed, whatever the audience.
              </p>
            </div>
            <Input label="Sender name" value={form.from_name ?? ''} maxLength={80} placeholder={companyName} onChange={(e) => set('from_name', e.target.value)} />
            <Input label="Reply-to email" type="email" value={form.reply_to ?? ''} maxLength={254} onChange={(e) => set('reply_to', e.target.value)} />
            <Textarea
              label="Business postal address"
              required
              rows={2}
              value={form.sender_address ?? ''}
              maxLength={300}
              onChange={(e) => set('sender_address', e.target.value)}
              helperText="Printed in every footer — required by CAN-SPAM, CASL and similar laws."
            />
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="space-y-3 p-5 hover:translate-y-0">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-text-primary">Preview</h2>
              <div className="flex gap-1" role="group" aria-label="Preview width">
                {[false, true].map((m) => (
                  <button key={String(m)} type="button" aria-pressed={mobilePreview === m} onClick={() => setMobilePreview(m)} className={`focus-ring min-h-[36px] rounded-lg px-3 text-xs ${mobilePreview === m ? 'bg-accent/10 text-accent' : 'text-text-secondary'}`}>
                    {m ? 'Mobile' : 'Desktop'}
                  </button>
                ))}
              </div>
            </div>
            <p className="truncate text-sm text-text-secondary"><span className="font-medium text-text-primary">Subject:</span> {preview.subject}</p>
            <div className="overflow-hidden rounded-xl border border-border bg-white">
              {/* sandbox="" = no scripts, no forms, no same-origin: the preview can never run user content. */}
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={preview.html}
                className="mx-auto block h-[420px] border-0 transition-all"
                style={{ width: mobilePreview ? 375 : '100%', maxWidth: '100%' }}
              />
            </div>
          </Card>

          <Card className="space-y-4 p-5 hover:translate-y-0">
            <h2 className="text-base font-semibold text-text-primary">Send</h2>
            {errors.length > 0 && (
              <ul className="space-y-1 text-sm text-text-secondary" aria-label="Things to fix before sending">
                {errors.map((e) => (
                  <li key={e} className="flex items-start gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-500" aria-hidden /> {e}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="secondary" size="sm" onClick={() => void saveDraft()} disabled={busy !== null}>
                {busy === 'save' ? 'Saving…' : 'Save draft'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void sendTest()} disabled={busy !== null || errors.length > 0}>
                {busy === 'test' ? 'Sending…' : 'Send me a test'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void saveAsTemplate()} disabled={busy !== null || !form.body.trim()}>
                Save as template
              </Button>
            </div>

            {!review ? (
              <Button className="w-full" onClick={() => void startReview()} disabled={busy !== null || errors.length > 0}>
                <Send className="h-4 w-4" aria-hidden /> {busy === 'review' ? 'Checking audience…' : 'Review & send'}
              </Button>
            ) : (
              <div className="space-y-4 rounded-xl border border-border bg-bg-primary p-4" aria-live="polite">
                <p className="text-sm font-semibold text-text-primary">{eligibleLabel}</p>
                {Object.entries(review.excluded).some(([, n]) => n > 0) && (
                  <ul className="space-y-0.5 text-xs text-text-secondary">
                    {(Object.entries(review.excluded) as [ExclusionReason, number][])
                      .filter(([, n]) => n > 0)
                      .map(([k, n]) => (
                        <li key={k}>{n.toLocaleString()} skipped — {EXCLUSION_LABELS[k]}</li>
                      ))}
                  </ul>
                )}
                {review.eligible === 0 ? (
                  <p role="alert" className="text-sm text-danger">Nobody in this audience can be emailed. Choose another audience or collect marketing opt-ins first.</p>
                ) : (
                  <>
                    <fieldset className="space-y-2">
                      <legend className="sr-only">When to send</legend>
                      {(['now', 'later'] as const).map((m) => (
                        <label key={m} className="flex min-h-[40px] cursor-pointer items-center gap-2 text-sm text-text-primary">
                          <input type="radio" name="when" checked={mode === m} onChange={() => setMode(m)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
                          {m === 'now' ? 'Send now' : 'Schedule for later'}
                        </label>
                      ))}
                      {mode === 'later' && (
                        <div>
                          <Input label="Send at (your time zone)" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} error={scheduleError ?? undefined} />
                        </div>
                      )}
                    </fieldset>
                    <label className="flex cursor-pointer items-start gap-2 text-sm text-text-secondary">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]" />
                      <span>I confirm these customers agreed to receive marketing email from my business and I'll honor unsubscribe requests.</span>
                    </label>
                    <Button className="w-full" onClick={() => void confirmSend()} disabled={!ack || !!scheduleError || busy !== null}>
                      {busy === 'send' ? 'Working…' : mode === 'now' ? `Send to ${review.eligible.toLocaleString()} people` : 'Schedule campaign'}
                    </Button>
                  </>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
