import { useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { useTrustT } from '@/hooks/useTrustT';
import { allChoices, buildResolvedPatch, planMerge, type Choice, type Row } from '@/lib/trust/conflict';

interface Props {
  open: boolean;
  /** Row as the user first loaded it. */
  base: Row;
  /** The user's edited values (only the fields they touched are required). */
  mine: Row;
  /** The current server row (carries the new row_version). */
  theirs: Row | null;
  /** Human label per field; falls back to the field name. */
  fieldLabel?: (field: string) => string;
  formatValue?: (field: string, value: unknown) => string;
  /** Called with the patch to re-save against `theirs.row_version`. Empty patch = nothing left to save. */
  onResolve: (patch: Row, theirs: Row) => void | Promise<void>;
  onCancel: () => void;
}

const defaultFormat = (_f: string, v: unknown): string => (v === null || v === undefined || v === '' ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Keep mine / take theirs per conflicting field; non-conflicting edits merge automatically. */
export function ConflictDialog({ open, base, mine, theirs, fieldLabel = (f) => f, formatValue = defaultFormat, onResolve, onCancel }: Props) {
  const { t } = useTrustT();
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onCancel);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [saving, setSaving] = useState(false);

  const plan = useMemo(() => (theirs ? planMerge(base, mine, theirs) : null), [base, mine, theirs]);
  if (!open) return null;

  if (!theirs || !plan) {
    return (
      <div role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" ref={ref} tabIndex={-1} className="fixed left-1/2 top-1/2 z-[120] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-secondary p-6">
        <h2 id="conflict-title" className="text-base font-semibold text-text-primary">{t('conflict.gone')}</h2>
        <button type="button" onClick={onCancel} className="focus-ring mt-4 rounded-xl border border-border px-4 py-2.5 text-sm">{t('conflict.cancel')}</button>
      </div>
    );
  }

  const patch = buildResolvedPatch(plan, choices);
  const show = (f: string, v: unknown) => formatValue(f, v) || t('conflict.empty');
  const apply = async () => {
    if (!patch || saving) return;
    setSaving(true);
    try {
      await onResolve(patch, theirs);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" onClick={onCancel} aria-hidden="true" />
      <div role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-body" ref={ref} tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-[120] max-h-[90vh] w-[94vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500"><TriangleAlert size={20} aria-hidden="true" /></span>
          <div>
            <h2 id="conflict-title" className="text-base font-semibold text-text-primary">{t('conflict.title')}</h2>
            <p id="conflict-body" className="mt-1 text-sm text-text-secondary">{t('conflict.body')}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => setChoices(allChoices(plan, 'mine'))} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium">{t('conflict.keepAllMine')}</button>
          <button type="button" onClick={() => setChoices(allChoices(plan, 'theirs'))} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium">{t('conflict.takeAllTheirs')}</button>
        </div>

        <ul className="mt-4 space-y-3">
          {plan.conflicts.map((d) => (
            <li key={d.field}>
              <fieldset className="rounded-xl border border-border p-3">
                <legend className="px-1 text-xs font-semibold text-text-primary">{fieldLabel(d.field)}</legend>
                <p className="text-xs text-text-secondary">{t('conflict.original')}: <span dir="auto">{show(d.field, d.base)}</span></p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(['mine', 'theirs'] as const).map((c) => (
                    <label key={c} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm ${choices[d.field] === c ? 'border-accent bg-accent/5' : 'border-border'}`}>
                      <input type="radio" name={`conflict-${d.field}`} checked={choices[d.field] === c} onChange={() => setChoices((p) => ({ ...p, [d.field]: c }))} className="mt-1" />
                      <span>
                        <span className="block text-xs font-semibold text-text-secondary">{c === 'mine' ? t('conflict.yours') : t('conflict.server')}</span>
                        <span dir="auto" className="block break-words text-text-primary">{show(d.field, c === 'mine' ? d.mine : d.theirs)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-primary">{t('conflict.cancel')}</button>
          <button type="button" onClick={apply} disabled={!patch || saving} className="focus-ring rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
            {saving ? t('conflict.saving') : t('conflict.apply')}
          </button>
        </div>
      </div>
    </>
  );
}
