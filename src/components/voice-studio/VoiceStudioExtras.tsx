import { useEffect, useRef, useState } from 'react';
import { Loader2, Phone, Play, RefreshCw, Shuffle, Vote } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { VOICE_CATALOG, previewVoice } from '@/lib/voiceStudio';
import { castVote, sendTestCall, sessionVotes, syncVoice, type SyncResult } from '@/lib/voiceStudioApi';
import type { Tuning } from '../../../supabase/functions/_shared/voice-studio/logic';
import { makeSessionId, parseSessionId, seededOrder, tally } from '../../../supabase/functions/_shared/voice-studio/blind';

interface Props { voiceKey: string; tuning: Tuning; greeting: string }

const LABELS = ['A', 'B', 'C'];
const btn = 'focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50';

function randomCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
}

export function VoiceStudioExtras({ voiceKey, tuning, greeting }: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  const [picked, setPicked] = useState<number[]>([]);
  const [joinCode, setJoinCode] = useState('');
  const [session, setSession] = useState<string | null>(null);
  const [voted, setVoted] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [urls, setUrls] = useState<Record<string, string>>({});
  const urlsRef = useRef<string[]>([]);

  useEffect(() => () => urlsRef.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); } finally { setBusy(null); }
  };

  const idx = session ? parseSessionId(session, VOICE_CATALOG.length) : null;
  const order = session && idx ? seededOrder(idx.map((i) => VOICE_CATALOG[i].key), session) : [];
  const nameOf = (k: string) => VOICE_CATALOG.find((v) => v.key === k)?.name ?? k;

  const openSession = (code: string) => {
    if (!parseSessionId(code, VOICE_CATALOG.length)) { toast('That session code is not valid.', 'error'); return; }
    setSession(code); setVoted(false); setCounts({}); setUrls({});
  };

  const play = (label: string, key: string) => run(`play-${label}`, async () => {
    const r = await previewVoice({ voiceKey: key, text: greeting, tuning, phone: true });
    urlsRef.current.push(r.url);
    setUrls((u) => ({ ...u, [label]: r.url }));
  });

  const vote = (key: string) => run('vote', async () => {
    if (!session) return;
    await castVote(session, key);
    setVoted(true);
    setCounts(tally(await sessionVotes(session)));
  });

  return (
    <div className="space-y-6">
      <Card interactive={false} aria-labelledby="vs-live">
        <h2 id="vs-live" className="mb-1 text-sm font-semibold text-text-primary">Live calls</h2>
        <p className="mb-3 text-xs text-text-secondary">Send your saved Standard voice to the live assistant. Only the voice changes; your greeting and AI disclosure are never touched.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={busy !== null} onClick={() => run('check', async () => { setSync(await syncVoice(false)); setConfirmApply(false); })}>
            {busy === 'check' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check changes
          </button>
          {sync?.dryRun && (sync.current?.voiceId === sync.proposed?.voiceId
            ? <span className="self-center text-xs text-text-secondary">Live calls already use this voice.</span>
            : !confirmApply
              ? <button type="button" className={btn} onClick={() => setConfirmApply(true)}>Apply to live calls</button>
              : <button type="button" className={`${btn} border-accent text-accent`} disabled={busy !== null}
                  onClick={() => run('apply', async () => { const r = await syncVoice(true); setSync(r); setConfirmApply(false); toast(r.verified ? 'Live voice updated' : 'Applied, but could not be verified', r.verified ? 'success' : 'error'); })}>
                  {busy === 'apply' ? <Loader2 size={14} className="animate-spin" /> : null} Confirm: change the live voice
                </button>)}
        </div>
        {sync?.applied && <p className="mt-2 text-xs text-text-secondary" role="status">{sync.verified ? 'Verified on the live assistant.' : 'Applied; verification did not match. Check the assistant before relying on it.'}</p>}
      </Card>

      <Card interactive={false} aria-labelledby="vs-call">
        <h2 id="vs-call" className="mb-1 text-sm font-semibold text-text-primary">Test call</h2>
        <p className="mb-3 text-xs text-text-secondary">Rings the escalation phone number in your settings with this voice and tuning. Up to 5 calls a day.</p>
        <button type="button" className={btn} disabled={busy !== null}
          onClick={() => run('call', async () => { await sendTestCall(voiceKey, tuning); toast('Calling your phone now', 'success'); })}>
          {busy === 'call' ? <Loader2 size={14} className="animate-spin" /> : <Phone size={14} />} Call my phone
        </button>
      </Card>

      <Card interactive={false} aria-labelledby="vs-blind">
        <h2 id="vs-blind" className="mb-1 text-sm font-semibold text-text-primary">Blind test with your team</h2>
        <p className="mb-3 text-xs text-text-secondary">Same greeting, voices hidden behind letters. Share the session code so teammates hear the same order.</p>

        {!session && (
          <div className="space-y-3">
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-text-secondary">Pick 2 or 3 voices</legend>
              <div className="flex flex-wrap gap-3">
                {VOICE_CATALOG.map((v, i) => (
                  <label key={v.key} className="flex items-center gap-1.5 text-sm text-text-primary">
                    <input type="checkbox" checked={picked.includes(i)} disabled={!picked.includes(i) && picked.length >= 3}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, i] : p.filter((x) => x !== i)))} />
                    {v.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={btn} disabled={picked.length < 2} onClick={() => openSession(makeSessionId(randomCode(), picked))}>
                <Shuffle size={14} /> Start session
              </button>
              <input aria-label="Session code" placeholder="Join with a code" value={joinCode} onChange={(e) => setJoinCode(e.target.value.trim().toLowerCase())}
                className="focus-ring w-44 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs" />
              <button type="button" className={btn} disabled={!joinCode} onClick={() => openSession(joinCode)}>Join</button>
            </div>
          </div>
        )}

        {session && idx && (
          <div className="space-y-3">
            <p className="text-xs text-text-secondary">Session code: <span className="font-mono text-text-primary">{session}</span></p>
            <div className="grid gap-3 sm:grid-cols-3">
              {order.map((key, i) => (
                <div key={key} className="rounded-xl border border-border p-3">
                  <p className="mb-2 text-sm font-semibold text-text-primary">Voice {LABELS[i]}{voted ? ` — ${nameOf(key)}` : ''}</p>
                  <button type="button" className={btn} disabled={busy !== null} onClick={() => play(LABELS[i], key)}>
                    {busy === `play-${LABELS[i]}` ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Play
                  </button>
                  {urls[LABELS[i]] && <audio controls autoPlay src={urls[LABELS[i]]} className="mt-2 w-full" />}
                  {!voted && (
                    <button type="button" className={`${btn} mt-2`} disabled={busy !== null} onClick={() => vote(key)}>
                      <Vote size={14} /> Vote {LABELS[i]}
                    </button>
                  )}
                  {voted && <p className="mt-2 text-xs text-text-secondary">{counts[key] ?? 0} vote{(counts[key] ?? 0) === 1 ? '' : 's'}</p>}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              {voted && <button type="button" className={btn} onClick={() => run('tally', async () => setCounts(tally(await sessionVotes(session))))}><RefreshCw size={14} /> Refresh results</button>}
              <button type="button" className={btn} onClick={() => setSession(null)}>Leave session</button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
