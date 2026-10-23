import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Lock, PhoneCall, Plus, RefreshCw, ShieldAlert, Trash2, TriangleAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonStatGrid } from '@/components/Skeleton';
import {
  DEFAULT_SETTINGS,
  SOURCE_KIND_LABELS,
  STATUS_LABELS,
  buildCurlSnippet,
  defaultDisclosure,
  disclosureGaps,
  formatMs,
  formatPhone,
  humanReasonLabel,
  parseDelays,
  slaPercent,
  toUsE164,
  validateSettings,
  type SourceKind,
  type SpeedToLeadMetrics,
  type SpeedToLeadRequest,
  type SpeedToLeadSettings,
  type SpeedToLeadSource,
} from '@/lib/speedToLead';
import {
  createSource,
  deleteSource,
  fetchMetrics,
  fetchRequests,
  fetchSettings,
  fetchSources,
  intakeEndpointUrl,
  markHandled,
  revokeConsent,
  saveSettings,
  updateSource,
} from '@/lib/speedToLeadApi';

const card = 'rounded-2xl border border-border bg-bg-secondary p-5';
const select =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={card}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function SpeedToLeadPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const businessName = (profile as { company_name?: string | null } | null)?.company_name ?? '';

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SpeedToLeadSettings>(DEFAULT_SETTINGS);
  const [delaysText, setDelaysText] = useState('5, 60');
  const [sources, setSources] = useState<SpeedToLeadSource[]>([]);
  const [requests, setRequests] = useState<SpeedToLeadRequest[]>([]);
  const [metrics, setMetrics] = useState<SpeedToLeadMetrics | null>(null);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<SourceKind>('web_form');
  const [newDisclosure, setNewDisclosure] = useState('');
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<{ token: string; version: number; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState<SpeedToLeadSource | null>(null);
  const [revokePhone, setRevokePhone] = useState('');
  const [revokeNote, setRevokeNote] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    const id = ++requestRef.current;
    setLoadError(null);
    try {
      const [s, src, reqs, m] = await Promise.all([
        fetchSettings(accountOwnerId),
        fetchSources(accountOwnerId),
        fetchRequests(accountOwnerId),
        fetchMetrics(30).catch(() => null),
      ]);
      if (id !== requestRef.current) return;
      setSettings(s);
      setDelaysText(s.retry_delays_minutes.join(', '));
      setSources(src);
      setRequests(reqs);
      setMetrics(m);
    } catch (e) {
      if (id === requestRef.current) setLoadError(e instanceof Error ? e.message : 'Could not load speed-to-lead.');
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!newDisclosure) setNewDisclosure(defaultDisclosure(businessName));
  }, [businessName, newDisclosure]);

  const openHandoffs = useMemo(() => requests.filter((r) => r.needs_human && !r.handled_at), [requests]);
  const settingsErrors = useMemo(
    () => validateSettings({ ...settings, retry_delays_minutes: parseDelays(delaysText) }),
    [settings, delaysText],
  );
  const gaps = useMemo(() => disclosureGaps(newDisclosure), [newDisclosure]);

  async function onSaveSettings() {
    if (!accountOwnerId || settingsErrors.length) return;
    setSaving(true);
    try {
      await saveSettings(accountOwnerId, { ...settings, retry_delays_minutes: parseDelays(delaysText) });
      toast('Speed-to-lead settings saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save settings', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function onCreateSource() {
    if (!accountOwnerId) return;
    setCreating(true);
    try {
      const { source, token } = await createSource(accountOwnerId, { name: newName, kind: newKind, disclosure_text: newDisclosure });
      setSources((p) => [source, ...p]);
      setReveal({ token, version: source.disclosure_version, name: source.name });
      setNewName('');
      toast('Source created. Copy the token now; it is shown only once.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the source', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Could not copy. Select the text and copy it manually.', 'error');
    }
  }

  async function onToggleSource(src: SpeedToLeadSource) {
    try {
      const updated = await updateSource(src.id, { enabled: !src.enabled });
      setSources((p) => p.map((s) => (s.id === src.id ? updated : s)));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the source', 'error');
    }
  }

  async function onDeleteSource() {
    if (!deleting) return;
    try {
      await deleteSource(deleting.id);
      setSources((p) => p.filter((s) => s.id !== deleting.id));
      toast('Source deleted. Consent proof already collected is kept.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the source', 'error');
    } finally {
      setDeleting(null);
    }
  }

  async function onHandled(id: string) {
    try {
      await markHandled(id);
      setRequests((p) => p.map((r) => (r.id === id ? { ...r, handled_at: new Date().toISOString() } : r)));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the lead', 'error');
    }
  }

  async function onRevoke() {
    const phone = toUsE164(revokePhone);
    if (!phone) {
      toast('Enter a valid US phone number.', 'error');
      return;
    }
    try {
      await revokeConsent(phone, revokeNote);
      setRevokePhone('');
      setRevokeNote('');
      toast('Consent revoked and number added to the do-not-call list.', 'success');
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record the revocation', 'error');
    }
  }

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Speed to Lead">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-text-primary">Restricted</h2>
          <p className="mt-1 max-w-sm text-sm text-text-secondary">Ask the account owner for access to Speed to Lead.</p>
        </div>
      </DashboardLayout>
    );
  }

  const pct = metrics ? slaPercent(metrics) : null;

  return (
    <DashboardLayout activeLabel="Speed to Lead">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Speed to Lead</h1>
            <p className="mt-1 text-sm text-text-secondary">
              New web and ad leads with consent get an AI callback within {settings.sla_seconds} seconds, inside allowed hours.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw size={16} /> Refresh
          </Button>
        </div>

        <div className="flex gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-text-primary">
          <TriangleAlert size={18} className="mt-0.5 shrink-0" />
          <p>
            AI-voice calls require prior express written consent. Have counsel review docs/compliance/speed-to-lead-assumptions.md and
            your consent wording before turning this on.
          </p>
        </div>

        {loadError && (
          <div role="alert" className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
            {loadError}
          </div>
        )}

        {loading ? (
          <SkeletonStatGrid count={4} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Leads (30 d)" value={String(metrics?.total ?? 0)} />
              <Stat label={`Called within ${settings.sla_seconds} s`} value={pct === null ? '-' : `${pct}%`} hint={`Median ${formatMs(metrics?.median_ms)} · P90 ${formatMs(metrics?.p90_ms)}`} />
              <Stat label="Booked by AI" value={String(metrics?.booked ?? 0)} />
              <Stat label="Need a human" value={String(metrics?.open_handoffs ?? 0)} hint={`${metrics?.suppressed ?? 0} suppressed (DNC / revoked)`} />
            </div>

            {openHandoffs.length > 0 && (
              <section className={card} aria-labelledby="stl-handoffs">
                <h2 id="stl-handoffs" className="text-base font-semibold text-text-primary">Follow up now</h2>
                <ul className="mt-3 divide-y divide-border">
                  {openHandoffs.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {r.full_name ?? formatPhone(r.phone_e164)} · <a className="text-accent" href={`tel:${r.phone_e164}`}>{formatPhone(r.phone_e164)}</a>
                        </p>
                        <p className="text-xs text-text-secondary">{humanReasonLabel(r.human_reason)}{r.service ? ` · ${r.service}` : ''}</p>
                      </div>
                      <Button size="sm" variant="secondary" onClick={() => void onHandled(r.id)}>
                        <Check size={16} /> Handled
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className={card} aria-labelledby="stl-settings">
              <h2 id="stl-settings" className="text-base font-semibold text-text-primary">Settings</h2>
              <label className="mt-4 flex items-center gap-3 text-sm text-text-primary">
                <input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} className="h-5 w-5" />
                Call new consented leads automatically
              </label>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Input label="Response target (seconds)" type="number" min={15} max={300} value={settings.sla_seconds} onChange={(e) => setSettings({ ...settings, sla_seconds: Number(e.target.value) })} />
                <Input label="Max attempts (1-3)" type="number" min={1} max={3} value={settings.max_attempts} onChange={(e) => setSettings({ ...settings, max_attempts: Number(e.target.value) })} />
                <Input label="Calling window starts" type="time" value={settings.call_window_start} onChange={(e) => setSettings({ ...settings, call_window_start: e.target.value })} helperText="Recipient local time, never before 8:00 AM." />
                <Input label="Calling window ends" type="time" value={settings.call_window_end} onChange={(e) => setSettings({ ...settings, call_window_end: e.target.value })} helperText="Recipient local time, never after 9:00 PM." />
                <Input label="Retry delays (minutes)" value={delaysText} onChange={(e) => setDelaysText(e.target.value)} helperText="Up to two, e.g. 5, 60" />
                <Input label="Lead freshness (hours)" type="number" min={1} max={168} value={settings.lead_ttl_hours} onChange={(e) => setSettings({ ...settings, lead_ttl_hours: Number(e.target.value) })} helperText="Older leads go to a human instead." />
              </div>
              <div className="mt-4">
                <Textarea label="Extra qualification guidance (optional)" rows={3} maxLength={1500} value={settings.qualification_notes ?? ''} onChange={(e) => setSettings({ ...settings, qualification_notes: e.target.value })} helperText="Appended to the AI's brief, e.g. 'Ask whether it is a rental property.'" />
              </div>
              <label className="mt-4 flex items-center gap-3 text-sm text-text-primary">
                <input type="checkbox" checked={settings.notify_on_handoff} onChange={(e) => setSettings({ ...settings, notify_on_handoff: e.target.checked })} className="h-5 w-5" />
                Notify my team when a lead needs a human
              </label>
              {settingsErrors.length > 0 && (
                <ul role="alert" className="mt-4 list-disc space-y-1 pl-5 text-sm text-danger">
                  {settingsErrors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              <div className="mt-5">
                <Button onClick={() => void onSaveSettings()} disabled={saving || settingsErrors.length > 0}>
                  {saving ? 'Saving...' : 'Save settings'}
                </Button>
              </div>
            </section>

            <section className={card} aria-labelledby="stl-sources">
              <h2 id="stl-sources" className="text-base font-semibold text-text-primary">Lead sources & consent wording</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Each source has a secret token and the exact consent text your form shows. Call it from your server only, never from browser code.
              </p>

              {reveal && (
                <div className="mt-4 rounded-xl border border-accent/40 bg-accent/5 p-4">
                  <p className="text-sm font-semibold text-text-primary">Token for "{reveal.name}" (shown once)</p>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-bg-primary p-3 text-xs text-text-primary">{buildCurlSnippet(intakeEndpointUrl(), reveal.token, reveal.version)}</pre>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void copy(buildCurlSnippet(intakeEndpointUrl(), reveal.token, reveal.version))}>
                      <Copy size={16} /> {copied ? 'Copied' : 'Copy example'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setReveal(null)}>I saved it</Button>
                  </div>
                </div>
              )}

              {sources.length === 0 ? (
                <EmptyState className="mt-4" icon={PhoneCall} title="No lead sources yet" description="Create one below to get an intake endpoint and token." />
              ) : (
                <ul className="mt-4 divide-y divide-border">
                  {sources.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{s.name} <span className="text-text-secondary">· {SOURCE_KIND_LABELS[s.kind]}</span></p>
                        <p className="text-xs text-text-secondary">Token ending {s.token_hint} · consent text v{s.disclosure_version}{s.last_lead_at ? ` · last lead ${new Date(s.last_lead_at).toLocaleString()}` : ''}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => void onToggleSource(s)}>{s.enabled ? 'Disable' : 'Enable'}</Button>
                        <Button size="sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}><Trash2 size={16} /></Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-6 grid gap-4 border-t border-border pt-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Source name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Website contact form" />
                  <div>
                    <label htmlFor="stl-kind" className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
                    <select id="stl-kind" className={select} value={newKind} onChange={(e) => setNewKind(e.target.value as SourceKind)}>
                      {Object.entries(SOURCE_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                </div>
                <Textarea label="Consent text shown next to the checkbox (must match your form exactly)" rows={5} value={newDisclosure} onChange={(e) => setNewDisclosure(e.target.value)} />
                {gaps.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-warning">
                    {gaps.map((g) => <li key={g}>Missing: {g}</li>)}
                  </ul>
                )}
                <div>
                  <Button onClick={() => void onCreateSource()} disabled={creating || newName.trim().length < 2 || newDisclosure.trim().length < 80}>
                    <Plus size={16} /> {creating ? 'Creating...' : 'Create source'}
                  </Button>
                </div>
              </div>
            </section>

            <section className={card} aria-labelledby="stl-recent">
              <h2 id="stl-recent" className="text-base font-semibold text-text-primary">Recent leads</h2>
              {requests.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary">No leads yet.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-text-secondary">
                      <tr><th className="py-2 pr-3">Lead</th><th className="pr-3">Status</th><th className="pr-3">Time to call</th><th className="pr-3">Attempts</th><th>Received</th></tr>
                    </thead>
                    <tbody className="divide-y divide-border text-text-primary">
                      {requests.map((r) => (
                        <tr key={r.id}>
                          <td className="py-2 pr-3">{r.full_name ?? formatPhone(r.phone_e164)}<span className="block text-xs text-text-secondary">{formatPhone(r.phone_e164)}</span></td>
                          <td className="pr-3">{STATUS_LABELS[r.status]}{r.final_reason && r.status !== 'booked' ? <span className="block text-xs text-text-secondary">{humanReasonLabel(r.human_reason) || r.final_reason.replace(/_/g, ' ')}</span> : null}</td>
                          <td className="pr-3">{formatMs(r.time_to_first_dial_ms)}{r.sla_met === false ? <span className="ml-1 text-xs text-danger">late</span> : null}</td>
                          <td className="pr-3">{r.attempt_count}</td>
                          <td>{new Date(r.received_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className={card} aria-labelledby="stl-revoke">
              <h2 id="stl-revoke" className="flex items-center gap-2 text-base font-semibold text-text-primary"><ShieldAlert size={18} /> Customer asked us to stop</h2>
              <p className="mt-1 text-sm text-text-secondary">Revokes consent, adds the number to the do-not-call list and cancels queued calls. Do this the same day you hear it, by any channel.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Input label="Phone number" value={revokePhone} onChange={(e) => setRevokePhone(e.target.value)} placeholder="(415) 555-2671" />
                <Input label="Note (how they asked)" value={revokeNote} onChange={(e) => setRevokeNote(e.target.value)} maxLength={300} />
              </div>
              <div className="mt-4"><Button variant="secondary" onClick={() => void onRevoke()} disabled={!revokePhone.trim()}>Revoke consent</Button></div>
            </section>
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this source?"
        description="Its token stops working immediately. Consent proof already collected is kept."
        confirmLabel="Delete"
        onConfirm={() => void onDeleteSource()}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
