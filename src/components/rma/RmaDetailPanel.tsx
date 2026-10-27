import { useMemo, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ErrorState, Pill, SelectField, Stat, formatDate, formatDateTime, useLoader } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import {
  authorizeRma, cancelRma, closeRma, fetchRmaDetail, fetchStockLevels, receiveRmaReplacement, recordRmaCredit, rejectRma,
  shipRma, updateRmaShipment, voidRmaCredit,
} from '@/lib/vendorRmaApi';
import {
  CREDIT_KINDS, CREDIT_KIND_LABELS, REASON_LABELS, RESOLUTION_LABELS, SHIP_STATUS_LABELS, STATUS_LABELS, STATUS_TONES,
  allowedActions, closeNeedsShortfallAccept, creditAgeDays, findStockShortages, humanize, isHttpUrl, netRecoveryCents,
  openReplacementUnits, parseMoneyToCents, receivedCreditCents, returnCostValueCents, stockDeltas, summarizeCredit, totalUnits,
  type CreditKind, type Rma, type RmaAction,
} from '@/lib/vendorRma';
import type { InventoryLocation } from '@/lib/inventory';

type PanelId = 'authorize' | 'ship' | 'shipment' | 'credit' | 'reject' | 'close' | 'cancel';

interface Props {
  rma: Rma;
  locations: InventoryLocation[];
  canManage: boolean;
  onChanged: () => void | Promise<void>;
  onEdit: () => void;
  onClose: () => void;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export function RmaDetailPanel({ rma, locations, canManage, onChanged, onEdit, onClose }: Props) {
  const { toast } = useToast();
  const { currency } = useCurrency();
  const money = (cents: number) => formatMoney(cents / 100, currency);

  const [panel, setPanel] = useState<PanelId | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [f, setF] = useState({
    vendorRmaNumber: rma.vendor_rma_number ?? '',
    carrier: rma.carrier ?? '',
    tracking: rma.tracking_number ?? '',
    trackingUrl: rma.tracking_url ?? '',
    freight: rma.return_freight_cents > 0 ? (rma.return_freight_cents / 100).toFixed(2) : '',
    shipStatus: rma.ship_status === 'not_shipped' ? 'in_transit' : rma.ship_status,
    amount: '',
    kind: 'credit_memo' as CreditKind,
    reference: '',
    receivedOn: todayIso(),
    note: '',
    restock: true,
    acceptShortfall: false,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const actions = useMemo<RmaAction[]>(() => (canManage ? allowedActions(rma) : []), [rma, canManage]);
  const can = (a: RmaAction) => actions.includes(a);

  const detail = useLoader(() => fetchRmaDetail(rma.id), `${rma.id}:${rma.updated_at}`);
  const partIds = useMemo(() => [...new Set(rma.lines.filter((l) => l.source === 'stock').map((l) => l.part_id))], [rma.lines]);
  const canShip = can('ship');
  const stock = useLoader(() => (canShip ? fetchStockLevels(partIds) : Promise.resolve([])), `${rma.id}:${rma.updated_at}:${canShip}`);

  const locName = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);
  const credit = summarizeCredit(rma.credit_expected_cents, rma.credit_received_cents, rma.resolution);
  const shortages = canShip && stock.data ? findStockShortages(rma.lines, stock.data) : [];
  const shipOut = stockDeltas(rma.lines, 'ship').reduce((s, d) => s + -d.delta, 0);
  const age = creditAgeDays(rma, new Date());
  const credits = detail.data?.credits ?? [];
  const lineName = (partId: string) => rma.lines.find((l) => l.part_id === partId)?.part?.name ?? 'part';

  const run = async (task: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    try {
      const message = await task();
      toast(message, 'success');
      setPanel(null);
      setVoidingId(null);
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = (p: PanelId) => { setErr({}); setPanel(panel === p ? null : p); };

  const submitAuthorize = () => {
    if (!f.vendorRmaNumber.trim()) { setErr({ vendorRmaNumber: 'Enter the number the vendor gave you.' }); return; }
    void run(async () => { await authorizeRma(rma.id, f.vendorRmaNumber.trim()); return 'Return authorized.'; });
  };

  const submitShip = () => {
    const e: Record<string, string> = {};
    let freight = 0;
    if (f.freight.trim()) {
      const p = parseMoneyToCents(f.freight);
      if (p == null) e.freight = 'Enter an amount like 12.50.'; else freight = p;
    }
    if (f.trackingUrl.trim() && !isHttpUrl(f.trackingUrl)) e.trackingUrl = 'Must start with http:// or https://';
    if (Object.keys(e).length) { setErr(e); return; }
    void run(async () => {
      const units = await shipRma(rma.id, { carrier: f.carrier, tracking_number: f.tracking, tracking_url: f.trackingUrl, return_freight_cents: freight });
      return units > 0 ? `Shipped. ${units} unit${units === 1 ? '' : 's'} removed from stock.` : 'Marked as shipped.';
    });
  };

  const submitShipment = () => {
    if (f.trackingUrl.trim() && !isHttpUrl(f.trackingUrl)) { setErr({ trackingUrl: 'Must start with http:// or https://' }); return; }
    void run(async () => {
      await updateRmaShipment(rma.id, { ship_status: f.shipStatus, carrier: f.carrier, tracking_number: f.tracking, tracking_url: f.trackingUrl });
      return 'Shipment updated.';
    });
  };

  const submitCredit = () => {
    const cents = parseMoneyToCents(f.amount);
    if (cents == null || cents < 1) { setErr({ amount: 'Enter an amount greater than zero, like 25.00.' }); return; }
    void run(async () => {
      await recordRmaCredit(rma.id, { amount_cents: cents, kind: f.kind, reference: f.reference, received_on: f.receivedOn, note: f.note });
      setF((s) => ({ ...s, amount: '', reference: '', note: '' }));
      return 'Credit recorded.';
    });
  };

  const submitVoid = (id: string) => void run(async () => { await voidRmaCredit(id, voidReason); setVoidReason(''); return 'Credit voided.'; });

  const submitReplacement = () =>
    void run(async () => {
      const units = await receiveRmaReplacement(rma.id);
      return `${units} replacement unit${units === 1 ? '' : 's'} added to stock.`;
    });

  const submitReject = () =>
    void run(async () => {
      const units = await rejectRma(rma.id, f.restock, f.note);
      return units > 0 ? `Return rejected. ${units} unit${units === 1 ? '' : 's'} restocked.` : 'Return rejected.';
    });

  const submitCancel = () => void run(async () => { await cancelRma(rma.id, f.note); return 'Return cancelled.'; });
  const submitClose = () => void run(async () => { await closeRma(rma.id, f.acceptShortfall); return 'Return closed.'; });

  const restockUnits = stockDeltas(rma.lines, 'restock_on_reject').reduce((s, d) => s + d.delta, 0);
  const needsShortfall = closeNeedsShortfallAccept(rma.status);

  return (
    <section aria-label={`Return ${rma.rma_number}`} className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-text-primary">{rma.rma_number}</h2>
            <Pill tone={STATUS_TONES[rma.status]}>{STATUS_LABELS[rma.status]}</Pill>
            {rma.ship_status !== 'not_shipped' && <Pill tone={rma.ship_status === 'exception' ? 'danger' : rma.ship_status === 'delivered' ? 'success' : 'info'}>{SHIP_STATUS_LABELS[rma.ship_status]}</Pill>}
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {rma.vendor?.name ?? 'Vendor'} · {REASON_LABELS[rma.reason_code]} · expecting {RESOLUTION_LABELS[rma.resolution].toLowerCase()}
          </p>
          <p className="text-xs text-text-secondary">
            {rma.vendor_rma_number ? `Vendor RMA ${rma.vendor_rma_number}` : 'No vendor RMA number yet'}
            {rma.purchase_order?.po_number ? ` · PO ${rma.purchase_order.po_number}` : ''} · created {formatDateTime(rma.created_at)}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close details"><X size={16} /></Button>
      </header>

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {can('edit') && <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>}
          {can('authorize') && <Button size="sm" variant="secondary" onClick={() => open('authorize')}>Vendor authorized it</Button>}
          {can('ship') && <Button size="sm" onClick={() => open('ship')}>Mark as shipped</Button>}
          {can('update_shipment') && <Button size="sm" variant="secondary" onClick={() => open('shipment')}>Update shipment</Button>}
          {can('record_credit') && <Button size="sm" variant="secondary" onClick={() => open('credit')}>Record credit</Button>}
          {can('receive_replacement') && <Button size="sm" onClick={submitReplacement} disabled={busy}>Receive replacement ({openReplacementUnits(rma.lines)})</Button>}
          {can('reject') && <Button size="sm" variant="ghost" onClick={() => open('reject')}>Vendor rejected</Button>}
          {can('cancel') && <Button size="sm" variant="ghost" onClick={() => open('cancel')}>Cancel</Button>}
          {can('close') && <Button size="sm" variant="ghost" onClick={() => open('close')}>Close</Button>}
        </div>
      )}

      {panel === 'authorize' && (
        <div className="max-w-md space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          <Input label="Vendor's RMA number" value={f.vendorRmaNumber} onChange={set('vendorRmaNumber')} error={err.vendorRmaNumber} maxLength={80} />
          <div className="flex gap-2"><Button size="sm" onClick={submitAuthorize} disabled={busy}>Save</Button><Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button></div>
        </div>
      )}

      {panel === 'ship' && (
        <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          {shortages.length > 0 && (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              Not enough available stock to ship:
              {shortages.map((s) => (
                <span key={`${s.part_id}${s.location_id}`} className="block">{lineName(s.part_id)} at {locName.get(s.location_id) ?? 'location'}: need {s.needed}, {s.available} available</span>
              ))}
              <span className="mt-1 block text-xs">Reserved stock cannot be returned. Edit the quantities or free up the reservation.</span>
            </div>
          )}
          <p className="text-sm text-text-secondary">
            {shipOut > 0 ? `${shipOut} unit${shipOut === 1 ? '' : 's'} will be removed from stock.` : 'No stock moves: these parts are already installed.'}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Carrier" value={f.carrier} onChange={set('carrier')} maxLength={80} />
            <Input label="Tracking number" value={f.tracking} onChange={set('tracking')} maxLength={120} />
            <Input label="Tracking link" value={f.trackingUrl} onChange={set('trackingUrl')} error={err.trackingUrl} placeholder="https://" />
            <Input label="Return freight you paid" inputMode="decimal" value={f.freight} onChange={set('freight')} error={err.freight} placeholder="0.00" />
          </div>
          <div className="flex gap-2"><Button size="sm" onClick={submitShip} disabled={busy || shortages.length > 0 || stock.loading}>{busy ? 'Shipping…' : 'Confirm shipped'}</Button><Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button></div>
        </div>
      )}

      {panel === 'shipment' && (
        <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SelectField label="Shipment status" value={f.shipStatus} onChange={set('shipStatus')}>
              {(['shipped', 'in_transit', 'delivered', 'exception'] as const).map((s) => <option key={s} value={s}>{SHIP_STATUS_LABELS[s]}</option>)}
            </SelectField>
            <Input label="Carrier" value={f.carrier} onChange={set('carrier')} maxLength={80} />
            <Input label="Tracking number" value={f.tracking} onChange={set('tracking')} maxLength={120} />
            <Input label="Tracking link" value={f.trackingUrl} onChange={set('trackingUrl')} error={err.trackingUrl} placeholder="https://" />
          </div>
          <div className="flex gap-2"><Button size="sm" onClick={submitShipment} disabled={busy}>Save</Button><Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button></div>
        </div>
      )}

      {panel === 'credit' && (
        <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Amount received" inputMode="decimal" value={f.amount} onChange={set('amount')} error={err.amount} placeholder="0.00" helperText={credit.outstanding > 0 ? `${money(credit.outstanding)} still expected` : undefined} />
            <SelectField label="Type" value={f.kind} onChange={set('kind')}>
              {CREDIT_KINDS.map((k) => <option key={k} value={k}>{CREDIT_KIND_LABELS[k]}</option>)}
            </SelectField>
            <Input label="Reference (credit memo #)" value={f.reference} onChange={set('reference')} maxLength={120} />
            <Input label="Received on" type="date" value={f.receivedOn} onChange={set('receivedOn')} />
          </div>
          <Textarea label="Note" rows={2} maxLength={500} value={f.note} onChange={set('note')} />
          <div className="flex gap-2"><Button size="sm" onClick={submitCredit} disabled={busy}>Record credit</Button><Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button></div>
        </div>
      )}

      {panel === 'reject' && (
        <div className="max-w-lg space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          {restockUnits > 0 && (
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" className="mt-1" checked={f.restock} onChange={(e) => setF((s) => ({ ...s, restock: e.target.checked }))} />
              <span>The vendor sent the goods back. Put {restockUnits} unit{restockUnits === 1 ? '' : 's'} back into stock.</span>
            </label>
          )}
          <Textarea label="Why was it rejected?" rows={2} maxLength={500} value={f.note} onChange={set('note')} />
          <div className="flex gap-2"><Button size="sm" onClick={submitReject} disabled={busy}>Mark rejected</Button><Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button></div>
        </div>
      )}

      {panel === 'cancel' && (
        <div className="max-w-lg space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          <p className="text-sm text-text-secondary">Nothing has shipped, so no stock is affected.</p>
          <Textarea label="Note (optional)" rows={2} maxLength={500} value={f.note} onChange={set('note')} />
          <div className="flex gap-2"><Button size="sm" onClick={submitCancel} disabled={busy}>Cancel this return</Button><Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Keep it</Button></div>
        </div>
      )}

      {panel === 'close' && (
        <div className="max-w-lg space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          {needsShortfall ? (
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" className="mt-1" checked={f.acceptShortfall} onChange={(e) => setF((s) => ({ ...s, acceptShortfall: e.target.checked }))} />
              <span>
                {rma.resolution === 'replacement'
                  ? `The vendor still owes ${openReplacementUnits(rma.lines)} unit(s). Close anyway.`
                  : `The vendor has paid ${money(credit.received)} of ${money(credit.expected)}. Accept the ${money(credit.outstanding)} shortfall and close.`}
              </span>
            </label>
          ) : (
            <p className="text-sm text-text-secondary">Closed returns can no longer be changed.</p>
          )}
          <div className="flex gap-2"><Button size="sm" onClick={submitClose} disabled={busy || (needsShortfall && !f.acceptShortfall)}>Close return</Button><Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Cancel</Button></div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Credit expected" value={rma.resolution === 'replacement' ? 'Replacement' : money(credit.expected)} hint={rma.restocking_fee_cents > 0 ? `after ${money(rma.restocking_fee_cents)} fee` : `${totalUnits(rma.lines)} unit(s)`} />
        <Stat label="Credit received" value={money(credit.received)} tone={credit.state === 'over' ? 'warning' : credit.state === 'full' ? 'success' : 'neutral'} hint={credit.percent == null ? undefined : `${credit.percent}% of expected`} />
        <Stat label="Still owed" value={rma.resolution === 'replacement' ? `${openReplacementUnits(rma.lines)} unit(s)` : money(credit.outstanding)} tone={credit.outstanding > 0 && age != null && age > 30 ? 'danger' : credit.outstanding > 0 ? 'warning' : 'neutral'} hint={credit.outstanding > 0 && age != null ? `${age} day(s) since the vendor got it` : undefined} />
        <Stat label="Net recovery" value={money(netRecoveryCents(credit.received, rma.return_freight_cents))} hint={`${money(rma.return_freight_cents)} freight · ${money(returnCostValueCents(rma.lines))} at cost`} />
      </div>
      {credit.state === 'over' && <p role="alert" className="text-sm text-warning-500">The vendor credited {money(credit.overpaid)} more than expected. Check the credit memo.</p>}
      {rma.reason_notes && <p className="whitespace-pre-wrap text-sm text-text-secondary">{rma.reason_notes}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">Parts on this return</caption>
          <thead className="text-xs text-text-secondary">
            <tr><th className="py-2 pr-3 font-medium">Part</th><th className="py-2 pr-3 font-medium">Qty</th><th className="py-2 pr-3 font-medium">Where</th><th className="py-2 pr-3 font-medium">Credit each</th><th className="py-2 pr-3 font-medium">Stock</th></tr>
          </thead>
          <tbody>
            {rma.lines.map((l) => (
              <tr key={l.id} className="border-t border-border align-top">
                <td className="py-2 pr-3"><p className="font-medium text-text-primary">{l.part?.name ?? 'Part'}</p><p className="text-xs text-text-secondary">{[l.part?.part_number, l.serial_number && `S/N ${l.serial_number}`, l.purchase_order_line_id && 'from purchase', l.usage_transaction_id && 'from job usage'].filter(Boolean).join(' · ')}</p></td>
                <td className="py-2 pr-3">{l.quantity}{rma.resolution === 'replacement' ? <span className="text-xs text-text-secondary"> ({l.quantity_replaced} replaced)</span> : null}</td>
                <td className="py-2 pr-3">{l.location?.name ?? (l.location_id ? locName.get(l.location_id) : null) ?? '—'}</td>
                <td className="py-2 pr-3">{money(l.unit_credit_cents)}</td>
                <td className="py-2 pr-3 text-xs text-text-secondary">{l.source === 'installed' ? 'Installed, no stock change' : l.ship_transaction_id ? (l.inbound_transaction_id ? 'Removed, then restocked' : 'Removed from stock') : 'Leaves stock when shipped'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(rma.carrier || rma.tracking_number || rma.shipped_at) && (
        <div className="rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
          <span className="font-medium text-text-primary">Shipment:</span> {[rma.carrier, rma.tracking_number].filter(Boolean).join(' · ') || 'No tracking'}
          {rma.tracking_url && isHttpUrl(rma.tracking_url) && (
            <a href={rma.tracking_url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-accent hover:underline">Track <ExternalLink size={12} /></a>
          )}
          <span className="block text-xs">
            {rma.shipped_at ? `Shipped ${formatDateTime(rma.shipped_at)}` : ''}{rma.delivered_at ? ` · delivered ${formatDateTime(rma.delivered_at)}` : ''}
          </span>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">Credits</h3>
        {detail.error && !detail.data ? (
          <ErrorState message={detail.error} onRetry={detail.reload} />
        ) : credits.length === 0 ? (
          <p className="text-sm text-text-secondary">{detail.loading ? 'Loading…' : 'No credit recorded yet.'}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {credits.map((c) => (
              <li key={c.id} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={c.voided_at ? 'text-text-secondary line-through' : 'text-text-primary'}>
                    {money(c.amount_cents)} · {CREDIT_KIND_LABELS[c.kind]}{c.reference ? ` · ${c.reference}` : ''} · {formatDate(c.received_on)}
                  </span>
                  {c.voided_at ? <Pill tone="neutral">Voided</Pill> : can('void_credit') && <Button size="sm" variant="ghost" onClick={() => { setVoidingId(voidingId === c.id ? null : c.id); setVoidReason(''); }}>Void</Button>}
                </div>
                {c.note && <p className="text-xs text-text-secondary">{c.note}</p>}
                {voidingId === c.id && (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div className="min-w-[220px] flex-1"><Input label="Reason" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={500} /></div>
                    <Button size="sm" onClick={() => submitVoid(c.id)} disabled={busy}>Void credit</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {credits.length > 0 && <p className="mt-1 text-xs text-text-secondary">Total received: {money(receivedCreditCents(credits))}</p>}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">History</h3>
        <ol className="space-y-1.5 text-sm">
          {(detail.data?.events ?? []).map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-2 text-text-secondary">
              <span className="text-xs">{formatDateTime(e.created_at)}</span>
              <span className="font-medium text-text-primary">{humanize(e.event_type)}</span>
              {e.message && <span>{e.message}</span>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
