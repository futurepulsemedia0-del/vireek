import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Play, TriangleAlert, Volume2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useSoundIdentity } from '@/lib/useSoundIdentity';
import { SOUND_CUES, SOUND_EVENTS, type SoundEvent } from '@/lib/soundIdentity';
import { generateHoldWav, type HoldStyle } from '@/lib/holdAudio';
import { buildIvrScript, validateIvrMenu } from '@/lib/ivrStandards';
import { A2P_CHECKLIST, a2pSampleMessages, buildVoicemailEmail, checklistProgress, validateCnam } from '@/lib/telephonyBrand';
import { resolveOverrideBody, validateOverride } from '@/lib/voiceScriptOverrides';
import {
  deleteScriptOverride, fetchLatencySummary, fetchScriptOverrides, saveScriptOverride, seedVoiceEvalSuite,
} from '@/lib/voiceBrandApi';
import { FORBIDDEN_PHRASES, PERSONA_VERSION, TRADE_KEYS, TRADE_TONES, TURN_LIMITS, buildVoicePersonaContext, type TradeKey } from '../../supabase/functions/_shared/voice-brand/persona';
import { SCRIPT_LIBRARY, renderScript, smsSegments } from '../../supabase/functions/_shared/voice-brand/scripts';
import { LATENCY_BUDGET } from '../../supabase/functions/_shared/voice-brand/styleCheck';

const TABS = [
  { key: 'persona', label: 'Persona' },
  { key: 'scripts', label: 'Scripts' },
  { key: 'sounds', label: 'Sounds' },
  { key: 'audio', label: 'Hold & IVR' },
  { key: 'telephony', label: 'Telephony' },
  { key: 'quality', label: 'Quality' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const SAMPLE = {
  business_name: 'Your Business', assistant_name: 'Sarah', callback_number: 'five five five, oh one two three', holiday_name: 'New Year',
  appointment_time: 'Tuesday at 2 PM', tech_name: 'Alex', eta_window: 'between 2 and 3 PM',
};
const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const hint = 'text-sm text-text-secondary';

function LegalNote({ children }: { children: string }) {
  return (
    <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-500/10 p-3 text-xs text-warning-500">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" /> <span>{children}</span>
    </p>
  );
}

function PersonaTab() {
  const [trade, setTrade] = useState<TradeKey>('general');
  const ctx = useMemo(() => buildVoicePersonaContext({ trade }), [trade]);
  return (
    <div className="space-y-4">
      <div className={card}>
        <label htmlFor="vb-trade" className="mb-1.5 block text-sm font-medium text-text-primary">Trade tone</label>
        <select id="vb-trade" value={trade} onChange={(e) => setTrade(e.target.value as TradeKey)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary sm:w-72">
          {TRADE_KEYS.map((k) => <option key={k} value={k}>{TRADE_TONES[k].label}</option>)}
        </select>
        <p className={`mt-3 ${hint}`}>{TRADE_TONES[trade].tone}</p>
        <p className={`mt-1 ${hint}`}>Per-turn limits: {TURN_LIMITS.maxWords} words, {TURN_LIMITS.maxSentences} sentences, {TURN_LIMITS.maxQuestions} question.</p>
      </div>
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">What Sarah receives (v{PERSONA_VERSION})</h2>
        <p className="mt-1 text-xs text-text-secondary">Injected as the {'{{voice_persona}}'} variable in the live voice prompt.</p>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-bg-primary p-3 text-xs text-text-secondary">{ctx}</pre>
      </div>
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">Never said</h2>
        <ul className="mt-2 space-y-1 text-sm text-text-secondary">
          {FORBIDDEN_PHRASES.map((f) => <li key={f.id}>• {f.reason}</li>)}
        </ul>
        <LegalNote>AI-disclosure, emergency (911) and no-guarantee wording are safe defaults, not legal advice. Have counsel review them.</LegalNote>
      </div>
    </div>
  );
}

function ScriptsTab({ ownerId, userId, canEdit }: { ownerId: string; userId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setOverrides(await fetchScriptOverrides(ownerId)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load scripts.'); }
    setLoading(false);
  }, [ownerId]);
  useEffect(() => { void load(); }, [load]);

  async function save(id: string, body: string) {
    setBusy(id);
    try { await saveScriptOverride(ownerId, userId, id, body); setOverrides((o) => ({ ...o, [id]: body.trim() })); toast('Script saved', 'success'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error'); }
    setBusy(null);
  }
  async function reset(id: string) {
    setBusy(id);
    try { await deleteScriptOverride(ownerId, id); setOverrides((o) => { const n = { ...o }; delete n[id]; return n; }); setDrafts((d) => { const n = { ...d }; delete n[id]; return n; }); toast('Reset to default', 'success'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not reset', 'error'); }
    setBusy(null);
  }

  if (loading) return <div className={card} role="status"><Loader2 className="animate-spin" size={18} /> Loading scripts…</div>;
  if (error) return <div className={card} role="alert">{error} <Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button></div>;

  return (
    <div className="space-y-4">
      <p className={hint}>Greetings never include the AI disclosure; it is added automatically before them. Use merge fields like {'{{business_name}}'}.</p>
      {Object.values(SCRIPT_LIBRARY).map((t) => {
        const draft = drafts[t.id] ?? overrides[t.id] ?? t.variants[0];
        const check = validateOverride(t.id, draft);
        const preview = renderScript(t.id, SAMPLE, 0, check.ok ? draft : undefined).text;
        const active = resolveOverrideBody(t.id, overrides);
        const dirty = draft.trim() !== (overrides[t.id] ?? t.variants[0]).trim();
        return (
          <div key={t.id} className={card}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-text-primary">{t.id.replace(/_/g, ' ')}</h2>
              <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">{t.channel === 'sms' ? 'SMS' : 'Voice'}{active ? ' · custom' : ''}</span>
            </div>
            <Textarea label="Text" value={draft} disabled={!canEdit} rows={3} onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))} />
            <p className="mt-2 text-sm text-text-secondary">Preview: {preview}{t.channel === 'sms' ? ` (${smsSegments(preview).segments} segment)` : ''}</p>
            {dirty && !check.ok && <ul className="mt-2 space-y-1 text-xs text-danger" role="alert">{check.errors.map((m) => <li key={m}>• {m}</li>)}</ul>}
            {canEdit && (
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={!dirty || !check.ok || busy === t.id} onClick={() => void save(t.id, draft)}>Save</Button>
                {overrides[t.id] && <Button size="sm" variant="secondary" disabled={busy === t.id} onClick={() => void reset(t.id)}>Reset</Button>}
              </div>
            )}
          </div>
        );
      })}
      <LegalNote>Recording-consent wording and SMS opt-out text must be reviewed by counsel (TCPA, state recording laws).</LegalNote>
    </div>
  );
}

function SoundsTab() {
  const { prefs, setPrefs, play, lastCue } = useSoundIdentity();
  return (
    <div className="space-y-4">
      <div className={card}>
        <label className="flex items-center gap-3 text-sm font-medium text-text-primary">
          <input type="checkbox" checked={prefs.enabled} onChange={(e) => setPrefs({ ...prefs, enabled: e.target.checked })} className="h-5 w-5" />
          Play sounds inside the dashboard (off by default)
        </label>
        <label htmlFor="vb-volume" className="mt-4 block text-sm font-medium text-text-primary">Volume {Math.round(prefs.volume * 100)}%</label>
        <input id="vb-volume" type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => setPrefs({ ...prefs, volume: Number(e.target.value) })} className="w-full sm:w-72" />
        <p className={`mt-2 ${hint}`}>Browsers cannot read your system Focus or Do Not Disturb mode; mute here if you need silence. Sounds never play on public pages.</p>
      </div>
      <div className={card}>
        <ul className="divide-y divide-border">
          {SOUND_EVENTS.map((ev: SoundEvent) => (
            <li key={ev} className="flex flex-wrap items-center gap-3 py-3">
              <label className="flex flex-1 items-center gap-3 text-sm text-text-primary">
                <input type="checkbox" disabled={ev === 'logo'} checked={prefs.events[ev]} onChange={(e) => setPrefs({ ...prefs, events: { ...prefs.events, [ev]: e.target.checked } })} className="h-5 w-5" />
                <span>{SOUND_CUES[ev].label}<span className="block text-xs text-text-secondary">{SOUND_CUES[ev].caption}</span></span>
              </label>
              <Button size="sm" variant="secondary" onClick={() => void play(ev, { preview: true })} aria-label={`Preview ${SOUND_CUES[ev].label}`}><Play size={14} /> Preview</Button>
            </li>
          ))}
        </ul>
      </div>
      <div className={card} aria-live="polite" role="status">
        <p className="text-sm font-medium text-text-primary">Visual equivalent</p>
        <p className={`mt-1 ${hint}`}>{lastCue ? `${lastCue.label} — ${lastCue.caption}` : 'Every sound also shows a message here and in notifications.'}</p>
      </div>
    </div>
  );
}

function AudioTab() {
  const [style, setStyle] = useState<HoldStyle>('calm');
  const [duration, setDuration] = useState(30);
  const [url, setUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const urlRef = useRef<string | null>(null);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  function generate() {
    const wav = generateHoldWav({ style, durationSec: duration });
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const next = URL.createObjectURL(new Blob([wav.bytes], { type: 'audio/wav' }));
    urlRef.current = next;
    setUrl(next);
    setFileName(wav.fileName);
  }

  const [businessName, setBusinessName] = useState('');
  const [greeting, setGreeting] = useState('Thanks for calling. How can we help?');
  const [optionsText, setOptionsText] = useState('1|Emergency service\n2|Scheduling\n3|Billing\n0|Speak to someone');
  const menu = useMemo(() => ({
    businessName, greeting,
    options: optionsText.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [digit, ...rest] = l.split('|'); return { digit: (digit ?? '').trim(), label: rest.join('|').trim() }; }),
  }), [businessName, greeting, optionsText]);
  const verdict = useMemo(() => validateIvrMenu(menu), [menu]);

  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">Branded hold audio</h2>
        <p className={`mt-1 ${hint}`}>Original synthesized ambience: no third-party music, no licensing risk.</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="vb-style" className="mb-1.5 block text-sm font-medium text-text-primary">Style</label>
            <select id="vb-style" value={style} onChange={(e) => setStyle(e.target.value as HoldStyle)} className="focus-ring rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary">
              <option value="calm">Calm</option><option value="warm">Warm</option><option value="bright">Bright</option>
            </select>
          </div>
          <div className="w-32"><Input label="Seconds" type="number" min={10} max={120} value={duration} onChange={(e) => setDuration(Math.min(120, Math.max(10, Number(e.target.value) || 30)))} /></div>
          <Button size="sm" onClick={generate}><Volume2 size={14} /> Generate</Button>
        </div>
        {url && (
          <div className="mt-4 space-y-2">
            <audio controls loop src={url} className="w-full" />
            <p className="text-xs text-text-secondary">[Soft ambient pad, no voice. Loops seamlessly.]</p>
            <a href={url} download={fileName} className="focus-ring inline-flex items-center gap-2 text-sm font-medium text-accent"><Download size={14} /> Download {fileName}</a>
          </div>
        )}
      </div>
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">IVR wording check</h2>
        <div className="mt-3 space-y-3">
          <Input label="Business name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
          <Textarea label="Greeting" rows={2} value={greeting} onChange={(e) => setGreeting(e.target.value)} />
          <Textarea label="Options (one per line: key|label)" rows={5} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} />
        </div>
        <ul className="mt-3 space-y-1 text-sm" role="status">
          {verdict.issues.length === 0 && <li className="text-success-500">Meets the Vireek IVR standard.</li>}
          {verdict.issues.map((i, idx) => <li key={idx} className={i.severity === 'error' ? 'text-danger' : 'text-warning-500'}>{i.severity === 'error' ? 'Error' : 'Tip'}: {i.message}</li>)}
        </ul>
        <p className="mt-3 text-xs text-text-secondary">Spoken: {buildIvrScript(menu)}</p>
      </div>
    </div>
  );
}

function TelephonyTab() {
  const [name, setName] = useState('');
  const [done, setDone] = useState<Record<string, boolean>>({});
  const cnam = useMemo(() => validateCnam(name), [name]);
  const progress = checklistProgress(done);
  const samples = useMemo(() => a2pSampleMessages({ business_name: name.trim() || 'Your Business' }), [name]);
  const email = useMemo(() => buildVoicemailEmail({ businessName: name.trim() || 'Your Business', callerName: 'Jordan Lee', callerNumber: '+15550100', receivedAt: new Date(), durationSeconds: 42, transcript: 'Hi, my water heater is leaking. Please call me back.', listenUrl: 'https://example.com/voicemail/abc' }), [name]);
  return (
    <div className="space-y-4">
      <div className={card}>
        <Input label="Business name" value={name} onChange={(e) => setName(e.target.value)} />
        <p className="mt-3 text-sm text-text-primary">Caller-ID name (CNAM, max 15): <strong>{cnam.suggested || '—'}</strong></p>
        {name && cnam.issues.map((m) => <p key={m} className="text-xs text-warning-500">{m}</p>)}
        <p className={`mt-2 ${hint}`}>Display is carrier-dependent and not guaranteed on every network.</p>
      </div>
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">SMS / A2P registration checklist ({progress.done}/{progress.total})</h2>
        <ul className="mt-3 space-y-3">
          {A2P_CHECKLIST.map((i) => (
            <li key={i.id}>
              <label className="flex items-start gap-3 text-sm text-text-primary">
                <input type="checkbox" className="mt-0.5 h-5 w-5" checked={!!done[i.id]} onChange={(e) => setDone((d) => ({ ...d, [i.id]: e.target.checked }))} />
                <span>{i.title}{i.needsLegal ? ' · legal review' : ''}<span className="block text-xs text-text-secondary">{i.detail}</span></span>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-text-secondary">Progress on this page is not saved.</p>
        <h3 className="mt-4 text-sm font-semibold text-text-primary">Sample messages for registration</h3>
        <ul className="mt-2 space-y-1 text-xs text-text-secondary">{samples.map((s) => <li key={s}>• {s}</li>)}</ul>
        <LegalNote>Registration rules, wording and consent evidence must be confirmed with your SMS provider and legal counsel.</LegalNote>
      </div>
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">Voicemail transcription email (preview)</h2>
        <p className="mt-2 text-sm font-medium text-text-primary">{email.subject}</p>
        <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-bg-primary p-3 text-xs text-text-secondary">{email.text}</pre>
      </div>
    </div>
  );
}

function QualityTab({ ownerId, userId, canEdit }: { ownerId: string; userId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lat, setLat] = useState<{ calls: number; withinBudgetPct: number | null; avgP95: number | null } | null>(null);
  const [latError, setLatError] = useState<string | null>(null);
  useEffect(() => { fetchLatencySummary(ownerId).then(setLat).catch((e) => setLatError(e instanceof Error ? e.message : 'Could not load latency.')); }, [ownerId]);

  async function seed() {
    setBusy(true);
    try { const r = await seedVoiceEvalSuite(ownerId, userId); setSuiteId(r.suiteId); toast(r.created ? 'Voice eval suite created' : 'Suite already exists', 'success'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not create the suite', 'error'); }
    setBusy(false);
  }
  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">Golden voice evals</h2>
        <p className={`mt-1 ${hint}`}>Scores tone, brevity, disclosure and safety rules on Sarah's replies in the nightly AI Regression run.</p>
        {canEdit && <Button size="sm" className="mt-3" disabled={busy} onClick={() => void seed()}>{busy ? 'Creating…' : 'Create / find suite'}</Button>}
        {suiteId && <p className="mt-3 break-all text-xs text-text-secondary">Suite id: <code>{suiteId}</code> — save it as the GitHub secret AI_REGRESSION_VOICE_SUITE_ID.</p>}
      </div>
      <div className={card}>
        <h2 className="text-base font-semibold text-text-primary">Turn-taking latency (30 days)</h2>
        <p className={`mt-1 ${hint}`}>Budget: first audio p50 ≤ {LATENCY_BUDGET.firstAudioP50Ms} ms, p95 ≤ {LATENCY_BUDGET.firstAudioP95Ms} ms.</p>
        {latError && <p className="mt-2 text-sm text-danger" role="alert">{latError}</p>}
        {!latError && lat === null && <p className="mt-2 text-sm text-text-secondary" role="status">Loading…</p>}
        {lat && lat.calls === 0 && <p className="mt-2 text-sm text-text-secondary">No latency data yet. It appears after calls whose reports include turn metrics.</p>}
        {lat && lat.calls > 0 && <p className="mt-2 text-sm text-text-primary">{lat.calls} calls · {lat.withinBudgetPct}% within budget · avg p95 {lat.avgP95 ?? '—'} ms</p>}
      </div>
    </div>
  );
}

export function VoiceBrandPage() {
  const { profile, teamMember, isOwner } = useAuth();
  const [tab, setTab] = useState<TabKey>('persona');
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const userId = profile?.id ?? null;
  const canEdit = isOwner || (teamMember as { role?: string } | null)?.role === 'admin';

  return (
    <DashboardLayout activeLabel="Voice Brand">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Volume2 size={20} /></span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Voice Brand</h1>
            <p className="mt-1 text-sm text-text-secondary">One voice and sound identity across calls, texts, hold audio and notifications.</p>
          </div>
        </div>
        <div role="tablist" aria-label="Voice brand sections" className="mt-6 flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map((t) => (
            <button key={t.key} role="tab" id={`vb-tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`vb-panel-${t.key}`} onClick={() => setTab(t.key)}
              className={`focus-ring shrink-0 px-4 py-3 text-sm font-medium ${tab === t.key ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
          ))}
        </div>
        <div role="tabpanel" id={`vb-panel-${tab}`} aria-labelledby={`vb-tab-${tab}`} className="mt-6">
          {tab === 'persona' && <PersonaTab />}
          {tab === 'scripts' && (ownerId && userId ? <ScriptsTab ownerId={ownerId} userId={userId} canEdit={canEdit} /> : <p className={hint}>Sign in to manage scripts.</p>)}
          {tab === 'sounds' && <SoundsTab />}
          {tab === 'audio' && <AudioTab />}
          {tab === 'telephony' && <TelephonyTab />}
          {tab === 'quality' && (ownerId && userId ? <QualityTab ownerId={ownerId} userId={userId} canEdit={canEdit} /> : <p className={hint}>Sign in to view quality data.</p>)}
        </div>
      </div>
    </DashboardLayout>
  );
}
