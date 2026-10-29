import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Loader2, MapPin, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  DEFAULT_GRID_SIZE,
  DEFAULT_RADIUS_M,
  GRID_SIZES,
  RADIUS_PRESETS_MI,
  SCHEDULES,
  SCHEDULE_LABELS,
  describeGrid,
  draftsEqual,
  formatMiles,
  gridPointCount,
  milesToMeters,
  validateKeywordDraft,
  validateLocationDraft,
  type GeoGridKeyword,
  type GeoGridLocation,
  type GridSize,
  type KeywordDraft,
  type LocationDraft,
  type PlaceCandidate,
  type ScanSchedule,
} from '@/lib/geoGrid';
import { createKeyword, createLocation, describeGeoGridError, searchPlaces, updateKeyword } from '@/lib/geoGridApi';

const SELECT_CLASS =
  'focus-ring min-h-[48px] w-full rounded-xl border border-border bg-bg-primary px-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

function FormShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      <p className="mb-5 mt-1 text-sm leading-relaxed text-text-secondary">{description}</p>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

interface LocationFormProps {
  accountOwnerId: string;
  defaultQuery: string;
  providerReady: boolean;
  onSaved: (location: GeoGridLocation) => void;
  onCancel: () => void;
}

export function LocationForm({ accountOwnerId, defaultQuery, providerReady, onSaved, onCancel }: LocationFormProps) {
  const { toast } = useToast();
  const [query, setQuery] = useState(defaultQuery);
  const [candidates, setCandidates] = useState<PlaceCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<PlaceCandidate | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const groupName = useId();

  const search = async () => {
    const q = query.trim();
    if (q.length < 2) {
      setError('Enter your business name and city.');
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    setError(null);
    setChosen(null);
    try {
      const found = await searchPlaces(q);
      if (seq !== searchSeq.current) return;
      setCandidates(found);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setCandidates(null);
      setError(describeGeoGridError(e));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  };

  const choose = (c: PlaceCandidate) => {
    setChosen(c);
    setName((prev) => (prev.trim() ? prev : c.name));
    setError(null);
  };

  const save = async () => {
    if (!chosen) {
      setError('Search for your business and pick it from the results.');
      return;
    }
    const draft: LocationDraft = {
      name: name.trim() || chosen.name,
      business_name: chosen.name,
      google_place_id: chosen.place_id,
      address: chosen.address,
      latitude: chosen.latitude,
      longitude: chosen.longitude,
    };
    const problem = validateLocationDraft(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const created = await createLocation(accountOwnerId, draft);
      toast(`"${created.name}" added`, 'success');
      onSaved(created);
    } catch (e) {
      setError(describeGeoGridError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell
      title="Add a location"
      description="Find your business exactly as it appears on Google Maps. We rank this listing, so pick the right one."
    >
      {!providerReady && (
        <p role="status" className="mb-4 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-warning-500">
          Business search is unavailable until a Google Places API key is configured.
        </p>
      )}
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Business name and city"
              icon={Search}
              value={query}
              maxLength={160}
              placeholder="e.g. Smith Plumbing Austin TX"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (providerReady && !searching) void search();
                }
              }}
            />
          </div>
          <Button variant="secondary" size="md" disabled={!providerReady || searching} onClick={() => void search()}>
            {searching ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </div>

        {candidates !== null && candidates.length === 0 && (
          <p role="status" className="text-sm text-text-secondary">
            Google found no match. Try adding the city or the street name.
          </p>
        )}

        {candidates !== null && candidates.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-text-primary">Pick your listing</legend>
            <ul className="space-y-2">
              {candidates.map((c) => {
                const active = chosen?.place_id === c.place_id;
                return (
                  <li key={c.place_id}>
                    <label
                      className={`flex min-h-[56px] cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                        active ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/40'
                      }`}
                    >
                      <input
                        type="radio"
                        name={groupName}
                        className="focus-ring mt-1 h-4 w-4 accent-accent"
                        checked={active}
                        onChange={() => choose(c)}
                      />
                      <span className="min-w-0">
                        <span className="block font-semibold text-text-primary">{c.name}</span>
                        <span className="block break-words text-sm text-text-secondary">{c.address || 'Address not available'}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        {chosen && (
          <Input
            label="Label for this location"
            value={name}
            maxLength={120}
            helperText="Shown in your list, e.g. “Downtown shop”."
            onChange={(e) => setName(e.target.value)}
          />
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !chosen}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <MapPin size={16} aria-hidden="true" />}
            {saving ? 'Saving…' : 'Add location'}
          </Button>
        </div>
      </div>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Keyword
// ---------------------------------------------------------------------------

interface KeywordFormProps {
  accountOwnerId: string;
  locations: readonly GeoGridLocation[];
  keywords: readonly GeoGridKeyword[];
  editing: GeoGridKeyword | null;
  defaultLocationId: string;
  onSaved: (keyword: GeoGridKeyword, created: boolean) => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function KeywordForm({ accountOwnerId, locations, keywords, editing, defaultLocationId, onSaved, onCancel, onDirtyChange }: KeywordFormProps) {
  const { toast } = useToast();
  const initial: KeywordDraft = useMemo(
    () =>
      editing
        ? { location_id: editing.location_id, keyword: editing.keyword, grid_size: editing.grid_size, radius_m: editing.radius_m, schedule: editing.schedule }
        : {
            location_id: defaultLocationId || locations[0]?.id || '',
            keyword: '',
            grid_size: DEFAULT_GRID_SIZE,
            radius_m: DEFAULT_RADIUS_M,
            schedule: 'weekly',
          },
    [editing, defaultLocationId, locations],
  );
  const [draft, setDraft] = useState<KeywordDraft>(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const dirty = !draftsEqual(draft, initial);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const problem = validateKeywordDraft(draft, keywords, editing?.id);
  const showProblem = touched && problem;
  const radiusOptions = useMemo(() => {
    const presets = RADIUS_PRESETS_MI.map((mi) => milesToMeters(mi));
    return presets.includes(draft.radius_m) ? presets : [...presets, draft.radius_m].sort((a, b) => a - b);
  }, [draft.radius_m]);

  const set = <K extends keyof KeywordDraft>(k: K, v: KeywordDraft[K]) => {
    setServerError(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const save = async () => {
    setTouched(true);
    if (problem) return;
    setSaving(true);
    setServerError(null);
    try {
      if (editing) {
        const saved = await updateKeyword(editing.id, accountOwnerId, editing.updated_at, draft);
        toast('Keyword updated', 'success');
        onSaved(saved, false);
      } else {
        const saved = await createKeyword(accountOwnerId, draft);
        toast(`Now tracking "${saved.keyword}"`, 'success');
        onSaved(saved, true);
      }
    } catch (e) {
      setServerError(describeGeoGridError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell
      title={editing ? 'Edit keyword' : 'Track a keyword'}
      description="We search this phrase from every point of the grid around your business and record where you appear."
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="geo-grid-location" className="mb-1.5 block text-sm font-medium text-text-primary">
            Location
          </label>
          <select
            id="geo-grid-location"
            className={SELECT_CLASS}
            value={draft.location_id}
            disabled={!!editing}
            onChange={(e) => set('location_id', e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        <Input
          label="Keyword"
          value={draft.keyword}
          maxLength={120}
          placeholder="e.g. emergency plumber"
          error={showProblem ? problem ?? undefined : undefined}
          onChange={(e) => set('keyword', e.target.value)}
          onBlur={() => setTouched(true)}
        />

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-text-primary">Grid size</legend>
          <div className="flex flex-wrap gap-2">
            {GRID_SIZES.map((s: GridSize) => (
              <button
                key={s}
                type="button"
                aria-pressed={draft.grid_size === s}
                onClick={() => set('grid_size', s)}
                className={`focus-ring min-h-[44px] rounded-xl border px-4 text-sm font-semibold transition-colors ${
                  draft.grid_size === s ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                }`}
              >
                {s}×{s}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="geo-grid-radius" className="mb-1.5 block text-sm font-medium text-text-primary">
              Radius
            </label>
            <select id="geo-grid-radius" className={SELECT_CLASS} value={draft.radius_m} onChange={(e) => set('radius_m', Number(e.target.value))}>
              {radiusOptions.map((m) => (
                <option key={m} value={m}>
                  {formatMiles(m)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="geo-grid-schedule" className="mb-1.5 block text-sm font-medium text-text-primary">
              Re-scan
            </label>
            <select
              id="geo-grid-schedule"
              className={SELECT_CLASS}
              value={draft.schedule}
              onChange={(e) => set('schedule', e.target.value as ScanSchedule)}
            >
              {SCHEDULES.map((s) => (
                <option key={s} value={s}>
                  {SCHEDULE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary">
          {describeGrid(draft.grid_size, draft.radius_m)}. Each scan uses {gridPointCount(draft.grid_size)} of your monthly scan points.
          {draft.schedule !== 'manual' ? ` Scheduled scans use the same budget (${SCHEDULE_LABELS[draft.schedule].toLowerCase()}).` : ''}
        </p>

        {serverError && (
          <p role="alert" className="text-sm text-danger">
            {serverError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || (!!editing && !dirty) || locations.length === 0}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Start tracking'}
          </Button>
        </div>
      </div>
    </FormShell>
  );
}
