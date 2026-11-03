import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { useAgentReadinessT } from '@/i18n/agentReadinessNamespace';
import type { Fix, FixAction } from '@/lib/agentReadinessCore';

interface Props {
  fix: Fix;
  actions: FixAction[];
  canManage: boolean;
  busy: boolean;
  onApprove: (fix: Fix, itemIds: string[]) => void;
  onSkip: (fix: Fix) => void;
  onUndo: (actionId: string) => void;
}

export function FixCard({ fix, actions, canManage, busy, onApprove, onSkip, onUndo }: Props) {
  const { t } = useAgentReadinessT();
  const navigate = useNavigate();
  const rows = fix.diff ?? [];
  const [picked, setPicked] = useState<Set<string>>(() => new Set(rows.map((r) => r.id)));
  const mine = actions.filter((a) => a.fix_key === fix.key);
  const skipped = mine.some((a) => a.status === 'skipped');
  const applied = mine.filter((a) => a.status === 'applied');
  const appliedIds = new Set(applied.flatMap((a) => a.changes.map((c) => c.id)));
  const pending = rows.filter((r) => !appliedIds.has(r.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <article className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby={`ar-fix-${fix.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={`ar-fix-${fix.key}`} className="text-base font-semibold text-text-primary">{t(`fixes.${fix.key}.title`)}</h3>
          <p className="text-sm text-text-secondary">{t(`fixes.${fix.key}.desc`)}</p>
        </div>
        {fix.impact > 0 && <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">{t('impact', { points: Math.round(fix.impact) })}</span>}
      </div>
      {(fix.notes ?? []).length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-text-secondary">{fix.notes?.map((n) => <li key={n}>{t(`notes.${n}`)}</li>)}</ul>
      )}

      {fix.kind === 'apply' && pending.length > 0 && !skipped && (
        <ul className="mt-3 space-y-3">
          {pending.map((r) => (
            <li key={r.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="focus-ring mt-1 h-4 w-4" checked={picked.has(r.id)} onChange={() => toggle(r.id)} disabled={!canManage} aria-label={t('selectRow', { name: r.label })} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-text-primary">{r.label}</span>
                  <span className="mt-1 block text-xs text-text-secondary"><span className="font-semibold">{t('diffBefore')}:</span> {r.before || t('emptyBefore')}</span>
                  <span className="mt-1 block rounded-lg bg-accent/10 px-2 py-1 text-xs text-text-primary"><span className="font-semibold">{t('diffAfter')}:</span> {r.after}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {fix.kind === 'copy' && fix.copyText && (
        <div className="mt-3">
          <pre className="max-h-64 overflow-auto rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary" tabIndex={0}>{fix.copyText}</pre>
          <div className="mt-2"><CopyButton text={fix.copyText} /></div>
        </div>
      )}
      {fix.kind === 'link' && fix.copyText && (
        <div className="mt-3">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary" tabIndex={0}>{fix.copyText}</pre>
          <div className="mt-2"><CopyButton text={fix.copyText} /></div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {fix.kind === 'apply' && pending.length > 0 && !skipped && (
          <Button size="sm" disabled={!canManage || busy || picked.size === 0} loading={busy} onClick={() => onApprove(fix, pending.filter((r) => picked.has(r.id)).map((r) => r.id))}>{t('approve')}</Button>
        )}
        {fix.href && <Button size="sm" variant="secondary" onClick={() => navigate(fix.href as string)}>{t('openPage')}</Button>}
        {!skipped && (pending.length > 0 || fix.kind !== 'apply') && (
          <Button size="sm" variant="ghost" disabled={!canManage || busy} onClick={() => onSkip(fix)}>{t('skip')}</Button>
        )}
        {skipped && <span className="text-xs text-text-secondary">{t('skipped')}</span>}
        {applied.map((a) => (
          <Button key={a.id} size="sm" variant="secondary" disabled={!canManage || busy} onClick={() => onUndo(a.id)}>{t('undo')} ({a.changes.length})</Button>
        ))}
      </div>
    </article>
  );
}
