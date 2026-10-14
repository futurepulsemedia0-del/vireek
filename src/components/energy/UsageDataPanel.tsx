import { useCallback, useEffect, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  deleteUsagePeriod,
  fetchUsagePeriods,
  fmtMoney,
  fmtNum,
  parseUsageCsv,
  saveUsagePeriods,
  type Fuel,
  type SiteOption,
  type UsagePeriodRow,
} from '@/lib/energyIntelligence';

const FIELD =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/70';

interface Props {
  customerId: string;
  sites: SiteOption[];
  siteId: string | null;
  onChanged: () => void;
}

/** Utility-bill history: add a bill, paste/import CSV, review and delete. */
export function UsageDataPanel({ customerId, sites, siteId, onChanged }: Props) {
  const { toast } = useToast();
  const [rows, setRows] = useState<UsagePeriodRow[] | null>(null);
  const [fuel, setFuel] = useState<Fuel>('electric');
  const [form, setForm] = useState({ start: '', end: '', usage: '', cost: '' });
  const [csv, setCsv] = useState('');
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await fetchUsagePeriods(customerId));
    } catch {
      setRows([]);
      toast('Could not load billing history.', 'error');
    }
  }, [customerId, toast]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  const after = async () => {
    await load();
    onChanged();
  };

  const addOne = async (e: React.FormEvent) => {
    e.preventDefault();
    const usage = Number(form.usage);
    const days = (Date.parse(form.end) - Date.parse(form.start)) / 86_400_000;
    if (!form.start || !form.end || !(days >= 1 && days <= 70))
      return toast('Billing period must be between 1 and 70 days.', 'error');
    if (!Number.isFinite(usage) || usage < 0 || form.usage === '')
      return toast('Enter the usage for this bill.', 'error');
    const dollars = form.cost.trim() === '' ? null : Number(form.cost.replace(/[$,]/g, ''));
    if (dollars !== null && (!Number.isFinite(dollars) || dollars < 0))
      return toast('Cost must be a dollar amount.', 'error');
    setBusy(true);
    try {
      await saveUsagePeriods(
        customerId,
        siteId,
        fuel,
        [
          {
            period_start: form.start,
            period_end: form.end,
            usage,
            cost_cents: dollars === null ? null : Math.round(dollars * 100),
          },
        ],
        'manual',
      );
      setForm({ start: form.end, end: '', usage: '', cost: '' });
      await after();
      toast('Bill saved.', 'success');
    } catch {
      toast('Could not save this bill.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async () => {
    const { rows: parsed, errors } = parseUsageCsv(csv);
    setCsvErrors(errors);
    if (parsed.length === 0) return toast('Nothing to import.', 'error');
    setBusy(true);
    try {
      const n = await saveUsagePeriods(customerId, siteId, fuel, parsed, 'import');
      setCsv('');
      await after();
      toast(
        `Imported ${n} bill${n === 1 ? '' : 's'}${errors.length ? `, ${errors.length} line(s) skipped` : ''}.`,
        errors.length ? 'info' : 'success',
      );
    } catch {
      toast('Import failed. Nothing was saved.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteUsagePeriod(id);
      await after();
    } catch {
      toast('Could not delete this bill.', 'error');
    }
  };

  const unit = fuel === 'electric' ? 'kWh' : 'therms';
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-4">
        <section
          className="rounded-2xl border border-border bg-bg-secondary p-5"
          aria-labelledby="eu-add"
        >
          <h3 id="eu-add" className="text-sm font-semibold text-text-primary">
            Add a utility bill
          </h3>
          <p className="mt-1 text-xs text-text-secondary">
            Use the meter-read dates on the bill. Twelve or more months unlock the weather model.
            {sites.length > 1 && siteId ? ' Bills are saved against the selected site.' : ''}
          </p>
          <div
            className="mt-3 inline-flex rounded-xl border border-border p-0.5"
            role="group"
            aria-label="Fuel"
          >
            {(['electric', 'gas'] as Fuel[]).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={fuel === f}
                onClick={() => setFuel(f)}
                className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold ${fuel === f ? 'bg-accent text-white' : 'text-text-secondary'}`}
              >
                {f === 'electric' ? 'Electric (kWh)' : 'Gas (therms)'}
              </button>
            ))}
          </div>
          <form onSubmit={addOne} className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-xs text-text-secondary">
              Read start
              <input
                type="date"
                required
                value={form.start}
                onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
                className={`${FIELD} mt-1`}
              />
            </label>
            <label className="text-xs text-text-secondary">
              Read end
              <input
                type="date"
                required
                value={form.end}
                onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
                className={`${FIELD} mt-1`}
              />
            </label>
            <label className="text-xs text-text-secondary">
              Usage ({unit})
              <input
                inputMode="decimal"
                required
                value={form.usage}
                onChange={(e) => setForm((f) => ({ ...f, usage: e.target.value }))}
                placeholder={fuel === 'electric' ? '812' : '46'}
                className={`${FIELD} mt-1`}
              />
            </label>
            <label className="text-xs text-text-secondary">
              Total billed ($, optional)
              <input
                inputMode="decimal"
                value={form.cost}
                onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
                placeholder="121.80"
                className={`${FIELD} mt-1`}
              />
            </label>
            <div className="col-span-2">
              <Button type="submit" size="sm" disabled={busy}>
                Save bill
              </Button>
            </div>
          </form>
        </section>

        <section
          className="rounded-2xl border border-border bg-bg-secondary p-5"
          aria-labelledby="eu-csv"
        >
          <h3
            id="eu-csv"
            className="flex items-center gap-2 text-sm font-semibold text-text-primary"
          >
            <Upload size={14} aria-hidden="true" /> Paste or import many bills
          </h3>
          <p className="mt-1 text-xs text-text-secondary">
            One bill per line: <code>period_start, period_end, usage, cost</code>. Imports as{' '}
            {fuel === 'electric' ? 'electric (kWh)' : 'gas (therms)'}; existing bills for the same
            start date are updated.
          </p>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={5}
            aria-label="Bill CSV"
            placeholder={'2026-01-05,2026-02-04,812,121.80\n2026-02-04,2026-03-06,744,111.60'}
            className={`${FIELD} mt-2 font-mono text-xs`}
          />
          {csvErrors.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-danger-500" role="alert">
              {csvErrors.slice(0, 5).map((er) => (
                <li key={er}>{er}</li>
              ))}
              {csvErrors.length > 5 && <li>and {csvErrors.length - 5} more</li>}
            </ul>
          )}
          <div className="mt-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={importCsv}
              disabled={busy || csv.trim() === ''}
            >
              Import
            </Button>
          </div>
        </section>
      </div>

      <section
        className="rounded-2xl border border-border bg-bg-secondary p-5"
        aria-labelledby="eu-list"
      >
        <h3 id="eu-list" className="text-sm font-semibold text-text-primary">
          Billing history
        </h3>
        {rows === null ? (
          <div className="mt-3 h-40 animate-pulse rounded-xl bg-bg-tertiary" />
        ) : rows.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-text-secondary">
            No bills yet for this customer.
          </p>
        ) : (
          <div className="mt-3 max-h-[28rem] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-bg-secondary text-text-secondary">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Period</th>
                  <th className="pr-2 font-medium">Fuel</th>
                  <th className="pr-2 text-right font-medium">Usage</th>
                  <th className="pr-2 text-right font-medium">Billed</th>
                  <th>
                    <span className="sr-only">Delete</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-1.5 pr-2 text-text-primary">
                      {r.period_start} to {r.period_end}
                    </td>
                    <td className="pr-2 text-text-secondary">
                      {r.fuel === 'electric' ? 'Electric' : 'Gas'}
                    </td>
                    <td className="pr-2 text-right text-text-primary">
                      {fmtNum(r.usage, 1)} {r.fuel === 'electric' ? 'kWh' : 'therms'}
                    </td>
                    <td className="pr-2 text-right text-text-secondary">
                      {fmtMoney(r.cost_cents)}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        aria-label={`Delete bill ${r.period_start}`}
                        className="focus-ring rounded-md p-1 text-text-secondary hover:text-danger-500"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
