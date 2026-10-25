// Shared building blocks for Vireek Pay & Capital screens.
import { useEffect, useState, type ReactNode } from 'react';
import { FlaskConical, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { acceptDisclosure, fetchDisclosure, PayError } from '@/lib/payApi';
import { describeUnavailable, type DisclosureDoc, type Tone } from '@/lib/pay';

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success-500/15 text-success-500',
  warning: 'bg-warning-500/15 text-warning-500',
  danger: 'bg-danger/15 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]}`}>{children}</span>;
}

/** Always visible whenever any number on screen came from sandbox data. */
export function SandboxBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-warning-500">
      <FlaskConical size={16} className="mt-0.5 shrink-0" />
      <span><strong>Sandbox mode.</strong> Nothing here is real: no money moves, no cards are issued and no credit decisions are made.</span>
    </div>
  );
}

export function UnavailableNotice({ reason }: { reason: string | null | undefined }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
      <ShieldAlert size={16} className="mt-0.5 shrink-0" />
      <span>{describeUnavailable(reason)}</span>
    </div>
  );
}

/** Shows the exact versioned terms and records acceptance (with the content hash the user saw). */
export function DisclosureGate({ disclosureKey, onAccepted }: { disclosureKey: string; onAccepted: () => void }) {
  const [doc, setDoc] = useState<DisclosureDoc | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchDisclosure(disclosureKey).then((d) => { if (!live) return; if (d?.accepted) onAccepted(); else setDoc(d); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the terms.'); });
    return () => { live = false; };
  }, [disclosureKey, onAccepted]);

  async function accept() {
    if (!doc) return;
    setBusy(true); setError(null);
    try { await acceptDisclosure(doc); onAccepted(); }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record your acceptance.');
      if (e instanceof PayError && e.code === 'stale_version') setDoc(await fetchDisclosure(disclosureKey).catch(() => null));
    } finally { setBusy(false); }
  }

  if (error && !doc) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (!doc) return <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-text-secondary" /></div>;

  return (
    <section aria-label={doc.title} className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="text-sm font-semibold text-text-primary">{doc.title}</h3>
      {!doc.legal_reviewed && <p className="mt-1 text-xs font-medium text-warning-500">Draft terms — not yet legally reviewed.</p>}
      <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-line rounded-lg bg-bg-primary p-3 text-sm leading-relaxed text-text-secondary" tabIndex={0}>{doc.body}</div>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-text-primary">
        <input type="checkbox" className="mt-0.5 h-5 w-5" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        I have read and understand these terms (version {doc.version}).
      </label>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <Button className="mt-3 w-full" disabled={!checked || busy} onClick={accept}>{busy ? 'Saving…' : 'Accept and continue'}</Button>
    </section>
  );
}
