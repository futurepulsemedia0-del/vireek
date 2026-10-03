import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Loader2, MapPin, Plus, Search, Send, ShieldCheck, X } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import {
  EQUIPMENT_PRESETS,
  LEVEL_LABELS,
  SERVICE_PRESETS,
  TRADE_OPTIONS,
  URGENCY_META,
  breakdownEntries,
  clampLevel,
  describeMarketError,
  formatRate,
  parseRateToCents,
  presetToRequirement,
  scoreTone,
  skillMarketApi,
  tokensFromText,
  validateSearch,
  type MarketCandidate,
  type MarketTrade,
  type Requirement,
  type RequirementKind,
  type SearchParams,
  type Urgency,
} from '@/lib/skillMarket';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const toneClass = {
  success: 'bg-success-500/10 text-success-500',
  accent: 'bg-accent/10 text-accent',
  warning: 'bg-warning-500/10 text-warning-500',
} as const;

interface OpenJob {
  id: string;
  service_type: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
}

type LocationMode = 'job' | 'device' | 'manual' | 'remote';

export function SkillSearchPanel({ onOfferSent }: { onOfferSent: () => void }) {
  const { toast } = useToast();

  // --- requirement builder
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [customKind, setCustomKind] = useState<RequirementKind>('equipment');
  const [customText, setCustomText] = useState('');
  const [level, setLevel] = useState(3);

  // --- job context
  const [mode, setMode] = useState<LocationMode>('device');
  const [jobs, setJobs] = useState<OpenJob[]>([]);
  const [jobId, setJobId] = useState('');
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [urgency, setUrgency] = useState<Urgency>('standard');
  const [trade, setTrade] = useState<MarketTrade | ''>('hvac');
  const [radius, setRadius] = useState('60');
  const [ceiling, setCeiling] = useState('');
  const [insurance, setInsurance] = useState(false);
  const [ownTeam, setOwnTeam] = useState(true);

  // --- results
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MarketCandidate[] | null>(null);
  const [searched, setSearched] = useState<SearchParams | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // --- offer form
  const [offerFor, setOfferFor] = useState<MarketCandidate | null>(null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [offerRate, setOfferRate] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('jobs')
        .select('id, service_type, address, latitude, longitude')
        .in('job_status', ['scheduled', 'en_route', 'in_progress'])
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .order('scheduled_datetime', { ascending: true })
        .limit(30);
      if (!cancelled && data) setJobs(data as OpenJob[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const addPreset = (kind: RequirementKind, id: string) => {
    const preset = (kind === 'equipment' ? EQUIPMENT_PRESETS : SERVICE_PRESETS).find((p) => p.id === id);
    if (!preset) return;
    setRequirements((cur) => {
      if (cur.length >= 6 || cur.some((r) => r.label === preset.label)) return cur;
      return [...cur, presetToRequirement(preset, level)];
    });
  };

  const addCustom = () => {
    const tokens = tokensFromText(customText);
    if (tokens.length === 0) return toast('Use plain keywords, e.g. "daikin vrv".', 'error');
    if (requirements.length >= 6) return toast('Use at most 6 requirements.', 'error');
    setRequirements((cur) => [...cur, { kind: customKind, tokens, minLevel: clampLevel(level), label: customText.trim().slice(0, 60) }]);
    setCustomText('');
  };

  const locate = () => {
    if (!navigator.geolocation) return toast('Location is not available on this device.', 'error');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        setLocating(false);
        toast('Could not read your location. Pick a job or enter coordinates.', 'error');
      },
      { enableHighAccuracy: false, timeout: 8000 },
    );
  };

  const resolvedCoords = useMemo(() => {
    if (mode === 'remote') return { lat: null, lng: null };
    if (mode === 'job') {
      const j = jobs.find((x) => x.id === jobId);
      return j ? { lat: j.latitude, lng: j.longitude } : { lat: null, lng: null };
    }
    if (mode === 'manual') {
      const lat = Number(latText);
      const lng = Number(lngText);
      return latText.trim() !== '' && lngText.trim() !== '' && Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat, lng }
        : { lat: null, lng: null };
    }
    return coords ?? { lat: null, lng: null };
  }, [mode, jobs, jobId, latText, lngText, coords]);

  const runSearch = useCallback(async () => {
    const rate = parseRateToCents(ceiling);
    if (rate !== null && !Number.isFinite(rate)) return toast('Enter a valid price ceiling.', 'error');
    const radiusNum = Number(radius);
    if (!Number.isInteger(radiusNum) || radiusNum < 1 || radiusNum > 500) return toast('Radius must be 1–500 miles.', 'error');

    const params: SearchParams = {
      requirements,
      lat: resolvedCoords.lat,
      lng: resolvedCoords.lng,
      urgency,
      trade: trade === '' ? null : trade,
      maxRadiusMiles: radiusNum,
      maxHourlyRateCents: rate,
      requiresInsurance: insurance,
      remote: mode === 'remote',
      includeOwnTeam: ownTeam,
      limit: 10,
    };
    const problem = validateSearch(params);
    if (problem) return toast(problem, 'error');

    setBusy(true);
    setOfferFor(null);
    try {
      setResults(await skillMarketApi.search(params));
      setSearched(params);
      setOpenId(null);
    } catch (e) {
      toast(describeMarketError(e), 'error');
    } finally {
      setBusy(false);
    }
  }, [ceiling, radius, requirements, resolvedCoords, urgency, trade, insurance, mode, ownTeam, toast]);

  const startOffer = (c: MarketCandidate) => {
    setOfferFor(c);
    setTitle(requirements.map((r) => r.label).join(' + ').slice(0, 120));
    setSummary('');
    setOfferRate(c.hourly_rate_cents === null ? '' : String(c.hourly_rate_cents / 100));
  };

  const sendOffer = async () => {
    if (!offerFor || !searched) return;
    const rate = parseRateToCents(offerRate);
    if (rate !== null && !Number.isFinite(rate)) return toast('Enter a valid rate.', 'error');
    if (title.trim().length < 3) return toast('Give the request a title.', 'error');
    setSending(true);
    try {
      await skillMarketApi.sendOffer({
        technicianId: offerFor.candidate_ref,
        title: title.trim(),
        summary: summary.trim(),
        urgency: searched.urgency,
        requirements: searched.requirements,
        matchScore: offerFor.score,
        matchBreakdown: offerFor.breakdown,
        offeredRateCents: rate,
        remote: searched.remote,
      });
      toast('Request sent. You will be notified when they respond.', 'success');
      setResults((cur) => (cur ? cur.filter((x) => x.candidate_ref !== offerFor.candidate_ref) : cur));
      setOfferFor(null);
      onOfferSent();
    } catch (e) {
      toast(describeMarketError(e), 'error');
    } finally {
      setSending(false);
    }
  };

  const levelOptions = [1, 2, 3, 4, 5];

  return (
    <div className="space-y-6">
      <section className="space-y-5 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Job requirements">
        <div>
          <h2 className="text-base font-semibold text-text-primary">What does the job need?</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Only technicians whose <em>verified job history</em> meets every requirement are considered — across the whole
            Vireek network.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="sm-level" className="mb-1.5 block text-sm font-medium text-text-primary">
              Minimum level
            </label>
            <select id="sm-level" value={level} onChange={(e) => setLevel(Number(e.target.value))} className={selectClass}>
              {levelOptions.map((l) => (
                <option key={l} value={l}>
                  Level {l} · {LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sm-equip" className="mb-1.5 block text-sm font-medium text-text-primary">
              Equipment
            </label>
            <select
              id="sm-equip"
              value=""
              onChange={(e) => {
                addPreset('equipment', e.target.value);
                e.target.value = '';
              }}
              className={selectClass}
            >
              <option value="">Add equipment…</option>
              {EQUIPMENT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sm-service" className="mb-1.5 block text-sm font-medium text-text-primary">
              Diagnostic skill
            </label>
            <select
              id="sm-service"
              value=""
              onChange={(e) => {
                addPreset('service', e.target.value);
                e.target.value = '';
              }}
              className={selectClass}
            >
              <option value="">Add skill…</option>
              {SERVICE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[10rem]">
            <label htmlFor="sm-ckind" className="mb-1.5 block text-sm font-medium text-text-primary">
              Custom type
            </label>
            <select id="sm-ckind" value={customKind} onChange={(e) => setCustomKind(e.target.value as RequirementKind)} className={selectClass}>
              <option value="equipment">Equipment</option>
              <option value="service">Skill / service</option>
            </select>
          </div>
          <div className="min-w-[14rem] flex-1">
            <Input
              label="Custom keywords"
              value={customText}
              maxLength={60}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustom();
                }
              }}
              helperText="Matched against job history, e.g. “daikin vrv”."
            />
          </div>
          <Button variant="secondary" size="md" onClick={addCustom} disabled={customText.trim() === ''}>
            <Plus size={16} /> Add
          </Button>
        </div>

        {requirements.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Selected requirements">
            {requirements.map((r, i) => (
              <li key={`${r.label}-${i}`} className="flex items-center gap-2 rounded-full border border-border bg-bg-primary py-1 pl-3 pr-1 text-sm text-text-primary">
                <span>
                  {r.label} · L{r.minLevel}+
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${r.label}`}
                  onClick={() => setRequirements((cur) => cur.filter((_, idx) => idx !== i))}
                  className="focus-ring rounded-full p-1 text-text-secondary hover:text-text-primary"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
          <div>
            <label htmlFor="sm-mode" className="mb-1.5 block text-sm font-medium text-text-primary">
              Job location
            </label>
            <select id="sm-mode" value={mode} onChange={(e) => setMode(e.target.value as LocationMode)} className={selectClass}>
              <option value="device">My current location</option>
              <option value="job">One of my open jobs</option>
              <option value="manual">Enter coordinates</option>
              <option value="remote">Remote diagnosis (no travel)</option>
            </select>
          </div>
          <div>
            <label htmlFor="sm-urgency" className="mb-1.5 block text-sm font-medium text-text-primary">
              Urgency
            </label>
            <select id="sm-urgency" value={urgency} onChange={(e) => setUrgency(e.target.value as Urgency)} className={selectClass}>
              {(Object.keys(URGENCY_META) as Urgency[]).map((u) => (
                <option key={u} value={u}>
                  {URGENCY_META[u].label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-secondary">{URGENCY_META[urgency].hint}</p>
          </div>

          {mode === 'device' && (
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button variant="secondary" size="sm" onClick={locate} disabled={locating}>
                {locating ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />}
                {coords ? 'Update location' : 'Use my location'}
              </Button>
              {coords && <span className="text-xs text-text-secondary">Location set (never shared with other companies).</span>}
            </div>
          )}
          {mode === 'job' && (
            <div className="sm:col-span-2">
              <label htmlFor="sm-job" className="mb-1.5 block text-sm font-medium text-text-primary">
                Open job
              </label>
              <select id="sm-job" value={jobId} onChange={(e) => setJobId(e.target.value)} className={selectClass}>
                <option value="">{jobs.length === 0 ? 'No geocoded open jobs' : 'Choose a job…'}</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {(j.service_type ?? 'Job') + (j.address ? ` — ${j.address}` : '')}
                  </option>
                ))}
              </select>
            </div>
          )}
          {mode === 'manual' && (
            <>
              <Input label="Latitude" inputMode="decimal" value={latText} onChange={(e) => setLatText(e.target.value)} />
              <Input label="Longitude" inputMode="decimal" value={lngText} onChange={(e) => setLngText(e.target.value)} />
            </>
          )}

          <div>
            <label htmlFor="sm-trade" className="mb-1.5 block text-sm font-medium text-text-primary">
              Trade
            </label>
            <select id="sm-trade" value={trade} onChange={(e) => setTrade(e.target.value as MarketTrade | '')} className={selectClass}>
              <option value="">Any trade</option>
              {TRADE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <Input label="Max distance (miles)" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} disabled={mode === 'remote'} />
          <Input label="Price ceiling ($/h, optional)" inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
          <div className="flex flex-col justify-end gap-2 text-sm text-text-primary">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={insurance} onChange={(e) => setInsurance(e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
              Require verified insurance
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ownTeam} onChange={(e) => setOwnTeam(e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
              Include my own team in the ranking
            </label>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void runSearch()} disabled={busy || requirements.length === 0}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Find best match
          </Button>
        </div>
      </section>

      {results !== null && results.length === 0 && (
        <EmptyState
          icon={Search}
          title="No verified match yet"
          description="No opted-in technician meets every requirement within range. Lower the minimum level, widen the distance, or try remote diagnosis."
        />
      )}

      {results !== null && results.length > 0 && (
        <ol className="space-y-4" aria-label="Ranked technicians">
          {results.map((c, idx) => {
            const tone = scoreTone(c.score);
            const expanded = openId === c.candidate_ref;
            return (
              <li key={c.candidate_ref} className="space-y-4 rounded-xl border border-border bg-bg-secondary p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">#{idx + 1}</p>
                    <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-text-primary">
                      {c.is_own_team ? (c.display_name ?? c.alias) : c.alias}
                      {c.is_own_team && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">Your team</span>}
                      {c.tier && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs capitalize text-text-secondary">{c.tier}</span>}
                    </h3>
                    <p className="text-sm text-text-secondary">
                      {c.company_name}
                      {c.distance_miles !== null ? ` · ${c.distance_miles} mi` : ' · remote'}
                      {` · ${formatRate(c.hourly_rate_cents)}`}
                    </p>
                  </div>
                  <div className={`rounded-xl px-4 py-2 text-center ${toneClass[tone]}`} aria-label={`Match score ${c.score} out of 100`}>
                    <p className="text-2xl font-bold leading-none">{Math.round(c.score)}</p>
                    <p className="text-[11px] uppercase tracking-wide">match</p>
                  </div>
                </div>

                <ul className="flex flex-wrap gap-2 text-sm text-text-primary">
                  {c.matched_skills.map((m) => (
                    <li key={m.label} className="flex items-center gap-1.5 rounded-full border border-border bg-bg-primary px-3 py-1">
                      <BadgeCheck size={14} className="text-success-500" />
                      {m.label} · L{m.level} · {m.confidence}% · {m.jobs} jobs
                    </li>
                  ))}
                  {c.valid_insurance && (
                    <li className="flex items-center gap-1.5 rounded-full border border-border bg-bg-primary px-3 py-1">
                      <ShieldCheck size={14} className="text-success-500" /> Insured
                    </li>
                  )}
                </ul>

                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-text-secondary">First-time fix</dt>
                    <dd className="font-medium text-text-primary">{c.first_time_fix_rate === null ? '—' : `${c.first_time_fix_rate}%`}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-secondary">Rating</dt>
                    <dd className="font-medium text-text-primary">{c.rating_avg === null ? '—' : `${c.rating_avg} / 5`}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-secondary">Availability</dt>
                    <dd className="font-medium text-text-primary">
                      {c.availability === 'open' && c.capacity_left > 0 ? `Open · ${c.capacity_left} slots today` : c.availability === 'busy' ? 'Busy' : 'Full today'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-secondary">In-network jobs</dt>
                    <dd className="font-medium text-text-primary">
                      {c.network_jobs === 0 ? 'New to network' : `${c.network_jobs} · ${c.network_resolved_rate ?? 0}% resolved`}
                    </dd>
                  </div>
                </dl>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setOpenId(expanded ? null : c.candidate_ref)}
                    aria-expanded={expanded}
                    className="focus-ring rounded text-sm font-medium text-accent hover:underline"
                  >
                    {expanded ? 'Hide' : 'Why this ranking?'}
                  </button>
                  {c.is_own_team ? (
                    <Link to="/dashboard/dispatch" className="focus-ring rounded text-sm font-medium text-accent hover:underline">
                      Assign from Dispatch Board
                    </Link>
                  ) : (
                    <Button size="sm" onClick={() => startOffer(c)} disabled={offerFor?.candidate_ref === c.candidate_ref}>
                      <Send size={14} /> Request technician
                    </Button>
                  )}
                </div>

                {expanded && (
                  <div className="space-y-2 rounded-xl border border-border bg-bg-primary p-4">
                    {breakdownEntries(c.breakdown).map((e) => (
                      <div key={e.key} className="grid grid-cols-[10rem_1fr_2.5rem] items-center gap-3 text-sm">
                        <span className="text-text-secondary">{e.label}</span>
                        <span className="h-2 overflow-hidden rounded-full bg-bg-tertiary" role="presentation">
                          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, e.value))}%` }} />
                        </span>
                        <span className="text-right font-medium text-text-primary">{e.value}</span>
                      </div>
                    ))}
                    {c.evidence_refreshed_at && (
                      <p className="pt-1 text-xs text-text-secondary">
                        Evidence refreshed {new Date(c.evidence_refreshed_at).toLocaleString()}. Levels come from completed jobs, never self-reported.
                      </p>
                    )}
                  </div>
                )}

                {offerFor?.candidate_ref === c.candidate_ref && (
                  <div className="space-y-4 rounded-xl border border-border bg-bg-primary p-4">
                    <Input label="Request title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
                    <Textarea
                      label="Details (optional)"
                      rows={3}
                      maxLength={600}
                      value={summary}
                      onChange={(e) => setSummary(e.target.value)}
                      helperText="No phone numbers or e-mails — contact details are shared automatically after they accept."
                    />
                    <Input label="Offered rate ($/h, optional)" inputMode="decimal" value={offerRate} onChange={(e) => setOfferRate(e.target.value)} />
                    <div className="flex justify-end gap-3">
                      <Button variant="ghost" size="sm" onClick={() => setOfferFor(null)} disabled={sending}>
                        Cancel
                      </Button>
                      <Button size="sm" onClick={() => void sendOffer()} disabled={sending}>
                        {sending && <Loader2 size={14} className="animate-spin" />}
                        Send request
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
