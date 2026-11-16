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
  resilient: 'bg-success-subtle text-success-strong',
  exposed: 'bg-warning-subtle text-warning-strong',
  fragile: 'bg-warning-subtle text-warning-strong',
  critical: 'bg-danger-subtle text-danger-strong',
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
      className="mt-5 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-3"
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
          className="mt-1 w-full rounded border border-border-strong px-2 py-1 dark:bg-surface-inverse"
        />
      </label>
      <label className="text-sm">
        Work done by hand (%)
        <input
          type="number" min={0} max={100} step="1" value={manual}
          onChange={(e) => setManual(e.target.value)}
          className="mt-1 w-full rounded border border-border-strong px-2 py-1 dark:bg-surface-inverse"
        />
      </label>
      <div className="flex items-end">
        <button type="submit" className="rounded-md bg-surface-inverse px-3 py-1.5 text-sm text-white">
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
    <section aria-labelledby="fragility-title" className="rounded-xl border border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="fragility-title" className="text-lg font-semibold">Business Fragility Score</h2>
          <p className="mt-1 text-sm text-text-secondary">
            How badly would a shock hurt this business? Higher means more fragile. Profit alone does not make a business resilient.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} disabled={busy}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm disabled:opacity-50">
            Recalculate
          </button>
          <button type="button" onClick={() => void saveSnapshot()} disabled={busy || report?.score == null}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm disabled:opacity-50">
            Save snapshot
          </button>
        </div>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}

      {report && report.score === null && (
        <p className="mt-4 text-sm text-text-secondary">
          Not enough data yet. {Math.round(report.coverage * 100)}% of the eight dimensions can be measured; at least five are needed.
        </p>
      )}

      {report && report.score !== null && report.band !== null && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <p className="text-4xl font-semibold tabular-nums">{report.score}</p>
          <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${BAND_STYLE[report.band]}`}>
            {BAND_LABEL[report.band]}
          </span>
          <p className="text-sm text-text-secondary">
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
                {c.advice && <span className="text-text-secondary"> — {c.advice}</span>}
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
              <span className="text-text-secondary">{c.display ?? 'no data'}</span>
              <div className="col-span-2 h-1.5 overflow-hidden rounded bg-bg-tertiary">
                <div className="h-full rounded bg-surface-inverse" style={{ width: `${Math.round((c.risk ?? 0) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <SettingsForm initial={settings} onSave={(next) => void applySettings(next)} />
    </section>
  );
}
