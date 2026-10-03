/**
 * VIREEK Service Data Exchange — /dashboard/data-exchange
 *
 * Consent-governed, privacy-preserving industry data layer. This page has
 * no cross-tenant query of its own: everything comes from the three RPCs
 * wrapped in src/lib/serviceDataExchange.ts. Intelligence products unlock
 * only for the data domains the account itself contributes (give-to-get).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Handshake,
  History,
  Info,
  Loader2,
  Lock,
  Network,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  SDE_DOMAIN_INFO,
  SDE_DOMAIN_ORDER,
  SDE_PRODUCT_INFO,
  SDE_PRODUCT_ORDER,
  describeDimension,
  fetchSdeConsentEvents,
  fetchSdeIntelligence,
  fetchSdeOverview,
  formatSdeValue,
  metricLabel,
  setSdeConsent,
} from '@/lib/serviceDataExchange';
import type {
  SdeCell,
  SdeConsentEvent,
  SdeDomain,
  SdeDomainState,
  SdeOverview,
  SdeProduct,
} from '@/lib/serviceDataExchange';

const GUARANTEES = [
  'Raw data never leaves your account. Only cohort statistics are ever stored.',
  'A cohort is published only when at least 5 accounts contribute (8 for pricing).',
  'No single account can supply more than 40% of a cohort, and each account’s contribution is capped.',
  'Small calibrated noise is added and sample sizes are rounded. This is privacy-hardening, not a certified differential-privacy guarantee.',
  'You can revoke any domain at any time. Cohorts are recomputed nightly from consenting accounts only.',
];

// ============================================================
// CONSENT CARD
// ============================================================

function ConsentCard({
  state,
  canManage,
  busy,
  onToggle,
}: {
  state: SdeDomainState;
  canManage: boolean;
  busy: boolean;
  onToggle: (domain: SdeDomain, next: boolean) => void;
}) {
  const info = SDE_DOMAIN_INFO[state.domain];
  const on = state.status === 'granted';

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl border p-4 ${on ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-secondary'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{info.label}</p>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">Used: </span>
            {info.uses}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">Never shared: </span>
            {info.never}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${on ? 'Stop sharing' : 'Share'} ${info.label}`}
          disabled={!canManage || busy}
          onClick={() => onToggle(state.domain, !on)}
          className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            on ? 'bg-accent' : 'bg-bg-tertiary'
          }`}
        >
          {busy ? (
            <Loader2 size={14} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-white" />
          ) : (
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}
            />
          )}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[11px] text-text-secondary">
        <span>
          Unlocks:{' '}
          {info.product.map((p) => SDE_PRODUCT_INFO[p].label).join(', ')}
        </span>
        {on && (
          <span className="font-medium text-text-primary">
            {state.records_contributed.toLocaleString('en-US')} records · {state.cohorts_contributed.toLocaleString('en-US')} cohorts
            <span className="font-normal text-text-secondary"> (last refresh)</span>
          </span>
        )}
      </div>
    </motion.div>
  );
}

// ============================================================
// CONFIRM MODAL
// ============================================================

function ConfirmModal({
  domain,
  next,
  busy,
  onCancel,
  onConfirm,
}: {
  domain: SdeDomain;
  next: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const info = SDE_DOMAIN_INFO[domain];

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-5 shadow-2xl"
      >
        <h4 className="text-sm font-semibold text-text-primary">
          {next ? `Share ${info.label.toLowerCase()} with the exchange?` : `Stop sharing ${info.label.toLowerCase()}?`}
        </h4>

        {next ? (
          <>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              <span className="font-medium text-text-primary">Used: </span>
              {info.uses}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              <span className="font-medium text-text-primary">Never shared: </span>
              {info.never}
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-relaxed text-text-secondary">
              {GUARANTEES.slice(0, 3).map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-text-secondary">
              In return you unlock: {info.product.map((p) => SDE_PRODUCT_INFO[p].label).join(', ')}.
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            Your data is excluded from the next nightly recompute, and you will lose access to{' '}
            {info.product.map((p) => SDE_PRODUCT_INFO[p].label).join(', ')} until you share again.
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="focus-ring flex-1 rounded-xl border border-border py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {next ? 'Share data' : 'Stop sharing'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// PRODUCT EXPLORER
// ============================================================

function ProductExplorer({
  overview,
  canManage,
  onShare,
}: {
  overview: SdeOverview;
  canManage: boolean;
  onShare: (domain: SdeDomain) => void;
}) {
  const { toast } = useToast();
  const [product, setProduct] = useState<SdeProduct>('failure_intelligence');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [myTradeOnly, setMyTradeOnly] = useState(false);
  const [cells, setCells] = useState<SdeCell[]>([]);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const state = overview.products.find((p) => p.product === product);
  const unlocked = state?.unlocked ?? false;
  const info = SDE_PRODUCT_INFO[product];

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!unlocked) {
      setCells([]);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    fetchSdeIntelligence(product, { search: debounced, myTradeOnly })
      .then((rows) => {
        if (id === requestId.current) setCells(rows);
      })
      .catch(() => {
        if (id === requestId.current) toast('Could not load intelligence', 'error');
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [product, unlocked, debounced, myTradeOnly, toast]);

  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold text-text-primary">Network intelligence</h2>
      <p className="mt-1 text-xs text-text-secondary">
        Each product unlocks when your account shares the data that feeds it.
      </p>

      <div className="mt-3 flex flex-wrap gap-2" role="tablist">
        {SDE_PRODUCT_ORDER.map((p) => {
          const s = overview.products.find((x) => x.product === p);
          const active = p === product;
          return (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setProduct(p)}
              className={`focus-ring flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
              }`}
            >
              {!s?.unlocked && <Lock size={11} />}
              {SDE_PRODUCT_INFO[p].label}
            </button>
          );
        })}
      </div>

      <div className="mt-3 rounded-2xl border border-border bg-bg-secondary p-4">
        <p className="text-sm font-semibold text-text-primary">{info.label}</p>
        <p className="mt-0.5 text-xs text-text-secondary">{info.blurb}</p>

        {!unlocked ? (
          <div className="mt-4 rounded-xl border border-dashed border-border p-6 text-center">
            <Lock className="mx-auto mb-2 h-5 w-5 text-text-secondary/60" />
            <p className="text-sm text-text-primary">
              Share {SDE_DOMAIN_INFO[info.domain].label.toLowerCase()} to unlock this.
            </p>
            {state && state.available_cells > 0 && (
              <p className="mt-1 text-xs text-text-secondary">
                {state.available_cells.toLocaleString('en-US')} cohorts are waiting for you.
              </p>
            )}
            {canManage ? (
              <button
                type="button"
                onClick={() => onShare(info.domain)}
                className="focus-ring mt-3 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                Review &amp; share
              </button>
            ) : (
              <p className="mt-2 text-xs text-text-secondary">Ask the account owner to enable sharing.</p>
            )}
          </div>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <div className="relative min-w-[200px] flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary/60" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search service, make, part…"
                  aria-label="Search cohorts"
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2 pl-8 pr-3 text-xs text-text-primary"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={myTradeOnly}
                  onChange={(e) => setMyTradeOnly(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--color-accent,#2563eb)]"
                />
                My trade only
              </label>
            </div>

            {loading ? (
              <div className="mt-4 space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded-xl bg-bg-tertiary" />
                ))}
              </div>
            ) : cells.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-border py-8 text-center text-xs text-text-secondary">
                No cohort has enough contributors yet. Cohorts appear automatically once enough accounts share
                this data — check back after the next nightly refresh.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-[11px] uppercase tracking-wide text-text-secondary">
                      <th className="py-2 pr-3 font-medium">Cohort</th>
                      <th className="py-2 pr-3 font-medium">Metric</th>
                      <th className="py-2 pr-3 text-right font-medium">Typical (median)</th>
                      <th className="py-2 pr-3 text-right font-medium">Middle range</th>
                      <th className="py-2 pr-3 text-right font-medium">Accounts</th>
                      <th className="py-2 text-right font-medium">Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cells.map((c) => (
                      <tr key={`${c.metric}|${JSON.stringify(c.dimension)}`} className="border-b border-border/50">
                        <td className="py-2 pr-3 font-medium text-text-primary">{describeDimension(c.dimension)}</td>
                        <td className="py-2 pr-3 text-text-secondary">{metricLabel(c.metric)}</td>
                        <td className="py-2 pr-3 text-right font-semibold text-text-primary">
                          {formatSdeValue(c.p50, c.unit)}
                        </td>
                        <td className="py-2 pr-3 text-right text-text-secondary">
                          {formatSdeValue(c.p25, c.unit)} – {formatSdeValue(c.p75, c.unit)}
                        </td>
                        <td className="py-2 pr-3 text-right text-text-secondary">{c.contributor_count}</td>
                        <td className="py-2 text-right text-text-secondary">~{c.sample_size}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ServiceDataExchangePage() {
  const { toast } = useToast();

  const [overview, setOverview] = useState<SdeOverview | null>(null);
  const [events, setEvents] = useState<SdeConsentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<{ domain: SdeDomain; next: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHow, setShowHow] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ov, ev] = await Promise.all([fetchSdeOverview(), fetchSdeConsentEvents()]);
      setOverview(ov);
      setEvents(ev);
      setFailed(false);
    } catch {
      setFailed(true);
      toast('Could not load the Data Exchange', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    setSaving(true);
    try {
      await setSdeConsent(pending.domain, pending.next);
      toast(pending.next ? 'Sharing enabled' : 'Sharing stopped', 'success');
      setPending(null);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast(msg.includes('account owner') ? 'Only the account owner can change this.' : 'Could not update sharing', 'error');
    } finally {
      setSaving(false);
    }
  }, [pending, load, toast]);

  const stats = useMemo(() => {
    const domains = overview?.domains ?? [];
    return {
      shared: domains.filter((d) => d.status === 'granted').length,
      cohorts: domains.reduce((sum, d) => sum + d.cohorts_contributed, 0),
      unlocked: (overview?.products ?? []).filter((p) => p.unlocked).length,
    };
  }, [overview]);

  const canManage = overview?.can_manage ?? false;

  return (
    <DashboardLayout activeLabel="Data Exchange">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Handshake size={22} className="text-accent" /> Service Data Exchange
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Contribute anonymous statistics — never raw records — and unlock failure, OEM, pricing, labor,
              parts, benchmark and demand intelligence built from the whole network. The more businesses share,
              the sharper it gets for everyone.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowHow(true)}
            aria-label="How privacy works"
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-accent"
          >
            <Info size={15} />
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : failed || !overview ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <p className="text-sm text-text-secondary">The Data Exchange isn’t available right now.</p>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void load();
              }}
              className="focus-ring mt-3 rounded-xl border border-border px-4 py-2 text-sm text-text-primary hover:text-accent"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                { label: 'Domains shared', value: `${stats.shared} / ${SDE_DOMAIN_ORDER.length}` },
                { label: 'Products unlocked', value: `${stats.unlocked} / ${SDE_PRODUCT_ORDER.length}` },
                { label: 'Cohorts you feed', value: stats.cohorts.toLocaleString('en-US') },
                {
                  label: 'Businesses in network',
                  value: overview.network_contributors !== null ? `${overview.network_contributors}+` : 'Growing',
                },
              ].map((s) => (
                <div key={s.label} className="rounded-2xl border border-border bg-bg-secondary p-4">
                  <p className="text-xl font-bold text-text-primary">{s.value}</p>
                  <p className="mt-0.5 text-[11px] text-text-secondary">{s.label}</p>
                </div>
              ))}
            </div>

            {!canManage && (
              <p className="mt-4 rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-2 text-xs text-text-primary">
                Only the account owner can change data-sharing settings. You can still browse any unlocked intelligence.
              </p>
            )}

            <section className="mt-8">
              <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
                <Network size={16} className="text-accent" /> What you share
              </h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {SDE_DOMAIN_ORDER.map((d) => {
                  const state = overview.domains.find((x) => x.domain === d);
                  if (!state) return null;
                  return (
                    <ConsentCard
                      key={d}
                      state={state}
                      canManage={canManage}
                      busy={saving && pending?.domain === d}
                      onToggle={(domain, next) => setPending({ domain, next })}
                    />
                  );
                })}
              </div>
            </section>

            <ProductExplorer
              overview={overview}
              canManage={canManage}
              onShare={(domain) => setPending({ domain, next: true })}
            />

            {events.length > 0 && (
              <section className="mt-8">
                <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
                  <History size={16} className="text-accent" /> Consent history
                </h2>
                <ul className="mt-3 divide-y divide-border/60 rounded-2xl border border-border bg-bg-secondary">
                  {events.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
                      <span className="text-text-primary">
                        {e.action === 'granted' ? 'Started sharing' : 'Stopped sharing'}{' '}
                        <span className="font-medium">{SDE_DOMAIN_INFO[e.domain]?.label ?? e.domain}</span>
                      </span>
                      <span className="text-text-secondary">{new Date(e.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="mt-6 flex items-start gap-2 text-xs text-text-secondary/70">
              <ShieldCheck size={13} className="mt-0.5 shrink-0" />
              <p>
                Intelligence refreshes nightly
                {overview.last_refreshed_at ? ` (last: ${new Date(overview.last_refreshed_at).toLocaleDateString()})` : ''}.
                Terms version {overview.terms_version}.
              </p>
            </div>
          </>
        )}
      </div>

      {pending && (
        <ConfirmModal
          domain={pending.domain}
          next={pending.next}
          busy={saving}
          onCancel={() => !saving && setPending(null)}
          onConfirm={() => void confirm()}
        />
      )}

      {showHow && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
          onClick={() => setShowHow(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-5 shadow-2xl"
          >
            <h4 className="text-sm font-semibold text-text-primary">How your data is protected</h4>
            <ul className="mt-3 list-disc space-y-2 pl-4 text-xs leading-relaxed text-text-secondary">
              {GUARANTEES.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setShowHow(false)}
              className="focus-ring mt-4 w-full rounded-xl border border-border py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              Close
            </button>
          </motion.div>
        </div>
      )}
    </DashboardLayout>
  );
}
