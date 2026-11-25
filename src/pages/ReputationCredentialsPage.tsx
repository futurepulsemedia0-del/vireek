import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Check, Copy, Loader as Loader2, ShieldOff } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  REPUTATION_DEFAULT_VALID_DAYS, REPUTATION_MAX_VALID_DAYS, REPUTATION_SCOPES, SCOPE_LABEL, buildEmbedSnippets, type ReputationScope,
} from '@/lib/reputationCredentials/core';
import {
  fetchReputationOverview, friendlyReputationError, issueReputationCredential, recordLicenseCheck, revokeReputationCredential,
  rowStatus, setReputationConsent, type RepCredentialRow, type RepOverview,
} from '@/lib/reputationCredentials/api';

const LABEL = 'Reputation credentials';
const FIELD = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring';
const BOX = 'rounded-xl border border-border p-4';
const SCOPE_HELP: Record<ReputationScope, string> = {
  verified_jobs: 'How many jobs were completed, and how many have verified work evidence. Counts only — no customers, addresses or prices.',
  outcomes: 'First-visit fix rate, callbacks, and ratings. Shown only from 10 completed jobs; smaller samples are published as “not enough data”.',
  license_checks: 'License type, issuer and expiry. Marked “checked” only if a manager recorded a check; never the license number.',
};
const fmt = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
const APP_URL = typeof window !== 'undefined' ? window.location.origin : 'https://vireek.com';
const FUNCTIONS_URL = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1`;

function CopyBtn({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const { toast } = useToast();
  return (
    <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => toast('Copy failed — select the text manually.', 'error')); }}>
      {done ? <Check size={14} /> : <Copy size={14} />}<span className="ml-1.5">{done ? 'Copied' : label}</span>
    </Button>
  );
}

export function ReputationCredentialsPage() {
  const { toast } = useToast();
  const [state, setState] = useState<RepOverview | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [subject, setSubject] = useState<string>('contractor'); // 'contractor' or a technician id
  const [draft, setDraft] = useState<ReputationScope[] | null>(null); // null = unchanged from saved consent
  const [days, setDays] = useState(REPUTATION_DEFAULT_VALID_DAYS);
  const [label, setLabel] = useState('');

  const load = useCallback(async () => {
    try { setState(await fetchReputationOverview()); setError(false); } catch { setError(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (tag: string, fn: () => Promise<string | void>, ok: string) => {
    setBusy(tag);
    try { const m = await fn(); toast(m || ok, 'success'); await load(); }
    catch (e) { toast(friendlyReputationError(e), 'error'); }
    finally { setBusy(null); }
  };

  const technicianId = subject === 'contractor' ? null : subject;
  const consent = useMemo(() => state?.consents.find((c) => (c.technician_id ?? null) === technicianId) ?? null, [state, technicianId]);
  useEffect(() => { setDraft(null); }, [subject]);

  if (error) return <DashboardLayout activeLabel={LABEL}><p role="alert" className="p-6 text-sm">Could not load reputation credentials. Please refresh.</p></DashboardLayout>;
  if (!state) return <DashboardLayout activeLabel={LABEL}><p role="status" className="p-6 text-sm text-text-secondary"><Loader2 size={14} className="mr-1.5 inline animate-spin" />Loading…</p></DashboardLayout>;

  const canActAs = (id: string | null) => (id === null ? state.is_manager : state.is_manager || id === state.self_technician_id);
  const consentEditable = technicianId === null ? state.is_manager : technicianId === state.self_technician_id; // technicians consent for themselves only
  const subjects = [...(state.is_manager ? [{ id: 'contractor', name: `${state.company} (business)` }] : []), ...state.technicians.map((t) => ({ id: t.id, name: t.name }))];
  const nameOf = (r: RepCredentialRow) => r.subject_name;

  return (
    <DashboardLayout activeLabel={LABEL}>
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold"><BadgeCheck size={22} aria-hidden="true" /> Reputation credentials</h1>
          <p className="mt-1 text-sm text-text-secondary">A signed, expiring credential built from your real job records. Anyone can verify it from a public link or an embeddable badge; you can revoke it any time and it stops verifying immediately.</p>
        </header>

        {subjects.length === 0 ? (
          <Card className="p-5 text-sm text-text-secondary">No technician profile is linked to your login yet, so there is nothing to issue.</Card>
        ) : (<>
          <Card className="space-y-4 p-5">
            <h2 className="text-base font-semibold">1 · Choose who and what to share</h2>
            <div>
              <label htmlFor="rc-subject" className="mb-1 block text-sm font-medium">Credential for</label>
              <select id="rc-subject" className={FIELD} value={subject} onChange={(e) => setSubject(e.target.value)}>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">I agree to publish{consentEditable ? '' : ' (only the technician themself can change this)'}</legend>
              {REPUTATION_SCOPES.map((s) => (
                <label key={s} className={`${BOX} flex items-start gap-3 text-sm`}>
                  <input type="checkbox" className="mt-1" disabled={!consentEditable}
                    checked={(draft ?? consent?.scopes ?? []).includes(s)}
                    onChange={(e) => { const base = draft ?? consent?.scopes ?? []; setDraft(e.target.checked ? [...new Set([...base, s])] : base.filter((x) => x !== s)); }} />
                  <span><strong>{SCOPE_LABEL[s]}</strong><br /><span className="text-text-secondary">{SCOPE_HELP[s]}</span></span>
                </label>
              ))}
            </fieldset>
            {consentEditable && (
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy === 'consent'} onClick={() => void run('consent', async () => {
                  const r = await setReputationConsent(technicianId, draft ?? consent?.scopes ?? []);
                  setDraft(null);
                  return r.credentials_revoked > 0 ? `Saved. ${r.credentials_revoked} credential(s) that included withdrawn items were revoked.` : 'Consent saved.';
                }, 'Consent saved.')}>{busy === 'consent' ? <Loader2 size={14} className="animate-spin" /> : null}<span>Save consent</span></Button>
                {consent && <Button variant="ghost" disabled={busy === 'withdraw'} onClick={() => void run('withdraw', async () => { const r = await setReputationConsent(technicianId, []); setDraft(null); return `Consent withdrawn. ${r.credentials_revoked} credential(s) revoked.`; }, 'Consent withdrawn.')}><ShieldOff size={14} /><span className="ml-1.5">Withdraw all consent &amp; revoke</span></Button>}
              </div>
            )}
            <p className="text-xs text-text-secondary">Counts and rates come from Vireek’s records and are fixed at the moment of issue. Changing consent or removing a technician revokes the affected credentials.</p>
          </Card>

          <Card className="space-y-4 p-5">
            <h2 className="text-base font-semibold">2 · Issue a credential</h2>
            {!consent ? <p className="text-sm text-text-secondary">Save consent first — a credential can only include items that were agreed.</p> : !canActAs(technicianId) ? <p className="text-sm text-text-secondary">You cannot issue this credential.</p> : (
              <>
                <p className="text-sm text-text-secondary">Will include: {consent.scopes.map((s) => SCOPE_LABEL[s]).join(', ')}.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="rc-days" className="mb-1 block text-sm font-medium">Valid for (days, max {REPUTATION_MAX_VALID_DAYS})</label>
                    <input id="rc-days" type="number" inputMode="numeric" min={1} max={REPUTATION_MAX_VALID_DAYS} className={FIELD} value={days} onChange={(e) => setDays(Number(e.target.value))} />
                  </div>
                  <div>
                    <label htmlFor="rc-label" className="mb-1 block text-sm font-medium">Internal label (optional)</label>
                    <input id="rc-label" maxLength={80} className={FIELD} value={label} onChange={(e) => setLabel(e.target.value)} />
                  </div>
                </div>
                <Button disabled={busy === 'issue' || !Number.isInteger(days) || days < 1 || days > REPUTATION_MAX_VALID_DAYS} onClick={() => void run('issue', async () => {
                  await issueReputationCredential({ technicianId, scopes: consent.scopes, validDays: days, label: label.trim() || undefined });
                  setLabel('');
                }, 'Credential issued.')}>{busy === 'issue' ? <Loader2 size={14} className="animate-spin" /> : null}<span>Issue credential</span></Button>
              </>
            )}
          </Card>

          <Card className="space-y-3 p-5">
            <h2 className="text-base font-semibold">3 · Issued credentials</h2>
            {state.credentials.length === 0 ? <p className="text-sm text-text-secondary">Nothing issued yet.</p> : (
              <ul className="space-y-3">
                {state.credentials.map((r) => {
                  const st = rowStatus(r);
                  const sn = buildEmbedSnippets({ appUrl: APP_URL, functionsUrl: FUNCTIONS_URL, id: r.id });
                  return (
                    <li key={r.id} className={BOX}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{nameOf(r)}{r.label ? ` · ${r.label}` : ''}</span>
                        <span className={`text-xs font-medium ${st === 'valid' ? 'text-success' : st === 'revoked' ? 'text-danger' : 'text-text-secondary'}`}>{st === 'valid' ? 'Valid' : st === 'revoked' ? 'Revoked' : 'Expired'}</span>
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">{r.scopes.map((s) => SCOPE_LABEL[s]).join(', ')} · issued {fmt(r.issued_at)} · {st === 'revoked' && r.revoked_at ? `revoked ${fmt(r.revoked_at)}` : `expires ${fmt(r.expires_at)}`}</p>
                      {st === 'valid' && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <CopyBtn value={sn.link} label="Copy link" />
                          <CopyBtn value={sn.html} label="Copy badge code" />
                          {canActAs(r.technician_id) && <Button size="sm" variant="ghost" disabled={busy === `x${r.id}`} onClick={() => { if (window.confirm('Revoke this credential? It will stop verifying immediately and cannot be reinstated.')) void run(`x${r.id}`, () => revokeReputationCredential(r.id, 'revoked_by_issuer'), 'Credential revoked.'); }}><ShieldOff size={14} /><span className="ml-1.5">Revoke</span></Button>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {state.is_manager && (
            <Card className="space-y-3 p-5">
              <h2 className="text-base font-semibold">License checks</h2>
              <p className="text-sm text-text-secondary">A license only shows as “checked” on a credential after an owner or admin confirms it. Editing a license clears its check.</p>
              {state.licenses.length === 0 ? <p className="text-sm text-text-secondary">No technician licenses on file.</p> : (
                <ul className="space-y-2">
                  {state.licenses.map((l) => (
                    <li key={l.id} className={`${BOX} flex flex-wrap items-center justify-between gap-2 text-sm`}>
                      <span>{state.technicians.find((t) => t.id === l.technician_id)?.name ?? 'Technician'} — {l.type}{l.name ? ` (${l.name})` : ''}{l.expires_at ? ` · expires ${fmt(l.expires_at)}` : ''}</span>
                      {l.checked_at ? <span className="text-xs text-success">Checked {fmt(l.checked_at)}</span> : (
                        <span className="flex gap-2">
                          <Button size="sm" variant="secondary" disabled={busy === `l${l.id}`} onClick={() => void run(`l${l.id}`, () => recordLicenseCheck(l.id, 'licensing_authority_lookup'), 'License check recorded.')}>Checked with the authority</Button>
                          <Button size="sm" variant="ghost" disabled={busy === `l${l.id}`} onClick={() => void run(`l${l.id}`, () => recordLicenseCheck(l.id, 'document_review'), 'License check recorded.')}>Reviewed the document</Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>)}
      </div>
    </DashboardLayout>
  );
}
