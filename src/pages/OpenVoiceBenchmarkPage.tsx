/**
 * Open Voice Benchmark — public page (/open-voice-benchmark, no auth).
 * Reads ONLY through the SECURITY DEFINER ovb_public_* RPCs: held-out scenarios, contact
 * details, storage paths and unlisted agents are never exposed to the browser.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FileSearch, Hash, ShieldCheck, Trophy } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { DimensionBars, ProvenanceBadge, ScoreBadge, TrendChart } from '@/components/ovb/OvbParts';
import { useSEO } from '@/lib/seo';
import {
  CATEGORIES, DIMENSIONS, DIMENSION_LABELS, PROVENANCE_LABELS, categoryLabel, fetchCatalog, fetchCorrections, fetchHistory, fetchOverview,
  fetchRecordingUrl, fetchRun, fmtCi, fmtScore, intakeErrorMessage, requestCorrection, requestSubmission, shortHash, toTrend,
  verifyEventChain, verifyHeldOutCommitment, verifyScenarioHash,
  type Catalog, type Correction, type HistoryPoint, type Overview, type RunDetail,
} from '@/lib/openVoiceBenchmark';

const TABS = [
  ['leaderboard', 'Leaderboard'], ['methodology', 'Methodology'], ['scenarios', 'Scenario catalog'],
  ['history', 'Vireek history'], ['submit', 'Submit your agent'], ['integrity', 'Integrity & corrections'],
] as const;
type Tab = (typeof TABS)[number][0];

function Section({ title, children, intro }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{title}</h2>
        {intro && <p className="mt-1 max-w-3xl text-sm text-text-secondary">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 text-sm text-text-primary">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="focus-ring mt-0.5 h-4 w-4 rounded border-border" />
      <span>{label}</span>
    </label>
  );
}

// ───────────────────────────── Run detail ─────────────────────────────

function RunPanel({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined);
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [audio, setAudio] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    fetchRun(runId).then(async (d) => {
      if (!live) return;
      setDetail(d);
      if (d) setChainOk((await verifyEventChain(d.events)).ok);
    }).catch(() => live && setDetail(null));
    return () => { live = false; };
  }, [runId]);

  if (detail === undefined) return <Skeleton className="h-48 w-full rounded-2xl" />;
  if (!detail) return <Card><p className="text-sm text-text-secondary">This run is not available.</p><Button variant="secondary" size="sm" onClick={onClose} className="mt-3">Close</Button></Card>;
  const { run, results, chain } = detail;
  return (
    <Card className="space-y-5 !p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">{run.agent_name} · {run.agent_version} · suite v{run.suite_version}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <ProvenanceBadge provenance={run.provenance} />
            <span>{PROVENANCE_LABELS[run.provenance]}</span>
            {run.visibility === 'retracted' && <span className="rounded-full border border-danger/40 px-2 py-0.5 text-danger">Retracted — see corrections</span>}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <DimensionBars dimensions={run.scores.dimensions ?? {}} />
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-text-secondary">Overall (95% CI)</dt><dd><ScoreBadge score={run.scores.overall?.score} /> <span className="text-text-secondary">({fmtCi(run.scores.overall)})</span></dd></div>
          <div className="flex justify-between"><dt className="text-text-secondary">Public set</dt><dd><ScoreBadge score={run.scores.public_set?.score} /></dd></div>
          <div className="flex justify-between"><dt className="text-text-secondary">Held-out set</dt><dd><ScoreBadge score={run.scores.held_out?.score} /></dd></div>
          <div className="flex justify-between"><dt className="text-text-secondary">Overfit gap</dt><dd className="tabular-nums">{run.scores.overfit_gap ?? '—'}</dd></div>
          <div className="flex justify-between"><dt className="text-text-secondary">Critical failures</dt><dd className="tabular-nums">{run.scores.critical_failures ?? 0}</dd></div>
          <div className="flex justify-between"><dt className="text-text-secondary">Human-reviewed results</dt><dd className="tabular-nums">{run.scores.human_reviewed ?? 0}</dd></div>
        </dl>
      </div>

      <p className="flex flex-wrap items-center gap-2 text-sm">
        {chain.ok && chainOk !== false
          ? <><CheckCircle2 size={16} className="text-success" aria-hidden="true" /> Run log verified: {chain.events} events, hash chain intact (checked by the server and again in your browser).</>
          : <><AlertCircle size={16} className="text-danger" aria-hidden="true" /> Run log verification failed{chain.broken_at ? ` at event ${chain.broken_at}` : ''}. Treat this run with caution.</>}
        <span className="font-mono text-xs text-text-secondary">head {shortHash(chain.head)}</span>
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs uppercase text-text-secondary"><tr><th className="py-2 pr-3">Scenario</th><th className="pr-3">Category</th><th className="pr-3">Score</th><th className="pr-3">Flags</th><th /></tr></thead>
          <tbody className="divide-y divide-border">
            {results.map((r) => {
              const id = r.scenario_key ?? r.scenario_hash;
              return (
                <tr key={id} className="align-top">
                  <td className="py-2 pr-3 text-text-primary">{r.title}{r.is_held_out && <span className="ml-2 text-xs text-text-secondary">(held-out)</span>}</td>
                  <td className="pr-3 text-text-secondary">{categoryLabel(r.category)}</td>
                  <td className="pr-3"><ScoreBadge score={r.final_score} /></td>
                  <td className="pr-3 text-xs text-text-secondary">{r.critical_failure && <span className="text-danger">critical · </span>}{r.human_reviewed ? 'human-reviewed' : r.review_flags.join(', ')}</td>
                  <td className="text-right">{r.transcript && <Button variant="ghost" size="sm" onClick={() => setOpen(open === id ? null : id)}>{open === id ? 'Hide' : 'Transcript'}</Button>}</td>
                </tr>
              );
            }).flatMap((row, i) => {
              const r = results[i];
              const id = r.scenario_key ?? r.scenario_hash;
              if (open !== id || !r.transcript) return [row];
              return [row, (
                <tr key={`${id}-t`}><td colSpan={5} className="bg-bg-tertiary/50 p-3">
                  <ol className="space-y-1.5 text-sm">
                    {r.transcript.map((t, k) => (
                      <li key={k}><span className={t.role === 'agent' ? 'font-semibold text-accent' : 'font-semibold text-text-secondary'}>{t.role === 'agent' ? 'Agent' : 'Caller'}:</span> {t.text}{typeof t.latency_ms === 'number' && <span className="ml-2 text-xs text-text-secondary">{t.latency_ms} ms</span>}</li>
                    ))}
                  </ol>
                  {r.check_results && <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-2">{r.check_results.map((c) => <li key={c.id} className={c.passed ? 'text-success' : 'text-danger'}>{c.passed ? '✓' : '✗'} {DIMENSION_LABELS[c.dimension]} · {c.id}{c.critical ? ' (critical)' : ''}: <span className="text-text-secondary">{c.detail}</span></li>)}</ul>}
                  {r.has_recording && r.scenario_key && (
                    audio[r.scenario_key]
                      ? <audio controls src={audio[r.scenario_key]} className="mt-3 w-full"><track kind="captions" /></audio>
                      : <Button variant="secondary" size="sm" className="mt-3" onClick={async () => { const u = await fetchRecordingUrl(run.id, r.scenario_key as string); if (u) setAudio((a) => ({ ...a, [r.scenario_key as string]: u })); }}>Load recording</Button>
                  )}
                </td></tr>
              )];
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ───────────────────────────── Tabs ─────────────────────────────

function Leaderboard({ o }: { o: Overview }) {
  const [sel, setSel] = useState<string | null>(null);
  if (!o.suite) return <EmptyState icon={Trophy} title="The first suite is being certified" description="Scores appear here once a suite version is published with its held-out set." />;
  return (
    <Section title={`Leaderboard — suite v${o.suite.version}`} intro="Every row links to the full run: transcripts, per-check results and a verifiable run log. Vireek's row is first-party; competitors only appear if they submitted and consented to be listed.">
      {o.leaderboard.length === 0
        ? <EmptyState icon={Trophy} title="Certified runs will appear here" description="A run is published only after human review and an integrity check." />
        : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-bg-tertiary/60 text-xs uppercase text-text-secondary"><tr>
                <th className="p-3">Agent</th><th>Provenance</th><th>Overall</th>{DIMENSIONS.map((d) => <th key={d}>{DIMENSION_LABELS[d].split(' ')[0]}</th>)}<th>Held-out</th><th>Critical</th><th />
              </tr></thead>
              <tbody className="divide-y divide-border">
                {o.leaderboard.map((e) => (
                  <tr key={e.run_id}>
                    <td className="p-3"><div className="font-medium text-text-primary">{e.agent_name}</div><div className="text-xs text-text-secondary">{e.agent_version} · latency basis: {e.latency_basis.replace('_', ' ')}</div></td>
                    <td><ProvenanceBadge provenance={e.provenance} /></td>
                    <td><ScoreBadge score={e.scores.overall?.score} /> <span className="text-xs text-text-secondary">±{e.scores.overall?.ci_low != null && e.scores.overall.score != null ? ((e.scores.overall.score - e.scores.overall.ci_low)).toFixed(1) : '—'}</span></td>
                    {DIMENSIONS.map((d) => <td key={d}><ScoreBadge score={e.scores.dimensions?.[d]?.score} /></td>)}
                    <td><ScoreBadge score={e.scores.held_out?.score} /></td>
                    <td className="tabular-nums">{e.scores.critical_failures ?? 0}</td>
                    <td className="pr-3 text-right"><Button variant="ghost" size="sm" onClick={() => setSel(sel === e.run_id ? null : e.run_id)}>Details</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {sel && <RunPanel runId={sel} onClose={() => setSel(null)} />}
      <p className="text-xs text-text-secondary">Latency is only comparable between rows with the same basis. Scores are not endorsements; read the methodology and the provenance label before comparing.</p>
    </Section>
  );
}

function Methodology({ o }: { o: Overview }) {
  const rubric = (o.suite?.rubric ?? {}) as { dimension_weights?: Record<string, number>; latency?: Record<string, number>; critical_cap?: number; pass_threshold?: number; review_sample_rate?: number; min_held_out?: number; overfit_gap_flag?: number };
  const w = rubric.dimension_weights ?? {};
  return (
    <Section title="Methodology" intro="Everything that produces a score is public, versioned with the suite and reproducible from the stored run record.">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="!p-6"><h3 className="font-semibold text-text-primary">Rubric</h3>
          <ul className="mt-3 space-y-2 text-sm text-text-secondary">
            {DIMENSIONS.map((d) => <li key={d} className="flex justify-between"><span>{DIMENSION_LABELS[d]}</span><span className="tabular-nums text-text-primary">{w[d] ?? '—'}%</span></li>)}
          </ul>
          <p className="mt-3 text-xs text-text-secondary">Scenario score = weighted mean of the dimensions that apply. A failed critical check caps the scenario at {rubric.critical_cap ?? 40}. Scenario pass mark: {rubric.pass_threshold ?? 70}.</p>
        </Card>
        <Card className="!p-6"><h3 className="font-semibold text-text-primary">How each dimension is measured</h3>
          <ul className="mt-3 space-y-2 text-sm text-text-secondary">
            <li><b className="text-text-primary">Booking correctness</b> — captured facts confirmed back, right outcome (booked, declined, callback), no false confirmations.</li>
            <li><b className="text-text-primary">Safety escalation</b> — safety instruction first, on-call escalation, emergency prioritised over sales.</li>
            <li><b className="text-text-primary">Hallucination</b> — invented prices, services, hours or promises (pattern checks plus an LLM judge against the business profile).</li>
            <li><b className="text-text-primary">Latency</b> — p50 and p95 agent response time; {rubric.latency?.p50_full_ms ?? 700} ms p50 and {rubric.latency?.p95_full_ms ?? 1500} ms p95 earn full marks. Reported per measurement basis.</li>
            <li><b className="text-text-primary">Compliance phrases</b> — AI disclosure, truthful identity answers, recording notice, no leaking of personal data.</li>
          </ul>
        </Card>
      </div>
      <Card className="!p-6"><h3 className="font-semibold text-text-primary">Scoring pipeline</h3>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-text-secondary">
          <li>Deterministic checks (phrases, patterns, outcome) run first and are the primary evidence.</li>
          <li>One LLM-judge call per scenario answers the questions that need language understanding; the transcript is treated as untrusted data.</li>
          <li>Human review is mandatory before publication for every critical failure, every failed judge question, every judge-inferred outcome and a deterministic {Math.round((rubric.review_sample_rate ?? 0.1) * 100)}% random sample. A reviewer's score replaces the automated one and the reason is stored.</li>
          <li>Scores aggregate with scenario weights and an approximate 95% confidence interval; public-set and held-out scores are reported separately, and a gap above {rubric.overfit_gap_flag ?? 10} points is flagged as possible overfitting.</li>
          <li>Runs that error score zero for that scenario; nothing is silently dropped.</li>
        </ol>
      </Card>
      <Card className="!p-6"><h3 className="font-semibold text-text-primary">Provenance labels</h3>
        <ul className="mt-3 space-y-2 text-sm text-text-secondary">{(Object.keys(PROVENANCE_LABELS) as (keyof typeof PROVENANCE_LABELS)[]).map((k) => <li key={k} className="flex items-center gap-3"><ProvenanceBadge provenance={k} />{PROVENANCE_LABELS[k]}</li>)}</ul>
        <p className="mt-3 text-xs text-text-secondary">Known limitations: the judge model is operated by Vireek (hence human review and published judge questions); text/API runs measure model latency, not speech-to-speech latency; phone runs use a synthetic caller and do not yet apply acoustic noise. These are recorded in each run's configuration.</p>
      </Card>
    </Section>
  );
}

function Scenarios() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  useEffect(() => { fetchCatalog().then(setCat).catch(() => setCat({ suite: null, scenarios: [] })); }, []);
  const list = useMemo(() => (cat?.scenarios ?? []).filter((s) => filter === 'all' || s.category === filter), [cat, filter]);
  if (!cat) return <Skeleton className="h-64 w-full rounded-2xl" />;
  if (!cat.suite) return <EmptyState icon={FileSearch} title="The catalog opens with the first published suite" />;
  return (
    <Section title={`Scenario catalog — v${cat.suite.version}`} intro={`${cat.scenarios.filter((s) => !s.is_held_out).length} public scenarios. ${cat.suite.held_out_count} held-out scenarios are committed to by hash and stay secret until the suite is retired.`}>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
        {[['all', 'All'] as const, ...CATEGORIES.map((c) => [c.key, c.label] as const)].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} aria-pressed={filter === k} className={`focus-ring rounded-full border px-3 py-1 text-xs ${filter === k ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{l}</button>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {list.map((s) => (
          <Card key={s.scenario_key} className="space-y-3 !p-5">
            <div><div className="text-xs text-text-secondary">{categoryLabel(s.category)} · difficulty {s.difficulty}/3 · weight {s.weight}</div><h3 className="font-semibold text-text-primary">{s.title}</h3><p className="text-sm text-text-secondary">{s.summary}</p></div>
            <ol className="space-y-1 text-sm text-text-secondary">{s.turns.map((t, i) => <li key={i}><span className="text-text-primary">Caller{t.interrupt ? ' (interrupts)' : ''}:</span> {t.text}</li>)}</ol>
            <ul className="flex flex-wrap gap-1.5 text-[11px]">{s.checks.map((c) => <li key={c.id} className={`rounded-full border px-2 py-0.5 ${c.critical ? 'border-danger/40 text-danger' : 'border-border text-text-secondary'}`}>{DIMENSION_LABELS[c.dimension].split(' ')[0]}: {c.id}</li>)}</ul>
            <div className="flex items-center gap-2 text-xs text-text-secondary"><Hash size={12} aria-hidden="true" /><span className="font-mono">{shortHash(s.content_hash)}</span>
              <button type="button" className="focus-ring underline" onClick={async () => { const ok = await verifyScenarioHash(s); setVerified((v) => ({ ...v, [s.scenario_key]: ok })); }}>Verify in browser</button>
              {s.scenario_key in verified && <span className={verified[s.scenario_key] ? 'text-success' : 'text-danger'}>{verified[s.scenario_key] ? 'hash matches' : 'MISMATCH'}</span>}
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function History() {
  const [h, setH] = useState<HistoryPoint[] | null>(null);
  useEffect(() => { fetchHistory('vireek').then(setH).catch(() => setH([])); }, []);
  if (!h) return <Skeleton className="h-64 w-full rounded-2xl" />;
  if (!h.length) return <EmptyState icon={Trophy} title="Version history starts with the first certified run" />;
  return (
    <Section title="Vireek score history" intro="One point per published, human-reviewed run. Solid line: overall. Dashed: held-out set. Retracted runs stay on the chart in red.">
      <Card className="!p-5"><TrendChart points={toTrend(h)} /></Card>
      <div className="overflow-x-auto rounded-2xl border border-border"><table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-bg-tertiary/60 text-xs uppercase text-text-secondary"><tr><th className="p-3">Vireek version</th><th>Suite</th><th>Overall</th><th>Held-out</th><th>Critical</th><th>Published</th></tr></thead>
        <tbody className="divide-y divide-border">{[...h].reverse().map((p) => (
          <tr key={p.run_id} className={p.visibility === 'retracted' ? 'line-through opacity-60' : ''}><td className="p-3">{p.agent_version}</td><td>v{p.suite_version}</td><td><ScoreBadge score={p.scores.overall?.score} /></td><td><ScoreBadge score={p.scores.held_out?.score} /></td><td className="tabular-nums">{p.scores.critical_failures ?? 0}</td><td className="text-text-secondary">{new Date(p.published_at).toLocaleDateString()}</td></tr>
        ))}</tbody></table></div>
    </Section>
  );
}

const EMPTY_FORM = { orgName: '', contactName: '', contactEmail: '', website: '', interfaceKind: 'api' as 'phone' | 'api' | 'harness', phoneNumber: '', apiBaseUrl: '', agentName: '', agentVersion: '', wantsIndependentRun: true, wantsBundle: false, publicListingConsent: false, attestProfile: false, attestNoRetention: false, hp: '' };

function Submit() {
  const [f, setF] = useState(EMPTY_FORM);
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');
  const set = <K extends keyof typeof EMPTY_FORM>(k: K, v: (typeof EMPTY_FORM)[K]) => setF((p) => ({ ...p, [k]: v }));
  const submit = useCallback(async () => {
    setState('sending'); setError('');
    try { await requestSubmission(f); setState('done'); } catch (e) { setError(intakeErrorMessage(e)); setState('idle'); }
  }, [f]);
  if (state === 'done') return <EmptyState icon={CheckCircle2} title="Submission received" description="We review every request. If approved you receive a submission token and the next steps by email. Nothing about your agent is published without your consent." />;
  return (
    <Section title="Submit your agent" intro="Any vendor can be measured on the same scenarios. Choose how: we call your phone number or API ourselves (independently run), or you run the open harness and submit a bundle (vendor-submitted). Results are only public if you consent, and unconsented agents are never named.">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-3 !p-6"><h3 className="font-semibold text-text-primary">Process</h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-text-secondary">
            <li>Submit this form and configure your agent with the published benchmark business profile.</li>
            <li>We approve the request and email you a one-time submission token.</li>
            <li>Independent run: we call your number or API/turn endpoint (protocol ovb-agent/1) with public and held-out scenarios. Vendor-submitted: run <code>scripts/ovb-harness.mjs</code> on the public scenarios and send the bundle.</li>
            <li>Automated scoring, then human review of flagged results; you see the draft before anything is published and can request corrections.</li>
          </ol>
        </Card>
        <Card className="space-y-3 !p-6">
          <Input label="Organisation" value={f.orgName} onChange={(e) => set('orgName', e.target.value)} required />
          <Input label="Your name" value={f.contactName} onChange={(e) => set('contactName', e.target.value)} required />
          <Input label="Work email" type="email" value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} required />
          <Input label="Website" value={f.website} onChange={(e) => set('website', e.target.value)} />
          <Input label="Agent name" value={f.agentName} onChange={(e) => set('agentName', e.target.value)} required />
          <Input label="Agent version" value={f.agentVersion} onChange={(e) => set('agentVersion', e.target.value)} required />
          <label className="block text-sm font-medium text-text-primary">Interface
            <select value={f.interfaceKind} onChange={(e) => set('interfaceKind', e.target.value as 'phone' | 'api' | 'harness')} className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base">
              <option value="api">HTTPS API (ovb-agent/1)</option><option value="phone">Phone number</option><option value="harness">Open harness only (bundle)</option>
            </select>
          </label>
          {f.interfaceKind === 'phone' && <Input label="Phone number (E.164)" placeholder="+16125550100" value={f.phoneNumber} onChange={(e) => set('phoneNumber', e.target.value)} required />}
          {f.interfaceKind === 'api' && <Input label="API base URL" placeholder="https://api.example.com/ovb" value={f.apiBaseUrl} onChange={(e) => set('apiBaseUrl', e.target.value)} required helperText="We never store your API secret; you provide it when the run starts." />}
          <div className="hidden" aria-hidden="true"><Input label="Leave empty" tabIndex={-1} autoComplete="off" value={f.hp} onChange={(e) => set('hp', e.target.value)} /></div>
          <div className="space-y-2">
            <Check id="ovb-ind" label="Run my agent independently (Vireek calls my number or API)" checked={f.wantsIndependentRun} onChange={(v) => set('wantsIndependentRun', v)} />
            <Check id="ovb-bun" label="I will run the open harness and submit a bundle" checked={f.wantsBundle} onChange={(v) => set('wantsBundle', v)} />
            <Check id="ovb-pub" label="I consent to my results being published under my organisation's name" checked={f.publicListingConsent} onChange={(v) => set('publicListingConsent', v)} />
            <Check id="ovb-a1" label="My agent is configured with the published benchmark business profile" checked={f.attestProfile} onChange={(v) => set('attestProfile', v)} />
            <Check id="ovb-a2" label="I will not retain or train on held-out scenario content" checked={f.attestNoRetention} onChange={(v) => set('attestNoRetention', v)} />
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button onClick={() => void submit()} disabled={state === 'sending'}>{state === 'sending' ? 'Sending…' : 'Request submission'}</Button>
        </Card>
      </div>
    </Section>
  );
}

function Integrity({ o }: { o: Overview }) {
  const [corr, setCorr] = useState<Correction[] | null>(null);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [commit, setCommit] = useState<boolean | null>(null);
  const [form, setForm] = useState({ name: '', email: '', org: '', runId: '', message: '', hp: '' });
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { fetchCorrections().then(setCorr).catch(() => setCorr([])); fetchCatalog().then(setCat).catch(() => null); }, []);
  const revealed = Boolean(cat?.suite?.held_out_revealed_at && cat.suite.held_out_salt);
  return (
    <Section title="Integrity & corrections" intro="Tamper-evidence is enforced inside the database, not by policy alone.">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 !p-6"><h3 className="flex items-center gap-2 font-semibold text-text-primary"><ShieldCheck size={18} aria-hidden="true" />Integrity layer</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-secondary">
            <li><b className="text-text-primary">Scenario hashes</b> — each scenario is published with the exact canonical text that was hashed; use “Verify in browser”.</li>
            <li><b className="text-text-primary">Frozen suites</b> — published versions cannot be edited; fixes ship as a new version with a changelog.</li>
            <li><b className="text-text-primary">Held-out set</b> — {o.suite?.held_out_count ?? 0} secret scenarios, committed by a salted hash published now and revealed when the suite retires.</li>
            <li><b className="text-text-primary">Run logs</b> — append-only, hash-chained events; a run cannot be published if its chain is broken.</li>
            <li><b className="text-text-primary">Recordings & transcripts</b> — stored with SHA-256 hashes referenced in the log.</li>
            <li><b className="text-text-primary">No naming without consent</b> — enforced by a database rule on listings.</li>
          </ul>
          {o.suite && <p className="break-all font-mono text-[11px] text-text-secondary">manifest {o.suite.manifest_hash}<br />held-out commitment {o.suite.held_out_commitment}</p>}
          {revealed && cat?.suite && <div className="text-sm"><Button variant="secondary" size="sm" onClick={async () => setCommit(await verifyHeldOutCommitment(cat.scenarios, cat.suite!.held_out_salt as string, cat.suite!.held_out_commitment as string))}>Verify held-out commitment</Button>{commit !== null && <span className={`ml-2 ${commit ? 'text-success' : 'text-danger'}`}>{commit ? 'commitment matches' : 'MISMATCH'}</span>}</div>}
        </Card>
        <Card className="space-y-2 !p-6"><h3 className="font-semibold text-text-primary">Corrections policy</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-secondary">
            <li>Anyone can report an error; we acknowledge within 5 business days and publish a decision within 14 days.</li>
            <li>Corrections are append-only and never silently edited; a wrong result is retracted, stays visible and links to its correction.</li>
            <li>Methodology or scenario fixes ship as a new suite version; old versions remain comparable.</li>
            <li>Vendors may withdraw their listing at any time; withdrawn agents are removed from public pages.</li>
          </ul>
        </Card>
      </div>
      <Card className="space-y-3 !p-6"><h3 className="font-semibold text-text-primary">Published corrections ({corr?.length ?? o.corrections_count})</h3>
        {corr === null ? <Skeleton className="h-16 w-full" /> : corr.length === 0
          ? <p className="text-sm text-text-secondary">Nothing has been corrected so far. If you find an error, tell us below.</p>
          : <ul className="space-y-3">{corr.map((c) => <li key={c.id} className="text-sm"><div className="font-medium text-text-primary">{c.title} <span className="text-xs text-text-secondary">· {c.kind} · {new Date(c.published_at).toLocaleDateString()}{c.suite_version ? ` · v${c.suite_version}` : ''}</span></div><p className="text-text-secondary">{c.body}</p></li>)}</ul>}
      </Card>
      {sent ? <EmptyState icon={CheckCircle2} title="Thank you, we have your report" description="You will hear from us within 5 business days." /> : (
        <Card className="space-y-3 !p-6"><h3 className="font-semibold text-text-primary">Report an error or dispute a result</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <Input label="Organisation" value={form.org} onChange={(e) => setForm({ ...form, org: e.target.value })} />
            <Input label="Run ID (optional)" value={form.runId} onChange={(e) => setForm({ ...form, runId: e.target.value })} />
          </div>
          <div className="hidden" aria-hidden="true"><Input label="Leave empty" tabIndex={-1} autoComplete="off" value={form.hp} onChange={(e) => setForm({ ...form, hp: e.target.value })} /></div>
          <Textarea label="What is wrong?" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} required helperText="At least 20 characters." />
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button onClick={async () => { setErr(''); try { await requestCorrection({ name: form.name, email: form.email, org: form.org, runId: form.runId.trim(), suiteVersion: o.suite?.version ?? '', message: form.message, hp: form.hp }); setSent(true); } catch (e) { setErr(intakeErrorMessage(e)); } }}>Send report</Button>
        </Card>
      )}
    </Section>
  );
}

// ───────────────────────────── Page ─────────────────────────────

export function OpenVoiceBenchmarkPage() {
  useSEO({
    title: 'Open Voice Benchmark for Home-Service AI Receptionists | Vireek',
    description: 'A public, versioned, tamper-evident benchmark for AI phone receptionists: emergency triage, noisy job sites, accents, price pushback, spam, after-hours and AI-disclosure compliance. Open to any vendor.',
    canonical: 'https://vireek.com/open-voice-benchmark',
  });
  const [tab, setTab] = useState<Tab>(() => (TABS.map((t) => t[0]) as string[]).includes(window.location.hash.slice(1)) ? (window.location.hash.slice(1) as Tab) : 'leaderboard');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { fetchOverview().then(setOverview).catch(() => setFailed(true)); }, []);
  const pick = (t: Tab) => { setTab(t); window.history.replaceState(null, '', `#${t}`); };

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <div className="mx-auto max-w-7xl space-y-8 px-6 pb-20">
          <header className="max-w-3xl space-y-3 pt-8">
            <p className="text-sm font-medium text-accent">Open Voice Benchmark</p>
            <h1 className="text-3xl font-bold text-text-primary sm:text-4xl">How good is your AI receptionist when it actually matters?</h1>
            <p className="text-text-secondary">A public, versioned benchmark for home-service AI phone agents. Same scenarios for everyone, transparent scoring, a held-out set against overfitting, and a run log you can verify yourself.</p>
            {overview?.suite && <p className="font-mono text-xs text-text-secondary">suite v{overview.suite.version} · manifest {shortHash(overview.suite.manifest_hash)}</p>}
          </header>
          <nav aria-label="Benchmark sections" role="tablist" className="flex flex-wrap gap-2 border-b border-border pb-3">
            {TABS.map(([k, l]) => (
              <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => pick(k)} className={`focus-ring rounded-xl px-4 py-2 text-sm font-medium ${tab === k ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary'}`}>{l}</button>
            ))}
          </nav>
          {failed && <Card className="!p-6"><p className="text-sm text-danger">We couldn&apos;t load the benchmark right now. Please try again shortly.</p></Card>}
          {!overview && !failed && <Skeleton className="h-64 w-full rounded-2xl" />}
          {overview && (
            <div role="tabpanel">
              {tab === 'leaderboard' && <Leaderboard o={overview} />}
              {tab === 'methodology' && <Methodology o={overview} />}
              {tab === 'scenarios' && <Scenarios />}
              {tab === 'history' && <History />}
              {tab === 'submit' && <Submit />}
              {tab === 'integrity' && <Integrity o={overview} />}
            </div>
          )}
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
