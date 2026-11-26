/**
 * Staff — /staff/legal-terms
 * Published legal document versions with accepted/pending counts, and the re-acceptance grace period.
 * Route is wrapped in <StaffRoute>; every RPC re-checks staff on the server. English only (staff tool, like AccountDetailPanel).
 */
import { useCallback, useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { fetchGraceDays, fetchLegalDocumentOverview, saveGraceDays } from '@/lib/legalEvidenceApi';
import { parseGraceDays, type LegalDocumentOverview } from '@/lib/legalEvidence';

type Load = { status: 'loading' } | { status: 'forbidden' } | { status: 'error' } | { status: 'ready'; docs: LegalDocumentOverview[]; grace: number };

export function StaffLegalTermsPage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [days, setDays] = useState('0');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const [docs, grace] = await Promise.all([fetchLegalDocumentOverview(), fetchGraceDays()]);
      setDays(String(grace));
      setLoad({ status: 'ready', docs, grace });
    } catch (e) {
      setLoad({ status: (e as { code?: string } | null)?.code === '42501' ? 'forbidden' : 'error' });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const onSave = async () => {
    if (busy) return;
    const n = parseGraceDays(days);
    if (n === null) return setMsg({ kind: 'err', text: 'Grace must be a whole number of days from 0 to 90.' });
    if (reason.trim().length < 10) return setMsg({ kind: 'err', text: 'Write a reason of at least 10 characters.' });
    setBusy(true);
    setMsg(null);
    try {
      await saveGraceDays(n, reason.trim());
      setReason('');
      setMsg({ kind: 'ok', text: 'Saved.' });
      await refresh();
    } catch {
      setMsg({ kind: 'err', text: 'Could not save. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <header>
          <h1 className="text-xl font-semibold text-text-primary">Legal terms</h1>
          <p className="text-sm text-text-secondary">Published versions, who has accepted, and the grace period before a material update blocks the product. Publishing is done with publish_legal_document_version() (see docs/LEGAL_TERMS_VERSIONING.md).</p>
        </header>

        {load.status === 'loading' && <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" role="status" aria-label="Loading" />}
        {load.status === 'forbidden' && <p role="alert" className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">Staff access is required.</p>}
        {load.status === 'error' && (
          <p role="alert" className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">
            Could not load. <button type="button" onClick={() => void refresh()} className="focus-ring rounded font-medium text-accent hover:underline">Retry</button>
          </p>
        )}

        {load.status === 'ready' && (
          <>
            <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full min-w-[760px] text-sm">
                <caption className="sr-only">Legal document versions</caption>
                <thead>
                  <tr className="border-b border-border text-xs text-text-secondary">
                    {['Document', 'Version', 'Effective', 'Material', 'Gates product', 'Hash', 'Accepted', 'Pending'].map((h) => (
                      <th key={h} scope="col" className="px-4 py-3 text-start font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {load.docs.map((d) => (
                    <tr key={d.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 text-text-primary">{d.title}<span className="block text-[11px] text-text-secondary">{d.docKey}{d.status !== 'published' ? ` · ${d.status}` : ''}</span></td>
                      <td className="px-4 py-3 text-text-primary" dir="ltr">v{d.version}</td>
                      <td className="px-4 py-3 text-text-primary">{d.effectiveAt ? new Date(d.effectiveAt).toLocaleDateString() : '—'}</td>
                      <td className="px-4 py-3 text-text-primary">{d.isMaterial ? `Yes${d.noticeWaived ? ' (notice waived)' : ''}` : 'No'}</td>
                      <td className="px-4 py-3 text-text-primary">{d.gating ? 'Yes' : 'No'}</td>
                      <td className={`px-4 py-3 ${d.hasHash ? 'text-text-primary' : 'text-warning'}`}>{d.hasHash ? 'Recorded' : 'Missing'}</td>
                      <td className="px-4 py-3 text-text-primary" dir="ltr">{d.acceptedCount}</td>
                      <td className="px-4 py-3 text-text-primary" dir="ltr">{d.pendingCount === null ? 'n/a' : d.pendingCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <section className="rounded-2xl border border-border bg-bg-secondary p-6">
              <h2 className="text-sm font-semibold text-text-primary">Grace period</h2>
              <p className="mt-1 text-xs text-text-secondary">Days after a material version takes effect before the product is blocked until it is accepted. 0 = blocked immediately. Applies to all documents that gate the product. [COUNSEL] confirm a suitable default.</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
                <div>
                  <label htmlFor="grace-days" className="block text-xs font-medium text-text-secondary">Days (0–90)</label>
                  <input id="grace-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className="focus-ring mt-1 w-full rounded-control border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" dir="ltr" />
                </div>
                <div>
                  <label htmlFor="grace-reason" className="block text-xs font-medium text-text-secondary">Reason (audit-logged)</label>
                  <input id="grace-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="focus-ring mt-1 w-full rounded-control border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
                </div>
                <Button onClick={() => void onSave()} loading={busy} loadingLabel="Saving…">Save</Button>
              </div>
              {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={`mt-3 text-sm ${msg.kind === 'err' ? 'text-danger' : 'text-success'}`}>{msg.text}</p>}
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
