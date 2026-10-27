import { useCallback, useEffect, useRef, useState } from 'react';
import { Calculator, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { formatCents, type Campaign, type DirectMailSettings } from '@/lib/directMail';
import { fetchVerificationSummary, verificationLabel, verifyCampaignAddresses, verifyUntilDone, type VerificationSummary } from '@/lib/directMailAudience';

const NOTE_TONE = { ok: 'text-success', warn: 'text-warning-500', bad: 'text-danger' } as const;

/** Per-mailer address-check note for the recipients table. */
export function VerificationNote({ piece }: { piece: { status: string; verification_status?: string | null; verification_note?: string | null } }) {
  const v = verificationLabel(piece);
  return v ? <span className={`mt-1 block ${NOTE_TONE[v.tone]}`}>{v.text}</span> : null;
}

/** Before sending: cost estimate + address check. Shown for draft campaigns only. */
export function PreSendPanel({ campaign, settings, queued, onChanged }: {
  campaign: Campaign; settings: DirectMailSettings; queued: number; onChanged: () => void;
}) {
  const { toast } = useToast();
  const [summary, setSummary] = useState<VerificationSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setSummary(await fetchVerificationSummary(campaign.id));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [campaign.id]);

  useEffect(() => { void load(); }, [load, queued]);
  useEffect(() => { stopRef.current = false; return () => { stopRef.current = true; }; }, []);

  const unit = campaign.est_unit_cost_cents;
  const total = queued * unit;
  const cap = campaign.budget_cap_cents;
  const overCap = cap !== null && total > cap;
  const live = settings.api_mode === 'live';

  const run = async () => {
    setRunning(true);
    try {
      const { total: t, stalled } = await verifyUntilDone(() => verifyCampaignAddresses(campaign.id), undefined, () => stopRef.current);
      if (stalled) toast('The address checker is not responding right now. Nothing was lost — try again in a minute.', 'error');
      else if (t.undeliverable > 0 && t.blocking) toast(`${t.undeliverable} undeliverable address${t.undeliverable === 1 ? ' was' : 'es were'} removed from the send. You will not be charged for them.`, 'success');
      else toast('Address check finished.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The address check failed.', 'error');
    } finally {
      setRunning(false);
      await load();
      onChanged();
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Before you send">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Calculator size={16} className="text-accent" /> Before you send</h3>

      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
        <div><dt className="text-text-secondary">Mailers to print</dt><dd className="mt-0.5 text-base font-semibold text-text-primary">{queued.toLocaleString()}</dd></div>
        <div><dt className="text-text-secondary">Estimated cost</dt><dd className="mt-0.5 text-base font-semibold text-text-primary">{unit > 0 ? formatCents(total) : '—'}</dd></div>
        <div><dt className="text-text-secondary">Budget cap</dt><dd className="mt-0.5 text-base font-semibold text-text-primary">{cap !== null ? formatCents(cap) : 'None'}</dd></div>
      </dl>
      <p className="mt-2 text-xs text-text-secondary">
        {unit > 0 ? `${queued.toLocaleString()} × ${formatCents(unit)} per mailer. ` : 'Add your expected cost per mailer (Edit) to see an estimate. '}
        This is an estimate: Lob’s real price per piece replaces it in Results after sending.
      </p>
      {overCap && <p role="alert" className="mt-2 text-xs text-warning-500">The estimate is above your {formatCents(cap)} cap, so sending will pause when the cap is reached.</p>}

      <div className="mt-4 border-t border-border pt-4">
        <p className="flex items-center gap-2 text-xs font-semibold text-text-primary"><ShieldCheck size={14} className="text-accent" /> Address check (USPS, through Lob)</p>
        {loadError && <p role="alert" className="mt-2 text-xs text-danger">Couldn’t load the address check status. <button type="button" className="focus-ring rounded underline" onClick={() => void load()}>Try again</button></p>}
        {summary && (
          <p className="mt-2 text-xs text-text-secondary" role="status">
            {summary.deliverable} verified · {summary.review} to review · {summary.undeliverable} undeliverable · {summary.unverified} not checked yet
          </p>
        )}
        <p className="mt-1 text-xs text-text-secondary">
          {live ? 'Undeliverable addresses are removed from the send, so you are not charged to print them.' : 'In test mode the results are shown but no address is removed (the provider simulates test answers).'}
          {' '}Lob may bill address checks separately on live keys.
        </p>
        <div className="mt-3">
          <Button size="sm" variant="secondary" disabled={running || !settings.configured || queued === 0} onClick={() => void run()}>
            {running ? 'Checking…' : summary && summary.unverified === 0 && queued > 0 ? 'Check again' : 'Check addresses'}
          </Button>
          {!settings.configured && <span className="ml-3 text-xs text-text-secondary">Connect Lob in Setup first.</span>}
        </div>
      </div>

      <p className="mt-4 text-[11px] text-text-secondary">Not live-verified: this Lob integration follows Lob’s documentation and is tested against mocks only. Send 2–3 test-mode proofs before your first live mailing.</p>
    </section>
  );
}
