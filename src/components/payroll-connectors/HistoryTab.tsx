import { useEffect, useState } from 'react';
import { AlertTriangle, Download, FileSpreadsheet, Loader2, Send, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Dialog, LoadError, StatusPill, formatDay, useLoader, type Tone } from '@/components/commissions/shared';
import { useToast } from '@/contexts/ToastContext';
import {
  EXPORT_STATUS_LABEL,
  LINE_STATUS_LABEL,
  PROVIDER_META,
  deliverToGusto,
  downloadExportFile,
  getExportDetail,
  hours,
  listExports,
  markSubmitted,
  money,
  payrollErrorMessage,
  voidExport,
  type ExportDetail,
  type ExportStatus,
  type LineStatus,
  type PayrollConnection,
  type PayrollExport,
} from '@/lib/payrollConnectors';

const STATUS_TONE: Record<ExportStatus, Tone> = { ready: 'info', delivering: 'warning', delivered: 'success', partial: 'warning', failed: 'danger', void: 'neutral' };
const LINE_TONE: Record<LineStatus, Tone> = { pending: 'neutral', sent: 'success', unchanged: 'info', conflict: 'warning', error: 'danger' };

interface Props {
  ownerId: string;
  connections: PayrollConnection[];
  openId: string | null;
  onOpenedChange: (id: string | null) => void;
  onGoToExport: () => void;
}

export function HistoryTab({ ownerId, connections, openId, onOpenedChange, onGoToExport }: Props) {
  const list = useLoader<PayrollExport[]>(() => listExports(ownerId), [ownerId]);

  // A delivery can be running in another tab; keep the list fresh while anything is "Sending…".
  const sending = (list.data ?? []).some((x) => x.status === 'delivering');
  useEffect(() => {
    if (!sending) return;
    const t = window.setInterval(list.reload, 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending]);

  if (list.loading) return <SkeletonCardList count={4} rows={2} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;
  const items = list.data ?? [];

  return (
    <>
      {items.length === 0 ? (
        <EmptyState icon={FileSpreadsheet} title="No exports yet" description="Create your first export to hand approved hours, commissions and tips to your payroll provider." action={{ label: 'Create an export', onClick: onGoToExport }} />
      ) : (
        <Card className="overflow-hidden p-0 hover:translate-y-0">
          <ul className="divide-y divide-border">
            {items.map((x) => (
              <li key={x.id}>
                <button type="button" onClick={() => onOpenedChange(x.id)} className="focus-ring grid w-full gap-1 px-4 py-3 text-left hover:bg-bg-tertiary sm:grid-cols-[1fr_auto] sm:items-center">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-text-primary">{PROVIDER_META[x.provider].label}</span>
                      <StatusPill tone={STATUS_TONE[x.status]}>{EXPORT_STATUS_LABEL[x.status]}</StatusPill>
                      <StatusPill tone="neutral">{x.delivery === 'api' ? 'API' : 'File'}</StatusPill>
                    </span>
                    <span className="mt-0.5 block text-xs text-text-secondary">{formatDay(x.period_start)} to {formatDay(x.period_end)} · created {formatDay(x.created_at)}</span>
                  </span>
                  <span className="text-xs text-text-secondary tabular-nums sm:text-right">
                    {x.totals.employees ?? 0} employees · {hours((x.totals.regular_hours ?? 0) + (x.totals.overtime_hours ?? 0))} h · {money((x.totals.commission_cents ?? 0) + (x.totals.tip_cents ?? 0))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {openId && <ExportDialog id={openId} connections={connections} onClose={() => onOpenedChange(null)} onChanged={list.reload} />}
    </>
  );
}

function ExportDialog({ id, connections, onClose, onChanged }: { id: string; connections: PayrollConnection[]; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const detail = useLoader<ExportDetail>(() => getExportDetail(id), [id]);
  const [busy, setBusy] = useState<'download' | 'send' | 'submit' | 'void' | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [reference, setReference] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);

  const d = detail.data;
  const x = d?.export;
  const connection = connections.find((c) => c.id === x?.connection_id);
  const meta = x ? PROVIDER_META[x.provider] : null;

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<unknown>, ok: string) {
    setBusy(kind);
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      toast(payrollErrorMessage(e, 'Something went wrong.'), 'error');
    } finally {
      setBusy(null);
      detail.reload();
      onChanged();
    }
  }

  const send = () =>
    run('send', async () => {
      const r = await deliverToGusto(id, overwrite);
      if (r.status !== 'delivered') throw new Error(`${r.counts.conflict} left untouched, ${r.counts.error} failed. Review the lines below.`);
    }, 'Sent to Gusto.');

  const needsAck = x?.status === 'delivered' || x?.status === 'partial';

  return (
    <>
      <Dialog
        open
        title={x && meta ? `${meta.label} export` : 'Export'}
        description={x ? `${formatDay(x.period_start)} to ${formatDay(x.period_end)}` : undefined}
        onClose={onClose}
        footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
      >
        {detail.loading ? (
          <SkeletonCardList count={2} rows={2} />
        ) : detail.error || !d || !x || !meta ? (
          <LoadError message={detail.error ?? 'Could not load this export.'} onRetry={detail.reload} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={STATUS_TONE[x.status]}>{EXPORT_STATUS_LABEL[x.status]}</StatusPill>
              <StatusPill tone="neutral">{x.delivery === 'api' ? 'Sent through the API' : 'File export'}</StatusPill>
              {d.lines.some((l) => l.drift) && <StatusPill tone="warning">Source data changed since export</StatusPill>}
            </div>

            {x.last_error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{x.last_error}</p>}
            {d.lines.some((l) => l.drift) && (
              <p className="flex items-start gap-2 text-xs text-text-secondary">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
                A timesheet, commission or tip changed after this export (for example a refunded tip). The numbers below are what was exported. Void and re-export to pick up the change.
              </p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <caption className="sr-only">Employees in this export</caption>
                <thead className="text-left text-text-secondary">
                  <tr>
                    <th scope="col" className="py-1.5 pr-2 font-medium">Employee</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Reg h</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">OT h</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Comm.</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">Tips</th>
                    {x.delivery === 'api' && <th scope="col" className="py-1.5 pl-2 font-medium">Result</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {d.lines.map((l) => (
                    <tr key={l.id} className="align-top">
                      <td className="py-1.5 pr-2 text-text-primary">{l.employee_name}<span className="block text-text-secondary">{l.external_id}</span></td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{hours(l.regular_hours)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{hours(l.overtime_hours)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(l.commission_cents)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(l.tip_cents)}</td>
                      {x.delivery === 'api' && (
                        <td className="py-1.5 pl-2">
                          <StatusPill tone={LINE_TONE[l.delivery_status]}>{LINE_STATUS_LABEL[l.delivery_status]}</StatusPill>
                          {l.delivery_message && l.delivery_status !== 'sent' && <span className="mt-1 block text-text-secondary">{l.delivery_message}</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {x.status !== 'void' && (
              <div className="space-y-3 border-t border-border pt-4">
                {x.delivery === 'file' ? (
                  <>
                    <p className="text-xs text-text-secondary">Import location: {meta.importHint}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant={x.downloaded_at ? 'secondary' : 'primary'} size="sm" disabled={busy !== null} onClick={() => void run('download', () => downloadExportFile(d, connection), 'File downloaded.')}>
                        {busy === 'download' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                        {x.downloaded_at ? 'Download again' : 'Download file'}
                      </Button>
                    </div>
                    {x.status === 'ready' && x.downloaded_at && (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <Input label={`${meta.label} batch or reference (optional)`} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
                        <Button size="sm" disabled={busy !== null} onClick={() => void run('submit', () => markSubmitted(id, reference), 'Marked as submitted.')}>
                          {busy === 'submit' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} I uploaded it
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {(x.status === 'ready' || x.status === 'failed' || x.status === 'partial') && (
                      <>
                        <label className="flex items-start gap-2 text-xs text-text-secondary">
                          <input type="checkbox" className="mt-0.5" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                          Overwrite values already in Gusto. Off by default: employees whose Gusto values differ are left untouched and flagged.
                        </label>
                        <Button size="sm" disabled={busy !== null} onClick={() => void send()}>
                          {busy === 'send' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                          {x.status === 'ready' ? 'Send to Gusto' : 'Send again'}
                        </Button>
                      </>
                    )}
                    {x.status === 'delivering' && <p className="text-sm text-text-secondary" aria-live="polite">Sending to Gusto. This page updates when it finishes.</p>}
                    <div>
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run('download', () => downloadExportFile(d, connection), 'File downloaded.')}>
                        <Download size={14} aria-hidden="true" /> Download as a file instead
                      </Button>
                    </div>
                  </>
                )}
                <Button variant="ghost" size="sm" disabled={busy !== null || x.status === 'delivering'} onClick={() => setVoiding(true)}>
                  <Undo2 size={14} aria-hidden="true" /> Void export
                </Button>
              </div>
            )}
            {x.status === 'void' && x.void_reason && <p className="text-sm text-text-secondary">Voided: {x.void_reason}</p>}

            <details className="text-xs text-text-secondary">
              <summary className="cursor-pointer font-medium text-text-primary">Activity</summary>
              <ul className="mt-2 space-y-1">
                {d.events.map((e) => (
                  <li key={e.id}>{formatDay(e.created_at)} · {e.event.replace(/_/g, ' ')}{e.message ? `: ${e.message}` : ''}</li>
                ))}
              </ul>
              {x.file_sha256 && <p className="mt-2 break-all">File checksum (SHA-256): {x.file_sha256}</p>}
            </details>
          </div>
        )}
      </Dialog>

      <Dialog
        open={voiding}
        danger
        title="Void this export?"
        description="The hours, commissions and tips return to the pool and can be exported or paid again."
        onClose={() => setVoiding(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setVoiding(false)}>Keep it</Button>
            <Button
              disabled={busy === 'void' || reason.trim().length < 3 || (needsAck && !ack)}
              onClick={() => void run('void', async () => { await voidExport(id, reason.trim(), ack); setVoiding(false); setReason(''); setAck(false); }, 'Export voided.')}
            >
              {busy === 'void' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Void export
            </Button>
          </>
        }
      >
        <Input label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        {needsAck && (
          <label className="flex items-start gap-2 text-sm text-text-secondary">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand this export was already handed to {meta?.label}. Voiding does not recall it from there.
          </label>
        )}
      </Dialog>
    </>
  );
}
