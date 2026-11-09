/**
 * Home Passport pilot — /dashboard/home-passport/pilot  (flag: home_passport_pilot, default OFF)
 *
 * Managers: contributor opt-in, versioned snapshots, expiring share links + QR, ownership transfer with
 * recorded owner consent, pilot metrics and audit trail. All data comes from RPCs; nothing is typed into a passport.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Lock, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { computePassportProjections } from '@/lib/homeServicePassport';
import {
  CONSENT_METHOD_OPTIONS,
  RECIPIENT_OPTIONS,
  SHARE_CONSENT_TEXT,
  TRANSFER_CONSENT_TEXT,
  cancelTransfer,
  completeTransfer,
  createShare,
  createSnapshot,
  getMetrics,
  getPilotStatus,
  listAudit,
  listShares,
  listSnapshots,
  listTransfers,
  mapPilotError,
  requestTransfer,
  revokeShare,
  setPilotSettings,
  shareStateLabel,
  shareUrl,
  type AddressLevel,
  type ConsentMethod,
  type IssuedShare,
  type PilotAuditEntry,
  type PilotMetrics,
  type PilotShare,
  type PilotSnapshotMeta,
  type PilotStatus,
  type PilotTransfer,
  type RecipientType,
} from '@/lib/homePassportPilot';

interface CustomerOption { id: string; name: string }
interface SiteOption { id: string; name: string; city: string | null }

const FIELD = 'mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const LABEL = 'block text-sm font-medium text-text-primary';

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}

export function HomePassportPilotPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;
  const { ready: flagsReady, isEnabled } = useFeatureFlags();
  const flagOn = isEnabled('home_passport_pilot');

  const [status, setStatus] = useState<PilotStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [snapshots, setSnapshots] = useState<PilotSnapshotMeta[]>([]);
  const [shares, setShares] = useState<PilotShare[]>([]);
  const [transfers, setTransfers] = useState<PilotTransfer[]>([]);
  const [metrics, setMetrics] = useState<PilotMetrics | null>(null);
  const [audit, setAudit] = useState<PilotAuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingCustomer, setLoadingCustomer] = useState(false);

  // settings
  const [optIn, setOptIn] = useState(false);
  const [showCompany, setShowCompany] = useState(false);
  // snapshot
  const [addressLevel, setAddressLevel] = useState<AddressLevel>('city');
  const [withRanges, setWithRanges] = useState(false);
  // share
  const [snapshotId, setSnapshotId] = useState('');
  const [recipient, setRecipient] = useState<RecipientType>('buyer');
  const [label, setLabel] = useState('');
  const [validDays, setValidDays] = useState(30);
  const [maxViews, setMaxViews] = useState(100);
  const [shareConsent, setShareConsent] = useState(false);
  const [issued, setIssued] = useState<IssuedShare | null>(null);
  const [qr, setQr] = useState('');
  // transfer
  const [siteId, setSiteId] = useState('');
  const [method, setMethod] = useState<ConsentMethod>('owner_written');
  const [transferConsent, setTransferConsent] = useState(false);
  const [closing, setClosing] = useState('');

  const loadGlobal = useCallback(async () => {
    try {
      const st = await getPilotStatus();
      setStatus(st);
      setOptIn(!!st.contributor_opt_in);
      setShowCompany(!!st.show_company_name);
      if (st.enabled) {
        const [m, a] = await Promise.all([getMetrics(30), listAudit(50)]);
        setMetrics(m);
        setAudit(a);
      }
    } catch {
      setStatusError(true);
    }
  }, []);

  useEffect(() => {
    if (!canAccess || !flagOn) return;
    void loadGlobal();
  }, [canAccess, flagOn, loadGlobal]);

  useEffect(() => {
    if (!status?.enabled) return;
    let cancelled = false;
    supabase.from('customers').select('id, name').order('name', { ascending: true }).limit(1000).then(({ data, error }) => {
      if (cancelled) return;
      if (error) toast('Could not load customers', 'error');
      setCustomers((data ?? []) as CustomerOption[]);
    });
    return () => { cancelled = true; };
  }, [status?.enabled, toast]);

  const loadCustomer = useCallback(async (id: string) => {
    if (!id) return;
    setLoadingCustomer(true);
    try {
      const [snaps, sh, tr, siteRes] = await Promise.all([
        listSnapshots(id), listShares(id), listTransfers(id),
        supabase.from('customer_sites').select('id, name, city').eq('customer_id', id).order('is_primary', { ascending: false }).limit(50),
      ]);
      setSnapshots(snaps);
      setShares(sh);
      setTransfers(tr);
      const s = ((siteRes.data ?? []) as SiteOption[]);
      setSites(s);
      setSiteId((cur) => (s.some((x) => x.id === cur) ? cur : (s[0]?.id ?? '')));
      setSnapshotId((cur) => (snaps.some((x) => x.snapshot_id === cur) ? cur : (snaps[0]?.snapshot_id ?? '')));
    } catch (e) {
      toast(mapPilotError(e), 'error');
    } finally {
      setLoadingCustomer(false);
    }
  }, [toast]);

  useEffect(() => { setIssued(null); setQr(''); void loadCustomer(customerId); }, [customerId, loadCustomer]);

  const run = useCallback(async (fn: () => Promise<void>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(okMsg, 'success');
      await Promise.all([loadCustomer(customerId), loadGlobal()]);
    } catch (e) {
      toast(mapPilotError(e), 'error');
    } finally {
      setBusy(false);
    }
  }, [customerId, loadCustomer, loadGlobal, toast]);

  const projections = useCallback(async () => (withRanges ? computePassportProjections(customerId) : null), [withRanges, customerId]);

  const pendingTransfer = useMemo(() => transfers.find((t) => t.status === 'pending'), [transfers]);

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Home Passport Pilot">
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-20 text-center">
          <Lock size={26} aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold text-text-primary">Managers only</h1>
        </div>
      </DashboardLayout>
    );
  }

  if (flagsReady && !flagOn) {
    return (
      <DashboardLayout activeLabel="Home Passport Pilot">
        <Card className="p-8 text-center">
          <Lock className="mx-auto" size={26} aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold text-text-primary">Home Passport pilot</h1>
          <p className="mt-1 text-sm text-text-secondary">This pilot is not enabled for your account. Contact Vireek to join.</p>
        </Card>
      </DashboardLayout>
    );
  }

  if (!status && !statusError) {
    return <DashboardLayout activeLabel="Home Passport Pilot"><div className="h-40 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" aria-label="Loading" /></DashboardLayout>;
  }

  if (statusError) {
    return (
      <DashboardLayout activeLabel="Home Passport Pilot">
        <Card className="p-6 text-center" role="alert">
          <p className="text-sm text-text-primary">Could not load the pilot status.</p>
          <Button className="mt-3" onClick={() => { setStatusError(false); void loadGlobal(); }}>Try again</Button>
        </Card>
      </DashboardLayout>
    );
  }

  if (!status?.enabled) {
    return (
      <DashboardLayout activeLabel="Home Passport Pilot">
        <Card className="p-8 text-center">
          <Lock className="mx-auto" size={26} aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold text-text-primary">Home Passport pilot</h1>
          <p className="mt-1 text-sm text-text-secondary">This pilot is not enabled for your account. Contact Vireek to join.</p>
        </Card>
      </DashboardLayout>
    );
  }

  const issueShare = () => run(async () => {
    const r = await createShare({ snapshotId, recipientType: recipient, label, validDays, maxViews, consent: shareConsent });
    setIssued(r);
    setQr(await QRCode.toDataURL(shareUrl(window.location.origin, r.token), { margin: 1, width: 220 }));
    setShareConsent(false);
  }, 'Share link created');

  return (
    <DashboardLayout activeLabel="Home Passport Pilot">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><ShieldCheck size={22} aria-hidden="true" /> Home Passport pilot</h1>
        <p className="mt-1 text-sm text-text-secondary">Versioned, sealed snapshots with expiring links. No customer contact details and no prices are ever included.</p>
      </div>

      <div className="space-y-4">
        <Card className="p-5">
          <h2 className="text-base font-semibold text-text-primary">Contribution settings</h2>
          <div className="mt-3 space-y-2">
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" className="mt-1" checked={optIn} disabled={busy}
                onChange={(e) => { setOptIn(e.target.checked); if (!e.target.checked) setShowCompany(false); }} />
              <span>Contribute to shared passports. Turning this off immediately revokes every live link.</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-text-primary">
              <input type="checkbox" className="mt-1" checked={showCompany} disabled={busy || !optIn} onChange={(e) => setShowCompany(e.target.checked)} />
              <span>Show my company name on shared passports (hidden by default).</span>
            </label>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => run(async () => { await setPilotSettings(optIn, showCompany); }, 'Settings saved')}>Save settings</Button>
        </Card>

        <Card className="p-5">
          <h2 className="text-base font-semibold text-text-primary">Pilot metrics (last {metrics?.window_days ?? 30} days)</h2>
          {metrics ? (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4" role="group" aria-label="Pilot metrics">
              <Tile label="Passports created" value={metrics.totals.passports_created} />
              <Tile label="Shares" value={metrics.totals.shares_created} />
              <Tile label="Views (hourly-deduplicated)" value={metrics.totals.share_views} />
              <Tile label="Transfers completed" value={metrics.totals.transfers_completed} />
            </div>
          ) : <div className="mt-3 h-16 animate-pulse rounded-xl bg-bg-secondary" aria-busy="true" />}
        </Card>

        <Card className="p-5">
          <label className={LABEL} htmlFor="pp-customer">Customer / property</label>
          <select id="pp-customer" className={FIELD} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Select a customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {customers.length === 0 && <p className="mt-2 text-sm text-text-secondary">No customers yet.</p>}
        </Card>

        {customerId && (
          <>
            <Card className="p-5">
              <h2 className="text-base font-semibold text-text-primary">1 · Create a snapshot</h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="pp-addr">Address detail</label>
                  <select id="pp-addr" className={FIELD} value={addressLevel} onChange={(e) => setAddressLevel(e.target.value as AddressLevel)}>
                    <option value="city">City and state only (recommended)</option>
                    <option value="full">Full street address</option>
                  </select>
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm text-text-primary">
                  <input type="checkbox" checked={withRanges} onChange={(e) => setWithRanges(e.target.checked)} />
                  Include estimated cost ranges
                </label>
              </div>
              <Button className="mt-3" disabled={busy || !optIn} onClick={() => run(async () => { await createSnapshot(customerId, addressLevel, await projections()); }, 'Snapshot created')}>Create new version</Button>
              {!optIn && <p className="mt-2 text-xs text-text-secondary">Save “Contribute to shared passports” first.</p>}
              {loadingCustomer ? <div className="mt-3 h-10 animate-pulse rounded bg-bg-secondary" aria-busy="true" /> : snapshots.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary">No snapshots yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-border text-sm">
                  {snapshots.map((s) => (
                    <li key={s.snapshot_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="text-text-primary">v{s.version} · {new Date(s.created_at).toLocaleString('en-US')} · {s.purpose === 'share' ? 'share' : 'ownership transfer'}</span>
                      <span className="text-xs text-text-secondary">{s.active_links} active link(s) · {s.snapshot_hash.slice(0, 10)}…</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-5">
              <h2 className="text-base font-semibold text-text-primary">2 · Share with consent</h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="pp-snap">Snapshot version</label>
                  <select id="pp-snap" className={FIELD} value={snapshotId} onChange={(e) => setSnapshotId(e.target.value)}>
                    {snapshots.map((s) => <option key={s.snapshot_id} value={s.snapshot_id}>v{s.version}</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL} htmlFor="pp-rec">Recipient</label>
                  <select id="pp-rec" className={FIELD} value={recipient} onChange={(e) => setRecipient(e.target.value as RecipientType)}>
                    {RECIPIENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL} htmlFor="pp-label">Label (optional)</label>
                  <input id="pp-label" className={FIELD} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={LABEL} htmlFor="pp-days">Expires (days)</label>
                    <input id="pp-days" type="number" min={1} max={90} className={FIELD} value={validDays} onChange={(e) => setValidDays(Number(e.target.value))} />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor="pp-views">Max views</label>
                    <input id="pp-views" type="number" min={1} max={1000} className={FIELD} value={maxViews} onChange={(e) => setMaxViews(Number(e.target.value))} />
                  </div>
                </div>
              </div>
              <label className="mt-3 flex items-start gap-2 text-sm text-text-primary">
                <input type="checkbox" className="mt-1" checked={shareConsent} onChange={(e) => setShareConsent(e.target.checked)} />
                <span>{SHARE_CONSENT_TEXT} <span className="text-xs text-text-secondary">(Draft wording — requires legal review.)</span></span>
              </label>
              <Button className="mt-3" disabled={busy || !shareConsent || !snapshotId} onClick={issueShare}>Create link</Button>

              {issued && (
                <div className="mt-4 rounded-xl border border-success-500/30 bg-success-500/5 p-4" role="status">
                  <p className="text-sm font-medium text-text-primary">Copy this link now — it is shown only once.</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded bg-bg-secondary p-2 text-xs">{shareUrl(window.location.origin, issued.token)}</code>
                    <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard.writeText(shareUrl(window.location.origin, issued.token)); toast('Link copied', 'success'); }}>
                      <Copy size={14} aria-hidden="true" /> Copy
                    </Button>
                  </div>
                  {qr && <img src={qr} alt="QR code for the share link" className="mt-3 h-40 w-40" />}
                  <p className="mt-2 text-xs text-text-secondary">Open the link and use “Print / save as PDF” on that page to produce a PDF.</p>
                </div>
              )}

              {shares.length > 0 && (
                <ul className="mt-4 divide-y divide-border text-sm">
                  {shares.map((s) => (
                    <li key={s.link_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="text-text-primary">v{s.version} · {s.recipient_type}{s.label ? ` · ${s.label}` : ''} · {s.view_count}/{s.max_views} views · {shareStateLabel(s.state)}</span>
                      {s.state === 'active' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(() => revokeShare(s.link_id), 'Link revoked')}>Revoke</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-5">
              <h2 className="text-base font-semibold text-text-primary">3 · Ownership transfer at sale</h2>
              {pendingTransfer ? (
                <div className="mt-3 space-y-3">
                  <p className="text-sm text-text-primary">Pending since {new Date(pendingTransfer.created_at).toLocaleDateString('en-US')} · expires {new Date(pendingTransfer.expires_at).toLocaleDateString('en-US')} · consent: {pendingTransfer.consent_method.replace('owner_', '').replace('_', ' ')}.</p>
                  <div>
                    <label className={LABEL} htmlFor="pp-close">Closing date</label>
                    <input id="pp-close" type="date" className={FIELD} value={closing} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setClosing(e.target.value)} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => run(async () => { await completeTransfer(pendingTransfer.transfer_id, closing || null); }, 'Transfer completed')}>Complete transfer</Button>
                    <Button variant="secondary" disabled={busy} onClick={() => run(() => cancelTransfer(pendingTransfer.transfer_id), 'Transfer cancelled')}>Cancel</Button>
                  </div>
                  <p className="text-xs text-text-secondary">Completing ends the seller’s ownership period, starts a name-free buyer period and revokes earlier share links.</p>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className={LABEL} htmlFor="pp-site">Property</label>
                      <select id="pp-site" className={FIELD} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                        {sites.length === 0 && <option value="">No property on file</option>}
                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.city ? ` · ${s.city}` : ''}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={LABEL} htmlFor="pp-method">How was the owner’s consent given?</label>
                      <select id="pp-method" className={FIELD} value={method} onChange={(e) => setMethod(e.target.value as ConsentMethod)}>
                        {CONSENT_METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <label className="flex items-start gap-2 text-sm text-text-primary">
                    <input type="checkbox" className="mt-1" checked={transferConsent} onChange={(e) => setTransferConsent(e.target.checked)} />
                    <span>{TRANSFER_CONSENT_TEXT} <span className="text-xs text-text-secondary">(Draft wording — requires legal review.)</span></span>
                  </label>
                  <Button disabled={busy || !transferConsent || !siteId || !optIn} onClick={() => run(async () => { await requestTransfer({ customerId, siteId, method, validDays: 30, addressLevel, projections: await projections() }); setTransferConsent(false); }, 'Transfer requested')}>Request transfer</Button>
                </div>
              )}
              {transfers.length > 0 && (
                <ul className="mt-4 divide-y divide-border text-sm">
                  {transfers.map((t) => <li key={t.transfer_id} className="py-2 text-text-primary">{new Date(t.created_at).toLocaleDateString('en-US')} · {t.status}{t.closing_date ? ` · closed ${t.closing_date}` : ''}</li>)}
                </ul>
              )}
            </Card>
          </>
        )}

        <Card className="p-5">
          <h2 className="text-base font-semibold text-text-primary">Audit trail</h2>
          {audit.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No activity yet.</p> : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Recent pilot activity</caption>
                <thead><tr className="text-text-secondary"><th scope="col" className="py-1 pr-3">When</th><th scope="col" className="pr-3">Action</th><th scope="col">By</th></tr></thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} className="border-t border-border text-text-primary">
                      <td className="py-1 pr-3">{new Date(a.created_at).toLocaleString('en-US')}</td>
                      <td className="pr-3">{a.action.replace('_', ' ')}</td>
                      <td>{a.by_public_visitor ? 'public visitor' : a.by_me ? 'you' : 'team member'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
}
