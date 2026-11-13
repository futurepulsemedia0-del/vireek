// Recreated: verify against original intent
import { useEffect, useRef, useState } from 'react';
import { FileUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { useChiefT } from '@/i18n/chiefOfStaffNamespace';
import { readXlsxToCsv, XlsxError } from '@/lib/xlsxReader';
import {
  archiveGoalTarget,
  classifySpreadsheet,
  confirmGoalTargets,
  formatGoalValue,
  parseGoals,
  type ClarifyQuestion,
  type ExtractAnswers,
  type ExtractResult,
  type GoalMetric,
  type GoalRow,
  type ParsedTarget,
  type PeriodAnswer,
} from '@/lib/chiefOfStaff';

interface Props {
  goals: GoalRow[];
  canAct: boolean;
  onChanged: () => void;
}

const STATUS_TONE: Record<GoalRow['progress']['status'], string> = {
  ahead: 'bg-success-500/10 text-success-500',
  on_track: 'bg-accent/10 text-accent',
  behind: 'bg-warning-500/10 text-warning-500',
  unavailable: 'bg-bg-tertiary text-text-secondary',
};

const PERIODS: PeriodAnswer[] = ['week', 'month', 'quarter', 'year'];
const MAX_TEXT = 20_000;

export function GoalsPanel({ goals, canAct, onChanged }: Props) {
  const { t } = useChiefT();
  const [adding, setAdding] = useState(false);

  return (
    <Panel
      title={t('goals.title')}
      aria-label={t('goals.title')}
      actions={
        canAct && !adding ? (
          <Button size="xs" variant="secondary" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" />
            {t('goals.add')}
          </Button>
        ) : undefined
      }
    >
      {adding && canAct && (
        <GoalIntake
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}

      {goals.length === 0 ? (
        !adding && <EmptyState compact icon={FileUp} title={t('goals.empty.title')} description={t('goals.empty.body')} />
      ) : (
        <ul className={`space-y-4 ${adding ? 'mt-5 border-t border-border pt-5' : ''}`}>
          {goals.map((g) => (
            <GoalItem key={g.target.id} row={g} canAct={canAct} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function GoalItem({ row, canAct, onChanged }: { row: GoalRow; canAct: boolean; onChanged: () => void }) {
  const { t, language } = useChiefT();
  const { toast } = useToast();
  const [removing, setRemoving] = useState(false);
  const lock = useRef(false);
  const { target, progress } = row;
  const metricLabel = t(`goals.metric.${target.metric}`);
  const targetValue = Number(target.target_value);
  const fmtDate = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  };
  const measurable = progress.status !== 'unavailable' && progress.actual !== null;
  const pct = progress.pct === null ? 0 : Math.max(0, Math.min(100, progress.pct));

  const remove = async () => {
    if (lock.current) return;
    lock.current = true;
    setRemoving(true);
    try {
      await archiveGoalTarget(target.id);
      toast(t('goals.removed'), 'success');
      onChanged();
    } catch {
      toast(t('rec.actionFailed'), 'error');
    } finally {
      lock.current = false;
      setRemoving(false);
    }
  };

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{metricLabel}</h3>
          <p className="text-xs text-text-secondary">
            {t('goals.period', { start: fmtDate(target.period_start), end: fmtDate(target.period_end) })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[progress.status]}`}>
            {t(`goals.status.${progress.status}`)}
          </span>
          {canAct && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={removing}
              aria-label={t('goals.remove', { metric: metricLabel })}
              className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {measurable ? (
        <>
          <p className="mt-3 text-sm text-text-primary">
            {t('goals.actualOfTarget', {
              actual: formatGoalValue(target.metric, progress.actual as number, language),
              target: formatGoalValue(target.metric, targetValue, language),
            })}
          </p>
          <div
            role="progressbar"
            aria-label={t('goals.progressLabel', { metric: metricLabel })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            className="mt-2 h-2 overflow-hidden rounded-full bg-bg-tertiary"
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <dl className="mt-2 space-y-0.5 text-xs text-text-secondary">
            {progress.expectedToDate !== null && <dd>{t('goals.expected', { value: formatGoalValue(target.metric, progress.expectedToDate, language) })}</dd>}
            {progress.projected !== null && <dd>{t('goals.projected', { value: formatGoalValue(target.metric, progress.projected, language) })}</dd>}
          </dl>
        </>
      ) : (
        <p className="mt-3 text-sm text-text-secondary">
          {progress.unavailable ? t(`goals.unavailable.${progress.unavailable}`) : t('goals.status.unavailable')}
        </p>
      )}
      <p className="mt-2 text-[11px] text-text-secondary">{t('goals.measuredFrom', { basis: progress.basis })}</p>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function GoalIntake({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, language } = useChiefT();
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [csv, setCsv] = useState('');
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<ExtractAnswers>({});
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const seq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reset = () => {
    seq.current++; // drop any in-flight parse
    setResult(null);
    setAnswers({});
    setParseError(null);
  };

  const onFile = async (file: File | undefined) => {
    setFileNote(null);
    setFileError(null);
    if (!file) return;
    const kind = classifySpreadsheet(file);
    try {
      if (kind === 'legacy_excel') return setFileError(t('intake.fileXlsx'));
      if (kind === 'unsupported') return setFileError(t('intake.fileUnsupported'));
      if (kind === 'too_large') return setFileError(/\.xlsx$/i.test(file.name) ? t('intake.xlsx.too_large') : t('intake.fileTooLarge'));
      if (kind === 'xlsx') {
        const { csv: converted, sheetName } = await readXlsxToCsv(await file.arrayBuffer());
        setCsv(converted);
        setFileNote(t('intake.sheetRead', { name: sheetName }));
      } else {
        setCsv(await file.text());
        setFileNote(t('intake.fileLoaded', { name: file.name }));
      }
      reset();
    } catch (err) {
      setFileError(err instanceof XlsxError ? t(`intake.xlsx.${err.code}`) : t('intake.fileReadFailed'));
    }
  };

  const check = async (nextAnswers: ExtractAnswers) => {
    if (busy.current) return;
    if (!text.trim() && !csv.trim()) return;
    busy.current = true;
    const mine = ++seq.current;
    setChecking(true);
    setParseError(null);
    try {
      const res = await parseGoals({ text: text.trim() || undefined, csv: csv.trim() || undefined, answers: nextAnswers });
      if (alive.current && mine === seq.current) setResult(res);
    } catch {
      if (alive.current && mine === seq.current) {
        setResult(null);
        setParseError(t('intake.parseFailed'));
      }
    } finally {
      busy.current = false;
      if (alive.current) setChecking(false);
    }
  };

  const answer = (patch: ExtractAnswers) => {
    const next: ExtractAnswers = { ...answers, ...patch, pick: { ...answers.pick, ...patch.pick } };
    setAnswers(next);
    void check(next);
  };

  const confirm = async () => {
    if (!result || result.targets.length === 0 || saving) return;
    setSaving(true);
    try {
      await confirmGoalTargets(result.targets);
      toast(t('intake.saved'), 'success');
      onSaved();
    } catch {
      toast(t('intake.saveFailed'), 'error');
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const empty =
    result !== null &&
    result.targets.length === 0 &&
    result.pendingPeriod.length === 0 &&
    result.questions.length === 0 &&
    result.unresolved.length === 0;

  return (
    <section aria-labelledby="goal-intake-title" className="space-y-4">
      <div>
        <h3 id="goal-intake-title" className="text-sm font-semibold text-text-primary">{t('intake.title')}</h3>
        <p className="mt-0.5 text-xs text-text-secondary">{t('intake.intro')}</p>
      </div>

      <Textarea
        label={t('intake.textLabel')}
        placeholder={t('intake.textPlaceholder')}
        value={text}
        maxLength={MAX_TEXT}
        rows={3}
        onChange={(e) => {
          setText(e.target.value);
          if (result) reset();
        }}
      />

      <div>
        <label htmlFor="goal-file" className="block text-xs font-semibold text-text-secondary">{t('intake.fileLabel')}</label>
        <input
          id="goal-file"
          type="file"
          accept=".xlsx,.csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = ''; // the same file can be chosen again after a fix
          }}
          className="mt-1 block w-full text-sm text-text-secondary file:me-3 file:rounded-lg file:border file:border-border file:bg-bg-tertiary file:px-3 file:py-1.5 file:text-sm file:text-text-primary"
        />
        <p className="mt-1 text-[11px] text-text-secondary">{t('intake.fileHint')}</p>
        {fileNote && <p role="status" className="mt-1 text-xs text-text-primary">{fileNote}</p>}
        {fileError && <p role="alert" className="mt-1 text-xs text-danger">{fileError}</p>}
      </div>

      {parseError && <p role="alert" className="text-sm text-danger">{parseError}</p>}

      {result && (
        <div className="space-y-4" aria-live="polite">
          {result.warnings.map((w, i) => (
            <p key={i} className="text-xs text-warning-500">
              {w.code === 'fraction_converted'
                ? t('intake.warn.fraction_converted', { ref: w.ref })
                : t(`intake.warn.${w.code}`)}
            </p>
          ))}

          {empty && <p className="text-sm text-text-secondary">{t('intake.nothingFound')}</p>}

          {result.questions.map((q) => (
            <Question key={`${q.id}:${q.metric ?? ''}`} q={q} answers={answers} onAnswer={answer} disabled={checking} />
          ))}

          {result.targets.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-text-secondary">{t('intake.previewTitle')}</h4>
              <TargetList targets={result.targets} language={language} />
            </div>
          )}

          {result.pendingPeriod.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-text-secondary">{t('intake.pendingTitle')}</h4>
              <TargetList targets={result.pendingPeriod} language={language} />
            </div>
          )}

          {result.unresolved.length > 0 && (
            <p className="text-xs text-text-secondary">{t('intake.unresolved', { count: result.unresolved.length })}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>{t('intake.cancel')}</Button>
        {result && result.targets.length > 0 ? (
          <Button size="sm" onClick={() => void confirm()} loading={saving} loadingLabel={t('intake.confirming')} disabled={checking}>
            {t('intake.confirm', { count: result.targets.length })}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void check(answers)}
            loading={checking}
            loadingLabel={t('intake.checking')}
            disabled={!text.trim() && !csv.trim()}
          >
            {t('intake.check')}
          </Button>
        )}
      </div>
    </section>
  );
}

function TargetList({ targets, language }: { targets: ParsedTarget[]; language: string }) {
  const { t } = useChiefT();
  return (
    <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border">
      {targets.map((x, i) => (
        <li key={`${x.metric}:${x.sourceRef}:${i}`} className="px-3 py-2">
          <p className="text-sm text-text-primary">
            {t(`goals.metric.${x.metric}`)} — <span className="font-semibold">{formatGoalValue(x.metric as GoalMetric, x.value, language)}</span>
          </p>
          {x.periodStart && x.periodEnd && (
            <p className="text-xs text-text-secondary">{t('goals.period', { start: x.periodStart, end: x.periodEnd })}</p>
          )}
          <p className="text-[11px] text-text-secondary">{t('intake.source', { ref: x.sourceRef })}</p>
        </li>
      ))}
    </ul>
  );
}

function Question({
  q,
  answers,
  onAnswer,
  disabled,
}: {
  q: ClarifyQuestion;
  answers: ExtractAnswers;
  onAnswer: (patch: ExtractAnswers) => void;
  disabled: boolean;
}) {
  const { t } = useChiefT();
  const metric = q.metric ? t(`goals.metric.${q.metric}`) : '';
  const name = `q-${q.id}-${q.metric ?? 'all'}`;

  return (
    <fieldset className="rounded-lg border border-border p-3" disabled={disabled}>
      <legend className="px-1 text-xs font-semibold text-text-secondary">{t('intake.questionsTitle')}</legend>
      <p className="text-sm text-text-primary">{t(`intake.q.${q.id}`, { metric })}</p>

      {q.id === 'period' && (
        <div className="mt-2 flex flex-wrap gap-3">
          {PERIODS.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-sm text-text-primary">
              <input type="radio" name={name} checked={answers.period === p} onChange={() => onAnswer({ period: p })} />
              {t(`intake.period.${p}`)}
            </label>
          ))}
        </div>
      )}

      {q.id === 'duplicate_metric' && q.metric && q.options && (
        <div className="mt-2 space-y-1.5">
          {q.options.map((opt, idx) => (
            <label key={`${idx}:${opt}`} className="flex items-start gap-1.5 text-sm text-text-primary">
              <input
                type="radio"
                name={name}
                className="mt-1"
                checked={answers.pick?.[q.metric as GoalMetric] === idx}
                onChange={() => onAnswer({ pick: { [q.metric as GoalMetric]: idx } })}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
