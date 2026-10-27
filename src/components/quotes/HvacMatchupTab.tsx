import { useMemo, useState } from 'react';
import { Archive, BadgeCheck, ExternalLink, FileSpreadsheet, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  CSV_TEMPLATE,
  REGION_LABELS,
  STAGING_LABELS,
  SYSTEM_TYPE_LABELS,
  evaluateMatchup,
  matchupTitle,
  parseMatchupCsv,
  rankMatchups,
  type AhriMatchup,
  type CoolingStatus,
  type CsvImportPreview,
  type DoeRegion,
  type MatchupFit,
} from '@/lib/ahriMatchup';
import type { LoadResult } from '@/lib/hvacSizing';
import {
  applyMatchupToQuote,
  deleteMatchup,
  importMatchups,
  selectQuoteMatchup,
  setMatchupActive,
  setMatchupVerified,
} from '@/lib/hvacSizingApi';
import { HVAC_SECTION, NumField, Pill, SelectField, WarningList, type Tone } from '@/components/quotes/HvacFields';

const AHRI_DIRECTORY_URL = 'https://www.ahridirectory.org/';

const COOLING_TONE: Record<CoolingStatus, Tone> = { ideal: 'good', acceptable: 'good', undersized: 'bad', oversized: 'warn' };
const COOLING_LABEL: Record<CoolingStatus, string> = {
  ideal: 'Ideal fit',
  acceptable: 'Within range',
  undersized: 'Undersized',
  oversized: 'Oversized',
};

interface Props {
  quoteId: string;
  quoteStatus: string;
  tiered: boolean;
  load: LoadResult | null;
  outdoorSummerDb: number;
  outdoorWinterDb: number;
  region: DoeRegion | null;
  onRegionChange: (r: DoeRegion) => void;
  matchups: AhriMatchup[];
  selected: AhriMatchup | null;
  /** Re-fetch the catalog and the quote's saved selection. */
  onRefresh: () => Promise<void>;
}

function money(cents: number | null): string {
  return cents === null ? 'No price' : `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function HvacMatchupTab(props: Props) {
  const { quoteId, load, region, matchups, selected, onRefresh } = props;
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const ctx = useMemo(
    () => (load && region ? { load, outdoorSummerDb: props.outdoorSummerDb, outdoorWinterDb: props.outdoorWinterDb, region } : null),
    [load, region, props.outdoorSummerDb, props.outdoorWinterDb],
  );
  const ranked = useMemo(() => (ctx ? rankMatchups(matchups, ctx) : []), [ctx, matchups]);
  const fitting = ranked.filter((f) => f.passes);
  const visible = showAll ? ranked : fitting;
  const selectedFit = useMemo(() => (ctx && selected ? evaluateMatchup(selected, ctx) : null), [ctx, selected]);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; reason?: string }>, success: string) => {
    setBusy(key);
    const res = await fn();
    if (res.ok) {
      toast(success, 'success');
      await onRefresh();
    } else {
      toast(res.reason === 'forbidden' ? 'You don\u2019t have permission to do that.' : 'That did not work. Please try again.', 'error');
    }
    setBusy(null);
  };

  const importSection = (
    <ImportPanel
      open={showImport}
      onToggle={() => setShowImport((v) => !v)}
      onImported={async () => {
        await onRefresh();
      }}
    />
  );

  return (
    <div className="space-y-5">
      <SelectField
        label="Efficiency region"
        value={region ?? ''}
        placeholder="Choose the job's region"
        onChange={(v) => props.onRegionChange(v)}
        options={(Object.keys(REGION_LABELS) as DoeRegion[]).map((r) => ({ value: r, label: REGION_LABELS[r] }))}
        helper="Sets the minimum SEER2 / EER2 / HSPF2. Reference values: confirm current federal and state rules."
      />

      {selected ? (
        <SelectedSystem
          quoteId={quoteId}
          quoteStatus={props.quoteStatus}
          tiered={props.tiered}
          matchup={selected}
          fit={selectedFit}
          busy={busy === 'select'}
          onClear={() => run('select', () => selectQuoteMatchup(quoteId, null), 'Selection cleared')}
          onApplied={onRefresh}
        />
      ) : null}

      {!load ? (
        <EmptyState
          icon={TriangleAlert}
          title="Calculate the load first"
          description="Fix the Load tab so there is a valid cooling and heating load, then come back to match equipment."
        />
      ) : !region ? (
        <div role="status" className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">
          Choose the efficiency region above to rank your equipment.
        </div>
      ) : matchups.filter((m) => m.active).length === 0 ? (
        <EmptyState
          icon={FileSpreadsheet}
          title="Add your AHRI matchups"
          description="Import the certified combinations you sell from your AHRI certificates. Vireek ranks them against this load."
          action={{ label: 'Import matchups', onClick: () => setShowImport(true) }}
        />
      ) : (
        <section aria-label="Matching equipment" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text-primary">
              {fitting.length} of {ranked.length} fit this load
            </h3>
            {ranked.length > fitting.length ? (
              <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Hide non-fitting' : `Show ${ranked.length - fitting.length} that don\u2019t fit`}
              </Button>
            ) : null}
          </div>
          {visible.length === 0 ? (
            <EmptyState
              icon={TriangleAlert}
              title="Nothing in your catalog fits"
              description="Add a size closer to the load, or review the ones that don't fit to see why."
              action={{ label: 'Show all', onClick: () => setShowAll(true) }}
            />
          ) : (
            <ul className="space-y-3">
              {visible.map((fit) => (
                <FitCard
                  key={fit.matchup.id}
                  fit={fit}
                  isSelected={selected?.id === fit.matchup.id}
                  busy={busy}
                  onSelect={() => run('select', () => selectQuoteMatchup(quoteId, fit.matchup.id), 'Equipment selected for this quote')}
                  onVerify={() =>
                    run(`v-${fit.matchup.id}`, () => setMatchupVerified(fit.matchup.id, !fit.verified), fit.verified ? 'Marked unverified' : 'Marked verified')
                  }
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {importSection}

      <div>
        <Button size="sm" variant="ghost" onClick={() => setShowCatalog((v) => !v)} aria-expanded={showCatalog}>
          {showCatalog ? 'Hide catalog' : `Manage catalog (${matchups.length})`}
        </Button>
        {showCatalog ? (
          <CatalogList
            matchups={matchups}
            busy={busy}
            onArchive={(m) => run(`a-${m.id}`, () => setMatchupActive(m.id, !m.active), m.active ? 'Archived' : 'Restored')}
            onDelete={(m) => run(`d-${m.id}`, () => deleteMatchup(m.id), 'Deleted')}
          />
        ) : null}
      </div>
    </div>
  );
}

function FitCard({
  fit, isSelected, busy, onSelect, onVerify,
}: { fit: MatchupFit; isSelected: boolean; busy: string | null; onSelect: () => void; onVerify: () => void }) {
  const m = fit.matchup;
  const h = fit.heating;
  return (
    <li className={`rounded-xl border p-4 ${isSelected ? 'border-accent' : 'border-border'} bg-bg-primary`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-semibold text-text-primary">{matchupTitle(m)}</p>
          <p className="break-words text-xs text-text-secondary">
            AHRI {m.ahri_ref_number} · {m.outdoor_model}
            {m.indoor_model ? ` + ${m.indoor_model}` : ''}
            {m.furnace_model ? ` + ${m.furnace_model}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill tone={COOLING_TONE[fit.coolingStatus]}>{COOLING_LABEL[fit.coolingStatus]}</Pill>
          <Pill tone={fit.verified ? 'good' : 'neutral'}>
            {fit.verified ? <BadgeCheck size={12} aria-hidden="true" /> : null}
            {fit.verified ? 'AHRI verified' : 'Unverified'}
          </Pill>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <Spec label="Capacity at design" value={`${fit.capacityAtDesignBtuh.toLocaleString('en-US')} Btu/h`} hint={`${Math.round(fit.coolingRatio * 100)}% of load`} />
        <Spec label="Efficiency" value={`${m.seer2} SEER2`} hint={[m.eer2 ? `${m.eer2} EER2` : null, m.hspf2 ? `${m.hspf2} HSPF2` : null].filter(Boolean).join(' · ') || STAGING_LABELS[m.staging]} />
        <Spec
          label="Heating"
          value={h.kind === 'none' ? 'Cooling only' : h.capacityAtDesignBtuh === null ? 'Needs data' : `${h.capacityAtDesignBtuh.toLocaleString('en-US')} Btu/h`}
          hint={h.status === 'needs_backup' ? `~${h.backupKw} kW backup` : h.status === 'ok' ? 'Covers the load' : undefined}
        />
        <Spec label="Price" value={money(m.sell_price_cents)} hint={`Score ${fit.score}`} />
      </dl>

      {fit.issues.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-text-secondary">
          {fit.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onSelect} disabled={isSelected || busy !== null}>
          {isSelected ? 'Selected' : 'Use for this quote'}
        </Button>
        <Button size="sm" variant="secondary" onClick={onVerify} disabled={busy !== null}>
          {fit.verified ? 'Remove verified mark' : 'I verified this on AHRI'}
        </Button>
        <a
          className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-accent hover:underline"
          href={AHRI_DIRECTORY_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          AHRI Directory <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    </li>
  );
}

function Spec({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="font-medium text-text-primary">{value}</dd>
      {hint ? <dd className="text-xs text-text-secondary">{hint}</dd> : null}
    </div>
  );
}

function SelectedSystem({
  quoteId, quoteStatus, tiered, matchup, fit, busy, onClear, onApplied,
}: {
  quoteId: string; quoteStatus: string; tiered: boolean; matchup: AhriMatchup; fit: MatchupFit | null;
  busy: boolean; onClear: () => void; onApplied: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [price, setPrice] = useState<number | null>(matchup.sell_price_cents === null ? null : matchup.sell_price_cents / 100);
  const [applying, setApplying] = useState(false);

  const blocked = quoteStatus !== 'draft' ? 'Only draft quotes can be changed.' : tiered ? 'This quote uses tiered options. Add the system to an option in the quote builder.' : null;
  const priceInvalid = price === null || !Number.isFinite(price) || price < 0 || price > 1000000;

  const apply = async () => {
    if (priceInvalid || price === null) return;
    setApplying(true);
    const res = await applyMatchupToQuote(quoteId, Math.round(price * 100));
    setApplying(false);
    if (!res.ok) {
      const msg =
        res.reason === 'invalid_state'
          ? res.detail === 'quote_not_editable' ? 'Only draft quotes can be changed.'
            : res.detail === 'quote_is_tiered' ? 'Tiered quotes can\u2019t take a line item from here.'
            : 'Choose a system and a price first.'
          : res.reason === 'forbidden' ? 'You don\u2019t have permission to do that.'
          : 'Could not add it to the quote.';
      toast(msg, 'error');
      return;
    }
    toast(res.data.added ? 'Added to the quote as a line item' : 'This system is already on the quote', res.data.added ? 'success' : 'info');
    await onApplied();
  };

  return (
    <section className={HVAC_SECTION} aria-label="Selected system">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Chosen for this quote</p>
          <p className="break-words font-semibold text-text-primary">{matchupTitle(matchup)}</p>
          <p className="break-words text-xs text-text-secondary">
            AHRI {matchup.ahri_ref_number} · {SYSTEM_TYPE_LABELS[matchup.system_type]} · {matchup.seer2} SEER2
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>Remove</Button>
      </div>
      {fit && fit.issues.length > 0 ? <div className="mt-3"><WarningList items={fit.issues.filter((i) => !i.startsWith('Sensible heat ratio not on file'))} /></div> : null}
      {matchup.ahri_status !== 'verified' ? (
        <p className="mt-3 text-xs text-text-secondary">Verify this combination on the AHRI Directory before presenting it to the customer.</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-48">
          <NumField label="Price on quote ($)" value={price} nullable onChange={setPrice} error={price !== null && priceInvalid ? 'Enter a price from 0 to 1,000,000.' : undefined} />
        </div>
        <Button onClick={apply} disabled={applying || priceInvalid || blocked !== null}>
          {applying ? 'Adding…' : 'Add to quote as line item'}
        </Button>
      </div>
      {blocked ? <p className="mt-2 text-xs text-text-secondary">{blocked}</p> : null}
    </section>
  );
}

function ImportPanel({ open, onToggle, onImported }: { open: boolean; onToggle: () => void; onImported: () => Promise<void> }) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<CsvImportPreview | null>(null);
  const [saving, setSaving] = useState(false);

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(CSV_TEMPLATE);
      toast('Template copied. Paste it into a spreadsheet.', 'success');
    } catch {
      setText(CSV_TEMPLATE);
      toast('Template added to the box below.', 'info');
    }
  };

  const submit = async () => {
    const p = parseMatchupCsv(text);
    setPreview(p);
    if (p.fatal || p.rows.length === 0) return;
    setSaving(true);
    const res = await importMatchups(p.rows);
    setSaving(false);
    if (!res.ok) {
      toast(res.reason === 'forbidden' ? 'You don\u2019t have permission to do that.' : 'The import failed. Nothing was changed.', 'error');
      return;
    }
    const rejected = res.data.rejected.length + p.rejected.length;
    toast(`${res.data.inserted} added, ${res.data.updated} updated${rejected ? `, ${rejected} skipped` : ''}`, rejected ? 'info' : 'success');
    if (rejected === 0) {
      setText('');
      setPreview(null);
    } else {
      setPreview({ ...p, rejected: [...p.rejected, ...res.data.rejected.map((r) => ({ line: r.index + 2, reason: r.reason }))] });
    }
    await onImported();
  };

  return (
    <div>
      <Button size="sm" variant="secondary" onClick={onToggle} aria-expanded={open}>
        <Upload size={14} aria-hidden="true" /> Import matchups
      </Button>
      {open ? (
        <div className={`${HVAC_SECTION} mt-3 space-y-3`}>
          <p className="text-sm text-text-secondary">
            Paste rows from a spreadsheet (comma or tab separated, header on the first line). Copy the AHRI reference number,
            models and ratings from each certificate. Imported rows start unverified.
          </p>
          <Textarea
            label="Matchup rows"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={CSV_TEMPLATE.split('\n')[0]}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} disabled={saving || text.trim() === ''}>{saving ? 'Importing…' : 'Import'}</Button>
            <Button variant="secondary" onClick={copyTemplate} disabled={saving}>Copy template</Button>
          </div>
          {preview?.fatal ? <WarningList tone="bad" items={[preview.fatal]} /> : null}
          {preview && preview.rejected.length > 0 ? (
            <WarningList items={preview.rejected.slice(0, 20).map((r) => `Line ${r.line}: ${r.reason}`)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CatalogList({
  matchups, busy, onArchive, onDelete,
}: { matchups: AhriMatchup[]; busy: string | null; onArchive: (m: AhriMatchup) => void; onDelete: (m: AhriMatchup) => void }) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (matchups.length === 0) return <p className="mt-2 text-sm text-text-secondary">The catalog is empty.</p>;
  return (
    <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
      {matchups.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="min-w-0">
            <p className={`break-words text-sm font-medium ${m.active ? 'text-text-primary' : 'text-text-secondary line-through'}`}>{matchupTitle(m)}</p>
            <p className="break-words text-xs text-text-secondary">AHRI {m.ahri_ref_number} · {m.outdoor_model}{m.active ? '' : ' · archived'}</p>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => onArchive(m)} disabled={busy !== null} aria-label={`${m.active ? 'Archive' : 'Restore'} AHRI ${m.ahri_ref_number}`}>
              <Archive size={14} aria-hidden="true" /> {m.active ? 'Archive' : 'Restore'}
            </Button>
            {confirmId === m.id ? (
              <Button size="sm" variant="secondary" onClick={() => { setConfirmId(null); onDelete(m); }} disabled={busy !== null}>Confirm delete</Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmId(m.id)} disabled={busy !== null} aria-label={`Delete AHRI ${m.ahri_ref_number}`}>
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
