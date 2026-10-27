/**
 * HVAC sizing on a quote (rendered on /dashboard/quotes/:id).
 *  - Load:      Manual J-based heating / cooling load estimate
 *  - Equipment: rank the account's AHRI matchups against that load (Manual S-style),
 *               pick one for the quote, add it as a line item
 *  - Ducts:     equal-friction duct sizing
 *
 * Access is the quote workspace rule (owner, or can_view_billing); the page gates
 * it and every RPC re-checks it server-side.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Calculator, Lock, RefreshCw, Save, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import type { AhriMatchup, DoeRegion } from '@/lib/ahriMatchup';
import {
  computeDuctDesign,
  computeLoad,
  sanitizeDuctInputs,
  sanitizeLoadInputs,
  validateDuctInputs,
  validateLoadInputs,
  type DuctInputs,
  type DuctResult,
  type HvacLoadInputs,
  type LoadResult,
} from '@/lib/hvacSizing';
import {
  fetchMatchups,
  fetchQuoteSizing,
  saveQuoteSizing,
  type QuoteSizingState,
  type SizingFailureReason,
} from '@/lib/hvacSizingApi';
import { HvacDuctTab } from '@/components/quotes/HvacDuctTab';
import { HVAC_SECTION } from '@/components/quotes/HvacFields';
import { HvacLoadTab } from '@/components/quotes/HvacLoadTab';
import { HvacMatchupTab } from '@/components/quotes/HvacMatchupTab';

type TabKey = 'load' | 'equipment' | 'duct';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'load', label: 'Load' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'duct', label: 'Ducts' },
];

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; reason: SizingFailureReason }
  | { kind: 'ready' };

interface Props {
  quoteId: string;
  quoteStatus: string;
}

function safeLoad(inputs: HvacLoadInputs): LoadResult | null {
  if (Object.keys(validateLoadInputs(inputs)).length > 0) return null;
  try {
    return computeLoad(inputs);
  } catch {
    return null;
  }
}

function safeDuct(inputs: DuctInputs): DuctResult | null {
  if (Object.keys(validateDuctInputs(inputs)).length > 0) return null;
  try {
    return computeDuctDesign(inputs);
  } catch {
    return null;
  }
}

function fmtSaved(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function QuoteHvacPanel({ quoteId, quoteStatus }: Props) {
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [sizing, setSizing] = useState<QuoteSizingState | null>(null);
  const [matchups, setMatchups] = useState<AhriMatchup[]>([]);
  const [tab, setTab] = useState<TabKey>('load');
  const [loadInputs, setLoadInputs] = useState<HvacLoadInputs>(() => sanitizeLoadInputs(null));
  const [ductInputs, setDuctInputs] = useState<DuctInputs>(() => sanitizeDuctInputs(null, 36000));
  const [region, setRegion] = useState<DoeRegion | null>(null);
  const [savedKey, setSavedKey] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);
  const savedDuctRef = useRef<DuctInputs | null>(null);
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({ load: null, equipment: null, duct: null });

  const keyOf = (l: HvacLoadInputs, d: DuctInputs, r: DoeRegion | null) => JSON.stringify([l, d, r]);

  const fetchAll = useCallback(
    async (initial: boolean) => {
      const req = ++requestRef.current;
      if (initial) setState({ kind: 'loading' });
      const [s, m] = await Promise.all([fetchQuoteSizing(quoteId), fetchMatchups()]);
      if (req !== requestRef.current) return;

      if (!s.ok || !m.ok) {
        if (initial) setState({ kind: 'error', reason: !s.ok ? s.reason : !m.ok ? m.reason : 'failed' });
        else toast('Could not refresh the HVAC data.', 'error');
        return;
      }
      setSizing(s.data);
      setMatchups(m.data);
      if (initial) {
        const saved = s.data.sizing;
        const l = sanitizeLoadInputs(saved?.load_inputs);
        const base = safeLoad(l)?.cooling.totalBtuh ?? 36000;
        const d = sanitizeDuctInputs(saved?.duct_inputs, base);
        const r = saved?.region ?? null;
        setLoadInputs(l);
        setDuctInputs(d);
        setRegion(r);
        savedDuctRef.current = d;
        setSavedKey(keyOf(l, d, r));
        setSavedAt(saved?.updated_at ?? null);
        setState({ kind: 'ready' });
      }
    },
    [quoteId, toast],
  );

  useEffect(() => {
    void fetchAll(true);
    return () => {
      requestRef.current++;
    };
  }, [fetchAll]);

  const loadResult = useMemo(() => safeLoad(loadInputs), [loadInputs]);
  const ductResult = useMemo(() => safeDuct(ductInputs), [ductInputs]);
  const loadErrors = useMemo(() => validateLoadInputs(loadInputs), [loadInputs]);
  const ductErrors = useMemo(() => validateDuctInputs(ductInputs), [ductInputs]);
  const selected = sizing?.sizing?.selection_snapshot ?? null;
  const dirty = state.kind === 'ready' && keyOf(loadInputs, ductInputs, region) !== savedKey;
  const suggestedCooling = selected?.cooling_btuh ?? loadResult?.cooling.totalBtuh ?? null;

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async () => {
    if (!loadResult || saving) return;
    setSaving(true);
    const res = await saveQuoteSizing(quoteId, {
      loadInputs,
      loadResult,
      ductInputs: ductResult ? ductInputs : undefined,
      ductResult: ductResult ?? undefined,
      region,
    });
    setSaving(false);
    if (!res.ok) {
      toast(
        res.reason === 'forbidden' ? 'You don\u2019t have permission to save this.'
        : res.reason === 'not_found' ? 'This quote no longer exists.'
        : 'Could not save the calculation.',
        'error',
      );
      return;
    }
    setSavedAt(res.data);
    // Duct edits that were not valid were not saved, so they must stay "unsaved".
    if (ductResult) savedDuctRef.current = ductInputs;
    setSavedKey(keyOf(loadInputs, savedDuctRef.current ?? ductInputs, region));
    const ductSkipped = !ductResult && ductInputs.rooms.length > 0;
    toast(ductSkipped ? 'Load saved. Duct sizes have errors and were not saved.' : 'Calculation saved', ductSkipped ? 'info' : 'success');
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = TABS[(idx + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].key;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  if (state.kind === 'loading') {
    return (
      <div role="status" aria-busy="true" aria-label="Loading HVAC sizing">
        <SkeletonCard rows={4} />
      </div>
    );
  }

  if (state.kind === 'error') {
    const view =
      state.reason === 'forbidden'
        ? { icon: Lock, title: 'You don\u2019t have access to HVAC sizing', description: 'It is limited to the account owner and team members with billing access.' }
        : state.reason === 'not_found'
          ? { icon: TriangleAlert, title: 'Quote not found', description: 'It may have been deleted.' }
          : { icon: TriangleAlert, title: 'Couldn\u2019t load HVAC sizing', description: 'Check your connection and try again.' };
    return (
      <EmptyState
        icon={view.icon}
        title={view.title}
        description={view.description}
        action={state.reason === 'failed' ? { label: 'Try again', onClick: () => void fetchAll(true) } : undefined}
      />
    );
  }

  const quoteState = sizing?.quoteStatus ?? quoteStatus;

  return (
    <section className={HVAC_SECTION} aria-labelledby="hvac-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="hvac-title" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Calculator size={16} aria-hidden="true" /> HVAC sizing
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Load estimate, AHRI equipment match and duct sizes for this job.
            {savedAt ? ` Saved ${fmtSaved(savedAt)}.` : ''}
            {dirty ? ' Unsaved changes.' : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => void fetchAll(false)} aria-label="Refresh HVAC data">
            <RefreshCw size={14} aria-hidden="true" />
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !loadResult || !dirty}>
            <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <div role="tablist" aria-label="HVAC sizing steps" className="-mx-1 mt-4 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.map((t, idx) => (
          <button
            key={t.key}
            ref={(el) => { tabRefs.current[t.key] = el; }}
            type="button"
            role="tab"
            id={`hvac-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`hvac-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => onTabKey(e, idx)}
            className={`focus-ring min-h-[44px] shrink-0 rounded-xl px-4 text-sm font-semibold ${
              tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`hvac-panel-${tab}`} aria-labelledby={`hvac-tab-${tab}`} className="mt-4">
        {tab === 'load' ? (
          <HvacLoadTab inputs={loadInputs} errors={loadErrors} result={loadResult} onChange={setLoadInputs} />
        ) : tab === 'equipment' ? (
          <HvacMatchupTab
            quoteId={quoteId}
            quoteStatus={quoteState}
            tiered={sizing?.tiered ?? false}
            load={loadResult}
            outdoorSummerDb={loadInputs.outdoorSummerDb}
            outdoorWinterDb={loadInputs.outdoorWinterDb}
            region={region}
            onRegionChange={setRegion}
            matchups={matchups}
            selected={selected}
            onRefresh={() => fetchAll(false)}
          />
        ) : (
          <HvacDuctTab
            inputs={ductInputs}
            errors={ductErrors}
            result={ductResult}
            suggestedCoolingBtuh={suggestedCooling}
            onChange={setDuctInputs}
          />
        )}
      </div>
    </section>
  );
}
