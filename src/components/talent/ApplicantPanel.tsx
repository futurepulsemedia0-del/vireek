import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, FileText, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  APPLICATION_STATUS_LABEL, REFERENCE_STRENGTHS, REJECTION_REASONS, RELATIONSHIPS, WORKER_TAGS, adverseEligibleOn, attestCredential, canMoveTo,
  centsToDollars, credentialBadge, fetchApplicant, hireApplicant, hireGate, locationLabel, recordBackgroundDecision, ratingDisplay,
  setApplicationStatus, signedDocumentUrl, startBackgroundCheck, tradeLabel, type ApplicantDetail, type ApplicationStatus, type EngagementType,
} from '@/lib/talentNetwork';

const selectClass = 'w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-3 text-sm text-text-primary focus:border-accent focus:outline-none';
const toneClass = { good: 'bg-green-500/10 text-green-500', warn: 'bg-amber-500/10 text-amber-500', bad: 'bg-red-500/10 text-red-500', neutral: 'bg-bg-tertiary text-text-secondary' };
const STEPS: ApplicationStatus[] = ['reviewing', 'interview', 'offer'];

function StatusIcon({ s }: { s: string }) {
  if (s === 'pass') return <CheckCircle2 size={16} className="text-green-500" aria-label="Passed" />;
  if (s === 'fail') return <XCircle size={16} className="text-red-500" aria-label="Not met" />;
  if (s === 'pending') return <Clock size={16} className="text-amber-500" aria-label="Pending" />;
  return <AlertTriangle size={16} className="text-text-secondary" aria-label="Note" />;
}

export function ApplicantPanel({ applicationId, backgroundProviderEnabled, onChanged }: { applicationId: string; backgroundProviderEnabled: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [d, setD] = useState<ApplicantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('not_a_fit');
  const [note, setNote] = useState('');
  const [bgNote, setBgNote] = useState('');
  const [hire, setHire] = useState({ type: 'w2' as EngagementType, startsOn: '', endsOn: '', rate: '', override: '' });
  const [showHire, setShowHire] = useState(false);

  const load = useCallback(async () => {
    try { setD(await fetchApplicant(applicationId)); setError(null); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load this applicant.'); }
  }, [applicationId]);
  useEffect(() => { setD(null); void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string, refreshParent = true) {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); await load(); if (refreshParent) onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); } finally { setBusy(false); }
  }

  async function openDoc(path: string) {
    const url = await signedDocumentUrl(path);
    if (url) window.open(url, '_blank', 'noopener,noreferrer'); else toast('Could not open the document.', 'error');
  }

  if (error) return <p role="alert" className="rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-red-500">{error}</p>;
  if (!d) return <Skeleton className="h-96 w-full rounded-2xl" />;

  const a = d.application;
  const snap = a.profile_snapshot;
  const p = d.profile;
  const open = ['submitted', 'reviewing', 'interview', 'offer'].includes(a.status);
  const gate = hireGate(d.compliance);
  const bg = d.background_check;
  const eligible = adverseEligibleOn(bg?.pre_adverse_sent_at ?? null);
  const waitOver = eligible ? new Date() >= eligible : false;
  const noteOk = bgNote.trim().length >= 20;

  return (
    <div className="space-y-5 rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">{p?.display_name ?? snap.display_name ?? 'Applicant'}</h2>
          <p className="text-sm text-text-secondary">{p?.headline ?? snap.headline}</p>
          <p className="mt-1 text-sm text-text-secondary">{(p?.trades ?? snap.trades ?? []).map(tradeLabel).join(', ')} · {locationLabel(p ?? snap)}{(p?.experience_years ?? snap.experience_years) != null && ` · ${p?.experience_years ?? snap.experience_years} yrs`}</p>
          {p && <p className="mt-1 text-sm text-text-primary">{p.contact_email}{p.phone ? ` · ${p.phone}` : ''}</p>}
          {d.reputation && d.reputation.count > 0 && <p className="mt-1 text-xs text-text-secondary">Worker rating {ratingDisplay(d.reputation.avg, d.reputation.count)}{d.reputation.tags[0] ? ` · ${d.reputation.tags.slice(0, 3).map((t) => WORKER_TAGS[t.tag] ?? t.tag).join(', ')}` : ''}</p>}
        </div>
        <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent">{APPLICATION_STATUS_LABEL[a.status]}</span>
      </div>
      {p?.bio && <p className="whitespace-pre-wrap text-sm text-text-primary">{p.bio}</p>}
      {a.cover_note && <p className="rounded-xl bg-bg-tertiary p-3 text-sm text-text-primary">“{a.cover_note}”</p>}
      {a.expected_rate_cents != null && <p className="text-sm text-text-secondary">Expects ${centsToDollars(a.expected_rate_cents)}/hr{a.availability_note ? ` · ${a.availability_note}` : ''}</p>}

      {open && (
        <div className="flex flex-wrap gap-2">
          {STEPS.filter((s) => canMoveTo(a.status, s)).map((s) => (
            <Button key={s} variant="secondary" disabled={busy} onClick={() => void act(() => setApplicationStatus(a.id, s), `Moved to ${APPLICATION_STATUS_LABEL[s]}.`)}>Move to {APPLICATION_STATUS_LABEL[s]}</Button>
          ))}
          <Button variant="secondary" disabled={busy} onClick={() => setReject((v) => !v)}>Reject…</Button>
        </div>
      )}
      {reject && open && (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <label htmlFor="ap-reason" className="block text-sm font-medium text-text-primary">Reason</label>
          <select id="ap-reason" className={selectClass} value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(REJECTION_REASONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <Textarea label="Internal note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
          <p className="text-xs text-text-secondary">Never reject based on a background-check result here. Use the background-check process below.</p>
          <Button disabled={busy} onClick={() => void act(() => setApplicationStatus(a.id, 'rejected', reason, note), 'Application closed.').then(() => setReject(false))}>Confirm rejection</Button>
        </div>
      )}

      <section aria-labelledby="ap-comp">
        <h3 id="ap-comp" className="mb-2 text-sm font-semibold text-text-primary">Compliance checklist</h3>
        {d.compliance.checks.length === 0 && <p className="text-sm text-text-secondary">No requirements on this posting.</p>}
        <ul className="space-y-2">
          {d.compliance.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2 text-sm"><StatusIcon s={c.status} /><span><span className="font-medium text-text-primary">{c.label}</span> <span className="text-text-secondary">{c.detail}</span></span></li>
          ))}
        </ul>
      </section>

      {d.credentials.length > 0 && (
        <section aria-labelledby="ap-cred">
          <h3 id="ap-cred" className="mb-2 text-sm font-semibold text-text-primary">Licenses & certifications</h3>
          <ul className="space-y-3">
            {d.credentials.map((c) => {
              const b = credentialBadge(c);
              return (
                <li key={c.id} className="rounded-xl border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-text-primary">{c.name} <span className="text-xs text-text-secondary">{[c.credential_number, c.region, c.issuing_authority].filter(Boolean).join(' · ')}</span></p>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs ${toneClass[b.tone]}`}>{b.label}</span>
                  </div>
                  {c.expires_on && <p className="text-xs text-text-secondary">Expires {c.expires_on}</p>}
                  {c.attestation && <p className="mt-1 text-xs text-text-secondary">Your team: {c.attestation.outcome === 'verified' ? 'verified' : 'not verified'} ({c.attestation.method.replace(/_/g, ' ')}){c.attestation.note ? ` — ${c.attestation.note}` : ''}</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.document_path && <Button variant="secondary" onClick={() => void openDoc(c.document_path!)}><FileText size={14} className="mr-1.5" />Document</Button>}
                    {open && <Button variant="secondary" disabled={busy} onClick={() => void act(() => attestCredential(a.id, c.id, 'verified', 'state_board_lookup', 'Matched against the licensing board record.'), 'Recorded as verified.', false)}>I verified it</Button>}
                    {open && <Button variant="secondary" disabled={busy} onClick={() => void act(() => attestCredential(a.id, c.id, 'not_verified', 'state_board_lookup', 'Could not match the licensing board record.'), 'Recorded as not verified.', false)}>Couldn’t verify</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-text-secondary">Look the number up on the issuing state board, then record the result. Attestations count for your company only.</p>
        </section>
      )}

      {d.references.length > 0 && (
        <section aria-labelledby="ap-ref">
          <h3 id="ap-ref" className="mb-2 text-sm font-semibold text-text-primary">References</h3>
          <ul className="space-y-2 text-sm">
            {d.references.map((r) => (
              <li key={r.id} className="rounded-xl border border-border p-3">
                <p className="font-medium text-text-primary">{r.referee_name} <span className="text-xs text-text-secondary">{RELATIONSHIPS[r.relationship]}{r.company ? ` · ${r.company}` : ''}</span></p>
                {r.status === 'received' ? (
                  <p className="text-text-secondary">{r.rating}/5 · would rehire: {r.would_rehire}{r.strengths.length ? ` · ${r.strengths.map((s) => REFERENCE_STRENGTHS[s] ?? s).join(', ')}` : ''}{r.comment ? ` — “${r.comment}”` : ''}</p>
                ) : <p className="text-text-secondary">{r.status === 'requested' ? 'Waiting for a response' : 'Not requested'}</p>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-secondary">Referee identity is self-reported by the applicant. Treat as one input, not proof.</p>
        </section>
      )}

      {(bg || a.status === 'offer') && (
        <section aria-labelledby="ap-bg" className="space-y-3">
          <h3 id="ap-bg" className="text-sm font-semibold text-text-primary">Background check</h3>
          {!bg && a.status === 'offer' && (
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">Allowed now because a conditional offer is open. The candidate authorizes the check with the screening provider; Vireek never sees the report.</p>
              {backgroundProviderEnabled
                ? <Button disabled={busy} onClick={() => void act(() => startBackgroundCheck(a.id), 'Background check started. The candidate was emailed by the provider.')}>Start background check</Button>
                : <p className="text-sm text-amber-500">No screening provider is connected for this workspace yet.</p>}
            </div>
          )}
          {bg && (
            <div className="space-y-3 text-sm">
              <p className="text-text-primary">Status: <span className="font-medium">{bg.status.replace(/_/g, ' ')}</span>{bg.result ? ` · result: ${bg.result}` : ''}</p>
              {bg.status === 'failed' && a.status === 'offer' && backgroundProviderEnabled && <Button disabled={busy} onClick={() => void act(() => startBackgroundCheck(a.id), 'New background check started.')}>Start a new check</Button>}
              {bg.status === 'complete' && bg.result === 'consider' && bg.decision !== 'adverse_final' && (
                <div className="space-y-3 rounded-xl border border-amber-500/40 p-4">
                  <p className="flex items-start gap-2 text-text-primary"><AlertTriangle size={16} className="mt-0.5 text-amber-500" aria-hidden="true" />This result needs an individualized review before any decision. Consider the nature of the record, how long ago it happened, and its relevance to the job. Follow your local fair-chance rules.</p>
                  <Textarea label="Your individualized assessment (min. 20 characters)" value={bgNote} onChange={(e) => setBgNote(e.target.value)} maxLength={1000} rows={3} />
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy || !noteOk} onClick={() => void act(() => recordBackgroundDecision(bg.id, 'engage', bgNote.trim()), 'Decision recorded: proceed.')}>Proceed with hire</Button>
                    {bg.decision !== 'pre_adverse_sent' && <Button variant="secondary" disabled={busy || !noteOk} onClick={() => void act(() => recordBackgroundDecision(bg.id, 'pre_adverse_sent', bgNote.trim()), 'Pre-adverse notice recorded.')}>I sent the pre-adverse notice</Button>}
                    {bg.decision === 'pre_adverse_sent' && <Button variant="secondary" disabled={busy || !waitOver} onClick={() => void act(() => recordBackgroundDecision(bg.id, 'adverse_final', bgNote.trim()), 'Final adverse action recorded.')}>Finalize adverse action</Button>}
                  </div>
                  {bg.decision === 'pre_adverse_sent' && <p className="text-xs text-text-secondary">Pre-adverse notice recorded {bg.pre_adverse_sent_at ? new Date(bg.pre_adverse_sent_at).toLocaleDateString() : ''}. Finalizing unlocks {eligible ? eligible.toLocaleDateString() : 'after 5 business days'} so the candidate can respond. Send the provider’s notices; Vireek only records the steps.</p>}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {a.status === 'offer' && (
        <section aria-labelledby="ap-hire" className="space-y-3">
          <h3 id="ap-hire" className="text-sm font-semibold text-text-primary">Hire & onboard</h3>
          {gate.hardBlocked && <p className="text-sm text-red-500">The background-check requirement isn’t satisfied. This can’t be overridden.</p>}
          {!showHire ? <Button disabled={gate.hardBlocked} onClick={() => setShowHire(true)}>Hire this person</Button> : (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="hr-type" className="mb-1.5 block text-sm font-medium text-text-primary">Engagement</label>
                  <select id="hr-type" className={selectClass} value={hire.type} onChange={(e) => setHire({ ...hire, type: e.target.value as EngagementType })}>
                    <option value="w2">W-2 employee</option><option value="1099">1099 contractor</option>
                  </select>
                </div>
                <Input label="Hourly rate" required value={hire.rate} onChange={(e) => setHire({ ...hire, rate: e.target.value })} inputMode="decimal" placeholder="38.50" />
                <Input label="Start date" required type="date" value={hire.startsOn} onChange={(e) => setHire({ ...hire, startsOn: e.target.value })} />
                <Input label="End date (gigs)" type="date" value={hire.endsOn} onChange={(e) => setHire({ ...hire, endsOn: e.target.value })} />
              </div>
              {gate.needsOverride && <Textarea label="Compliance override reason (min. 20 characters, logged)" value={hire.override} onChange={(e) => setHire({ ...hire, override: e.target.value })} maxLength={500} rows={2} />}
              <p className="text-xs text-text-secondary">Creates a pending technician account (invite emailed) and a payroll record. Collect I-9 / W-4 / W-9 through your payroll or HR process; Vireek only tracks completion.</p>
              <Button disabled={busy || !hire.startsOn || !hire.rate} onClick={() => void act(async () => {
                const r = await hireApplicant({ applicationId: a.id, engagementType: hire.type, startsOn: hire.startsOn, endsOn: hire.endsOn, hourlyRate: hire.rate, overrideReason: hire.override });
                if (!r.inviteSent) toast('Hired, but the invite email failed. Resend it from Team.', 'info');
              }, 'Hired. Onboarding started.')}>Confirm hire</Button>
            </div>
          )}
        </section>
      )}

      {d.events.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-text-primary">Activity log</summary>
          <ul className="mt-2 space-y-1 text-xs text-text-secondary">
            {d.events.map((e, i) => <li key={`${e.created_at}-${i}`}>{new Date(e.created_at).toLocaleString()} · {e.actor_role} · {e.kind.replace(/_/g, ' ')}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
