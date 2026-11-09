import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { addToCart, listCart } from '@/lib/partsOrderingApi';
import { formatMoney, type CartLine } from '@/lib/partsOrdering';
import {
  getOffers,
  listSourcingJobs,
  requestParts,
  searchParts,
  submitOrder,
  type OffersPayload,
  type PartHit,
  type SourcingJob,
} from '@/lib/partsSourcingApi';
import { formatBps, newIdempotencyKey, rankSources, sourcingHeadline, type SourceOption } from '@/lib/partsSourcing';
import { Chip, EmptyState, ErrorNote, LoadingRow, card, field, label } from './shared';

function fmtDay(day: string | null): string {
  return day ? new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'Unknown';
}

export function CompareTab() {
  const { toast } = useToast();
  const { isOwner, teamMember } = useAuth();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PartHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [part, setPart] = useState<PartHit | null>(null);
  const [jobs, setJobs] = useState<SourcingJob[]>([]);
  const [jobId, setJobId] = useState('');
  const [qty, setQty] = useState(1);
  const [data, setData] = useState<OffersPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [holdJob, setHoldJob] = useState(true);
  const idemKey = useRef<string | null>(null);

  const canManage = data?.can_manage ?? (isOwner || teamMember?.role === 'admin');

  useEffect(() => {
    listSourcingJobs().then(setJobs).catch(() => setJobs([]));
  }, []);

  const runSearch = useCallback(async () => {
    setSearching(true);
    setSearchError('');
    try {
      setHits(await searchParts(query));
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      setSearching(false);
    }
  }, [query]);

  const load = useCallback(async () => {
    if (!part) return;
    setLoading(true);
    setError('');
    try {
      setData(await getOffers(part.id, jobId || null));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Could not compare sources.');
    } finally {
      setLoading(false);
    }
  }, [part, jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reloadCart = useCallback(async () => {
    if (!jobId) {
      setCart([]);
      return;
    }
    try {
      setCart(await listCart(jobId));
    } catch {
      setCart([]);
    }
  }, [jobId]);

  useEffect(() => {
    idemKey.current = null;
    void reloadCart();
  }, [reloadCart]);

  const job = jobs.find((j) => j.id === jobId) ?? null;
  const options: SourceOption[] = data
    ? rankSources({
        qty,
        today: new Date(),
        scheduled: data.job?.scheduled_datetime ?? job?.scheduled_datetime ?? null,
        stock: { truck: data.stock.truck, branch: data.stock.branch },
        internalUnitCostCents: data.part.unit_cost_cents,
        offers: data.offers,
        settings: data.settings,
        rules: data.rules,
        partId: data.part.id,
        partCategory: data.part.category,
      })
    : [];
  const headline = sourcingHeadline(options, !!(data?.job?.scheduled_datetime));

  const add = async (o: SourceOption) => {
    if (!o.catalogItemId) return;
    setBusy(o.key);
    try {
      await addToCart({ catalogItemId: o.catalogItemId, quantity: o.quantity, jobId: jobId || null, addRequirement: !!jobId });
      idemKey.current = null;
      toast('Added to the job order list', 'success');
      await reloadCart();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add this part.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!jobId || cart.length === 0) return;
    setBusy('submit');
    idemKey.current = idemKey.current ?? newIdempotencyKey();
    try {
      const res = await submitOrder({ idempotencyKey: idemKey.current, cartIds: cart.map((c) => c.id), jobId, holdJob });
      toast(res.replayed ? 'This order was already placed.' : `${res.orders.length} order(s) created.`, 'success');
      idemKey.current = null;
      await reloadCart();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not submit the order.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const request = async () => {
    if (!jobId) return;
    setBusy('request');
    try {
      const r = await requestParts(jobId);
      toast(r.status === 'already_requested' ? 'Your manager was already notified.' : 'Request sent to your manager.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the request.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className={card}>
        <label htmlFor="ps-search" className={label}>Find a part (name or part number)</label>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <input id="ps-search" value={query} onChange={(e) => setQuery(e.target.value)} className={field} placeholder="e.g. capacitor 45/5" maxLength={60} autoComplete="off" />
          <Button type="submit" size="sm" loading={searching} disabled={query.trim().length < 2} disabledReason="Type at least 2 characters">
            <Search size={14} aria-hidden="true" /> Search
          </Button>
        </form>
        {searchError && <div className="mt-3"><ErrorNote message={searchError} onRetry={() => void runSearch()} /></div>}
        {hits && hits.length === 0 && !searching && <div className="mt-3"><EmptyState>No parts match “{query}”.</EmptyState></div>}
        {hits && hits.length > 0 && (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => { setPart(h); setHits(null); }}
                  className="focus-ring flex min-h-[48px] w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-bg-primary"
                >
                  <span className="text-sm font-medium text-text-primary">{h.name}</span>
                  <span className="text-xs text-text-secondary">{h.part_number ?? 'No part #'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {part && (
        <div className={card}>
          <h2 className="text-sm font-semibold text-text-primary">{part.name}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="ps-job" className={label}>For job (adds the appointment check)</label>
              <select id="ps-job" value={jobId} onChange={(e) => setJobId(e.target.value)} className={field}>
                <option value="">No job — just compare</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {(j.customer_name ?? 'Job')} · {j.service_type ?? 'Service'} · {j.scheduled_datetime ? new Date(j.scheduled_datetime).toLocaleDateString() : 'unscheduled'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ps-qty" className={label}>Quantity</label>
              <input id="ps-qty" type="number" inputMode="numeric" min={1} max={1000} value={qty} onChange={(e) => setQty(Math.min(1000, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))} className={field} />
            </div>
          </div>

          {loading && <LoadingRow text="Comparing sources…" />}
          {error && <div className="mt-3"><ErrorNote message={error} onRetry={() => void load()} /></div>}

          {data && !loading && (
            <div className="mt-4 space-y-3">
              {headline.warning && <div role="alert" className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">{headline.warning}</div>}
              {options.length === 0 ? (
                <EmptyState>No stock on hand and no supplier lists this part. Import a supplier price list or add a cross reference in Setup.</EmptyState>
              ) : (
                <ul className="space-y-3">
                  {options.map((o, i) => (
                    <li key={o.key} className="rounded-xl border border-border bg-bg-primary p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-text-primary">{o.label}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {i === 0 && o.covers && <Chip tone="ok">Best option</Chip>}
                          {!o.covers && <Chip tone="bad">{o.kind === 'supplier' ? 'Backordered' : `Only ${o.quantity} on hand`}</Chip>}
                          {o.relation && o.relation !== 'exact' && <Chip tone="info">{o.relation.replace('_', ' ')}</Chip>}
                          {o.meetsAppointment === true && <Chip tone="ok">Arrives in time</Chip>}
                          {o.meetsAppointment === false && <Chip tone="bad">Misses appointment</Chip>}
                        </div>
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary sm:grid-cols-4">
                        <div><dt>Qty</dt><dd className="font-medium text-text-primary">{o.quantity}</dd></div>
                        <div><dt>Unit cost</dt><dd className="font-medium text-text-primary">{formatMoney(o.unitCostCents)}</dd></div>
                        <div><dt>Total</dt><dd className="font-medium text-text-primary">{formatMoney(o.totalCostCents)}</dd></div>
                        <div><dt>Available</dt><dd className="font-medium text-text-primary">{o.kind === 'supplier' ? fmtDay(o.etaDay) : 'Today'}</dd></div>
                        {data.can_manage && o.sellUnitCents != null && (
                          <>
                            <div><dt>Sell price</dt><dd className="font-medium text-text-primary">{formatMoney(o.sellUnitCents)}</dd></div>
                            <div><dt>Margin</dt><dd className="font-medium text-text-primary">{o.marginBps != null ? formatBps(o.marginBps) : '—'}</dd></div>
                          </>
                        )}
                      </dl>
                      {o.kind === 'supplier' && (
                        <div className="mt-3">
                          <Button size="sm" variant="secondary" fullWidth loading={busy === o.key} disabled={!o.covers || !jobId} disabledReason={!jobId ? 'Pick a job to order for' : 'Not available'} onClick={() => void add(o)}>
                            Add {o.quantity} to job order
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {data.stock.other_trucks > 0 && <p className="text-xs text-text-secondary">{data.stock.other_trucks} more on other trucks — a transfer may beat ordering.</p>}
            </div>
          )}
        </div>
      )}

      {jobId && cart.length > 0 && (
        <div className={card}>
          <h2 className="mb-2 text-sm font-semibold text-text-primary">Job order list</h2>
          <ul className="divide-y divide-border text-sm">
            {cart.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-text-primary">{c.item?.name ?? 'Unavailable item'} <span className="text-text-secondary">· {c.item?.inventory_vendors?.name ?? 'Supplier'}</span></span>
                <span className="text-text-secondary">× {c.quantity}</span>
              </li>
            ))}
          </ul>
          {canManage ? (
            <div className="mt-3 space-y-3">
              <label className="flex min-h-[40px] items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={holdJob} onChange={(e) => setHoldJob(e.target.checked)} className="h-4 w-4" />
                Put the job on hold until parts arrive
              </label>
              <Button fullWidth loading={busy === 'submit'} onClick={() => void submit()}>Place order</Button>
            </div>
          ) : (
            <div className="mt-3">
              <Button fullWidth loading={busy === 'request'} onClick={() => void request()}>Request approval from manager</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
