/**
 * Public signer page for Native E-Signature — /sign/:token.
 * Read-only against the DB except through submitSignature/declineSignature
 * in src/lib/signatures.ts, both of which go through the
 * sign-document-action Edge Function so the audit log gets a real IP.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Ban, CheckCircle2, Clock3, FileSignature, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { SignaturePad, SignaturePadValue } from '@/components/signatures/SignaturePad';
import {
  fetchSignatureRequestForSigner,
  recordSignatureView,
  recordSignatureConsent,
  submitSignature,
  declineSignature,
  PublicSignatureInfo,
} from '@/lib/signatures';

type ViewState = 'loading' | 'not_found' | 'declined' | 'blocked' | 'signed_wait' | 'completed' | 'form';

export function SignDocumentPage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<PublicSignatureInfo | null | undefined>(undefined);
  const [consented, setConsented] = useState(false);
  const [signature, setSignature] = useState<SignaturePadValue | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<'signed' | 'completed' | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [localDeclined, setLocalDeclined] = useState(false);
  const [viewLogged, setViewLogged] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetchSignatureRequestForSigner(token).then((data) => setInfo(data));
  }, [token]);

  useEffect(() => {
    if (!token || !info || viewLogged) return;
    if (info.signer_status === 'pending') recordSignatureView(token);
    setViewLogged(true);
  }, [token, info, viewLogged]);

  const viewState: ViewState = useMemo(() => {
    if (info === undefined) return 'loading';
    if (info === null) return 'not_found';
    if (localDeclined || info.signer_status === 'declined') return 'declined';
    if (localResult === 'completed') return 'completed';
    if (localResult === 'signed') return 'signed_wait';
    if (info.signer_status === 'signed') return info.request_status === 'completed' ? 'completed' : 'signed_wait';
    if (info.request_status === 'voided' || info.request_status === 'expired') return 'blocked';
    return 'form';
  }, [info, localResult, localDeclined]);

  const handleConsentToggle = (checked: boolean) => {
    setConsented(checked);
    if (checked && token) recordSignatureConsent(token);
  };

  const handleSubmit = async () => {
    if (!token || !signature || !consented || submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await submitSignature(token, { type: signature.type, data: signature.data, typedFont: signature.typedFont });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error || 'This document could not be signed. It may already be signed or the link has expired.');
      return;
    }
    setLocalResult(res.completed ? 'completed' : 'signed');
  };

  const handleDecline = async () => {
    if (!token || submitting) return;
    setSubmitting(true);
    const ok = await declineSignature(token, declineReason.trim());
    setSubmitting(false);
    if (ok) setLocalDeclined(true);
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-lg">
          {viewState === 'loading' && (
            <Card className="text-center">
              <p className="text-sm text-text-secondary">Loading your document…</p>
            </Card>
          )}

          {viewState === 'not_found' && (
            <Card className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">We couldn't load this signing link</h1>
              <p className="mt-2 text-sm text-text-secondary">Double-check the link, or ask the sender for a new one.</p>
            </Card>
          )}

          {viewState === 'declined' && info && (
            <Card className="text-center">
              <Ban size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">You declined to sign</h1>
              <p className="mt-2 text-sm text-text-secondary">{info.business_name ?? 'The sender'} has been notified.</p>
            </Card>
          )}

          {viewState === 'blocked' && info && (
            <Card className="text-center">
              <Clock3 size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">This signing link is no longer active</h1>
              <p className="mt-2 text-sm text-text-secondary">Ask {info.business_name ?? 'the sender'} to send a new one.</p>
            </Card>
          )}

          {(viewState === 'signed_wait' || viewState === 'completed') && info && (
            <Card className="text-center">
              <CheckCircle2 size={28} className="mx-auto mb-3 text-success-500" />
              <h1 className="text-lg font-semibold text-text-primary">{viewState === 'completed' ? 'Everyone has signed' : "You're signed"}</h1>
              <p className="mt-2 text-sm text-text-secondary">
                {viewState === 'completed'
                  ? `"${info.title}" is now fully executed.`
                  : `Thanks — waiting on ${info.other_signers.filter((s) => s.status !== 'signed').length || 'the remaining'} more signer(s).`}
              </p>
              {info.other_signers.length > 0 && (
                <div className="mt-4 space-y-1.5 text-left">
                  {info.other_signers.map((s, i) => (
                    <div key={i} className="flex items-center justify-between rounded-lg bg-bg-tertiary px-3 py-2 text-xs">
                      <span className="text-text-primary">{s.name}</span>
                      <span className="capitalize text-text-secondary">{s.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {viewState === 'form' && info && (
            <Card>
              <div className="mb-5 flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <FileSignature size={20} />
                </span>
                <div>
                  <h1 className="text-lg font-semibold text-text-primary">{info.title}</h1>
                  <p className="text-xs text-text-secondary">
                    Sent by {info.business_name ?? 'the sender'} · for {info.signer_name}
                  </p>
                </div>
              </div>

              {info.document_summary && (
                <p className="mb-5 whitespace-pre-line rounded-xl border border-border bg-bg-tertiary p-3.5 text-sm text-text-secondary">
                  {info.document_summary}
                </p>
              )}

              {info.document_url && (
                <a href={info.document_url} target="_blank" rel="noreferrer" className="focus-ring mb-5 inline-block text-sm font-medium text-accent hover:brightness-110">
                  View full document →
                </a>
              )}

              {!declining ? (
                <>
                  <label className="mb-4 flex items-start gap-2.5 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={consented}
                      onChange={(e) => handleConsentToggle(e.target.checked)}
                      className="focus-ring mt-0.5 h-4 w-4 shrink-0 rounded border-border text-accent"
                    />
                    <span>{info.consent_text}</span>
                  </label>

                  <div className={consented ? '' : 'pointer-events-none opacity-40'}>
                    <p className="mb-2 text-sm font-medium text-text-primary">Your signature</p>
                    <SignaturePad defaultName={info.signer_name} onChange={setSignature} />
                  </div>

                  {error && <p className="mt-3 text-sm text-danger">{error}</p>}

                  <div className="mt-5 flex items-center justify-between gap-3">
                    <button type="button" onClick={() => setDeclining(true)} className="focus-ring text-sm text-text-secondary hover:text-danger">
                      I can't sign this
                    </button>
                    <Button variant="primary" onClick={handleSubmit} disabled={!consented || !signature || submitting}>
                      <ShieldCheck size={15} /> {submitting ? 'Signing…' : 'Sign & submit'}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="mb-2 text-sm font-medium text-text-primary">Why can't you sign this?</p>
                  <Textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Optional — let them know what needs to change" rows={3} />
                  <div className="mt-4 flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => setDeclining(false)} disabled={submitting}>
                      Back
                    </Button>
                    <Button variant="secondary" onClick={handleDecline} disabled={submitting} className="!border-danger !text-danger">
                      {submitting ? 'Submitting…' : 'Decline to sign'}
                    </Button>
                  </div>
                </>
              )}
            </Card>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
