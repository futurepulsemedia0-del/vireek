import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, ExternalLink, Pencil, ShieldAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { ApiError, bulkApprove, deleteRun, setField } from './sarahLearnApi';
import { displayUrl, diffStatus, formatValue, groupFields, isHttpUrl, kindOf, parseEditInput, reviewCounts, safeHostname, type LearnField, type LearnRun, type LearnSource } from './sarahLearnLogic';

interface Props {
  run: LearnRun;
  fields: LearnField[];
  sources: LearnSource[];
  onReload: () => Promise<void>;
  onNext: () => void;
  onRerun: () => void;
  onDeleted: () => void;
}

const HINT_KINDS = new Set(['hours', 'list', 'faq', 'emergency']);

function Badge({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'warn' | 'ok' }) {
  const cls = tone === 'warn' ? 'border-danger/40 text-danger' : tone === 'ok' ? 'border-success-500/40 text-success-500' : 'border-border text-text-secondary';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function ReviewStep({ run, fields, sources, onReload, onNext, onRerun, onDeleted }: Props) {
  const { t } = useTranslation('sarahLearn');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<{ key: string; msg: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const groups = useMemo(() => groupFields(fields), [fields]);
  const counts = useMemo(() => reviewCounts(fields), [fields]);
  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusyKey(key);
    setError('');
    try {
      await fn();
      await onReload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('review.saveError'));
    } finally {
      setBusyKey(null);
    }
  };

  const saveEdit = (key: string) => {
    const parsed = parseEditInput(key, draft);
    if (parsed === null) return setFieldError({ key, msg: t('review.invalid') });
    setFieldError(null);
    void act(key, async () => {
      await setField(run.id, key, parsed, 'edit');
      setEditing(null);
    });
  };

  const confirmDelete = () => {
    if (!window.confirm(t('review.deleteConfirm'))) return;
    void act('__delete', async () => {
      await deleteRun(run.id);
      onDeleted();
    });
  };

  const statusLabel = (f: LearnField) => t(`review.${f.status}`);

  return (
    <section aria-labelledby="sl-review" className="space-y-6">
      <div>
        <h2 id="sl-review" className="text-xl font-bold text-text-primary">
          {t('review.heading')}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">{t('review.intro')}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" disabled={counts.pendingSafe.length === 0} disabledReason={t('review.nothingSafe')} loading={busyKey === '__bulk'} onClick={() => act('__bulk', () => bulkApprove(run.id))}>
          {t('review.approveSafe', { count: counts.pendingSafe.length })}
        </Button>
        {counts.pendingSensitive.length > 0 && (
          <p role="status" className="flex items-center gap-1.5 text-sm text-danger">
            <ShieldAlert size={16} aria-hidden="true" />
            {t('review.sensitiveNote', { count: counts.pendingSensitive.length })}
          </p>
        )}
      </div>

      {groups.length === 0 && <p className="text-sm text-text-secondary">{t('review.empty')}</p>}

      {groups.map(({ group, fields: gf }) => (
        <div key={group} className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">{t(`review.groups.${group}`)}</h3>
          {gf.map((f) => {
            const src = f.source_id ? sourceById.get(f.source_id) : undefined;
            const isEditing = editing === f.key;
            const diff = diffStatus(f);
            const kind = kindOf(f.key);
            return (
              <Card key={f.key} interactive={false} className="space-y-3 !p-4" data-testid={`field-${f.key}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-base font-semibold text-text-primary">{t(`fields.${f.key}`)}</h4>
                  <Badge tone={f.confidence === 'high' ? 'ok' : f.confidence === 'low' ? 'warn' : 'neutral'}>{t(`review.confidence.${f.confidence}`)}</Badge>
                  {f.assumed && <Badge tone="warn">{t('review.assumed')}</Badge>}
                  {f.sensitive && <ShieldAlert size={14} className="text-danger" aria-label={t('review.sensitiveTitle')} />}
                  <Badge tone={f.status === 'rejected' ? 'warn' : f.status === 'pending' ? 'neutral' : 'ok'}>{statusLabel(f)}</Badge>
                  {diff === 'changed' && <Badge tone="warn">{t('review.changed')}</Badge>}
                </div>

                {isEditing ? (
                  <div className="space-y-2">
                    <Textarea label={t(`fields.${f.key}`)} value={draft} onChange={(e) => setDraft(e.target.value)} rows={kind === 'faq' ? 8 : 4} error={fieldError?.key === f.key ? fieldError.msg : undefined} helperText={HINT_KINDS.has(kind) ? t(`review.hint.${kind}`) : undefined} />
                    <div className="flex gap-2">
                      <Button size="sm" loading={busyKey === f.key} onClick={() => saveEdit(f.key)}>
                        {t('review.save')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setFieldError(null); }}>
                        {t('review.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-line break-words text-sm text-text-primary">{formatValue(f.key, f.value)}</p>
                )}

                {diff === 'changed' && (
                  <p className="whitespace-pre-line break-words text-xs text-text-secondary">
                    {t('review.previous')}: {formatValue(f.key, f.prev_value)}
                  </p>
                )}

                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
                  {f.origin === 'interview' && <span>{t('review.fromInterview')}</span>}
                  {f.origin === 'owner_edit' && <span>{t('review.fromEdit')}</span>}
                  {f.citation && f.origin === 'source' && <span className="break-words">“{f.citation}”</span>}
                  {src && isHttpUrl(src.url) && (
                    <a href={src.url ?? undefined} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex items-center gap-1 text-accent underline">
                      {t('review.source')}: {safeHostname(src.url)}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                </p>

                {!isEditing && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="xs" variant={f.status === 'approved' || f.status === 'edited' ? 'secondary' : 'primary'} disabled={f.status === 'approved' || f.status === 'edited'} loading={busyKey === f.key} onClick={() => act(f.key, () => setField(run.id, f.key, null, 'approve'))}>
                      <Check size={14} aria-hidden="true" /> {t('review.approve')}
                    </Button>
                    <Button size="xs" variant="secondary" onClick={() => { setEditing(f.key); setDraft(formatValue(f.key, f.value)); setFieldError(null); }}>
                      <Pencil size={14} aria-hidden="true" /> {t('review.edit')}
                    </Button>
                    <Button size="xs" variant="ghost" disabled={f.status === 'rejected'} onClick={() => act(f.key, () => setField(run.id, f.key, null, 'reject'))}>
                      <X size={14} aria-hidden="true" /> {t('review.reject')}
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ))}

      {sources.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">{t('review.sourcesTitle')}</h3>
          <ul className="space-y-1 text-xs text-text-secondary">
            {sources.map((s) => (
              <li key={s.id} className="flex items-center gap-1.5 break-all">
                {s.status !== 'fetched' && <CircleAlert size={12} className="shrink-0 text-danger" aria-hidden="true" />}
                {s.kind === 'pasted_text' ? t('sources.pasteLabel') : displayUrl(s.url)} · {t(s.status === 'fetched' ? 'sources.fetched' : s.status === 'blocked_robots' ? 'sources.blocked' : 'sources.failed')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button onClick={onNext} disabled={fields.length === 0}>
          {t('review.next')}
        </Button>
        <Button variant="secondary" onClick={onRerun}>
          {t('review.rerun')}
        </Button>
        <Button variant="ghost" onClick={confirmDelete} loading={busyKey === '__delete'}>
          {t('review.deleteRun')}
        </Button>
      </div>
    </section>
  );
}
