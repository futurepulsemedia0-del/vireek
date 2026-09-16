import { useMemo, useState } from 'react';
import {
  Building2,
  Download,
  Loader2,
  Lock,
  CalendarRange,
  FileJson,
  FileSpreadsheet,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  ENTERPRISE_DATASETS,
  EnterpriseDatasetId,
  ExportFormat,
  isEnterpriseExportEligible,
  runEnterpriseExport,
} from '@/lib/enterpriseExport';

const ALL_IDS = ENTERPRISE_DATASETS.map((d) => d.id);

export function EnterpriseDataExportPanel() {
  const { profile, isOwner } = useAuth();
  const { toast } = useToast();

  const eligible = isEnterpriseExportEligible(profile?.plan, isOwner);

  const [selected, setSelected] = useState<EnterpriseDatasetId[]>(() => [...ALL_IDS]);
  const [format, setFormat] = useState<ExportFormat>('json');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [running, setRunning] = useState(false);

  const allSelected = selected.length === ALL_IDS.length;

  const summary = useMemo(() => {
    const n = selected.length;
    const range =
      dateFrom || dateTo
        ? ` · ${dateFrom || '…'} → ${dateTo || '…'}`
        : ' · all time';
    return `${n} dataset${n === 1 ? '' : 's'}${range} · ${format.toUpperCase()}`;
  }, [selected, dateFrom, dateTo, format]);

  const toggle = (id: EnterpriseDatasetId) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.length === ALL_IDS.length ? [] : [...ALL_IDS]));
  };

  const handleRun = async () => {
    if (!selected.length) {
      toast('Select at least one dataset.', 'error');
      return;
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      toast('“From” date must be before “To” date.', 'error');
      return;
    }
    setRunning(true);
    try {
      const result = await runEnterpriseExport({
        datasets: selected,
        format,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      toast(
        result.format === 'json'
          ? 'Workspace export downloaded (JSON).'
          : `Workspace export started — ${result.fileCount} CSV file${result.fileCount === 1 ? '' : 's'}. Allow multiple downloads if the browser asks.`,
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Workspace export failed.', 'error');
    } finally {
      setRunning(false);
    }
  };

  // Non-owners never see this panel (parent can still mount; we hide).
  if (!isOwner) return null;

  if (!eligible) {
    return (
      <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <Lock size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-text-primary">Workspace data export</h2>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              Organization-level export (all workspace data the owner can access) is available on
              Business and Enterprise plans. Personal “Export my data” remains available to every account below.
            </p>
            <Link
              to="/pricing"
              className="mt-3 inline-flex text-sm font-semibold text-accent hover:underline"
            >
              View plans
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-accent/25 bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Building2 size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text-primary">Workspace data export</h2>
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
              Enterprise
            </span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">
            Export the full workspace for compliance, migration, or offline analysis. This is separate
            from the personal data download and is limited to the account owner.
          </p>
        </div>
      </div>

      {/* Datasets */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Datasets</p>
          <button
            type="button"
            onClick={toggleAll}
            className="text-xs font-semibold text-accent hover:underline"
          >
            {allSelected ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {ENTERPRISE_DATASETS.map((ds) => {
            const checked = selected.includes(ds.id);
            return (
              <label
                key={ds.id}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition ${
                  checked
                    ? 'border-accent/40 bg-accent/5'
                    : 'border-border bg-bg-primary/50 hover:border-border'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(ds.id)}
                  className="mt-1 h-4 w-4 rounded border-border text-accent focus:ring-accent/30"
                />
                <span>
                  <span className="block text-sm font-medium text-text-primary">{ds.label}</span>
                  <span className="block text-xs text-text-secondary">{ds.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Date range */}
      <div className="mt-5">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-secondary">
          <CalendarRange size={12} />
          Date range (optional)
        </p>
        <p className="mb-2 text-xs text-text-secondary">
          Applied only to datasets that have a <code className="font-mono text-[11px]">created_at</code> field.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 sm:max-w-[180px]"
          />
          <span className="hidden text-text-secondary sm:inline">→</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 sm:max-w-[180px]"
          />
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
              }}
              className="text-xs font-semibold text-text-secondary hover:text-text-primary"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Format */}
      <div className="mt-5">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">Format</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setFormat('json')}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition ${
              format === 'json'
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border text-text-secondary hover:bg-bg-tertiary'
            }`}
          >
            <FileJson size={14} />
            JSON (single file)
          </button>
          <button
            type="button"
            onClick={() => setFormat('csv')}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition ${
              format === 'csv'
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border text-text-secondary hover:bg-bg-tertiary'
            }`}
          >
            <FileSpreadsheet size={14} />
            CSV (one file per dataset)
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent" />
          <span>
            {summary}. Row cap per table: 50,000. Over-cap tables are marked in the export — contact support for a full archive.
          </span>
        </p>
        <button
          type="button"
          onClick={handleRun}
          disabled={running || selected.length === 0}
          className="focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {running ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          {running ? 'Preparing workspace export…' : 'Export workspace'}
        </button>
      </div>
    </div>
  );
}
