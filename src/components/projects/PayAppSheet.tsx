import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Download, Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { centsToDollarsInput, dollarsToCents, formatDate, formatMoney, formatPercent, type InstallProject } from '@/lib/installProjects';
import type { SavePayAppInput } from '@/lib/payAppsApi';
import type { PayAppPdfInput } from '@/lib/payAppPdf';
import {
  BLOCKS_SAVE,
  PAY_APP_STATUS_LABEL,
  bpsToPercentInput,
  buildDraftLines,
  calculateApplication,
  parsePercentToBps,
  percentComplete,
  reconcile,
  thisPeriodFromPercent,
  validateApplication,
  type LineEntry,
  type PayApp,
  type PayAppLine,
  type SovLine,
} from '@/lib/payApps';
import { Pill, panelClass } from './projectUi';

/** "1,250.50" / "-200" → cents. '' → 0. Invalid → null. Negative allowed (credits). */
function parseSignedMoney(text: string): number | null {
  const t = text.trim();
  const neg = t.startsWith('-');
  const cents = dollarsToCents(neg ? t.slice(1) : t);
  if (cents === null) return null;
  return neg ? -cents : cents;
}

const signedInput = (cents: number) => (cents === 0 ? '' : centsToDollarsInput(cents));

const cellInput = 'w-full rounded-lg border border-border bg-bg-primary px-2 py-1 text-right text-sm tabular-nums text-text-primary focus-visible:border-accent focus-visible:outline-none disabled:opacity-60';

interface EntryRowProps {
  line: PayAppLine;
  storedLastPeriod: number;
  error: string | null;
  onChange: (entry: LineEntry) => void;
}

function EntryRow({ line, storedLastPeriod, error, onChange }: EntryRowProps) {
  const work = line.previous_cents + line.this_period_cents;
  const [pctText, setPctText] = useState(() => bpsToPercentInput(Math.round(percentComplete(work, line.scheduled_value_cents) * 100)));
  const [eText, setEText] = useState(() => signedInput(line.this_period_cents));
  const [fText, setFText] = useState(() => signedInput(line.stored_cents));

  // Re-sync the text boxes when the amounts change from outside (e.g. after a save),
  // without clobbering what the person is typing.
  useEffect(() => {
    if (parseSignedMoney(eText) !== line.this_period_cents) setEText(signedInput(line.this_period_cents));
    if (parseSignedMoney(fText) !== line.stored_cents) setFText(signedInput(line.stored_cents));
    const bps = parsePercentToBps(pctText);
    if (bps === null || thisPeriodFromPercent(line.scheduled_value_cents, line.previous_cents, bps) !== line.this_period_cents) {
      setPctText(bpsToPercentInput(Math.round(percentComplete(work, line.scheduled_value_cents) * 100)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.this_period_cents, line.stored_cents, line.previous_cents, line.scheduled_value_cents]);

  const total = work + line.stored_cents;
  const bad = error !== null;
  const invalid = `${cellInput} ${bad ? 'border-danger-500' : ''}`;

  return (
    <tr className="border-t border-border align-top">
      <td className="px-2 py-2 text-sm text-text-secondary">{line.item_no}</td>
      <td className="min-w-[180px] px-2 py-2 text-sm text-text-primary">
        {line.description}
        {line.change_order_ref && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">{line.change_order_ref}</span>}
        {storedLastPeriod > 0 && <p className="mt-0.5 text-xs text-text-secondary">{formatMoney(storedLastPeriod)} was stored last period — include it in “This period” once installed.</p>}
        {bad && <p role="alert" className="mt-0.5 text-xs text-danger-500">{error}</p>}
      </td>
      <td className="px-2 py-2 text-right text-sm tabular-nums">{formatMoney(line.scheduled_value_cents)}</td>
      <td className="px-2 py-2 text-right text-sm tabular-nums text-text-secondary">{formatMoney(line.previous_cents)}</td>
      <td className="w-24 px-2 py-2">
        <input
          aria-label={`Item ${line.item_no} work complete to date, percent`}
          inputMode="decimal"
          className={invalid}
          value={pctText}
          onChange={(e) => {
            setPctText(e.target.value);
            const bps = parsePercentToBps(e.target.value);
            if (bps === null) return;
            const next = thisPeriodFromPercent(line.scheduled_value_cents, line.previous_cents, bps);
            setEText(signedInput(next));
            onChange({ thisPeriodCents: next, storedCents: line.stored_cents });
          }}
        />
      </td>
      <td className="w-32 px-2 py-2">
        <input
          aria-label={`Item ${line.item_no} this period, dollars`}
          inputMode="decimal"
          className={invalid}
          value={eText}
          placeholder="0.00"
          onChange={(e) => {
            setEText(e.target.value);
            const cents = parseSignedMoney(e.target.value);
            if (cents === null) return;
            setPctText(bpsToPercentInput(Math.round(percentComplete(line.previous_cents + cents, line.scheduled_value_cents) * 100)));
            onChange({ thisPeriodCents: cents, storedCents: line.stored_cents });
          }}
        />
      </td>
      <td className="w-32 px-2 py-2">
        <input
          aria-label={`Item ${line.item_no} stored materials, dollars`}
          inputMode="decimal"
          className={invalid}
          value={fText}
          placeholder="0.00"
          onChange={(e) => {
            setFText(e.target.value);
            const cents = dollarsToCents(e.target.value);
            if (cents === null) return;
            onChange({ thisPeriodCents: line.this_period_cents, storedCents: cents });
          }}
        />
      </td>
      <td className="px-2 py-2 text-right text-sm font-medium tabular-nums">{formatMoney(total)}</td>
      <td className="px-2 py-2 text-right text-sm tabular-nums text-text-secondary">{formatPercent(percentComplete(total, line.scheduled_value_cents), 2)}</td>
      <td className="px-2 py-2 text-right text-sm tabular-nums">{formatMoney(line.scheduled_value_cents - total)}</td>
    </tr>
  );
}

export interface PayAppSheetProps {
  mode: 'edit' | 'view';
  project: InstallProject;
  sov: SovLine[];
  /** The draft (edit) or the issued/paid/void application (view); null = brand-new draft. */
  app: PayApp | null;
  appLines: PayAppLine[] | null;
  /** The latest issued/paid application that precedes this one. */
  previous: { app: PayApp; lines: PayAppLine[] } | null;
  today: string;
  busy: boolean;
  toolbar?: ReactNode;
  onSave?: (v: SavePayAppInput) => void;
  onIssue?: (v: SavePayAppInput) => void;
  onDiscard?: () => void;
  onPdf: (input: PayAppPdfInput) => void;
  onClose: () => void;
}

export function PayAppSheet(props: PayAppSheetProps) {
  const { mode, project, sov, app, appLines, previous, today, busy } = props;
  const editable = mode === 'edit';

  const initialEntries = useMemo(() => {
    const e: Record<string, LineEntry> = {};
    for (const l of appLines ?? []) if (l.sov_line_id) e[l.sov_line_id] = { thisPeriodCents: l.this_period_cents, storedCents: l.stored_cents };
    return e;
  }, [appLines]);

  const previousPeriod = previous?.app.period_to ?? null;
  const [entries, setEntries] = useState<Record<string, LineEntry>>(initialEntries);
  const [periodTo, setPeriodTo] = useState(app?.period_to ?? (previousPeriod && previousPeriod > today ? previousPeriod : today));
  const [appDate, setAppDate] = useState(app?.application_date ?? today);
  const [releaseText, setReleaseText] = useState(app && app.retainage_release_cents > 0 ? centsToDollarsInput(app.retainage_release_cents) : '');
  const [notes, setNotes] = useState(app?.notes ?? '');

  const releaseCents = dollarsToCents(releaseText);
  const retainagePercent = editable ? project.retainage_percent : app?.retainage_percent ?? project.retainage_percent;
  const prevCert = editable ? previous?.app.earned_less_retainage_cents ?? 0 : app?.previous_certificates_cents ?? 0;

  const lines = useMemo(
    () => (editable ? buildDraftLines(sov, previous?.lines ?? null, entries, app?.id ?? 'draft') : appLines ?? []),
    [editable, sov, previous, entries, app?.id, appLines],
  );

  const calc = useMemo(
    () => calculateApplication({ lines, retainagePercent, retainageReleaseCents: releaseCents ?? 0, previousCertificatesCents: prevCert }),
    [lines, retainagePercent, releaseCents, prevCert],
  );
  const problems = useMemo(() => reconcile(calc), [calc]);
  const issues = useMemo(
    () =>
      editable
        ? validateApplication({ lines, retainagePercent, retainageReleaseCents: releaseCents ?? 0, contractValueCents: project.contract_value_cents, periodTo, previousPeriodTo: previousPeriod })
        : [],
    [editable, lines, retainagePercent, releaseCents, project.contract_value_cents, periodTo, previousPeriod],
  );
  const lineErrors = useMemo(() => new Map(issues.filter((i) => i.lineId).map((i) => [i.lineId as string, i.message])), [issues]);
  const prevStored = useMemo(() => new Map((previous?.lines ?? []).map((l) => [l.sov_line_id ?? '', l.stored_cents])), [previous]);

  const saveBlockers = issues.filter((i) => BLOCKS_SAVE.includes(i.code)).length > 0 || releaseCents === null || problems.length > 0 || !periodTo;
  const issueBlockers = issues.length > 0 || saveBlockers;
  const t = calc.totals;

  const payload = (): SavePayAppInput => ({
    projectId: project.id,
    periodTo,
    applicationDate: appDate,
    notes,
    retainageReleaseCents: releaseCents ?? 0,
    entries: Object.fromEntries(lines.filter((l) => l.sov_line_id).map((l) => [l.sov_line_id as string, { thisPeriodCents: l.this_period_cents, storedCents: l.stored_cents }])),
  });

  const heldBeforeRelease = t.retainageWorkCents + t.retainageStoredCents;
  const number = app?.application_no ?? (previous ? previous.app.application_no + 1 : 1);

  const summary: { n: string; text: string; cents: number; strong?: boolean; sub?: boolean }[] = [
    { n: '1', text: 'Original contract sum', cents: t.originalContractCents },
    { n: '2', text: 'Net change by change orders', cents: t.changeOrdersCents },
    { n: '3', text: 'Contract sum to date', cents: t.contractToDateCents, strong: true },
    { n: '4', text: 'Total completed & stored to date', cents: t.completedStoredCents },
    { n: '5', text: `Retainage (${retainagePercent}%)`, cents: t.totalRetainageCents },
    { n: 'a', text: 'of completed work', cents: t.retainageWorkCents, sub: true },
    { n: 'b', text: 'of stored material', cents: t.retainageStoredCents, sub: true },
    ...(t.retainageReleasedCents > 0 ? [{ n: '', text: 'less retainage released', cents: -t.retainageReleasedCents, sub: true }] : []),
    { n: '6', text: 'Total earned less retainage', cents: t.earnedLessRetainageCents, strong: true },
    { n: '7', text: 'Less previous certificates', cents: t.previousCertificatesCents },
    { n: '8', text: 'Current payment due', cents: t.currentPaymentDueCents, strong: true },
    { n: '9', text: 'Balance to finish incl. retainage', cents: t.balanceToFinishCents },
  ];

  const status = app?.status ?? 'draft';
  const pdfInput = (): PayAppPdfInput => ({
    contractorName: null, // filled by the tab (needs the profile)
    project: { name: project.name, project_number: project.project_number, customer_name: project.customer_name, site_address: project.site_address },
    app: {
      application_no: number,
      status,
      period_to: periodTo,
      application_date: appDate,
      retainage_percent: retainagePercent,
      retainage_release_cents: releaseCents ?? 0,
      notes: notes.trim() || null,
    },
    lines,
    previousCertificatesCents: prevCert,
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button type="button" onClick={props.onClose} className="focus-ring rounded text-sm text-accent underline-offset-2 hover:underline">← All applications</button>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold text-text-primary">
            Pay application #{number}
            <Pill tone={status === 'paid' ? 'success' : status === 'issued' ? 'info' : status === 'void' ? 'danger' : 'neutral'}>{PAY_APP_STATUS_LABEL[status]}</Pill>
          </h2>
          <p className="text-sm text-text-secondary">Period to {formatDate(periodTo)} · retainage {retainagePercent}% (from project settings)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => props.onPdf(pdfInput())} disabled={problems.length > 0}>
            <Download size={14} aria-hidden="true" /> {editable ? 'Preview PDF' : 'Download PDF'}
          </Button>
          {props.toolbar}
        </div>
      </div>

      {problems.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger-500/40 bg-danger-500/10 p-3 text-sm text-danger-500">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>These figures do not reconcile and cannot be saved: {problems.join('; ')}. Please report this.</span>
        </div>
      )}

      {editable && (
        <div className={`${panelClass} grid gap-3 sm:grid-cols-3`}>
          <label className="text-xs font-medium text-text-secondary">
            Period to
            <Input type="date" value={periodTo} min={previousPeriod ?? undefined} onChange={(e) => setPeriodTo(e.target.value)} className="mt-1 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-text-secondary">
            Application date
            <Input type="date" value={appDate} onChange={(e) => setAppDate(e.target.value)} className="mt-1 py-2 text-sm" />
          </label>
          {project.retainage_percent > 0 && (
            <label className="text-xs font-medium text-text-secondary">
              Retainage released this application ($)
              <div className="mt-1 flex gap-2">
                <Input aria-label="Retainage released" inputMode="decimal" placeholder="0.00" value={releaseText} onChange={(e) => setReleaseText(e.target.value)} className="py-2 text-sm" />
                <Button type="button" size="sm" variant="ghost" onClick={() => setReleaseText(centsToDollarsInput(heldBeforeRelease))} disabled={heldBeforeRelease <= 0}>All</Button>
              </div>
              {releaseCents === null && <span role="alert" className="mt-1 block text-danger-500">Enter a dollar amount.</span>}
            </label>
          )}
        </div>
      )}

      <div className={`${panelClass} overflow-x-auto p-0`}>
        <table className="w-full min-w-[920px] border-collapse text-left">
          <caption className="sr-only">Continuation sheet: schedule of values with work completed, stored materials and balance to finish</caption>
          <thead>
            <tr className="text-xs uppercase tracking-wide text-text-secondary">
              <th scope="col" className="px-2 py-2.5">A · Item</th>
              <th scope="col" className="px-2 py-2.5">B · Description</th>
              <th scope="col" className="px-2 py-2.5 text-right">C · Scheduled</th>
              <th scope="col" className="px-2 py-2.5 text-right">D · Previous</th>
              <th scope="col" className="px-2 py-2.5 text-right">% work</th>
              <th scope="col" className="px-2 py-2.5 text-right">E · This period</th>
              <th scope="col" className="px-2 py-2.5 text-right">F · Stored</th>
              <th scope="col" className="px-2 py-2.5 text-right">G · Total</th>
              <th scope="col" className="px-2 py-2.5 text-right">% (G÷C)</th>
              <th scope="col" className="px-2 py-2.5 text-right">H · Balance</th>
            </tr>
          </thead>
          <tbody>
            {editable
              ? lines.map((l) => (
                  <EntryRow
                    key={l.sov_line_id ?? l.id}
                    line={l}
                    storedLastPeriod={prevStored.get(l.sov_line_id ?? '') ?? 0}
                    error={lineErrors.get(l.id) ?? null}
                    onChange={(entry) => setEntries((prev) => ({ ...prev, [l.sov_line_id as string]: entry }))}
                  />
                ))
              : lines.map((l, i) => {
                  const c = calc.lines[i];
                  return (
                    <tr key={l.id} className="border-t border-border text-sm">
                      <td className="px-2 py-2 text-text-secondary">{l.item_no}</td>
                      <td className="px-2 py-2 text-text-primary">
                        {l.description}
                        {l.change_order_ref && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">{l.change_order_ref}</span>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(c.scheduledCents)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-text-secondary">{formatMoney(c.previousCents)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-text-secondary">{formatPercent(percentComplete(c.workToDateCents, c.scheduledCents), 2)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(c.thisPeriodCents)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(c.storedCents)}</td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums">{formatMoney(c.totalCents)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-text-secondary">{formatPercent(c.percent, 2)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(c.balanceCents)}</td>
                    </tr>
                  );
                })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border bg-bg-tertiary/50 text-sm font-semibold">
              <td className="px-2 py-2.5" />
              <td className="px-2 py-2.5">Grand total</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{formatMoney(t.scheduledCents)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{formatMoney(t.previousCents)}</td>
              <td className="px-2 py-2.5" />
              <td className="px-2 py-2.5 text-right tabular-nums">{formatMoney(t.thisPeriodCents)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{formatMoney(t.storedCents)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{formatMoney(t.totalCents)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{formatPercent(t.percent, 2)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{formatMoney(t.balanceCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {editable && (
            <>
              <label className="block text-xs font-medium text-text-secondary">
                Notes (printed on the G702)
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} className="focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
              </label>
              {issues.length > 0 && (
                <ul role="alert" className="space-y-1 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-warning-500">
                  {issues.map((i, n) => (
                    <li key={`${i.code}-${n}`} className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{i.message}</li>
                  ))}
                </ul>
              )}
              {issues.length === 0 && problems.length === 0 && (
                <p className="flex items-center gap-2 text-sm text-success-500"><CheckCircle2 size={16} aria-hidden="true" /> Everything reconciles — ready to issue.</p>
              )}
              <p className="flex items-start gap-2 text-xs text-text-secondary"><Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />Issuing freezes this application. Descriptions, scheduled values and previous amounts are snapshotted, so later edits never change an issued G702/G703.</p>
            </>
          )}
          {!editable && app?.notes && <p className="whitespace-pre-wrap text-sm text-text-secondary">{app.notes}</p>}
        </div>

        <div className={panelClass}>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">G702 summary</h3>
          <dl className="space-y-1.5">
            {summary.map((row, i) => (
              <div key={`${row.n}-${i}`} className={`flex items-baseline justify-between gap-3 text-sm ${row.strong ? 'rounded-lg bg-bg-tertiary/60 px-2 py-1.5 font-semibold text-text-primary' : row.sub ? 'pl-6 text-text-secondary' : 'px-2 text-text-primary'}`}>
                <dt>{row.n && <span className="mr-2 text-text-secondary">{row.n}</span>}{row.text}</dt>
                <dd className="tabular-nums">{formatMoney(row.cents)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {editable && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <Button variant="ghost" size="sm" disabled={busy || !app} onClick={props.onDiscard}>Discard draft</Button>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy || saveBlockers} onClick={() => props.onSave?.(payload())}>{busy ? 'Saving…' : 'Save draft'}</Button>
            <Button size="sm" disabled={busy || issueBlockers || lines.length === 0} onClick={() => props.onIssue?.(payload())}>Issue application</Button>
          </div>
        </div>
      )}
    </div>
  );
}
