import { useCallback, useEffect, useState } from 'react';
import { deriveInputs, scoreFragility, type FragilityBand, type FragilityReport } from '@/lib/fragilityScore';
import {
  fetchFragilitySettings,
  fetchLatestFragilityScore,
  fetchRawBusinessData,
  saveFragilitySettings,
  saveFragilitySnapshot,
  type FragilitySettings,
} from '@/lib/fragilityApi';

const BAND_LABEL: Record<FragilityBand, string> = {
  resilient: 'Resilient',
  exposed: 'Exposed',
  fragile: 'Fragile',
  critical: 'Critical',
};

const BAND_STYLE: Record<FragilityBand, string> = {
  resilient: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  exposed: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  fragile: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
  critical: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

const errorText = (e: unknown) => (e as { message?: string } | null)?.message ?? 'Something went wrong.';

interface SettingsFormProps {
  initial: FragilitySettings;
  onSave: (next: FragilitySettings) => void;
}

function SettingsForm({ initial, onSave }: SettingsFormProps) {
  const [backup, setBackup] = useState(initial.backupCapacityPct?.toString() ?? '');
  const [manual, setManual] = useState(initial.manualWorkPct?.toString() ?? '');

  const parse = (v: string): number | null => (v.trim() === '' ? null : Math.min(100, Math.max(0, Number(v))));

  return (
    <form
      className="mt-5 grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-3 dark:border-slate-700"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ backupCapacityPct: parse(backup), manualWorkPct: parse(manual) });
      }}
    >
      <label className="text-sm">
        Spare technician capacity (%)
        <input
          type="number" min={0} max={100} step="1" value={backup}
          onChange={(e) => setBackup(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
        />
      </label>
      <label className="text-sm">
        Work done by hand (%)
        <input
          type="number" min={0} max={100} step="1" value={manual}
          onChange={(e) => setManual(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
        />
      </label>
      <div className="flex items-end">
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white dark:bg-slate-100 dark:text-slate-900">
          Save inputs
        </button>
      </div>
    </form>
  );
}

interface Props {
  ownerId: string;
}

export default function FragilityScorePanel({ ownerId }: Props) {
  const [report, setReport] = useState<FragilityReport | null>(null);
  const [settings, setSettings] = useState<FragilitySettings>({ backupCapacityPct: null, manualWorkPct: null });
  const [previous, setPrevious] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await fetchFragilitySettings(ownerId);
      const raw = await fetchRawBusinessData(ownerId, saved);
      setSettings(saved);
      setReport(scoreFragility(deriveInputs(raw)));
      setPrevious(await fetchLatestFragilityScore(ownerId));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const applySettings = async (next: FragilitySettings) => {
    try {
      await saveFragilitySettings(ownerId, next);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const saveSnapshot = async () => {
    const current = report?.score;
    if (!report || current == null) return;
    try {
      await saveFragilitySnapshot(ownerId, report);
      setPrevious(current);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const delta = report?.score != null && previous !== null ? Math.round((report.score - previous) * 10) / 10 : null;

  return (
    <section aria-labelledby="fragility-title" className="rounded-xl border border-slate-200 p-5 dark:border-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="fragility-title" className="text-lg font-semibold">Business Fragility Score</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            How badly would a shock hurt this business? Higher means more fragile. Profit alone does not make a business resilient.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600">
            Recalculate
          </button>
          <button type="button" onClick={() => void saveSnapshot()} disabled={busy || report?.score == null}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600">
            Save snapshot
          </button>
        </div>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {report && report.score === null && (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
          Not enough data yet. {Math.round(report.coverage * 100)}% of the eight dimensions can be measured; at least five are needed.
        </p>
      )}

      {report && report.score !== null && report.band !== null && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <p className="text-4xl font-semibold tabular-nums">{report.score}</p>
          <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${BAND_STYLE[report.band]}`}>
            {BAND_LABEL[report.band]}
          </span>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Scalability {report.scalability ?? 'n/a'} / 100 · Coverage {Math.round(report.coverage * 100)}%
            {delta !== null && ` · ${delta > 0 ? '+' : ''}${delta} since last snapshot`}
          </p>
        </div>
      )}

      {report && report.weakestLinks.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Weakest links</h3>
          <ul className="mt-2 space-y-2">
            {report.weakestLinks.map((c) => (
              <li key={c.key} className="text-sm">
                <span className="font-medium">{c.label}</span>
                {c.advice && <span className="text-slate-600 dark:text-slate-400"> — {c.advice}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report && (
        <ul className="mt-5 space-y-2">
          {report.components.map((c) => (
            <li key={c.key} className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
              <span>{c.label}</span>
              <span className="text-slate-600 dark:text-slate-400">{c.display ?? 'no data'}</span>
              <div className="col-span-2 h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
                <div className="h-full rounded bg-slate-700 dark:bg-slate-300" style={{ width: `${Math.round((c.risk ?? 0) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <SettingsForm initial={settings} onSave={(next) => void applySettings(next)} />
    </section>
  );
}
