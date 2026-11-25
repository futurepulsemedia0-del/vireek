import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import type { PhoneNumber } from '@/lib/phoneNumbers';
import {
  cancelRotation,
  replacementCandidates,
  retireBlocker,
  retireRotation,
  setRotationReplacement,
  startRotation,
  suggestedRotationReason,
  type NumberHealthRow,
  type NumberRotationRow,
} from '@/lib/numberHealth';
import { NUMBER_HEALTH_NS } from '@/i18n/numberHealthNamespace';

const btn = 'focus-ring min-h-[44px] rounded-lg px-4 text-sm font-semibold disabled:opacity-60';

/**
 * Rotate / retire workflow for one number: start a rotation, pick one of your other active numbers as the replacement,
 * then retire. The database enforces ownership and ordering; this component only mirrors the rules for clarity.
 */
export function NumberRotationPanel({ number, health, numbers, rotations, healthById, onChanged }: {
  number: PhoneNumber;
  health: NumberHealthRow | null;
  numbers: PhoneNumber[];
  rotations: NumberRotationRow[];
  healthById: Record<string, string | undefined>;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation(NUMBER_HEALTH_NS);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const rotation = rotations.find((r) => r.phone_number_id === number.id) ?? null;
  const suggested = suggestedRotationReason(health?.spam_label ?? 'unknown', health?.provider_live ?? false);

  // Nothing to show for a healthy number with no open rotation. "Start" stays reachable only when there is a reason.
  if (!rotation && !suggested) return null;

  const run = async (fn: () => Promise<string | void>, failKey: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) toast(msg, 'success');
      await onChanged();
    } catch {
      toast(t(failKey), 'error');
    } finally {
      setBusy(false);
    }
  };

  const candidates = replacementCandidates(numbers, number.id, rotations, healthById);
  const replacementRow = rotation?.replacement_number_id ? numbers.find((n) => n.id === rotation.replacement_number_id) ?? null : null;
  const blocker = rotation ? retireBlocker(rotation, replacementRow?.status ?? null, false) : null;
  const selectId = `nr-repl-${number.id}`;

  return (
    <div className="mt-3 rounded-lg border border-border p-3">
      <h3 className="text-xs font-semibold text-text-secondary">{t('rotation.title')}</h3>
      <p className="mt-1 text-xs text-text-secondary">{t('rotation.intro')}</p>

      {!rotation && suggested && (
        <>
          <p role="status" className="mt-2 text-xs text-warning">{t('rotation.suggest')}</p>
          <button type="button" disabled={busy} onClick={() => void run(async () => { await startRotation(number.id, suggested); }, 'rotation.failed')} className={`${btn} mt-2 w-full border border-border text-text-primary sm:w-auto`}>
            {busy ? <><Loader2 className="me-2 inline h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('rotation.starting')}</> : t('rotation.start')}
          </button>
        </>
      )}

      {rotation && (
        <>
          <p className="mt-2 text-xs text-text-secondary">{t(`rotation.reason.${rotation.reason}`)}</p>
          <label htmlFor={selectId} className="mb-1 mt-3 block text-xs font-semibold text-text-secondary">{t('rotation.replacement')}</label>
          {candidates.length === 0 && !replacementRow ? (
            <p className="text-xs text-text-secondary">{t('rotation.none')}</p>
          ) : (
            <select
              id={selectId}
              value={rotation.replacement_number_id ?? ''}
              disabled={busy}
              onChange={(e) => void run(async () => { await setRotationReplacement(rotation.id, e.target.value || null); }, 'rotation.replacementFailed')}
              className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary"
            >
              <option value="">{t('rotation.choose')}</option>
              {replacementRow && !candidates.some((c) => c.id === replacementRow.id) && <option value={replacementRow.id}>{replacementRow.friendly_name || replacementRow.phone_number}</option>}
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.friendly_name || c.phone_number}</option>)}
            </select>
          )}
          {blocker === 'no_replacement' && <p role="status" className="mt-2 text-xs text-text-secondary">{t('rotation.needReplacement')}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || blocker !== null}
              onClick={() => { if (!window.confirm(t('rotation.confirm'))) return; void run(async () => { const r = await retireRotation(rotation.id, false); return r.primaryMoved ? t('rotation.primaryMoved') : t('rotation.retired'); }, 'rotation.failed'); }}
              className={`${btn} bg-danger text-on-danger`}
            >
              {busy ? t('rotation.retiring') : t('rotation.retire')}
            </button>
            <button type="button" disabled={busy} onClick={() => void run(async () => { await cancelRotation(rotation.id); return t('rotation.cancelled'); }, 'rotation.failed')} className={`${btn} border border-border text-text-primary`}>
              {t('rotation.cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
