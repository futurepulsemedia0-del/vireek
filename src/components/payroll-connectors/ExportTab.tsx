import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, CalendarRange, FileSpreadsheet, Loader2, Plug, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { LoadError, StatusPill, toIsoDate, useLoader } from '@/components/commissions/shared';
import { useToast } from '@/contexts/ToastContext';
import {
  PAYROLL_PROVIDERS,
  PROVIDER_META,
  createExport,
  getPreview,
  hours,
  money,
  newIdempotencyKey,
  payrollErrorMessage,
  type DeliveryMode,
  type PayrollConnection,
  type PayrollProvider,
} from '@/lib/payrollConnectors';

interface Props {
  ownerId: string;
  connections: PayrollConnection[];
  /** Called with the new export id so the page can open it in History. */
  onCreated: (exportId: string) => void;
  onGoToConnections: () => void;
  onGoToMapping: (provider: PayrollProvider) => void;
}

const FLAG_LABEL: Record<string, string> = {
  unmapped: 'No provider ID',
  negative_commission: 'Negative commission carried forward',
};

function presetRange(kind: 'last-week' | 'last-2-weeks' | 'last-month' | 'this-month'): { start: string; end: string } {
  const now = new Date();
  const day = (d: Date) => toIsoDate(d);
  if (kind === 'this-month') return { start: day(new Date(now.getFullYear(), now.getMonth(), 1)), end: day(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
  if (kind === 'last-month') return { start: day(new Date(now.getFullYear(), now.getMonth() - 1, 1)), end: day(new Date(now.getFullYear(), now.getMonth(), 0)) };
  // Weeks run Monday to Sunday and end on the last completed Sunday.
  const sinceMonday = (now.getDay() + 6) % 7;
  const lastSunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday - 1);
  const span = kind === 'last-week' ? 6 : 13;
  return { start: day(new Date(lastSunday.getFullYear(), lastSunday.getMonth(), lastSunday.getDate() - span)), end: day(lastSunday) };
}

export function ExportTab({ ownerId, connections, onCreated, onGoToConnections, onGoToMapping }: Props) {
  const { toast } = useToast();
  const [provider, setProvider] = useState<PayrollProvider>('gusto');
  const [range, setRange] = useState(() => presetRange('last-2-weeks'));
  const [delivery, setDelivery] = useState<DeliveryMode>('file');
  const [busy, setBusy] = useState(false);
  const attemptKey = useRef(newIdempotencyKey());

  const connection = connections.find((c) => c.provider === provider);
  const meta = PROVIDER_META[provider];
  const apiReady = connection?.mode === 'api' && connection.status === 'connected' && !!connection.external_company_id;
  const effectiveDelivery: DeliveryMode = delivery === 'api' && apiReady ? 'api' : 'file';
  const rangeValid = !!range.start && !!range.end && range.start <= range.end;

  const preview = useLoader(
    async () => (rangeValid ? getPreview(provider, range.start, range.end) : null),
    [ownerId, provider, range.start, range.end, rangeValid, connection?.id ?? 'none'],
  );

  const exportable = useMemo(
    () => (preview.data?.lines ?? []).filter((l) => l.external_id && (l.regular_hours > 0 || l.overtime_hours > 0 || l.commission_cents > 0 || l.tip_cents > 0)),
    [preview.data],
  );
  const unmappedCount = (preview.data?.lines ?? []).filter((l) => l.flags.includes('unmapped')).length;

  async function create() {
    if (busy || !connection) return;
    setBusy(true);
    try {
      const id = await createExport(provider, range.start, range.end, effectiveDelivery, attemptKey.current);
      attemptKey.current = newIdempotencyKey();
      toast('Export created. Review it, then download or send it.', 'success');
      onCreated(id);
    } catch (e) {
      toast(payrollErrorMessage(e, 'Could not create the export.'), 'error');
      preview.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="pc-provider-h" className="space-y-3">
        <h2 id="pc-provider-h" className="text-sm font-semibold text-text-primary">1. Choose your payroll provider</h2>
        <div role="radiogroup" aria-labelledby="pc-provider-h" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PAYROLL_PROVIDERS.map((p) => {
            const c = connections.find((x) => x.provider === p);
            const selected = p === provider;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setProvider(p)}
                className={`focus-ring rounded-2xl border p-4 text-left transition-colors ${selected ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-text-primary">{PROVIDER_META[p].label}</span>
                  {c ? <StatusPill tone={c.mode === 'api' ? 'success' : 'info'}>{c.mode === 'api' ? 'Live' : 'File'}</StatusPill> : <StatusPill tone="neutral">Not set up</StatusPill>}
                </span>
                <span className="mt-1.5 block text-xs text-text-secondary">{PROVIDER_META[p].fileLabel}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="pc-period-h" className="space-y-3">
        <h2 id="pc-period-h" className="text-sm font-semibold text-text-primary">2. Pick the pay period</h2>
        <Card className="space-y-4 p-5 hover:translate-y-0">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input type="date" label="Period start" value={range.start} max={range.end || undefined} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
            <Input type="date" label="Period end" value={range.end} min={range.start || undefined} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CalendarRange size={14} className="text-text-secondary" aria-hidden="true" />
            {([['last-week', 'Last week'], ['last-2-weeks', 'Last 2 weeks'], ['last-month', 'Last month'], ['this-month', 'This month']] as const).map(([k, label]) => (
              <Button key={k} variant="secondary" size="sm" onClick={() => setRange(presetRange(k))}>{label}</Button>
            ))}
          </div>
          {!rangeValid && <p role="alert" className="text-sm text-danger">Choose a start date on or before the end date.</p>}
          {provider === 'gusto' && <p className="text-xs text-text-secondary">For the Gusto API the dates must match an open pay period in Gusto exactly.</p>}
        </Card>
      </section>

      <section aria-labelledby="pc-review-h" className="space-y-3" aria-live="polite">
        <h2 id="pc-review-h" className="text-sm font-semibold text-text-primary">3. Review what will be exported</h2>

        {!connection ? (
          <EmptyState
            icon={Plug}
            title={`Set up ${meta.label} first`}
            description="Save your provider settings once, then map each employee to their provider ID."
            action={{ label: 'Go to Connections', onClick: onGoToConnections }}
          />
        ) : preview.loading ? (
          <SkeletonCardList count={2} rows={3} />
        ) : preview.error ? (
          <LoadError message={preview.error} onRetry={preview.reload} />
        ) : !rangeValid ? null : (
          <>
            {preview.data && preview.data.warnings.length > 0 && (
              <ul className="space-y-2" aria-label="Warnings">
                {preview.data.warnings.map((w) => (
                  <li key={w.code} className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-text-primary">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
                    <span className="flex-1">{w.message}</span>
                    {w.code === 'unmapped' && <Button variant="ghost" size="sm" onClick={() => onGoToMapping(provider)}>Map employees</Button>}
                  </li>
                ))}
              </ul>
            )}

            {exportable.length === 0 ? (
              <EmptyState
                icon={FileSpreadsheet}
                title="Nothing to export for this period"
                description={unmappedCount > 0 ? 'Employees with pay data need a provider ID before they can be exported.' : 'Only approved timesheets, approved commissions and paid tips that were not exported or paid before are included.'}
                action={unmappedCount > 0 ? { label: 'Map employees', onClick: () => onGoToMapping(provider) } : undefined}
              />
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                  {[
                    ['Employees', String(preview.data?.totals.employees ?? 0)],
                    ['Regular hours', hours(preview.data?.totals.regular_hours ?? 0)],
                    ['Overtime hours', hours(preview.data?.totals.overtime_hours ?? 0)],
                    ['Commissions', money(preview.data?.totals.commission_cents ?? 0)],
                    ['Tips', money(preview.data?.totals.tip_cents ?? 0)],
                  ].map(([k, v]) => (
                    <Card key={k} className="p-4 hover:translate-y-0">
                      <dt className="text-xs text-text-secondary">{k}</dt>
                      <dd className="mt-1 text-lg font-semibold text-text-primary tabular-nums">{v}</dd>
                    </Card>
                  ))}
                </dl>

                <Card className="overflow-hidden p-0 hover:translate-y-0">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                      <caption className="sr-only">Employees included in this export</caption>
                      <thead className="bg-bg-tertiary text-left text-xs text-text-secondary">
                        <tr>
                          <th scope="col" className="px-4 py-2.5 font-medium">Employee</th>
                          <th scope="col" className="px-4 py-2.5 font-medium">{meta.idLabel}</th>
                          <th scope="col" className="px-4 py-2.5 text-right font-medium">Regular h</th>
                          <th scope="col" className="px-4 py-2.5 text-right font-medium">Overtime h</th>
                          <th scope="col" className="px-4 py-2.5 text-right font-medium">Commission</th>
                          <th scope="col" className="px-4 py-2.5 text-right font-medium">Tips</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(preview.data?.lines ?? []).map((l) => (
                          <tr key={l.employee_id} className={l.external_id ? '' : 'bg-warning-500/5'}>
                            <td className="px-4 py-2.5 font-medium text-text-primary">
                              {l.employee_name}
                              {l.flags.map((f) => (
                                <span key={f} className="ml-2"><StatusPill tone="warning">{FLAG_LABEL[f] ?? f}</StatusPill></span>
                              ))}
                            </td>
                            <td className="px-4 py-2.5 text-text-secondary">{l.external_id || '-'}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{hours(l.regular_hours)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{hours(l.overtime_hours)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{money(l.commission_cents)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{money(l.tip_cents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                <Card className="space-y-4 p-5 hover:translate-y-0">
                  <h3 className="text-sm font-semibold text-text-primary">4. Create the export</h3>
                  {meta.supportsApi && (
                    <div role="radiogroup" aria-label="Delivery method" className="grid gap-2 sm:grid-cols-2">
                      {([
                        ['file', 'Download a file', `${meta.fileLabel}. Upload it in ${meta.label} yourself.`],
                        ['api', 'Send to Gusto automatically', apiReady ? `Fills the open payroll in ${connection.company_name ?? 'your Gusto company'}.` : 'Connect Gusto and choose a company first.'],
                      ] as const).map(([value, title, desc]) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={effectiveDelivery === value}
                          disabled={value === 'api' && !apiReady}
                          onClick={() => setDelivery(value)}
                          className={`focus-ring rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${effectiveDelivery === value ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'}`}
                        >
                          <span className="block text-sm font-semibold text-text-primary">{title}</span>
                          <span className="mt-0.5 block text-xs text-text-secondary">{desc}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-text-secondary">
                    Creating the export reserves these hours, commissions and tips so they can never be exported twice or paid again in a Vireek pay run. You can void it later to release them. {meta.label} handles withholding and cash; nothing is posted to your books.
                  </p>
                  <div className="flex justify-end">
                    <Button onClick={create} disabled={busy || exportable.length === 0}>
                      {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : effectiveDelivery === 'api' ? <Send size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
                      {busy ? 'Creating…' : `Create export for ${exportable.length} employee${exportable.length === 1 ? '' : 's'}`}
                    </Button>
                  </div>
                </Card>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
