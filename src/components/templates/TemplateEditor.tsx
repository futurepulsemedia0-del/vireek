import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, Lock, XCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { StatusPill } from '@/components/templates/StatusPill';
import { TemplatePreview } from '@/components/templates/TemplatePreview';
import { useToast } from '@/contexts/ToastContext';
import {
  ACTION_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  CHANNELS,
  CHANNEL_LABELS,
  EMPTY_DRAFT,
  NAME_LIMIT,
  TEMPLATE_VARIABLES,
  VARIABLE_GROUP_LABELS,
  availableActions,
  draftsEqual,
  editResetsApproval,
  lintTemplate,
  summarizeLint,
  toDraft,
  variableSnippet,
  type LintSeverity,
  type MessageTemplate,
  type ReviewAction,
  type TemplateCategory,
  type TemplateChannel,
  type TemplateDraft,
  type TemplateStats,
  type VariableGroup,
} from '@/lib/messageTemplates';
import {
  createMessageTemplate,
  describeTemplateError,
  reviewMessageTemplate,
  updateMessageTemplate,
} from '@/lib/messageTemplatesApi';

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

const ACTION_TOAST: Record<ReviewAction, string> = {
  submit: 'Submitted for review',
  approve: 'Template approved',
  reject: 'Template rejected',
  archive: 'Template archived',
  restore: 'Restored as a draft',
};

const GROUP_ORDER: VariableGroup[] = ['customer', 'business', 'job', 'links'];

const LINT_STYLES: Record<LintSeverity, { icon: typeof Info; tone: string }> = {
  error: { icon: XCircle, tone: 'text-danger' },
  warning: { icon: AlertTriangle, tone: 'text-warning-500' },
  info: { icon: Info, tone: 'text-text-secondary' },
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface TemplateEditorProps {
  /** null = creating a new template. */
  template: MessageTemplate | null;
  initialDraft: TemplateDraft | null;
  accountOwnerId: string;
  currentUserId: string;
  isOwner: boolean;
  canReview: boolean;
  stats?: TemplateStats;
  onSaved: (template: MessageTemplate, created: boolean) => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function TemplateEditor({
  template,
  initialDraft,
  accountOwnerId,
  currentUserId,
  isOwner,
  canReview,
  stats,
  onSaved,
  onClose,
  onDirtyChange,
}: TemplateEditorProps) {
  const { toast } = useToast();
  const baseline = useMemo(() => (template ? toDraft(template) : (initialDraft ?? EMPTY_DRAFT)), [template, initialDraft]);
  const [draft, setDraft] = useState<TemplateDraft>(baseline);
  const [busy, setBusy] = useState<'save' | ReviewAction | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [lastField, setLastField] = useState<'subject' | 'body'>('body');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  const dirty = !draftsEqual(draft, baseline);
  const readOnly = template?.status === 'archived';
  const locked = readOnly || busy !== null;
  const issues = useMemo(() => lintTemplate(draft), [draft]);
  const lint = useMemo(() => summarizeLint(issues), [issues]);
  const actions = template
    ? availableActions({ status: template.status, canReview, isOwner, isAuthor: template.created_by === currentUserId })
    : [];
  const canSave = !locked && draft.name.trim() !== '' && draft.body.trim() !== '' && (template ? dirty : true);

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const patch = (changes: Partial<TemplateDraft>) => setDraft((d) => ({ ...d, ...changes }));

  const insertVariable = (snippet: string) => {
    if (locked) return;
    const field = lastField === 'subject' && draft.channel === 'email' ? 'subject' : 'body';
    const el = field === 'subject' ? subjectRef.current : bodyRef.current;
    const current = field === 'subject' ? draft.subject : draft.body;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + snippet + current.slice(end);
    patch(field === 'subject' ? { subject: next } : { body: next });
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + snippet.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  const save = async () => {
    setBusy('save');
    try {
      const saved = template
        ? await updateMessageTemplate(template.id, accountOwnerId, template.updated_at, draft)
        : await createMessageTemplate(accountOwnerId, draft);
      onSaved(saved, !template);
      toast(
        !template
          ? 'Template created'
          : editResetsApproval(template.status) && saved.status === 'draft'
            ? 'Saved. Approval was reset, so this needs a new review.'
            : 'Changes saved',
        'success',
      );
    } catch (e) {
      toast(describeTemplateError(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const run = async (action: ReviewAction, note?: string) => {
    if (!template) return;
    setBusy(action);
    try {
      let current = template;
      if (action === 'submit' && dirty) {
        current = await updateMessageTemplate(template.id, accountOwnerId, template.updated_at, draft);
        onSaved(current, false);
      }
      const next = await reviewMessageTemplate(current.id, action, note);
      onSaved(next, false);
      setDraft(toDraft(next));
      setRejecting(false);
      setRejectNote('');
      toast(ACTION_TOAST[action], 'success');
    } catch (e) {
      toast(describeTemplateError(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const requestArchive = () => {
    if (template && (template.status === 'approved' || template.status === 'pending_review')) setConfirmArchive(true);
    else void run('archive');
  };

  const isSms = draft.channel === 'sms';
  const reviewerView = template?.status === 'pending_review' && actions.includes('approve');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" className="lg:hidden" onClick={onClose} aria-label="Back to templates">
          <ArrowLeft size={16} aria-hidden="true" /> Back
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-bold text-text-primary">{template ? template.name : 'New template'}</h2>
        {template && <StatusPill status={template.status} />}
      </div>

      {template?.status === 'rejected' && (
        <div role="status" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-text-primary">
          <p className="font-semibold text-danger">Changes requested</p>
          <p className="mt-0.5 whitespace-pre-wrap">{template.review_note ?? 'The reviewer did not leave a note.'}</p>
        </div>
      )}
      {template?.status === 'pending_review' && (
        <div role="status" className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">
          {reviewerView ? 'This template is waiting for your review.' : 'Waiting for a reviewer. You will see the decision here.'}
        </div>
      )}
      {template?.status === 'approved' && (
        <div role="status" className="rounded-xl border border-success/30 bg-success/10 p-3 text-sm text-text-primary">
          Approved on {formatDate(template.reviewed_at)} and ready to use. Editing the content sends it back to draft for a new review.
        </div>
      )}
      {readOnly && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-border bg-bg-tertiary p-3 text-sm text-text-secondary">
          <Lock size={14} aria-hidden="true" /> Archived. Restore it to edit or reuse.
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
          <Input
            label="Template name"
            required
            value={draft.name}
            maxLength={NAME_LIMIT}
            disabled={locked}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g. Day-before reminder"
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="mb-1.5 block text-sm font-medium text-text-primary">Channel</span>
              <div role="group" aria-label="Channel" className="grid grid-cols-2 gap-2">
                {CHANNELS.map((c: TemplateChannel) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={draft.channel === c}
                    disabled={locked}
                    onClick={() => patch({ channel: c })}
                    className={`focus-ring min-h-[48px] rounded-xl border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      draft.channel === c ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {CHANNEL_LABELS[c]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor="template-category" className="mb-1.5 block text-sm font-medium text-text-primary">
                Category
              </label>
              <select
                id="template-category"
                className={SELECT_CLASS}
                value={draft.category}
                disabled={locked}
                onChange={(e) => patch({ category: e.target.value as TemplateCategory })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!isSms && (
            <Input
              ref={subjectRef}
              label="Subject line"
              required
              value={draft.subject}
              disabled={locked}
              maxLength={200}
              onFocus={() => setLastField('subject')}
              onChange={(e) => patch({ subject: e.target.value })}
              placeholder="e.g. Your appointment is confirmed"
            />
          )}

          <Textarea
            ref={bodyRef}
            label="Message"
            required
            rows={isSms ? 6 : 12}
            value={draft.body}
            disabled={locked}
            onFocus={() => setLastField('body')}
            onChange={(e) => patch({ body: e.target.value })}
            placeholder={isSms ? '{{business_name}}: Hi {{first_name|there}}, ...' : 'Write your email here'}
            helperText={isSms ? 'Plain text only. Include your business name and "Reply STOP to opt out."' : 'Plain text. Line breaks are kept.'}
          />

          <fieldset disabled={locked} className="min-w-0">
            <legend className="mb-1.5 text-sm font-medium text-text-primary">Insert variable</legend>
            <div className="space-y-2">
              {GROUP_ORDER.map((group) => (
                <div key={group} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-full text-[11px] font-medium uppercase tracking-wide text-text-secondary sm:w-auto sm:min-w-[68px]">
                    {VARIABLE_GROUP_LABELS[group]}
                  </span>
                  {TEMPLATE_VARIABLES.filter((v) => v.group === group).map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertVariable(variableSnippet(v))}
                      className="focus-ring min-h-[32px] rounded-lg border border-border bg-bg-primary px-2.5 text-xs text-text-primary transition-colors hover:border-accent/50 disabled:opacity-50"
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </fieldset>

          {rejecting && (
            <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-3">
              <Textarea
                label="Reason for rejection"
                required
                rows={3}
                maxLength={1000}
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="Tell the author what to fix"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy !== null || rejectNote.trim() === ''} onClick={() => void run('reject', rejectNote)}>
                  {busy === 'reject' ? 'Rejecting…' : 'Confirm rejection'}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {!readOnly && (
              <Button size="sm" disabled={!canSave} onClick={() => void save()}>
                {busy === 'save' ? 'Saving…' : template ? 'Save changes' : 'Create draft'}
              </Button>
            )}
            {actions.includes('submit') && (
              <Button size="sm" variant="secondary" disabled={locked || !lint.canSubmit || draft.name.trim() === ''} onClick={() => void run('submit')}>
                {busy === 'submit' ? 'Submitting…' : ACTION_LABELS.submit}
              </Button>
            )}
            {actions.includes('approve') && !rejecting && (
              <>
                <Button size="sm" disabled={locked || dirty} onClick={() => void run('approve')}>
                  {busy === 'approve' ? 'Approving…' : ACTION_LABELS.approve}
                </Button>
                <Button size="sm" variant="secondary" disabled={locked} onClick={() => setRejecting(true)}>
                  {ACTION_LABELS.reject}
                </Button>
              </>
            )}
            {actions.includes('archive') && (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={requestArchive}>
                {busy === 'archive' ? 'Archiving…' : ACTION_LABELS.archive}
              </Button>
            )}
            {actions.includes('restore') && (
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('restore')}>
                {busy === 'restore' ? 'Restoring…' : ACTION_LABELS.restore}
              </Button>
            )}
          </div>
          {actions.includes('submit') && !lint.canSubmit && (
            <p className="text-xs text-danger" role="alert">
              Fix {lint.errors} error{lint.errors === 1 ? '' : 's'} in the compliance check to submit for review.
            </p>
          )}
          {actions.includes('approve') && dirty && (
            <p className="text-xs text-text-secondary">Save or discard your edits before approving.</p>
          )}
        </div>

        <div className="space-y-4">
          <TemplatePreview channel={draft.channel} subject={draft.subject} body={draft.body} />

          <section aria-label="Compliance check" className="rounded-2xl border border-border bg-bg-secondary p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text-primary">Compliance check</h3>
              <p className="text-xs text-text-secondary">
                {lint.errors} error{lint.errors === 1 ? '' : 's'} · {lint.warnings} warning{lint.warnings === 1 ? '' : 's'}
              </p>
            </div>
            {issues.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 size={16} aria-hidden="true" /> All checks passed. Carrier and spam rules look good.
              </p>
            ) : (
              <ul className="space-y-2">
                {issues.map((issue) => {
                  const { icon: Icon, tone } = LINT_STYLES[issue.severity];
                  return (
                    <li key={issue.code} className="flex items-start gap-2 text-sm text-text-primary">
                      <Icon size={16} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
                      <span>
                        <span className="sr-only">{issue.severity}: </span>
                        {issue.message}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {template && (
            <section aria-label="Usage" className="rounded-2xl border border-border bg-bg-secondary p-4">
              <h3 className="mb-3 text-sm font-semibold text-text-primary">Usage</h3>
              <dl className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-text-secondary">All time</dt>
                  <dd className="mt-0.5 text-xl font-bold text-text-primary">{stats?.total_uses ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-text-secondary">Last 30 days</dt>
                  <dd className="mt-0.5 text-xl font-bold text-text-primary">{stats?.uses_30d ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-text-secondary">Last used</dt>
                  <dd className="mt-1.5 text-sm font-semibold text-text-primary">{formatDate(stats?.last_used_at ?? null)}</dd>
                </div>
              </dl>
              {template.status !== 'approved' && (
                <p className="mt-3 text-xs text-text-secondary">Only approved templates can be used, so usage starts after approval.</p>
              )}
            </section>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmArchive}
        title="Archive this template?"
        description="It will stop being available for new messages. You can restore it later as a draft, but it will need a new review."
        confirmLabel="Archive template"
        onConfirm={async () => {
          setConfirmArchive(false);
          await run('archive');
        }}
        onCancel={() => setConfirmArchive(false)}
      />
    </div>
  );
}
