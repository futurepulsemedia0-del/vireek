/**
 * Side-by-side merge dialog.
 *
 * Pick which record survives ("primary"), then choose per field which value
 * to keep. Everything linked to the other record (calls, jobs, quotes,
 * equipment, ...) moves to the primary, and the whole merge can be undone
 * for UNMERGE_WINDOW_DAYS. Stacks into a bottom sheet on mobile.
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { GitMerge, Loader2, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  DUPLICATE_KIND_LABELS,
  MERGE_FIELDS,
  UNMERGE_WINDOW_DAYS,
  DuplicatesError,
  defaultChoices,
  fetchRelatedCounts,
  humanizeTable,
  isBlank,
  mergeRecords,
  pickDefaultPrimary,
  resolveValue,
  totalMoved,
  type DuplicatePair,
  type DuplicateRecord,
  type FieldChoice,
  type MergeResult,
} from '@/lib/duplicates';

interface MergeDialogProps {
  pair: DuplicatePair | null;
  onClose: () => void;
  onMerged: (result: MergeResult, pair: DuplicatePair) => void;
}

type Side = 'a' | 'b';

function display(value: string | null | undefined) {
  return isBlank(value) ? <span className="italic text-text-secondary/70">empty</span> : value;
}

function ChoiceButton({
  selected,
  label,
  children,
  onClick,
}: {
  selected: boolean;
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onClick}
      className={`focus-ring min-h-[44px] rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
        selected
          ? 'border-accent bg-accent/10 text-text-primary'
          : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40'
      }`}
    >
      <span className="block whitespace-pre-line break-words">{children}</span>
    </button>
  );
}

export function MergeDialog({ pair, onClose, onMerged }: MergeDialogProps) {
  const open = pair !== null;
  const dialogRef = useFocusTrap(open);
  useEscapeToClose(open, onClose);

  const [primary, setPrimary] = useState<Side>('a');
  const [counts, setCounts] = useState<{ a: Record<string, number>; b: Record<string, number> } | null>(null);
  const [countsLoading, setCountsLoading] = useState(false);
  const [countsFailed, setCountsFailed] = useState(false);
  const [choices, setChoices] = useState<Record<string, FieldChoice>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load linked-history counts for both records whenever a new pair opens.
  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    setCounts(null);
    setCountsFailed(false);
    setCountsLoading(true);
    setError(null);
    setSubmitting(false);
    Promise.all([fetchRelatedCounts(pair.kind, pair.a.id), fetchRelatedCounts(pair.kind, pair.b.id)])
      .then(([a, b]) => {
        if (cancelled) return;
        setCounts({ a, b });
        const side = pickDefaultPrimary(pair.a, pair.b, a, b);
        setPrimary(side);
        setChoices(defaultChoices(pair.kind, pair[side], pair[side === 'a' ? 'b' : 'a']));
      })
      .catch(() => {
        if (cancelled) return;
        setCountsFailed(true);
        const side = pickDefaultPrimary(pair.a, pair.b, null, null);
        setPrimary(side);
        setChoices(defaultChoices(pair.kind, pair[side], pair[side === 'a' ? 'b' : 'a']));
      })
      .finally(() => {
        if (!cancelled) setCountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pair]);

  const records = useMemo(() => {
    if (!pair) return null;
    const other: Side = primary === 'a' ? 'b' : 'a';
    return { primary: pair[primary] as DuplicateRecord, other: pair[other] as DuplicateRecord, otherSide: other };
  }, [pair, primary]);

  const switchPrimary = (side: Side) => {
    if (!pair || side === primary) return;
    setPrimary(side);
    setChoices(defaultChoices(pair.kind, pair[side], pair[side === 'a' ? 'b' : 'a']));
  };

  const handleMerge = async () => {
    if (!pair || !records || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await mergeRecords(pair.kind, records.primary.id, records.other.id, choices);
      onMerged(result, pair);
    } catch (e) {
      setError(e instanceof DuplicatesError ? e.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  const kindLabel = pair ? DUPLICATE_KIND_LABELS[pair.kind].singular : '';
  const otherCounts = counts && records ? counts[records.otherSide] : null;
  const movingTotal = otherCounts ? totalMoved(otherCounts) : 0;

  return (
    <AnimatePresence>
      {open && pair && records && (
        <>
          <motion.div
            key="merge-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={submitting ? undefined : onClose}
            className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm"
          />
          <div className="pointer-events-none fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4">
            <motion.div
              key="merge-panel"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              ref={dialogRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-labelledby="merge-dialog-title"
              className="pointer-events-auto flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:max-w-2xl sm:rounded-2xl dark:shadow-card-hover-dark"
            >
              <div className="flex items-start justify-between gap-3 border-b border-border p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <GitMerge size={20} aria-hidden="true" />
                  </span>
                  <div>
                    <h2 id="merge-dialog-title" className="text-base font-semibold text-text-primary">
                      Merge duplicate {kindLabel}s
                    </h2>
                    <p className="mt-0.5 text-sm text-text-secondary">
                      Choose the record to keep, then pick the best value for each field.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  aria-label="Close"
                  className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary disabled:opacity-50"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-5 overflow-y-auto p-5">
                {countsLoading ? (
                  <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading history…
                  </div>
                ) : (
                  <>
                    {countsFailed && (
                      <p className="flex items-start gap-2 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
                        <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        Couldn&apos;t load linked history. You can still merge — all linked records will move.
                      </p>
                    )}

                    <div role="radiogroup" aria-label="Record to keep" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {(['a', 'b'] as const).map((side) => {
                        const rec = pair[side];
                        const c = counts?.[side];
                        return (
                          <ChoiceButton
                            key={side}
                            selected={primary === side}
                            label={`Keep ${rec.name} as the primary record`}
                            onClick={() => switchPrimary(side)}
                          >
                            <span className="block text-xs font-medium uppercase tracking-wide text-accent">
                              {primary === side ? 'Keeping this one' : 'Merge into the other'}
                            </span>
                            <span className="mt-0.5 block font-medium text-text-primary">{rec.name}</span>
                            <span className="block text-xs">
                              {c ? `${totalMoved(c)} linked ${totalMoved(c) === 1 ? 'record' : 'records'}` : 'History unavailable'}
                              {rec.created_at ? ` · added ${new Date(rec.created_at).toLocaleDateString()}` : ''}
                            </span>
                          </ChoiceButton>
                        );
                      })}
                    </div>

                    <div className="space-y-4">
                      {MERGE_FIELDS[pair.kind].map((field) => {
                        const pv = records.primary[field.key];
                        const ov = records.other[field.key];
                        if (isBlank(pv) && isBlank(ov)) return null;
                        const same = (pv ?? '').trim().toLowerCase() === (ov ?? '').trim().toLowerCase();
                        const current = choices[field.key] ?? 'survivor';
                        return (
                          <div key={field.key}>
                            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-secondary">
                              {field.label}
                            </p>
                            {same ? (
                              <p className="rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                                {display(pv)} <span className="ml-1 text-xs text-text-secondary">(same on both)</span>
                              </p>
                            ) : (
                              <div
                                role="radiogroup"
                                aria-label={field.label}
                                className={`grid grid-cols-1 gap-2 ${field.allowBoth ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}
                              >
                                <ChoiceButton
                                  selected={current === 'survivor'}
                                  label={`${field.label}: ${isBlank(pv) ? 'empty' : pv} (from ${records.primary.name})`}
                                  onClick={() => setChoices((c) => ({ ...c, [field.key]: 'survivor' }))}
                                >
                                  {display(pv)}
                                </ChoiceButton>
                                <ChoiceButton
                                  selected={current === 'merged'}
                                  label={`${field.label}: ${isBlank(ov) ? 'empty' : ov} (from ${records.other.name})`}
                                  onClick={() => setChoices((c) => ({ ...c, [field.key]: 'merged' }))}
                                >
                                  {display(ov)}
                                </ChoiceButton>
                                {field.allowBoth && !isBlank(pv) && !isBlank(ov) && (
                                  <ChoiceButton
                                    selected={current === 'both'}
                                    label={`${field.label}: keep both`}
                                    onClick={() => setChoices((c) => ({ ...c, [field.key]: 'both' }))}
                                  >
                                    {resolveValue('both', pv, ov)}
                                  </ChoiceButton>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
                      <p className="font-medium text-text-primary">
                        {movingTotal > 0
                          ? `${movingTotal} linked ${movingTotal === 1 ? 'record moves' : 'records move'} to ${records.primary.name}`
                          : 'No linked history to move'}
                      </p>
                      {otherCounts && movingTotal > 0 && (
                        <ul className="mt-2 flex flex-wrap gap-1.5">
                          {Object.entries(otherCounts).map(([table, n]) => (
                            <li key={table} className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs">
                              {humanizeTable(table)} · {n}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 text-xs">
                        You can undo this merge for {UNMERGE_WINDOW_DAYS} days. After that, {records.other.name} is deleted for good.
                      </p>
                    </div>
                  </>
                )}

                {error && (
                  <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                    {error}
                  </p>
                )}
              </div>

              <div className="flex gap-3 border-t border-border p-5">
                <Button variant="secondary" className="flex-1" onClick={onClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button className="flex-1" onClick={() => void handleMerge()} disabled={countsLoading || submitting}>
                  {submitting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <GitMerge size={16} aria-hidden="true" />}
                  {submitting ? 'Merging…' : 'Merge records'}
                </Button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
