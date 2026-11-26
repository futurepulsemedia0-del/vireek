// Click-through for the Master Services Agreement, shown under /msa. Records user, timestamp, IP, user agent and the
// document hash through record_legal_click_through('msa_click_through'). Wording is [COUNSEL]: TODO(counsel) review
// the authority statement and whether signer name/title or an order-form reference must be captured.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { recordMsaAcceptance } from '@/lib/legalEvidenceApi';

export function MsaAcceptanceCard() {
  const { session, loading } = useAuth();
  const [authority, setAuthority] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return null;

  const submit = async () => {
    if (!authority || busy) return;
    setBusy(true);
    setError(null);
    try {
      await recordMsaAcceptance(title.trim() || undefined);
      setDone(true);
    } catch {
      setError('We could not save your acceptance. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="msa-accept-title" className="mx-auto mt-10 max-w-3xl rounded-2xl border border-border bg-bg-secondary p-6">
      <h2 id="msa-accept-title" className="text-lg font-semibold text-text-primary">Accept this agreement</h2>
      {!session ? (
        <p className="mt-2 text-sm text-text-secondary">
          To accept the Master Services Agreement for your business,{' '}
          <Link to="/login" state={{ from: '/msa' }} className="font-medium text-accent underline">sign in</Link> first.
        </p>
      ) : done ? (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-text-primary">
          <CheckCircle2 size={18} className="text-success" aria-hidden="true" /> Your acceptance has been recorded.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-text-secondary">
            Accepting records your account, the date and time, the version of this agreement and technical details of your connection (IP address and browser).
          </p>
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-text-secondary">
            <input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} className="focus-ring mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent" />
            <span>I have read this agreement and I am authorized to accept it on behalf of my business.</span>
          </label>
          <div className="mt-4 max-w-sm">
            <label htmlFor="msa-signer-title" className="block text-xs font-medium text-text-secondary">Your job title (optional)</label>
            <input id="msa-signer-title" type="text" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="organization-title" className="focus-ring mt-1 w-full rounded-control border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
          </div>
          {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
          <Button className="mt-5" onClick={() => void submit()} disabled={!authority || busy}>
            {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Accept agreement
          </Button>
        </>
      )}
    </section>
  );
}
