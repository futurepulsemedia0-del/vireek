import { useId, useMemo, useState } from 'react';
import { Copy, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  CHANNELS,
  CONTENT_TYPES,
  charCount,
  getChannel,
  hasErrors,
  isContentStatus,
  isChannelId,
  isContentType,
  isoToLocalInput,
  localInputToIso,
  quickActions,
  selectableStatuses,
  statusLabel,
  validateDraft,
  type ContentItem,
  type ContentStatus,
  type ItemDraft,
} from '@/lib/contentCalendar';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

interface Props {
  /** null = creating a new item (or a duplicate — `seed` carries the copy). */
  item: ContentItem | null;
  seed: ItemDraft;
  saving: boolean;
  onSave: (draft: ItemDraft) => void | Promise<void>;
  onClose: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}

export function ItemEditorDialog({ item, seed, saving, onSave, onClose, onDuplicate, onDelete }: Props) {
  const [draft, setDraft] = useState<ItemDraft>(seed);
  const [submitted, setSubmitted] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const uid = useId();

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(seed), [draft, seed]);
  const errors = useMemo(
    () => validateDraft(draft, new Date(), item ? { scheduled_at: item.scheduled_at, status: item.status } : null),
    [draft, item],
  );
  const channel = getChannel(draft.channel);
  const bodyLen = charCount(draft.body);
  const readOnlyStatus = item?.status === 'published';
  const statuses = selectableStatuses(item?.status ?? null);

  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, requestClose);

  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (saving || hasErrors(errors)) return;
    void onSave(draft);
  };

  // One-click status change that keeps the user's other edits: validate the NEXT state, then save it.
  const saveAs = (to: ContentStatus) => {
    const next = { ...draft, status: to };
    setDraft(next);
    setSubmitted(true);
    if (saving || hasErrors(validateDraft(next, new Date(), item ? { scheduled_at: item.scheduled_at, status: item.status } : null))) return;
    void onSave(next);
  };

  const err = (key: keyof typeof errors) => (submitted ? errors[key] : undefined);
  const counterTone = bodyLen > channel.limit ? 'text-danger' : bodyLen > channel.limit * 0.9 ? 'text-warning-500' : 'text-text-secondary';

  return (
    <>
      <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm" onClick={requestClose} aria-hidden />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="fixed inset-x-0 bottom-0 z-[101] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(42rem,94vw)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6 dark:shadow-card-hover-dark"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id={`${uid}-title`} className="text-lg font-semibold text-text-primary">
              {item ? 'Edit content' : 'New content'}
            </h2>
            {item && <p className="mt-0.5 text-xs text-text-secondary">Currently {statusLabel(item.status).toLowerCase()}</p>}
          </div>
          <button type="button" onClick={requestClose} aria-label="Close" tabIndex={-1} className="focus-ring -m-2 rounded-lg p-2 text-text-secondary hover:text-text-primary">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {confirmDiscard && (
          <div role="alert" className="mb-4 flex flex-col gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="text-text-primary">Discard your unsaved changes?</span>
            <span className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button type="button" size="sm" onClick={onClose}>
                Discard
              </Button>
            </span>
          </div>
        )}

        <form onSubmit={submit} noValidate className="space-y-4">
          <Input
            label="Title"
            required
            value={draft.title}
            maxLength={400}
            onChange={(e) => set('title', e.target.value)}
            error={err('title')}
            placeholder="e.g. Fall tune-up special"
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-channel`} className="mb-1.5 block text-sm font-medium text-text-primary">
                Channel
              </label>
              <select
                id={`${uid}-channel`}
                className={selectClass}
                value={draft.channel}
                onChange={(e) => isChannelId(e.target.value) && set('channel', e.target.value)}
              >
                {CHANNELS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-type`} className="mb-1.5 block text-sm font-medium text-text-primary">
                Content type
              </label>
              <select
                id={`${uid}-type`}
                className={selectClass}
                value={draft.content_type}
                onChange={(e) => isContentType(e.target.value) && set('content_type', e.target.value)}
              >
                {CONTENT_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-status`} className="mb-1.5 block text-sm font-medium text-text-primary">
                Status
              </label>
              <select
                id={`${uid}-status`}
                className={selectClass}
                value={draft.status}
                disabled={readOnlyStatus}
                onChange={(e) => isContentStatus(e.target.value) && set('status', e.target.value)}
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            <Input
              label="Date & time"
              type="datetime-local"
              value={isoToLocalInput(draft.scheduled_at)}
              onChange={(e) => set('scheduled_at', e.target.value ? localInputToIso(e.target.value) : null)}
              error={err('scheduled_at')}
              helperText={draft.scheduled_at ? undefined : 'Leave empty to keep it as an unscheduled idea.'}
            />
          </div>

          <Textarea
            label="Caption / copy"
            rows={5}
            value={draft.body}
            onChange={(e) => set('body', e.target.value)}
            error={err('body')}
            placeholder={`Write the ${channel.label} copy…`}
          />
          <p className={`-mt-3 text-right text-xs ${counterTone}`} aria-live="polite">
            {bodyLen.toLocaleString('en-US')} / {channel.limit.toLocaleString('en-US')} characters
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Tags"
              value={draft.tags}
              onChange={(e) => set('tags', e.target.value)}
              error={err('tags')}
              helperText="Comma separated, e.g. spring, tune-up"
            />
            <Input
              label="Link"
              type="url"
              inputMode="url"
              value={draft.link_url}
              onChange={(e) => set('link_url', e.target.value)}
              error={err('link_url')}
              placeholder="https://"
            />
          </div>

          <Textarea label="Internal notes" rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} error={err('notes')} placeholder="Only your team sees this." />

          {item && quickActions(item.status).length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-bg-tertiary p-3">
              <span className="text-xs font-medium text-text-secondary">Quick actions</span>
              {quickActions(item.status).map((a) => (
                <Button key={a.to} type="button" size="sm" variant="secondary" disabled={saving} onClick={() => saveAs(a.to)}>
                  {a.label}
                </Button>
              ))}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-2">
              {item && onDuplicate && (
                <Button type="button" variant="ghost" size="sm" onClick={onDuplicate} disabled={saving}>
                  <Copy className="h-4 w-4" aria-hidden /> Duplicate
                </Button>
              )}
              {item && onDelete && (
                <Button type="button" variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={onDelete} disabled={saving}>
                  <Trash2 className="h-4 w-4" aria-hidden /> Delete
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={requestClose} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : item ? 'Save changes' : 'Add to calendar'}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </>
  );
}
