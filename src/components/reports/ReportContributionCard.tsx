import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { NEVER_SHARED, REPORT_TERMS_VERSION, SHARED_FIELDS, getContribution, setContribution, type ContributionState } from '@/lib/stateOfCalls';

/** Explicit, revocable, org-level opt-in. Default is NOT contributing. Only the account owner can change it. */
export function ReportContributionCard() {
  const { toast } = useToast();
  const [state, setState] = useState<ContributionState | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { try { setState(await getContribution()); } catch { toast('Could not load your data-sharing setting', 'error'); } }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const change = async (grant: boolean) => {
    setBusy(true);
    try { await setContribution(grant); setAgree(false); await load(); toast(grant ? 'Thank you — you are now contributing anonymized statistics.' : 'Withdrawn. You are excluded from all future reports.', 'success'); }
    catch { toast('Could not save. Only the account owner can change this.', 'error'); }
    finally { setBusy(false); }
  };
  if (!state) return null;
  const on = state.status === 'granted';

  return (
    <section aria-labelledby="report-consent-h" className="rounded-xl border border-border bg-bg-secondary p-5">
      <h3 id="report-consent-h" className="flex items-center gap-2 text-base font-semibold text-text-primary"><ShieldCheck size={18} className="text-accent" /> State of Home Service Calls — contribute anonymized statistics</h3>
      <p className="mt-2 text-sm text-text-secondary">Optional. Help publish an industry report and unlock the “You vs. similar businesses” comparison. Only anonymized counts leave your account, and a figure is published only when at least 10 businesses are behind it.</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div><h4 className="text-sm font-medium text-text-primary">What is shared</h4><ul className="mt-1 list-disc pl-5 text-sm text-text-secondary">{SHARED_FIELDS.map((f) => <li key={f.label}><strong>{f.label}:</strong> {f.detail}</li>)}</ul></div>
        <div><h4 className="text-sm font-medium text-text-primary">Never shared</h4><ul className="mt-1 list-disc pl-5 text-sm text-text-secondary">{NEVER_SHARED.map((f) => <li key={f}>{f}</li>)}</ul></div>
      </div>
      <p className="mt-3 text-xs text-text-secondary">You can withdraw at any time; you are then excluded from every future edition. Reports already published are aggregates and are not recalculated. Terms version: {REPORT_TERMS_VERSION}. See the <a className="underline" href="/privacy">Privacy Policy</a> and <a className="underline" href="/dpa">DPA</a>.</p>
      {on ? (
        <div className="mt-4 flex items-center gap-3"><span className="text-sm font-medium text-green-700">Contributing{state.granted_at ? ` since ${new Date(state.granted_at).toLocaleDateString()}` : ''}</span>
          <button disabled={busy || !state.can_manage} onClick={() => void change(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50">Withdraw consent</button></div>
      ) : (
        <div className="mt-4">
          <label className="flex items-start gap-2 text-sm text-text-primary"><input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={!state.can_manage} /> <span>I am authorized to act for this business and agree to contribute anonymized statistics as described above.</span></label>
          <button disabled={!agree || busy || !state.can_manage} onClick={() => void change(true)} className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Start contributing</button>
          {!state.can_manage && <p className="mt-2 text-xs text-text-secondary">Only the account owner can change this setting.</p>}
        </div>
      )}
    </section>
  );
}
