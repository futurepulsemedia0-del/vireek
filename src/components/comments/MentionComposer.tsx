import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AtSign, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import {
  COMMENT_MAX_LENGTH,
  applyMention,
  detectMentionQuery,
  draftCharCount,
  filterCandidates,
  validateDraft,
} from '@/lib/comments';
import type { Draft, MentionCandidate } from '@/lib/comments';

interface Props {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  candidates: MentionCandidate[];
  currentUserId?: string | null;
  submitting?: boolean;
  /** Accessible name of the text box. */
  label: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  error?: string | null;
}

const COUNTER_FROM = Math.floor(COMMENT_MAX_LENGTH * 0.85);

export function MentionComposer({
  draft,
  onChange,
  onSubmit,
  onCancel,
  candidates,
  currentUserId,
  submitting = false,
  label,
  placeholder = 'Write a comment… type @ to mention a teammate',
  submitLabel = 'Comment',
  autoFocus = false,
  error = null,
}: Props) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // "@" position the person dismissed with Escape, so the list doesn't pop right back.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const query = useMemo(() => detectMentionQuery(draft.text, caret), [draft.text, caret]);
  const matches = useMemo(
    () => (query ? filterCandidates(candidates, query.query, { excludeUserId: currentUserId }) : []),
    [candidates, query, currentUserId],
  );
  const open = !!query && matches.length > 0 && dismissedAt !== query.start && !submitting;

  useEffect(() => {
    setActive(0);
  }, [query?.start, query?.query]);

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

  const problem = validateDraft(draft);
  const chars = draftCharCount(draft);
  const canSubmit = problem === null && !submitting;

  const syncCaret = () => {
    const el = areaRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  const pick = (person: MentionCandidate) => {
    if (!query) return;
    const next = applyMention(draft, query, caret, person);
    onChange(next.draft);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const insertAt = () => {
    const el = areaRef.current;
    const pos = el?.selectionStart ?? draft.text.length;
    const before = draft.text.slice(0, pos);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const text = `${before}${needsSpace ? ' ' : ''}@${draft.text.slice(pos)}`;
    const nextCaret = before.length + (needsSpace ? 1 : 0) + 1;
    onChange({ ...draft, text });
    setDismissedAt(null);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[active] ?? matches[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (query) setDismissedAt(query.start);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSubmit) onSubmit();
      return;
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Textarea
          ref={areaRef}
          aria-label={label}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          rows={3}
          value={draft.text}
          placeholder={placeholder}
          disabled={submitting}
          onChange={(e) => {
            onChange({ ...draft, text: e.target.value });
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
        />

        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Mention a teammate"
            className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-border bg-bg-secondary p-1 shadow-card-hover dark:shadow-card-hover-dark"
          >
            {matches.map((person, i) => (
              <li
                key={person.userId}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(person)}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${
                  i === active ? 'bg-accent/10 text-text-primary' : 'text-text-secondary'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent">
                    {person.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate font-medium">{person.name}</span>
                </span>
                {person.role && <span className="shrink-0 text-[11px] capitalize text-text-secondary">{person.role}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={insertAt}
            disabled={submitting || candidates.length === 0}
            aria-label="Mention a teammate"
            title={candidates.length === 0 ? 'No teammates can see this record' : 'Mention a teammate'}
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
          >
            <AtSign size={15} aria-hidden="true" />
          </button>
          {chars >= COUNTER_FROM && (
            <span
              aria-live="polite"
              className={`text-xs ${chars > COMMENT_MAX_LENGTH ? 'font-semibold text-danger' : 'text-text-secondary'}`}
            >
              {chars.toLocaleString('en-US')}/{COMMENT_MAX_LENGTH.toLocaleString('en-US')}
            </span>
          )}
          <span className="hidden text-[11px] text-text-secondary sm:inline">Ctrl/⌘ + Enter to send</span>
        </div>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
          )}
          <Button type="button" size="sm" onClick={onSubmit} disabled={!canSubmit}>
            {submitting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
            {submitting ? 'Sending…' : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
