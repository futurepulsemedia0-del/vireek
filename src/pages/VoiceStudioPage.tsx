import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Mic, Play, Loader2, Plus, Trash2, Save } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { VoiceStudioExtras } from '@/components/voice-studio/VoiceStudioExtras';
import { CloneConsentCard } from '@/components/voice-studio/CloneConsentCard';
import { supabase } from '@/lib/supabase';
import {
  DEFAULT_TUNING, SCENARIOS, LIMITS, sanitizeTuning, tuningForScenario,
  type Scenario, type Tuning,
} from '../../supabase/functions/_shared/voice-studio/logic';
import {
  VOICE_CATALOG, getOwnerId, loadProfiles, previewVoice, saveProfile,
  type PreviewResult, type ScenarioProfile,
} from '@/lib/voiceStudio';

const DEFAULT_VOICE = 'sarah-warm-f-us';
const FALLBACK_GREETING = 'Thanks for calling. This is Sarah, an AI voice assistant. How can I help you today?';
const SCENARIO_LABEL: Record<Scenario, string> = { default: 'Standard', emergency: 'Emergency', sales: 'Sales' };
type Profiles = Record<Scenario, ScenarioProfile>;

function Slider(p: { id: string; label: string; min: number; max: number; step: number; value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <label htmlFor={p.id} className="mb-1 flex justify-between text-xs font-medium text-text-secondary">
        <span>{p.label}</span><span>{p.value}</span>
      </label>
      <input id={p.id} type="range" min={p.min} max={p.max} step={p.step} value={p.value}
        onChange={(e) => p.onChange(Number(e.target.value))} className="focus-ring w-full accent-accent" />
    </div>
  );
}

export function VoiceStudioPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<Scenario>('default');
  const [greeting, setGreeting] = useState(FALLBACK_GREETING);
  const [phone, setPhone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [saved, owner] = await Promise.all([loadProfiles(), getOwnerId()]);
        const { data: bp } = await supabase.from('business_profile').select('greeting_script').eq('user_id', owner).maybeSingle();
        if (!alive) return;
        const base = saved.default ?? { voiceKey: DEFAULT_VOICE, tuning: DEFAULT_TUNING };
        const next = {} as Profiles;
        for (const s of SCENARIOS) {
          next[s] = saved[s] ?? { voiceKey: base.voiceKey, tuning: tuningForScenario(base.tuning, s) };
        }
        setProfiles(next);
        if (bp?.greeting_script) setGreeting(bp.greeting_script);
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : 'Could not load Voice Studio.');
      }
    })();
    return () => { alive = false; };
  }, []);

  const cur = profiles?.[scenario];
  const patch = (p: Partial<ScenarioProfile>) =>
    setProfiles((prev) => (prev ? { ...prev, [scenario]: { ...prev[scenario], ...p } } : prev));
  const patchTuning = (p: Partial<Tuning>) => cur && patch({ tuning: { ...cur.tuning, ...p } });

  const onPreview = async () => {
    if (!cur) return;
    setBusy(true);
    try {
      const r = await previewVoice({ voiceKey: cur.voiceKey, text: greeting, tuning: cur.tuning, phone });
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = r.url;
      setResult(r);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Preview failed.', 'error');
    } finally { setBusy(false); }
  };

  const onSave = async () => {
    if (!cur) return;
    setSaving(true);
    try {
      await saveProfile(scenario, cur.voiceKey, sanitizeTuning(cur.tuning));
      toast('Voice settings saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally { setSaving(false); }
  };

  const card = 'rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark';

  return (
    <DashboardLayout activeLabel="Settings">
      <button type="button" onClick={() => navigate('/dashboard/settings/assistant')}
        className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to assistant settings
      </button>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Mic size={24} /></span>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Voice Studio</h1>
          <p className="text-sm text-text-secondary">Choose, tune and preview your AI receptionist's voice.</p>
        </div>
      </div>

      {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
      {!profiles && !loadError && <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" /> Loading…</p>}

      {cur && (
        <div className="space-y-6">
          <div className="flex gap-2" role="tablist" aria-label="Scenario">
            {SCENARIOS.map((s) => (
              <button key={s} type="button" role="tab" aria-selected={scenario === s} onClick={() => setScenario(s)}
                className={`focus-ring rounded-xl border px-3 py-1.5 text-sm ${scenario === s ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
                {SCENARIO_LABEL[s]}
              </button>
            ))}
          </div>

          <Card interactive={false} aria-labelledby="vs-lib">
            <h2 id="vs-lib" className="mb-3 text-sm font-semibold text-text-primary">Voice library</h2>
            <div role="radiogroup" aria-labelledby="vs-lib" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {VOICE_CATALOG.map((v) => (
                <button key={v.key} type="button" role="radio" aria-checked={cur.voiceKey === v.key} onClick={() => patch({ voiceKey: v.key })}
                  className={`focus-ring rounded-xl border p-3 text-left ${cur.voiceKey === v.key ? 'border-accent bg-accent/10' : 'border-border'}`}>
                  <span className="block text-sm font-medium text-text-primary">{v.name}</span>
                  <span className="block text-xs text-text-secondary">{v.tags.join(', ')} · {v.accent} · {v.gender}</span>
                </button>
              ))}
            </div>
          </Card>

          <section className={card} aria-labelledby="vs-tune">
            <h2 id="vs-tune" className="mb-3 text-sm font-semibold text-text-primary">Tuning — {SCENARIO_LABEL[scenario]}</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Slider id="vs-speed" label="Speed" min={0.7} max={1.2} step={0.05} value={cur.tuning.speed} onChange={(n) => patchTuning({ speed: n })} />
              <Slider id="vs-warmth" label="Warmth / energy" min={0} max={1} step={0.05} value={cur.tuning.warmth} onChange={(n) => patchTuning({ warmth: n })} />
              <Slider id="vs-pause" label="Pause (ms)" min={0} max={800} step={50} value={cur.tuning.pauseMs} onChange={(n) => patchTuning({ pauseMs: n })} />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-text-secondary">
              <label className="flex items-center gap-2">Formality
                <select value={cur.tuning.formality} onChange={(e) => patchTuning({ formality: e.target.value as Tuning['formality'] })}
                  className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1">
                  <option value="casual">Casual</option><option value="neutral">Neutral</option><option value="formal">Formal</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={cur.tuning.fillers} onChange={(e) => patchTuning({ fillers: e.target.checked })} /> Filler words
              </label>
            </div>
            <p className="mt-2 text-xs text-text-secondary">
              Speed, warmth, pause and pronunciation affect the preview. Formality and filler words are saved but only reach live calls after the Vapi sync ships.
            </p>

            <h3 className="mb-2 mt-5 text-xs font-semibold text-text-primary">Pronunciation (business, street and city names)</h3>
            {cur.tuning.pronunciations.map((p, i) => (
              <div key={i} className="mb-2 flex gap-2">
                <input aria-label="Written as" value={p.match} maxLength={LIMITS.maxMatch} placeholder="Puyallup"
                  onChange={(e) => patchTuning({ pronunciations: cur.tuning.pronunciations.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)) })}
                  className="focus-ring w-1/2 rounded-lg border border-border bg-bg-primary px-2 py-1 text-sm" />
                <input aria-label="Say it like" value={p.say} maxLength={LIMITS.maxSay} placeholder="pew-AL-up"
                  onChange={(e) => patchTuning({ pronunciations: cur.tuning.pronunciations.map((x, j) => (j === i ? { ...x, say: e.target.value } : x)) })}
                  className="focus-ring w-1/2 rounded-lg border border-border bg-bg-primary px-2 py-1 text-sm" />
                <button type="button" aria-label="Remove pronunciation" onClick={() => patchTuning({ pronunciations: cur.tuning.pronunciations.filter((_, j) => j !== i) })}
                  className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger"><Trash2 size={14} /></button>
              </div>
            ))}
            {cur.tuning.pronunciations.length < LIMITS.maxPronunciations && (
              <button type="button" onClick={() => patchTuning({ pronunciations: [...cur.tuning.pronunciations, { match: '', say: '' }] })}
                className="focus-ring flex items-center gap-1 text-xs text-accent"><Plus size={14} /> Add pronunciation</button>
            )}
          </section>

          <section className={card} aria-labelledby="vs-prev">
            <h2 id="vs-prev" className="mb-3 text-sm font-semibold text-text-primary">Preview</h2>
            <label htmlFor="vs-greeting" className="mb-1 block text-xs font-medium text-text-secondary">Greeting to speak</label>
            <textarea id="vs-greeting" rows={3} maxLength={LIMITS.maxText} value={greeting} onChange={(e) => setGreeting(e.target.value)}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary p-3 text-sm" />
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input type="checkbox" checked={phone} onChange={(e) => setPhone(e.target.checked)} /> Phone-line sound (8 kHz)
              </label>
              <button type="button" onClick={onPreview} disabled={busy || !greeting.trim()}
                className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Play preview
              </button>
              <button type="button" onClick={onSave} disabled={saving}
                className="focus-ring flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm text-text-primary disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
              </button>
            </div>
            {result && (
              <div className="mt-4" aria-live="polite">
                <audio controls autoPlay src={result.url} className="w-full" />
                <p className="mt-2 text-sm text-text-primary">{result.spoken}</p>
                <p className="mt-1 text-xs text-text-secondary">
                  Latency {result.latencyMs} ms{result.costCents !== null ? ` · ≈ ${result.costCents}¢ per preview` : ''}
                  {result.phone ? ' · phone-line simulation is approximate' : ''}
                </p>
              </div>
            )}
          </section>
        </div>
      )}
      {cur && (
        <div className="mt-6 space-y-6">
          <VoiceStudioExtras voiceKey={cur.voiceKey} tuning={cur.tuning} greeting={greeting} />
          <CloneConsentCard />
        </div>
      )}
    </DashboardLayout>
  );
}
