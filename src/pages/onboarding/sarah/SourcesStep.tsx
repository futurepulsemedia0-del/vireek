import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, Globe } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Textarea } from '@/components/ui/Input';
import { MiniLoader } from '@/components/ui/MiniLoader';
import { ApiError, startRun, track, type StartEvent } from './sarahLearnApi';
import { displayUrl, formatDuration } from './sarahLearnLogic';

interface Props {
  locale: 'en' | 'es';
  parentRunId?: string;
  initialUrl?: string;
  onDone: (runId: string, info: { fields: number; ms: number }) => void;
}

interface Row {
  url: string;
  status: 'fetched' | 'blocked_robots' | 'failed';
}

export function SourcesStep({ locale, parentRunId, initialUrl = '', onDone }: Props) {
  const { t } = useTranslation('sarahLearn');
  const [url, setUrl] = useState(initialUrl);
  const [text, setText] = useState('');
  const [own, setOwn] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [extract, setExtract] = useState<{ done: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = async () => {
    setError('');
    if (!url.trim() && text.trim().length < 40) return setError(t('sources.needInput'));
    if (!own) return setError(t('sources.needConfirm'));
    setBusy(true);
    setRows([]);
    setExtract(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let finished = false;
    try {
      await startRun(
        { websiteUrl: url.trim(), pastedText: text.trim(), ownPropertyConfirmed: own, locale, parentRunId },
        (e: StartEvent) => {
          if (e.step === 'fetch') setRows((r) => [...r, { url: e.url, status: e.status }]);
          else if (e.step === 'extract') setExtract({ done: e.done, total: e.total });
          else if (e.step === 'error') setError(e.message);
          else if (e.step === 'done') {
            finished = true;
            track('first_draft', { ms: e.ms, fields: e.fields });
            onDone(e.run_id, { fields: e.fields, ms: e.ms });
          }
        },
        ctrl.signal,
      );
      if (!finished && !ctrl.signal.aborted) setError((prev) => prev || t('page.loadError'));
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err instanceof ApiError ? err.message : t('page.loadError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="sl-sources" className="space-y-5">
      <h2 id="sl-sources" className="text-xl font-bold text-text-primary">
        {t('sources.heading')}
      </h2>
      <Input label={t('sources.websiteLabel')} placeholder={t('sources.websitePlaceholder')} helperText={t('sources.websiteHelp')} value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} inputMode="url" autoComplete="url" />
      <Textarea label={t('sources.pasteLabel')} placeholder={t('sources.pastePlaceholder')} helperText={t('sources.pasteHelp')} value={text} onChange={(e) => setText(e.target.value.slice(0, 3600))} disabled={busy} rows={5} />
      <Checkbox label={t('sources.ownConfirm')} checked={own} onChange={(e) => setOwn(e.target.checked)} disabled={busy} />
      <p className="text-xs text-text-secondary">{t('sources.privacyNote')}</p>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      <Button onClick={submit} loading={busy} loadingLabel={t('sources.starting')} className="w-full sm:w-auto">
        {t('sources.start')}
      </Button>

      {(busy || rows.length > 0) && (
        <ol aria-live="polite" aria-label={t('sources.starting')} className="space-y-2 rounded-xl border border-border bg-bg-primary p-4 text-sm">
          {rows.map((r, i) => (
            <li key={`${r.url}-${i}`} className="flex items-start gap-2 text-text-secondary">
              {r.status === 'fetched' ? <Check size={16} className="mt-0.5 shrink-0 text-success-500" aria-hidden="true" /> : <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />}
              <span className="min-w-0 break-words">
                <Globe size={12} className="mr-1 inline" aria-hidden="true" />
                {r.url === 'pasted' ? t('sources.pasteLabel') : displayUrl(r.url)}
                {' · '}
                {t(r.status === 'fetched' ? 'sources.fetched' : r.status === 'blocked_robots' ? 'sources.blocked' : 'sources.failed')}
              </span>
            </li>
          ))}
          {extract && (
            <li className="flex items-center gap-2 text-text-primary">
              {busy && <MiniLoader />}
              {t('sources.extracting', { done: extract.done, total: extract.total })}
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

export function draftDoneLabel(t: (k: string, o?: Record<string, unknown>) => string, ms: number): string {
  return t('sources.done', { time: formatDuration(ms) });
}
