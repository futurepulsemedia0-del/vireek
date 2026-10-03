/**
 * Global Failure Atlas — /dashboard/failure-atlas
 *
 * Network-wide, privacy-preserving failure knowledge graph. Every business
 * benefits from the collective outcome data of all contributing businesses;
 * nothing identifying ever leaves an account (k-anonymity, dominance cap,
 * bucketing — enforced in SQL, see 20270301000000_global_failure_atlas.sql).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Globe, Lock, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { FailureAtlasPanel } from '@/components/atlas/FailureAtlasPanel';
import {
  ATLAS_PRIVACY,
  RISK_BAND_LABEL,
  fetchAtlasIndex,
  fetchAtlasStats,
  fetchConsent,
  fetchMyExposure,
  formatAgeMonths,
  formatMake,
  formatModelFamily,
  formatPct,
  humanizeKey,
  setConsent,
  type AtlasConsent,
  type AtlasExposureRow,
  type AtlasIndexRow,
  type AtlasStats,
  type RiskBand,
} from '@/lib/failureAtlas';

const FIELD =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/70';

const BAND_STYLES: Record<RiskBand, string> = {
  past_typical: 'bg-red-500/10 text-red-600 border-red-500/25',
  in_window: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  approaching: 'bg-accent/10 text-accent border-accent/25',
  early: 'bg-bg-tertiary text-text-secondary border-border',
  unknown: 'bg-bg-tertiary text-text-secondary border-border',
};

type Tab = 'lookup' | 'fleet';

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
    </div>
  );
}

function ContributionCard({
  consent,
  isOwner,
  saving,
  onToggle,
}: {
  consent: AtlasConsent | null;
  isOwner: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
}) {
  const on = consent?.contribute === true;
  return (
    <section
      className="rounded-2xl border border-border bg-bg-secondary p-5"
      aria-labelledby="atlas-contribute-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2
            id="atlas-contribute-title"
            className="flex items-center gap-2 text-sm font-semibold text-text-primary"
          >
            <ShieldCheck size={16} className="text-accent" aria-hidden="true" /> Contribute
            anonymously to the Atlas
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            When on, counts and outcomes of equipment failures (make, model family, failure type,
            equipment age, parts, first-visit-fix and callback results) are folded into network-wide
            statistics. Never shared: customers, addresses, names, prices, notes, jobs or
            technicians. A pattern is published only when at least {ATLAS_PRIVACY.minBusinesses}{' '}
            independent businesses support it and no single business exceeds{' '}
            {ATLAS_PRIVACY.maxBusinessSharePct}% of it. Turn it off any time — your data leaves the
            Atlas at the next nightly refresh.
          </p>
        </div>
        {isOwner ? (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Contribute anonymously to the Failure Atlas"
            disabled={saving || consent === null}
            onClick={() => onToggle(!on)}
            className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}
            />
          </button>
        ) : (
          <span className="flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-3 py-1 text-xs font-semibold text-text-secondary">
            <Lock size={12} aria-hidden="true" /> {on ? 'Contributing' : 'Not contributing'} · owner
            controls this
          </span>
        )}
      </div>
    </section>
  );
}

function ExposureList({ rows }: { rows: AtlasExposureRow[] }) {
  const actionable = rows.filter((r) => r.risk_band !== 'early');
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
        <p className="mx-auto max-w-md text-sm text-text-secondary">
          None of your active equipment matches a published Atlas pattern yet. Add make, model and
          install date to your equipment records, and patterns will appear here as the network
          grows.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {(actionable.length > 0 ? actionable : rows).map((r) => (
        <motion.div
          key={`${r.equipment_id}-${r.failure_mode}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4"
        >
          <div>
            <p className="text-sm font-semibold text-text-primary">
              {formatMake(r.make ?? '')} {r.model ?? ''}{' '}
              <span className="font-normal text-text-secondary">
                · {humanizeKey(r.equipment_type)}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {humanizeKey(r.failure_mode)} — network failure rate {formatPct(r.failure_rate_pct)},
              median age {formatAgeMonths(r.median_age_months)}
              {r.unit_age_months !== null && (
                <> · this unit is {formatAgeMonths(r.unit_age_months)}</>
              )}
            </p>
          </div>
          <span
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${BAND_STYLES[r.risk_band]}`}
          >
            {RISK_BAND_LABEL[r.risk_band]}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

export function FailureAtlasPage() {
  const { user, profile, isOwner } = useAuth();
  const { toast } = useToast();
  const ownerId =
    profile?.role === 'owner'
      ? (user?.id ?? null)
      : ((profile as { account_owner_id?: string | null } | null)?.account_owner_id ??
        user?.id ??
        null);

  const [tab, setTab] = useState<Tab>('lookup');
  const [stats, setStats] = useState<AtlasStats | null>(null);
  const [index, setIndex] = useState<AtlasIndexRow[] | null>(null);
  const [exposure, setExposure] = useState<AtlasExposureRow[] | null>(null);
  const [consent, setConsentState] = useState<AtlasConsent | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AtlasIndexRow | null>(null);
  const [manual, setManual] = useState({ type: '', make: '', model: '' });
  const [manualActive, setManualActive] = useState<{
    type: string;
    make: string;
    model: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [s, i, e, c] = await Promise.allSettled([
        fetchAtlasStats(),
        fetchAtlasIndex(),
        fetchMyExposure(),
        ownerId
          ? fetchConsent(ownerId)
          : Promise.resolve({ contribute: false, consented_at: null } as AtlasConsent),
      ]);
      if (cancelled) return;
      setStats(s.status === 'fulfilled' ? s.value : null);
      setIndex(i.status === 'fulfilled' ? i.value : []);
      setExposure(e.status === 'fulfilled' ? e.value : []);
      setConsentState(
        c.status === 'fulfilled' ? c.value : { contribute: false, consented_at: null },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setSaving(true);
      try {
        await setConsent(next);
        setConsentState({ contribute: next, consented_at: next ? new Date().toISOString() : null });
        toast(
          next
            ? 'Thank you — your outcomes will join the Atlas at the next nightly refresh.'
            : 'Contribution turned off. Your data leaves the Atlas at the next refresh.',
          'success',
        );
      } catch {
        toast('Could not update your contribution setting. Please try again.', 'error');
      } finally {
        setSaving(false);
      }
    },
    [toast],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = index ?? [];
    return q === ''
      ? rows
      : rows.filter((r) => `${r.make_key} ${r.model_family} ${r.equipment_type}`.includes(q));
  }, [index, query]);

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (manual.make.trim() === '') return;
    setSelected(null);
    setManualActive({ type: manual.type, make: manual.make, model: manual.model });
  };

  const active = selected
    ? {
        type: selected.equipment_type,
        make: selected.make_key,
        model: selected.model_family === '*' ? '' : selected.model_family,
      }
    : manualActive;

  return (
    <DashboardLayout activeLabel="Global Failure Atlas">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Globe size={22} className="text-accent" aria-hidden="true" /> Global Failure Atlas
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            What actually fails, when, and what fixes it — learned from the outcomes of the whole
            Vireek network, without exposing any business's data.
          </p>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Contributing businesses"
            value={
              stats && stats.contributing_businesses > 0
                ? `${stats.contributing_businesses.toLocaleString()}+`
                : '—'
            }
          />
          <StatTile
            label="Units observed"
            value={
              stats && stats.units_observed > 0 ? `${stats.units_observed.toLocaleString()}+` : '—'
            }
          />
          <StatTile
            label="Failure patterns published"
            value={stats ? stats.cells_published.toLocaleString() : '—'}
          />
        </div>

        <ContributionCard
          consent={consent}
          isOwner={isOwner}
          saving={saving}
          onToggle={handleToggle}
        />

        <div role="tablist" aria-label="Atlas views" className="mb-4 mt-6 flex gap-2">
          {(
            [
              ['lookup', 'Equipment lookup'],
              ['fleet', 'My fleet exposure'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              type="button"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`focus-ring rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${tab === key ? 'bg-accent text-white' : 'border border-border bg-bg-secondary text-text-secondary hover:text-text-primary'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'lookup' ? (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4">
                <label
                  htmlFor="atlas-search"
                  className="mb-1 block text-xs font-semibold text-text-primary"
                >
                  Browse the Atlas
                </label>
                <input
                  id="atlas-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search brand, model family or equipment type"
                  className={FIELD}
                />
                <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">
                  {index === null ? (
                    <div className="h-24 animate-pulse rounded-xl bg-bg-tertiary" />
                  ) : filtered.length === 0 ? (
                    <p className="py-4 text-center text-xs text-text-secondary">
                      Nothing published yet for this search.
                    </p>
                  ) : (
                    filtered.map((r) => {
                      const isSel =
                        selected?.equipment_type === r.equipment_type &&
                        selected.make_key === r.make_key &&
                        selected.model_family === r.model_family;
                      return (
                        <button
                          key={`${r.equipment_type}|${r.make_key}|${r.model_family}`}
                          type="button"
                          aria-pressed={isSel}
                          onClick={() => {
                            setSelected(r);
                            setManualActive(null);
                          }}
                          className={`focus-ring flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs ${isSel ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary'}`}
                        >
                          <span className="font-medium text-text-primary">
                            {formatMake(r.make_key)} · {formatModelFamily(r.model_family)} ·{' '}
                            {humanizeKey(r.equipment_type)}
                          </span>
                          <span>{r.failure_modes} patterns</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <form
                onSubmit={submitManual}
                className="rounded-2xl border border-border bg-bg-secondary p-4"
              >
                <p className="mb-2 text-xs font-semibold text-text-primary">
                  Or look up a specific unit
                </p>
                <div className="space-y-2">
                  <input
                    aria-label="Equipment type"
                    value={manual.type}
                    onChange={(e) => setManual((m) => ({ ...m, type: e.target.value }))}
                    placeholder="Equipment type (e.g. AC Condenser)"
                    className={FIELD}
                  />
                  <input
                    aria-label="Make"
                    required
                    value={manual.make}
                    onChange={(e) => setManual((m) => ({ ...m, make: e.target.value }))}
                    placeholder="Make (e.g. Carrier)"
                    className={FIELD}
                  />
                  <input
                    aria-label="Model"
                    value={manual.model}
                    onChange={(e) => setManual((m) => ({ ...m, model: e.target.value }))}
                    placeholder="Model number (optional)"
                    className={FIELD}
                  />
                  <Button type="submit" size="sm">
                    Look up
                  </Button>
                </div>
                <p className="mt-2 text-[11px] text-text-secondary">
                  Model numbers are matched by family, falling back to brand-wide patterns when a
                  model is too new to have its own.
                </p>
              </form>
            </div>

            {active ? (
              <FailureAtlasPanel
                ownerId={ownerId}
                equipmentType={active.type}
                make={active.make}
                model={active.model}
              />
            ) : (
              <p className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-text-secondary">
                Pick equipment from the Atlas, or look up a specific unit, to see its network-wide
                failure profile.
              </p>
            )}
          </div>
        ) : exposure === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <ExposureList rows={exposure} />
        )}
      </div>
    </DashboardLayout>
  );
}
