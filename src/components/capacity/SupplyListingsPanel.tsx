import { useCallback, useEffect, useState } from 'react';
import { Loader2, Truck, X } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { TagToggleGroup } from '@/components/capacity/TagToggleGroup';
import { useToast } from '@/contexts/ToastContext';
import { TRADE_CATEGORY_LABELS, TRADE_CATEGORY_OPTIONS } from '@/lib/laborMarketplace';
import { describeNetworkError } from '@/lib/contractorNetwork';
import {
  WINDOW_OPTIONS,
  formatWindow,
  liquidityApi,
  parseRateToCents,
  type CapacityListing,
} from '@/lib/capacityLiquidity';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const tradeOptions = TRADE_CATEGORY_OPTIONS.map((t) => ({ value: t, label: TRADE_CATEGORY_LABELS[t] }));
const tradeLabel = (t: string) => (TRADE_CATEGORY_LABELS as Record<string, string>)[t] ?? t;

/** Supply side: publish idle technicians / vans for a time window. */
export function SupplyListingsPanel() {
  const { toast } = useToast();
  const [listings, setListings] = useState<CapacityListing[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);

  const [trades, setTrades] = useState<string[]>([]);
  const [techs, setTechs] = useState('1');
  const [vans, setVans] = useState('0');
  const [hours, setHours] = useState(String(WINDOW_OPTIONS[1].hours));
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      await liquidityApi.expireListings().catch(() => undefined);
      setListings(await liquidityApi.listMyListings());
    } catch {
      /* keep last good state; the pulse panel surfaces connectivity problems */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = listings.filter((l) => l.status === 'active' && new Date(l.available_until).getTime() > Date.now());

  const publish = async () => {
    const t = Number(techs);
    const v = Number(vans);
    const h = Number(hours);
    const rateCents = parseRateToCents(rate);
    if (trades.length === 0) return toast('Pick at least one trade.', 'error');
    if (!Number.isInteger(t) || t < 1 || t > 50) return toast('Technicians must be between 1 and 50.', 'error');
    if (!Number.isInteger(v) || v < 0 || v > 50) return toast('Idle vans must be between 0 and 50.', 'error');
    if (rateCents !== null && !Number.isFinite(rateCents)) return toast('Enter a valid hourly rate.', 'error');

    setBusy(true);
    try {
      await liquidityApi.publishListing({
        trades,
        technicians: t,
        vehicles: v,
        availableFrom: null,
        availableUntil: new Date(Date.now() + h * 3_600_000).toISOString(),
        hourlyRateCents: rateCents,
        note: note.trim(),
      });
      toast('Capacity published. You are now prioritised for matching jobs.', 'success');
      setTrades([]);
      setTechs('1');
      setVans('0');
      setRate('');
      setNote('');
      setOpen(false);
      await load();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (id: string) => {
    setWithdrawingId(id);
    try {
      await liquidityApi.withdrawListing(id);
      toast('Listing withdrawn.', 'success');
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      await load();
      setWithdrawingId(null);
    }
  };

  return (
    <section className="space-y-4 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Idle capacity">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Truck size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Your idle capacity</h2>
        </div>
        {!open && (
          <Button size="sm" onClick={() => setOpen(true)}>
            Publish idle capacity
          </Button>
        )}
      </div>
      <p className="text-sm text-text-secondary">
        Tell the network which technicians and vans are free and when. While a listing is live, the matching engine
        ranks you higher for jobs in your trades.
      </p>

      {open && (
        <div className="space-y-4 rounded-xl border border-border bg-bg-primary p-4">
          <TagToggleGroup label="Trades available" options={tradeOptions} value={trades} onChange={setTrades} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Input label="Idle technicians" inputMode="numeric" value={techs} onChange={(e) => setTechs(e.target.value)} />
            <Input label="Idle vans" inputMode="numeric" value={vans} onChange={(e) => setVans(e.target.value)} />
            <div>
              <label htmlFor="cx-listing-window" className="mb-1.5 block text-sm font-medium text-text-primary">
                Available
              </label>
              <select id="cx-listing-window" value={hours} onChange={(e) => setHours(e.target.value)} className={selectClass}>
                {WINDOW_OPTIONS.map((w) => (
                  <option key={w.hours} value={w.hours}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Input
            label="Hourly rate ($, optional)"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            helperText="Used to match jobs that set a price ceiling."
          />
          <Textarea
            label="Note (optional)"
            rows={2}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            helperText="No phone numbers or e-mails."
          />
          <div className="flex justify-end gap-3">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={publish} disabled={busy}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              Publish
            </Button>
          </div>
        </div>
      )}

      {loaded && live.length === 0 && !open && (
        <EmptyState
          icon={Truck}
          title="No live availability"
          description="Publish free technicians or vans to appear in the market and get matched jobs first."
        />
      )}

      {live.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {live.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-medium text-text-primary">
                  {l.technicians_available} technician{l.technicians_available === 1 ? '' : 's'}
                  {l.vehicles_idle > 0 ? ` · ${l.vehicles_idle} van${l.vehicles_idle === 1 ? '' : 's'}` : ''}
                  {' · '}
                  {l.trades.map(tradeLabel).join(', ')}
                </p>
                <p className="text-xs text-text-secondary">{formatWindow(l.available_from, l.available_until)}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void withdraw(l.id)} disabled={withdrawingId === l.id}>
                {withdrawingId === l.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                Withdraw
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
