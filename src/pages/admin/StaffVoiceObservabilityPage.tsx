// /staff/voice-observability — voice SLO dashboard + Call Inspector + inspector audit log (Vireek employees only).
// Data: obs_voice_dashboard(), inspector_search_calls(), inspector_get_call(), inspector_recent_audit() RPCs and the
// call-inspector edge function (20280402000000_voice_observability.sql). Every RPC re-checks profiles.is_staff on the
// server; every inspector read requires a reason and is written to the append-only audit log BEFORE data is returned.
// Staff-internal screen: English only, like StaffReliabilityPage.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { RefreshCw, ScrollText, PhoneCall, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import { FLAG_LABEL, TONE_CLASS, barPercent, fmtMs, fmtPct, latencyTone, rateTone, reasonValid } from '@/lib/observability/inspectorView';

type Tab = 'dashboard' | 'inspector' | 'audit';
type Group = 'region' | 'dial' | 'asr' | 'llm' | 'tts' | 'telephony' | 'all';

interface DashRow {
  g: string; calls: number; answer_rate: number | null; completion_rate: number | null; booking_success_rate: number | null;
  ttfw_p50_ms: number | null; ttfw_p95_ms: number | null; turn_p50_ms: number | null; turn_p95_ms: number | null; turn_p99_ms: number | null;
  tool_failure_rate: number | null; asr_confidence_avg: number | null; flagged_calls: number;
}
interface SearchRow {
  vapi_call_id: string; trace_id: string; region: string | null; created_at: string; duration_ms: number | null; ended_reason: string | null;
  answered: boolean; completed: boolean | null; turn_p95_ms: number | null; ttfw_ms: number | null; tool_failed: number; flags: string[];
}
interface TimelineEventView { t: number; kind: string; name: string; ok?: boolean; ms?: number }
interface CallDetail {
  tenant_id: string; trace_id: string; vapi_call_id: string; region: string | null; ended_reason: string | null; duration_ms: number | null; flags: string[];
  providers: { asr: string | null; llm: string | null; tts: string | null; telephony: string | null };
  timeline: { summary?: Record<string, number | null>; events?: TimelineEventView[]; truncated?: boolean };
  events: Array<{ at: string; kind: string; name: string; ok: boolean | null; ms: number | null; tool_call_id: string | null }>;
  quality_findings: Array<{ kind: string; severity: string; title: string; detail: string; status: string }>;
}
interface AuditRow { id: number; actor_id: string; action: string; vapi_call_id: string | null; reason: string; created_at: string }
interface ReplayView { wouldFlagNow: string[]; flaggedThen: string[]; newlyFlagged: string[]; noLongerFlagged: string[]; notReplayable: string[]; notes: string[] }

const GROUPS: Array<{ value: Group; label: string }> = [
  { value: 'region', label: 'Edge region' }, { value: 'dial', label: 'Dialed country code' }, { value: 'asr', label: 'ASR provider' }, { value: 'llm', label: 'LLM provider' },
  { value: 'tts', label: 'TTS provider' }, { value: 'telephony', label: 'Telephony provider' }, { value: 'all', label: 'All calls' },
];
const HOURS = [1, 6, 24, 72, 168];
const INPUT = 'w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring';

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function StaffVoiceObservabilityPage() {
  useSEO({ title: 'Voice observability — Staff', description: 'Internal: voice SLOs, call inspector and audit log.', canonical: 'https://vireek.com/staff/voice-observability' });
  const uid = useId();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [access, setAccess] = useState<'checking' | 'ok' | 'forbidden'>('checking');

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  // ---- dashboard
  const [group, setGroup] = useState<Group>('region');
  const [hours, setHours] = useState(24);
  const [rows, setRows] = useState<DashRow[]>([]);
  const [dashState, setDashState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dashError, setDashError] = useState('');

  const loadDash = useCallback(async () => {
    setDashState((s) => (s === 'ready' ? s : 'loading'));
    const { data, error } = await supabase.rpc('obs_voice_dashboard', { p_hours: hours, p_group: group });
    if (error) {
      setDashError(error.message);
      if (error.message.includes('forbidden')) setAccess('forbidden');
      setDashState('error');
      return;
    }
    setAccess('ok');
    setRows((data ?? []) as DashRow[]);
    setDashState('ready');
  }, [group, hours]);

  useEffect(() => {
    void loadDash();
    const id = window.setInterval(() => void loadDash(), 60_000);
    return () => window.clearInterval(id);
  }, [loadDash]);

  // ---- inspector
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'flagged' | 'failed' | 'slow'>('flagged');
  const [reason, setReason] = useState('');
  const [results, setResults] = useState<SearchRow[] | null>(null);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [transcript, setTranscript] = useState<{ sealed: boolean; lines: string[]; note: string } | null>(null);
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const ok = reasonValid(reason);

  const search = async () => {
    setBusy(true); setNotice(''); setDetail(null); setTranscript(null); setReplay(null);
    const { data, error } = await supabase.rpc('inspector_search_calls', { p_query: query.trim() || null, p_reason: reason.trim(), p_limit: 25, p_filter: filter });
    setBusy(false);
    if (error) { setNotice(error.message.includes('forbidden') ? 'You do not have access to the inspector.' : error.message); return; }
    setResults((data ?? []) as SearchRow[]);
  };

  const open = async (callId: string) => {
    setBusy(true); setNotice(''); setTranscript(null); setReplay(null);
    const { data, error } = await supabase.rpc('inspector_get_call', { p_vapi_call_id: callId, p_reason: reason.trim() });
    setBusy(false);
    if (error) { setNotice(error.message); return; }
    if (!data) { setNotice('No trace stored for this call.'); return; }
    setDetail(data as CallDetail);
  };

  const invoke = async (action: 'transcript' | 'replay') => {
    if (!detail) return;
    setBusy(true); setNotice('');
    const { data, error } = await supabase.functions.invoke('call-inspector', { body: { action, vapiCallId: detail.vapi_call_id, reason: reason.trim() } });
    setBusy(false);
    if (error) { setNotice(`${action} failed: ${error.message}`); return; }
    if (action === 'transcript') setTranscript(data as { sealed: boolean; lines: string[]; note: string });
    else setReplay((data as { replay: ReplayView }).replay);
  };

  // ---- audit
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  useEffect(() => {
    if (tab !== 'audit') return;
    void supabase.rpc('inspector_recent_audit', { p_limit: 100 }).then(({ data, error }) => {
      if (error) setNotice(error.message); else setAudit((data ?? []) as AuditRow[]);
    });
  }, [tab]);

  const maxMs = useMemo(() => Math.max(0, ...(detail?.timeline.events ?? []).map((e) => e.ms ?? 0)), [detail]);

  if (access === 'forbidden') {
    return (
      <div className="min-h-screen bg-bg-primary"><Header />
        <main className="mx-auto max-w-3xl px-6 pt-28"><h1 className="text-2xl font-bold text-text-primary">Not available</h1>
          <p className="mt-2 text-text-secondary">This screen is for Vireek staff.</p></main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary">
      <Header />
      <main className="mx-auto max-w-6xl px-6 pb-16 pt-28">
        <h1 className="text-2xl font-bold text-text-primary">Voice observability</h1>
        <p className="mt-1 text-sm text-text-secondary">Real-traffic SLIs from recorded calls. Synthetic probe calls are excluded; see Reliability for those.</p>

        <div role="tablist" aria-label="Voice observability sections" className="mt-6 flex gap-2">
          {(['dashboard', 'inspector', 'audit'] as Tab[]).map((t) => (
            <button key={t} role="tab" id={`${uid}-tab-${t}`} aria-selected={tab === t} aria-controls={`${uid}-panel-${t}`} tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              className={`focus-ring rounded-xl px-4 py-2 text-sm font-semibold ${tab === t ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}>
              {t === 'dashboard' ? 'SLO dashboard' : t === 'inspector' ? 'Call inspector' : 'Audit log'}
            </button>
          ))}
        </div>

        <div aria-live="polite" className="mt-3 min-h-[1.25rem] text-sm text-danger">{notice}</div>

        {tab === 'dashboard' && (
          <section role="tabpanel" id={`${uid}-panel-dashboard`} aria-labelledby={`${uid}-tab-dashboard`} className="mt-2">
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-sm text-text-secondary">Group by
                <select className={`${INPUT} mt-1`} value={group} onChange={(e) => setGroup(e.target.value as Group)}>
                  {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                </select></label>
              <label className="text-sm text-text-secondary">Window
                <select className={`${INPUT} mt-1`} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  {HOURS.map((h) => <option key={h} value={h}>{h < 24 ? `${h} h` : `${h / 24} d`}</option>)}
                </select></label>
              <Button variant="secondary" size="sm" onClick={() => void loadDash()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Refresh</Button>
            </div>

            {dashState === 'loading' && <p className="mt-6 text-text-secondary" aria-busy="true">Loading…</p>}
            {dashState === 'error' && <p className="mt-6 text-danger" role="alert">Could not load metrics: {dashError}</p>}
            {dashState === 'ready' && rows.length === 0 && <EmptyState icon={PhoneCall} title="No recorded calls in this window" description="Metrics appear after the first end-of-call report is processed." className="mt-6" />}
            {dashState === 'ready' && rows.length > 0 && (
              <div className="mt-6 overflow-x-auto rounded-2xl border border-border">
                <table className="w-full min-w-[960px] text-left text-sm">
                  <caption className="sr-only">Voice SLIs grouped by {group}</caption>
                  <thead className="bg-bg-secondary text-text-secondary">
                    <tr>{['Group', 'Calls', 'Answer', 'Completion', 'Booking', 'TTFW p50', 'TTFW p95', 'Turn p50', 'Turn p95', 'Turn p99', 'Tool fail', 'ASR conf', 'Flagged'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.g} className="border-t border-border">
                        <th scope="row" className="px-3 py-2 font-medium text-text-primary">{r.g}</th>
                        <td className="px-3 py-2">{r.calls}</td>
                        <td className={`px-3 py-2 ${TONE_CLASS[rateTone(r.answer_rate, 0.97, 0.9)]}`}>{fmtPct(r.answer_rate)}</td>
                        <td className={`px-3 py-2 ${TONE_CLASS[rateTone(r.completion_rate, 0.94, 0.9)]}`}>{fmtPct(r.completion_rate)}</td>
                        <td className={`px-3 py-2 ${TONE_CLASS[rateTone(r.booking_success_rate, 0.8, 0.7)]}`}>{fmtPct(r.booking_success_rate)}</td>
                        <td className="px-3 py-2">{fmtMs(r.ttfw_p50_ms)}</td>
                        <td className={`px-3 py-2 ${TONE_CLASS[latencyTone(r.ttfw_p95_ms)]}`}>{fmtMs(r.ttfw_p95_ms)}</td>
                        <td className="px-3 py-2">{fmtMs(r.turn_p50_ms)}</td>
                        <td className={`px-3 py-2 ${TONE_CLASS[latencyTone(r.turn_p95_ms)]}`}>{fmtMs(r.turn_p95_ms)}</td>
                        <td className={`px-3 py-2 ${TONE_CLASS[latencyTone(r.turn_p99_ms)]}`}>{fmtMs(r.turn_p99_ms)}</td>
                        <td className="px-3 py-2">{fmtPct(r.tool_failure_rate)}</td>
                        <td className="px-3 py-2">{r.asr_confidence_avg === null ? '—' : r.asr_confidence_avg.toFixed(2)}</td>
                        <td className="px-3 py-2">{r.flagged_calls}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {tab === 'inspector' && (
          <section role="tabpanel" id={`${uid}-panel-inspector`} aria-labelledby={`${uid}-tab-inspector`} className="mt-2 space-y-6">
            <p className="rounded-xl bg-warning-500/10 p-3 text-sm text-text-primary">
              Every search and every call you open is written to a permanent audit log with your name and the reason below. Do not copy customer data out of this screen.
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              <label className="text-sm text-text-secondary">Call ID or trace ID (optional)
                <input className={`${INPUT} mt-1`} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} /></label>
              <label className="text-sm text-text-secondary">Show
                <select className={`${INPUT} mt-1`} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                  <option value="flagged">Flagged bad calls</option><option value="failed">Failed or tool errors</option><option value="slow">Slow (p95 over 3 s)</option><option value="all">All recent</option>
                </select></label>
              <label className="text-sm text-text-secondary">Reason (required, 10+ characters)
                <input className={`${INPUT} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. support ticket 4521" maxLength={500} aria-invalid={reason.length > 0 && !ok} /></label>
            </div>
            <Button size="sm" disabled={!ok || busy} disabledReason={!ok ? 'Enter a reason of at least 10 characters' : undefined} loading={busy} onClick={() => void search()}>Search calls</Button>

            {results && results.length === 0 && <EmptyState icon={SearchX} variant="no-results" title="No matching calls" description="Try another filter or a wider search." />}
            {results && results.length > 0 && (
              <ul className="divide-y divide-border-primary rounded-2xl border border-border" aria-label="Matching calls">
                {results.map((r) => (
                  <li key={r.vapi_call_id}>
                    <button className="focus-ring flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-bg-secondary" onClick={() => void open(r.vapi_call_id)}>
                      <span className="font-mono text-xs text-text-primary">{r.vapi_call_id}</span>
                      <span className="text-xs text-text-secondary">{ago(r.created_at)} · {r.region ?? 'unknown'} · p95 {fmtMs(r.turn_p95_ms)} · {r.flags.map((f) => FLAG_LABEL[f] ?? f).join(', ') || 'no flags'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {detail && (
              <article aria-label="Call detail" className="space-y-5 rounded-2xl border border-border p-5">
                <header>
                  <h2 className="font-mono text-sm text-text-primary">{detail.vapi_call_id}</h2>
                  <p className="text-xs text-text-secondary">Trace {detail.trace_id} · tenant {detail.tenant_id} · {detail.region ?? 'unknown region'} · ended: {detail.ended_reason ?? 'unknown'} · {fmtMs(detail.duration_ms)}</p>
                  <p className="text-xs text-text-secondary">ASR {detail.providers.asr ?? '—'} · LLM {detail.providers.llm ?? '—'} · TTS {detail.providers.tts ?? '—'} · Telephony {detail.providers.telephony ?? '—'}</p>
                </header>
                {detail.flags.length > 0 && <p className="text-sm text-warning-500">Flags: {detail.flags.map((f) => FLAG_LABEL[f] ?? f).join(', ')}</p>}
                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  {([['Turns', detail.timeline.summary?.turnCount], ['Turn p50', fmtMs(detail.timeline.summary?.turnP50)], ['Turn p95', fmtMs(detail.timeline.summary?.turnP95)], ['Turn p99', fmtMs(detail.timeline.summary?.turnP99)],
                     ['Time to first word', fmtMs(detail.timeline.summary?.timeToFirstWordMs)], ['LLM TTFB p95', fmtMs(detail.timeline.summary?.llmTtfbP95)], ['TTS TTFB p95', fmtMs(detail.timeline.summary?.ttsTtfbP95)], ['ASR p95', fmtMs(detail.timeline.summary?.asrP95)],
                     ['Barge-ins', detail.timeline.summary?.interruptions], ['ASR confidence', detail.timeline.summary?.asrConfidenceAvg ?? '—'], ['Tool failures', detail.timeline.summary?.toolFailed], ['Tool retries', detail.timeline.summary?.toolRetried],
                     ['Jitter', detail.timeline.summary?.jitterMs ?? 'not supplied'], ['Packet loss %', detail.timeline.summary?.packetLossPct ?? 'not supplied'], ['MOS', detail.timeline.summary?.mos ?? 'not supplied']] as Array<[string, string | number | null | undefined]>).map(([k, v]) => (
                    <div key={k}><dt className="text-text-secondary">{k}</dt><dd className="font-semibold text-text-primary">{v ?? '—'}</dd></div>
                  ))}
                </dl>

                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Timeline{detail.timeline.truncated ? ' (compacted: failures and slowest events kept)' : ''}</h3>
                  {(detail.timeline.events ?? []).length === 0 ? <p className="mt-1 text-sm text-text-secondary">Timeline expired (healthy calls keep the detailed timeline for 30 days; numbers stay).</p> : (
                    <ol className="mt-2 space-y-1">
                      {(detail.timeline.events ?? []).map((e, i) => (
                        <li key={`${e.t}-${i}`} className="flex items-center gap-3 text-xs">
                          <span className="w-16 shrink-0 text-text-secondary">{fmtMs(e.t)}</span>
                          <span className={`w-40 shrink-0 ${e.ok === false ? 'text-danger' : 'text-text-primary'}`}>{e.kind}: {e.name}{e.ok === false ? ' (failed)' : ''}</span>
                          <span className="h-2 flex-1 rounded bg-bg-tertiary" aria-hidden="true"><span className={`block h-2 rounded ${e.ok === false ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${barPercent(e.ms, maxMs)}%` }} /></span>
                          <span className="w-16 shrink-0 text-right text-text-secondary">{fmtMs(e.ms)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>

                {detail.events.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">Live events (tool calls, retries)</h3>
                    <ul className="mt-1 text-xs text-text-secondary">{detail.events.map((e, i) => <li key={i}>{ago(e.at)} · {e.kind} {e.name} · {e.ok === false ? 'FAILED' : 'ok'} · {fmtMs(e.ms)}{e.tool_call_id ? ` · ${e.tool_call_id}` : ''}</li>)}</ul>
                  </div>
                )}
                {detail.quality_findings.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">Quality findings</h3>
                    <ul className="mt-1 text-xs text-text-secondary">{detail.quality_findings.map((f, i) => <li key={i}>[{f.severity}] {f.title} — {f.detail} ({f.status})</li>)}</ul>
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void invoke('transcript')}>Load redacted transcript</Button>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void invoke('replay')}>Replay in sandbox</Button>
                </div>
                {transcript && (
                  <div>
                    <p className="text-xs text-text-secondary">{transcript.note}</p>
                    {!transcript.sealed && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-bg-secondary p-3 text-xs text-text-primary">{transcript.lines.join('\n')}</pre>}
                  </div>
                )}
                {replay && (
                  <div className="text-sm text-text-primary">
                    <p>Would flag now: {replay.wouldFlagNow.join(', ') || 'nothing'}. Flagged then: {replay.flaggedThen.join(', ') || 'nothing'}.</p>
                    {replay.newlyFlagged.length > 0 && <p className="text-warning-500">Newly flagged: {replay.newlyFlagged.join(', ')}</p>}
                    {replay.noLongerFlagged.length > 0 && <p className="text-success-500">No longer flagged: {replay.noLongerFlagged.join(', ')}</p>}
                    <p className="text-xs text-text-secondary">Cannot be replayed from numbers alone: {replay.notReplayable.join(', ')}. {replay.notes.join(' ')}</p>
                  </div>
                )}
              </article>
            )}
          </section>
        )}

        {tab === 'audit' && (
          <section role="tabpanel" id={`${uid}-panel-audit`} aria-labelledby={`${uid}-tab-audit`} className="mt-2">
            {audit === null ? <p className="text-text-secondary" aria-busy="true">Loading…</p> : audit.length === 0 ? <EmptyState icon={ScrollText} title="No inspector activity yet" description="Every search and every opened call will be listed here." /> : (
              <div className="overflow-x-auto rounded-2xl border border-border">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <caption className="sr-only">Most recent inspector access</caption>
                  <thead className="bg-bg-secondary text-text-secondary"><tr>{['When', 'Staff member', 'Action', 'Call', 'Reason'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                  <tbody>{audit.map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="px-3 py-2">{ago(a.created_at)}</td><td className="px-3 py-2 font-mono text-xs">{a.actor_id.slice(0, 8)}</td>
                      <td className="px-3 py-2">{a.action}</td><td className="px-3 py-2 font-mono text-xs">{a.vapi_call_id ?? '—'}</td><td className="px-3 py-2">{a.reason}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
