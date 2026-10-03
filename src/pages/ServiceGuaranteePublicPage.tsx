/**
 * Customer-facing Verified Service page — /guarantee/:token
 *
 * Token-gated (jobs.reschedule_token). Shows whether the fix has been verified,
 * lets the customer answer "is the problem still solved?" at a checkpoint, and
 * lets them report a problem any time during the coverage period. Reads and
 * writes only through the token-gated RPCs in serviceGuarantee.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Check, Clock, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import {
  EVIDENCE_LABELS,
  STAGE_LABELS,
  daysLeft,
  fetchPublicGuarantee,
  reportIssue,
  respondToCheckpoint,
  type CheckpointStage,
  type PublicGuarantee,
} from '@/lib/serviceGuarantee';

const POLL_MS = 30_000;

const HEADLINES: Record<PublicGuarantee['status'], { title: string; body: string }> = {
  verifying: { title: 'We are verifying your repair', body: 'We check back after 48 hours, 7 days and 30 days to make sure the problem stays solved.' },
  verified: { title: 'Vireek Verified Service', body: 'Your repair passed every verification check. You are still covered: tell us if anything goes wrong.' },
  claim_open: { title: 'We received your report', body: 'We are checking your warranty and arranging the right technician. You do not need to do anything else.' },
  recovering: { title: 'Your recovery visit is scheduled', body: 'The business has scheduled a follow-up visit to fix this. They will contact you with the details.' },
  recovered: { title: 'Fixed by a recovery visit', body: 'Your issue was resolved. If anything is still wrong, contact the business directly.' },
  expired: { title: 'Verified and completed', body: 'Your repair passed every verification check and the coverage period has ended.' },
  voided: { title: 'This guarantee is no longer active', body: 'Please contact the business directly if you need help.' },
};

function errorText(reason: string): string {
  switch (reason) {
    case 'invalid_description':
      return 'Please describe the problem in a few words (3 to 1000 characters).';
    case 'not_covered':
      return 'This job can no longer take a new report online. Please contact the business directly.';
    case 'already_closed':
    case 'too_early':
    case 'out_of_order':
    case 'not_verifying':
      return 'This check is no longer waiting for an answer. Refresh the page to see the latest status.';
    default:
      return 'Something went wrong. Please try again or contact the business directly.';
  }
}

export function ServiceGuaranteePublicPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicGuarantee | null | undefined>(undefined);
  const [note, setNote] = useState('');
  const [issue, setIssue] = useState('');
  const [showIssue, setShowIssue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setData(null);
      return;
    }
    setData(await fetchPublicGuarantee(token));
  }, [token]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const answer = async (stage: CheckpointStage, solved: boolean) => {
    if (!token || busy) return;
    if (!solved && note.trim().length > 0 && note.trim().length < 3) {
      setMessage({ tone: 'error', text: 'Please add a few more words, or leave the note empty.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = await respondToCheckpoint(token, stage, solved, note);
    if (res.ok) {
      setMessage({
        tone: 'ok',
        text: solved ? 'Thank you. We recorded that your problem is solved.' : 'Thank you. We opened a claim and the business has been alerted.',
      });
      setNote('');
    } else {
      setMessage({ tone: 'error', text: errorText(res.reason) });
    }
    await load();
    setBusy(false);
  };

  const submitIssue = async () => {
    if (!token || busy) return;
    setBusy(true);
    setMessage(null);
    const res = await reportIssue(token, issue);
    if (res.ok) {
      setMessage({ tone: 'ok', text: 'Thank you. We opened a claim and the business has been alerted.' });
      setIssue('');
      setShowIssue(false);
    } else {
      setMessage({ tone: 'error', text: errorText(res.reason) });
    }
    await load();
    setBusy(false);
  };

  const textarea = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-lg">
          {data === undefined && <p className="py-20 text-center text-sm text-text-secondary">Loading…</p>}

          {data === null && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Guarantee not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                This link isn't valid, or this business hasn't turned on Verified Service. Please contact the business directly.
              </p>
            </div>
          )}

          {data && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {data.business_name ?? 'Your service provider'}
                  {data.service_type ? ` · ${data.service_type}` : ''}
                </p>
                <ShieldCheck size={36} className={`mx-auto mt-4 ${data.status === 'verified' || data.status === 'expired' || data.status === 'recovered' ? 'text-success-500' : data.status === 'claim_open' ? 'text-danger' : 'text-accent'}`} aria-hidden />
                <h1 className="mt-3 text-lg font-semibold text-text-primary">{HEADLINES[data.status].title}</h1>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-text-secondary">{HEADLINES[data.status].body}</p>
                {(data.status === 'verified' || data.status === 'expired') && data.evidence_level !== 'none' && (
                  <p className="mx-auto mt-4 inline-flex items-center gap-1.5 rounded-full bg-success-500/10 px-3 py-1.5 text-xs font-semibold text-success-500">
                    <Check size={14} aria-hidden /> {EVIDENCE_LABELS[data.evidence_level]}
                  </p>
                )}
                {data.can_report && data.status === 'verified' && <p className="mt-3 text-xs text-text-secondary">Covered for {daysLeft(data.expires_at, Date.now())} more days.</p>}
                {data.technician_name && <p className="mt-3 text-xs text-text-secondary">Technician: {data.technician_name}</p>}
              </div>

              {data.awaiting_stage && data.status === 'verifying' && (
                <div className="rounded-2xl border border-accent/30 bg-accent/5 p-5">
                  <h2 className="text-sm font-semibold text-text-primary">Is the problem still solved?</h2>
                  <p className="mt-1 text-xs text-text-secondary">It has been about {STAGE_LABELS[data.awaiting_stage]} since your service. This takes 10 seconds.</p>
                  <label htmlFor="sg-note" className="sr-only">
                    Optional note
                  </label>
                  <textarea id="sg-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything you want us to know (optional)" className={`${textarea} mt-3`} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void answer(data.awaiting_stage as CheckpointStage, true)} disabled={busy}>
                      Yes, it is solved
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void answer(data.awaiting_stage as CheckpointStage, false)} disabled={busy}>
                      No, there is still a problem
                    </Button>
                  </div>
                </div>
              )}

              {message && (
                <p role="status" className={`rounded-xl px-4 py-3 text-sm ${message.tone === 'ok' ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}>
                  {message.text}
                </p>
              )}

              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h2 className="mb-3 text-sm font-semibold text-text-primary">Verification checks</h2>
                <ul className="space-y-2">
                  {data.checkpoints.map((c) => {
                    const passed = c.status === 'passed';
                    const failed = c.status === 'failed';
                    return (
                      <li key={c.stage} className="flex items-center gap-3 text-sm">
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${passed ? 'bg-success-500/15 text-success-500' : failed ? 'bg-danger/15 text-danger' : 'bg-bg-tertiary text-text-secondary/60'}`}>
                          {passed ? <Check size={14} aria-hidden /> : failed ? <AlertCircle size={14} aria-hidden /> : <Clock size={14} aria-hidden />}
                        </span>
                        <span className={passed ? 'font-medium text-text-primary' : 'text-text-secondary'}>
                          {STAGE_LABELS[c.stage]} check
                          {passed && c.evidence ? ` · ${c.evidence === 'customer_confirmed' ? 'confirmed by you' : 'no issue reported'}` : ''}
                          {failed ? ' · issue reported' : ''}
                          {c.status === 'pending' ? ` · ${new Date(c.due_at).toLocaleDateString()}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {data.can_report && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                  {showIssue ? (
                    <div className="space-y-3">
                      <label htmlFor="sg-issue" className="text-sm font-semibold text-text-primary">
                        What is still wrong?
                      </label>
                      <textarea id="sg-issue" rows={3} maxLength={1000} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="Describe the problem in a few words" className={textarea} />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => void submitIssue()} disabled={busy || issue.trim().length < 3}>
                          Send report
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setShowIssue(false)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm text-text-secondary">Something not right with the repair?</p>
                      <Button size="sm" variant="secondary" onClick={() => setShowIssue(true)}>
                        Report a problem
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <p className="px-2 text-center text-xs leading-relaxed text-text-secondary">
                Verification is based on recorded evidence. A check passes as “confirmed by you” only when you answer it; otherwise it passes as “no issue reported” and is labelled that way.
              </p>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
