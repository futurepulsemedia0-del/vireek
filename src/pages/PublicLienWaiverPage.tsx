/**
 * Lien waiver signing — /lien-waiver/:token
 * Public, token-gated (no sign-in). Shows the exact wording that was frozen when the request was sent and lets the
 * signer e-sign (typed name + consent) or decline. Signed waivers stay viewable at the same link as a read-only copy.
 * Never exposes internal ids or other waivers.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Clock3, FileX2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { fetchPublicWaiver, recordPublicView, respondPublic } from '@/lib/lienWaiversApi';
import { NOT_LEGAL_ADVICE, formatUsd, lienWaiverError, longDate, type PublicLienWaiver } from '@/lib/lienWaivers';

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; w: PublicLienWaiver };

function Notice({ icon: Icon, title, body, tone }: { icon: typeof CheckCircle2; title: string; body: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }) {
  const color = tone === 'success' ? 'text-success-500' : tone === 'danger' ? 'text-danger-500' : tone === 'warning' ? 'text-warning-500' : 'text-text-secondary';
  return (
    <div role="status" className="rounded-2xl border border-border bg-bg-secondary p-6 text-center">
      <Icon size={32} className={`mx-auto ${color}`} aria-hidden="true" />
      <h2 className="mt-3 text-lg font-semibold text-text-primary">{title}</h2>
      <p className="mt-1 text-sm text-text-secondary">{body}</p>
    </div>
  );
}

function SignForm({ w, token, onDone }: { w: PublicLienWaiver; token: string; onDone: () => void }) {
  const [mode, setMode] = useState<'sign' | 'decline'>('sign');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [agree, setAgree] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'sign') {
      if (name.trim().length < 2) { setError('Please type your full name to sign.'); return; }
      if (!agree) { setError('Please confirm that you have read and agree to this waiver.'); return; }
    }
    setError('');
    setBusy(true);
    try {
      await respondPublic(token, mode === 'sign' ? 'signed' : 'declined', name.trim(), title.trim(), note.trim());
      onDone();
    } catch (err) {
      setError(lienWaiverError(err, 'We couldn’t record your response. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Your response">
      <div role="group" aria-label="Your decision" className="grid grid-cols-2 gap-2">
        {(['sign', 'decline'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setError(''); }}
            className={`focus-ring min-h-[44px] rounded-xl px-4 text-sm font-semibold transition-colors ${mode === m ? (m === 'sign' ? 'bg-accent text-white' : 'bg-danger-500 text-white') : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
            {m === 'sign' ? 'Sign' : 'Decline'}
          </button>
        ))}
      </div>

      {mode === 'sign' ? (
        <>
          <Input label="Type your full legal name to sign" required autoComplete="name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          <Input label="Title / role (optional)" autoComplete="organization-title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
          <label className="flex items-start gap-3 text-sm text-text-primary">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-border" />
            <span>I have read this waiver and release, I am authorized to sign it for <strong>{w.claimantName}</strong>, and I agree that my typed name is my legal signature.</span>
          </label>
        </>
      ) : (
        <>
          <Input label="Your name (optional)" autoComplete="name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          <Textarea label="Reason (optional)" rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </>
      )}

      {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full">
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        {mode === 'sign' ? 'Sign waiver' : 'Decline'}
      </Button>
      <p className="text-center text-xs text-text-secondary">Your name, the time, your network address and this exact wording are recorded as your signature.</p>
    </form>
  );
}

export function PublicLienWaiverPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    const w = await fetchPublicWaiver(token);
    setState(w ? { kind: 'ready', w } : { kind: 'missing' });
  }, [token]);

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    fetchPublicWaiver(token).then((w) => {
      if (!live) return;
      setState(w ? { kind: 'ready', w } : { kind: 'missing' });
      if (w?.status === 'sent') void recordPublicView(token);
    });
    return () => { live = false; };
  }, [token]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  return (
    <main className="min-h-screen bg-bg-primary px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-2xl space-y-5">
        {state.kind === 'loading' && <div className="h-72 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" aria-label="Loading your waiver" />}

        {state.kind === 'missing' && <Notice icon={FileX2} tone="neutral" title="We couldn’t find this waiver" body="The link may be incorrect, or the waiver was withdrawn. Please contact the business that sent it to you." />}

        {state.kind === 'ready' && (() => {
          const w = state.w;
          return (
            <>
              <header>
                <p className="text-sm font-medium text-text-secondary">{w.businessName ?? 'Lien waiver'}{w.number ? ` · ${w.number}` : ''}</p>
                <h1 className="mt-1 break-words text-2xl font-bold text-text-primary">{w.title}</h1>
                <p className="mt-1 text-sm text-text-secondary">
                  {w.claimantName} · {formatUsd(w.amountCents)} · through {longDate(w.throughDate)}
                </p>
              </header>

              {w.status === 'signed' && <Notice icon={CheckCircle2} tone="success" title="Signed — thank you" body={`${w.signerName ?? 'The signer'}${w.signerTitle ? `, ${w.signerTitle},` : ''} signed this waiver${w.signedAt ? ` on ${longDate(w.signedAt)}` : ''}. A copy stays available at this link.`} />}
              {w.status === 'declined' && <Notice icon={XCircle} tone="danger" title="This waiver was declined" body="No rights were released. Contact the business if this was a mistake." />}
              {w.status === 'void' && <Notice icon={FileX2} tone="neutral" title="This waiver was withdrawn" body="It is no longer valid. Contact the business for a replacement." />}
              {w.status === 'expired' && <Notice icon={Clock3} tone="warning" title="This signing link has expired" body="Please contact the business and ask them to send it again." />}

              {w.requiresNotary && (
                <div role="note" className="flex items-start gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm text-text-primary">
                  <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
                  <p>This form may need to be notarized to be effective in {w.stateCode}. An electronic signature alone may not satisfy that requirement — ask the business how to complete it.</p>
                </div>
              )}

              <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Waiver wording">
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-text-primary" data-testid="waiver-body">{w.body}</pre>
                {w.status === 'signed' && (
                  <dl className="mt-4 space-y-1 border-t border-border pt-3 text-sm">
                    <div className="flex justify-between gap-3"><dt className="text-text-secondary">Signed by</dt><dd className="text-right font-medium text-text-primary">{w.signerName}{w.signerTitle ? `, ${w.signerTitle}` : ''}</dd></div>
                    {w.contentHash && <div className="flex justify-between gap-3"><dt className="text-text-secondary">Document fingerprint</dt><dd className="break-all text-right font-mono text-xs text-text-secondary">{w.contentHash.slice(0, 16)}…</dd></div>}
                  </dl>
                )}
              </section>

              {w.status === 'sent' && (
                <>
                  <SignForm w={w} token={token} onDone={() => void load()} />
                  {w.expiresAt && <p className="text-center text-xs text-text-secondary">This link is valid until {longDate(w.expiresAt)}.</p>}
                </>
              )}
              <p className="text-center text-xs text-text-secondary">{NOT_LEGAL_ADVICE}</p>
            </>
          );
        })()}
      </div>
    </main>
  );
}
