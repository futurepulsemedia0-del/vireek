import { useMemo, useState } from 'react';
import { History as HistoryIcon, ScrollText } from 'lucide-react';
import { useAutopilotT } from '@/i18n/autopilotNamespace';
import { diffLines } from '@/lib/callScripts';
import type { CallScriptVersion } from '@/lib/callScripts';
import type { AuditEntry, VoiceExperiment } from '@/lib/voiceAutopilot';

function VersionDiff({ before, after }: { before: CallScriptVersion; after: CallScriptVersion }) {
  const { t } = useAutopilotT();
  const lines = useMemo(() => diffLines(`${before.opening_line}\n${before.body}`, `${after.opening_line}\n${after.body}`), [before, after]);
  const changed = lines.some((l) => l.type !== 'same');
  return (
    <div className="mt-2 rounded-xl border border-border bg-bg-primary p-3 text-xs" role="group" aria-label={t('history.diffTitle')}>
      {!changed ? <p className="text-text-secondary">{t('history.diffNone')}</p> : (
        <ul className="space-y-0.5 font-mono">
          {lines.map((l, i) => (
            <li key={i} className={l.type === 'add' ? 'text-success-500' : l.type === 'del' ? 'text-danger' : 'text-text-secondary'}>
              <span aria-hidden="true">{l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}</span>
              <span className="sr-only">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</span>
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ExperimentHistory({ experiments, versions }: { experiments: VoiceExperiment[]; versions: CallScriptVersion[] }) {
  const { t } = useAutopilotT();
  const [open, setOpen] = useState<string | null>(null);
  const byId = useMemo(() => new Map(versions.map((v) => [v.id, v] as const)), [versions]);
  return (
    <section aria-labelledby="hist-title" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h3 id="hist-title" className="flex items-center gap-2 text-base font-semibold text-text-primary"><HistoryIcon size={18} aria-hidden="true" className="text-accent" />{t('history.title')}</h3>
      {experiments.length === 0 ? <p className="mt-2 text-sm text-text-secondary">{t('history.empty')}</p> : (
        <ul className="mt-3 space-y-2">
          {experiments.map((e) => {
            const a = byId.get(e.control_version_id), b = byId.get(e.challenger_version_id);
            return (
              <li key={e.id} className="rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text-primary">{e.name}</span>
                  <span className="text-xs text-text-secondary">{t(`history.status.${e.status}`)} · {t(`dimension.${e.dimension}`)} · {new Date(e.started_at).toLocaleDateString()}</span>
                </div>
                {a && b && (
                  <>
                    <button type="button" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)} className="focus-ring mt-1 min-h-[44px] rounded text-xs font-medium text-accent">{t('history.diff')}</button>
                    {open === e.id && <VersionDiff before={a} after={b} />}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function AuditLog({ entries }: { entries: AuditEntry[] }) {
  const { t } = useAutopilotT();
  return (
    <section aria-labelledby="audit-title" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h3 id="audit-title" className="flex items-center gap-2 text-base font-semibold text-text-primary"><ScrollText size={18} aria-hidden="true" className="text-accent" />{t('audit.title')}</h3>
      <p className="mt-1 text-xs text-text-secondary">{t('audit.intro')}</p>
      {entries.length === 0 ? <p className="mt-2 text-sm text-text-secondary">{t('audit.empty')}</p> : (
        <ul className="mt-3 space-y-1.5 text-sm">
          {entries.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-1.5 first:border-t-0 first:pt-0">
              <span className="text-text-primary">{t(`audit.${a.event}`, { defaultValue: a.event })}</span>
              <span className="text-xs text-text-secondary">{t(`audit.${a.actor_kind}`)} · {new Date(a.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
