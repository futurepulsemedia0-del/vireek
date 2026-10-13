import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronUp, Download, Loader2, Tag, Trash2, UserPlus, X, RefreshCw } from 'lucide-react';
import { parseTags } from '@/lib/bulk/engine';

export interface BulkStatusOption {
  value: string;
  label: string;
  /** When set, a confirmation dialog with this text is shown before applying. */
  confirm?: string;
}
export interface Assignee {
  id: string;
  name: string;
}

export interface BulkActionBarProps {
  count: number;
  noun: { singular: string; plural: string };
  busy?: boolean;
  totalMatching?: number;
  onSelectAllMatching?: () => void;
  onClear: () => void;
  statusOptions?: BulkStatusOption[];
  onStatus?: (option: BulkStatusOption) => void;
  assignees?: Assignee[];
  assigneesLoading?: boolean;
  onOpenAssign?: () => void;
  onAssign?: (assigneeId: string | null) => void;
  tagSuggestions?: string[];
  onTags?: (mode: 'add' | 'remove', tags: string[]) => void;
  onExport?: () => void;
  onDelete?: () => void;
}

type MenuKey = 'status' | 'assign' | 'tags';

const btn =
  'focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50';
const menu =
  'absolute bottom-full left-0 mb-2 max-h-64 min-w-[11rem] overflow-y-auto rounded-xl border border-border bg-bg-secondary p-1 shadow-card-hover';
const item = 'focus-ring block w-full rounded-lg px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary';

export function BulkActionBar(props: BulkActionBarProps) {
  const { count, noun, busy, onClear } = props;
  const [open, setOpen] = useState<MenuKey | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (count === 0) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (open) setOpen(null);
      else onClear();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [count, open, onClear]);

  const toggle = (key: MenuKey) => {
    if (key === 'assign' && open !== 'assign') props.onOpenAssign?.();
    setOpen((o) => (o === key ? null : key));
  };
  const tags = parseTags(tagDraft);
  const label = count === 1 ? noun.singular : noun.plural;

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {count > 0 ? `${count} ${label} selected` : ''}
      </p>
      <AnimatePresence>
        {count > 0 && (
          <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[90] flex justify-center px-3">
            <motion.div
              ref={wrapRef}
              role="region"
              aria-label="Bulk actions"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1 rounded-2xl border border-border bg-bg-secondary px-2 py-1.5 shadow-card-hover"
            >
              <span className="px-2 text-xs font-semibold text-text-primary" data-testid="bulk-count">
                {count} {label} selected
              </span>
              {props.onSelectAllMatching && props.totalMatching !== undefined && props.totalMatching > count && (
                <button type="button" onClick={props.onSelectAllMatching} className={`${btn} text-accent`}>
                  Select all {props.totalMatching}
                </button>
              )}
              <span className="mx-1 hidden h-5 w-px bg-border sm:block" />

              {props.statusOptions && props.onStatus && (
                <div className="relative">
                  <button type="button" disabled={busy} onClick={() => toggle('status')} aria-haspopup="menu" aria-expanded={open === 'status'} className={btn}>
                    <RefreshCw size={13} /> Status <ChevronUp size={12} />
                  </button>
                  {open === 'status' && (
                    <div role="menu" className={menu}>
                      {props.statusOptions.map((o) => (
                        <button key={o.value} role="menuitem" type="button" className={item} onClick={() => { setOpen(null); props.onStatus?.(o); }}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {props.onAssign && (
                <div className="relative">
                  <button type="button" disabled={busy} onClick={() => toggle('assign')} aria-haspopup="menu" aria-expanded={open === 'assign'} className={btn}>
                    <UserPlus size={13} /> Assign <ChevronUp size={12} />
                  </button>
                  {open === 'assign' && (
                    <div role="menu" className={menu}>
                      {props.assigneesLoading && <p className="px-3 py-2 text-xs text-text-secondary">Loading team…</p>}
                      {!props.assigneesLoading && (props.assignees ?? []).length === 0 && (
                        <p className="px-3 py-2 text-xs text-text-secondary">No team members available.</p>
                      )}
                      {(props.assignees ?? []).map((a) => (
                        <button key={a.id} role="menuitem" type="button" className={item} onClick={() => { setOpen(null); props.onAssign?.(a.id); }}>
                          {a.name}
                        </button>
                      ))}
                      <button role="menuitem" type="button" className={`${item} border-t border-border text-text-secondary`} onClick={() => { setOpen(null); props.onAssign?.(null); }}>
                        Unassign
                      </button>
                    </div>
                  )}
                </div>
              )}

              {props.onTags && (
                <div className="relative">
                  <button type="button" disabled={busy} onClick={() => toggle('tags')} aria-haspopup="dialog" aria-expanded={open === 'tags'} className={btn}>
                    <Tag size={13} /> Tag <ChevronUp size={12} />
                  </button>
                  {open === 'tags' && (
                    <div role="dialog" aria-label="Edit tags" className={`${menu} w-64 p-3`}>
                      <input
                        autoFocus
                        value={tagDraft}
                        onChange={(e) => setTagDraft(e.target.value)}
                        placeholder="urgent, follow-up"
                        aria-label="Tags, comma separated"
                        className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
                      />
                      {(props.tagSuggestions ?? []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(props.tagSuggestions ?? []).slice(0, 12).map((s) => (
                            <button key={s} type="button" onClick={() => setTagDraft((d) => (d.trim() ? `${d.replace(/,\s*$/, '')}, ${s}` : s))} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary">
                              {s}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="mt-3 flex gap-2">
                        <button type="button" disabled={tags.length === 0} onClick={() => { props.onTags?.('add', tags); setTagDraft(''); setOpen(null); }} className="focus-ring flex-1 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                          Add
                        </button>
                        <button type="button" disabled={tags.length === 0} onClick={() => { props.onTags?.('remove', tags); setTagDraft(''); setOpen(null); }} className="focus-ring flex-1 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-text-primary disabled:opacity-50">
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {props.onExport && (
                <button type="button" disabled={busy} onClick={props.onExport} className={btn}>
                  <Download size={13} /> Export
                </button>
              )}
              {props.onDelete && (
                <button type="button" disabled={busy} onClick={props.onDelete} className={`${btn} text-danger hover:bg-danger/10`}>
                  <Trash2 size={13} /> Delete
                </button>
              )}

              <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
              {busy && <Loader2 size={14} className="animate-spin text-text-secondary" aria-label="Working" />}
              <button type="button" onClick={onClear} aria-label="Clear selection" className={`${btn} px-2`}>
                <X size={14} />
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
