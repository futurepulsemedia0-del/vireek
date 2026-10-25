import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ExternalLink, FileText, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Skeleton } from '@/components/Skeleton';
import { RatingForm } from '@/components/talent/RatingForm';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import {
  APPLICATION_STATUS_LABEL, BUSINESS_TAGS, REJECTION_REASONS, RELATIONSHIPS, TRADES, WORKER_TAGS, WORK_TYPES,
  acceptTerms, addReference, credentialBadge, deleteCredential, deleteMyProfile, deleteReference, exportMyData, fetchMyApplications,
  fetchMyCredentials, fetchMyEngagements, fetchMyProfile, fetchMyReferences, fetchMyReputation, formatDateRange, locationLabel,
  profileCompleteness, ratingDisplay, requestReference, saveCredential, saveMyProfile, signedDocumentUrl, uploadCredentialDocument,
  validateCredential, validateDocument, validateProfile, validateReference, withdrawApplication,
  type Credential, type CredentialInput, type EngagementRow, type MyApplication, type ProfileInput, type Reference, type ReferenceInput,
  type Reputation, type TalentProfile,
} from '@/lib/talentNetwork';

type Tab = 'profile' | 'credentials' | 'references' | 'applications' | 'work' | 'privacy';
const TABS: Array<[Tab, string]> = [['profile', 'Profile'], ['credentials', 'Licenses & certs'], ['references', 'References'], ['applications', 'Applications'], ['work', 'Work & ratings'], ['privacy', 'Privacy']];
const selectClass = 'w-full rounded-xl border border-border bg-bg-secondary px-3.5 py-3 text-sm text-text-primary focus:border-accent focus:outline-none';
const TERMS_VERSION = 'v1';

const toInput = (p: TalentProfile | null): ProfileInput => ({
  display_name: p?.display_name ?? '', headline: p?.headline ?? '', bio: p?.bio ?? '', phone: p?.phone ?? '', trades: p?.trades ?? [],
  experience_years: p?.experience_years != null ? String(p.experience_years) : '', city: p?.city ?? '', region: p?.region ?? '',
  country: p?.country ?? 'US', service_radius_miles: p?.service_radius_miles != null ? String(p.service_radius_miles) : '',
  open_to: p?.open_to ?? ['gig'], desired_hourly: p?.desired_hourly_cents != null ? (p.desired_hourly_cents / 100).toFixed(2) : '',
  availability: p?.availability ?? 'open', status: p?.status ?? 'active',
});
const EMPTY_CRED: CredentialInput = { kind: 'license', name: '', issuing_authority: '', credential_number: '', region: '', issued_on: '', expires_on: '' };
const EMPTY_REF: ReferenceInput = { referee_name: '', referee_email: '', referee_phone: '', relationship: 'supervisor', company: '', years_known: '' };
const toneClass = { good: 'bg-green-500/10 text-green-500', warn: 'bg-amber-500/10 text-amber-500', bad: 'bg-red-500/10 text-red-500', neutral: 'bg-bg-tertiary text-text-secondary' };

export function TalentWorkerPage() {
  useSEO({ title: 'My Talent Profile — Vireek', description: 'Manage your trade profile, credentials and applications.', canonical: 'https://vireek.com/talent/me' });
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('profile');
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<TalentProfile | null>(null);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [refs, setRefs] = useState<Reference[]>([]);
  const [apps, setApps] = useState<MyApplication[]>([]);
  const [work, setWork] = useState<EngagementRow[]>([]);
  const [rep, setRep] = useState<Reputation | null>(null);
  const [form, setForm] = useState<ProfileInput>(toInput(null));
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [terms, setTerms] = useState(false);
  const [cred, setCred] = useState<CredentialInput>(EMPTY_CRED);
  const [credFile, setCredFile] = useState<File | null>(null);
  const [credError, setCredError] = useState<string | null>(null);
  const [ref, setRef] = useState<ReferenceInput>(EMPTY_REF);
  const [refError, setRefError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rateOpen, setRateOpen] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const p = await fetchMyProfile();
      setProfile(p);
      setForm(toInput(p));
      if (p) {
        const [c, r, a, w, rp] = await Promise.all([fetchMyCredentials(), fetchMyReferences(), fetchMyApplications(), fetchMyEngagements(), fetchMyReputation()]);
        setCreds(c); setRefs(r); setApps(a); setWork(w); setRep(rp);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load your profile.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void reload(); }, [reload]);

  const completeness = useMemo(() => profileCompleteness(profile, creds.length, refs.length), [profile, creds.length, refs.length]);
  const set = <K extends keyof ProfileInput>(k: K, v: ProfileInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (k: 'trades' | 'open_to', v: string) => setForm((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));

  async function saveProfile() {
    const problem = validateProfile(form) ?? (!profile?.terms_accepted_at && !terms ? 'Accept the terms to continue.' : null);
    setFormError(problem);
    if (problem) return;
    setSaving(true);
    try {
      await saveMyProfile(form);
      if (!profile?.terms_accepted_at) await acceptTerms(TERMS_VERSION);
      toast('Profile saved.', 'success');
      await reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save your profile.');
    } finally {
      setSaving(false);
    }
  }

  async function addCredential() {
    if (!profile || !user) return;
    const problem = validateCredential(cred) ?? (credFile ? validateDocument(credFile) : null);
    setCredError(problem);
    if (problem) return;
    try {
      const path = credFile ? await uploadCredentialDocument(user.id, credFile) : undefined;
      await saveCredential(profile.id, cred, undefined, path);
      setCred(EMPTY_CRED); setCredFile(null);
      toast('Credential added.', 'success');
      setCreds(await fetchMyCredentials());
    } catch (e) {
      setCredError(e instanceof Error ? e.message : 'Could not save the credential.');
    }
  }

  async function addRef() {
    if (!profile) return;
    const problem = validateReference(ref, profile.contact_email);
    setRefError(problem);
    if (problem) return;
    try {
      await addReference(profile.id, ref);
      setRef(EMPTY_REF);
      setRefs(await fetchMyReferences());
    } catch (e) {
      setRefError(e instanceof Error ? e.message : 'Could not add the reference.');
    }
  }

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast(ok, 'success'); await reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); }
  }

  async function openDoc(path: string) {
    const url = await signedDocumentUrl(path);
    if (url) window.open(url, '_blank', 'noopener,noreferrer'); else toast('Could not open the document.', 'error');
  }

  async function download() {
    try {
      const blob = new Blob([await exportMyData()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vireek-talent-data.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export your data.', 'error');
    }
  }

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-24 pt-28">
        <div className="mx-auto max-w-3xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold text-text-primary">My talent profile</h1>
              <p className="mt-1 text-sm text-text-secondary">Shared only with businesses you apply to. <Link className="text-accent underline" to="/talent">Browse jobs</Link></p>
            </div>
            {profile && <p className="text-sm text-text-secondary">Profile {completeness}% complete · Rating {ratingDisplay(rep?.avg, rep?.count)}</p>}
          </div>

          <div role="tablist" aria-label="Sections" className="mt-6 flex flex-wrap gap-2">
            {TABS.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} disabled={!profile && k !== 'profile'} onClick={() => setTab(k)}
                className={`rounded-full border px-4 py-1.5 text-sm disabled:opacity-40 ${tab === k ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{l}</button>
            ))}
          </div>

          {loading ? <Skeleton className="mt-6 h-72 w-full rounded-2xl" /> : (
            <div className="mt-6 space-y-6">
              {tab === 'profile' && (
                <section className="space-y-5 rounded-2xl border border-border bg-bg-secondary p-6">
                  <Input label="Full name" required value={form.display_name} onChange={(e) => set('display_name', e.target.value)} maxLength={80} />
                  <Input label="Headline" value={form.headline} onChange={(e) => set('headline', e.target.value)} maxLength={120} placeholder="Licensed HVAC tech, 8 years residential service" />
                  <Textarea label="About you" value={form.bio} onChange={(e) => set('bio', e.target.value)} maxLength={2000} rows={5} />
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium text-text-primary">Trades (up to 8)</legend>
                    <div className="flex flex-wrap gap-2">
                      {TRADES.map(([v, l]) => (
                        <button key={v} type="button" aria-pressed={form.trades.includes(v)} onClick={() => toggle('trades', v)}
                          className={`rounded-full border px-3 py-1.5 text-sm ${form.trades.includes(v) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{l}</button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium text-text-primary">Open to</legend>
                    <div className="flex flex-wrap gap-2">
                      {WORK_TYPES.map(([v, l]) => (
                        <button key={v} type="button" aria-pressed={form.open_to.includes(v)} onClick={() => toggle('open_to', v)}
                          className={`rounded-full border px-3 py-1.5 text-sm ${form.open_to.includes(v) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{l}</button>
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Input label="City" required value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={80} />
                    <Input label="State" required value={form.region} onChange={(e) => set('region', e.target.value)} maxLength={40} placeholder="TX" />
                    <Input label="Travel radius (miles)" value={form.service_radius_miles} onChange={(e) => set('service_radius_miles', e.target.value)} inputMode="numeric" />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Input label="Years of experience" value={form.experience_years} onChange={(e) => set('experience_years', e.target.value)} inputMode="numeric" />
                    <Input label="Desired hourly rate" value={form.desired_hourly} onChange={(e) => set('desired_hourly', e.target.value)} inputMode="decimal" placeholder="38.50" />
                    <Input label="Phone (shared once you apply)" value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={30} />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="tw-avail" className="mb-1.5 block text-sm font-medium text-text-primary">Availability</label>
                      <select id="tw-avail" className={selectClass} value={form.availability} onChange={(e) => set('availability', e.target.value)}>
                        <option value="open">Open to work now</option><option value="limited">Limited availability</option><option value="unavailable">Not available</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="tw-status" className="mb-1.5 block text-sm font-medium text-text-primary">Profile status</label>
                      <select id="tw-status" className={selectClass} value={form.status} onChange={(e) => set('status', e.target.value)}>
                        <option value="active">Active (can apply)</option><option value="paused">Paused</option>
                      </select>
                    </div>
                  </div>
                  {!profile?.terms_accepted_at && (
                    <label className="flex items-start gap-3 text-sm text-text-secondary">
                      <input type="checkbox" className="mt-1" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
                      <span>I agree that when I apply, my profile and credential list are shared with that business, and that references and background checks are handled as described in the <Link className="text-accent underline" to="/privacy">Privacy Policy</Link>.</span>
                    </label>
                  )}
                  {formError && <p role="alert" className="text-sm text-red-500">{formError}</p>}
                  <Button onClick={() => void saveProfile()} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
                </section>
              )}

              {tab === 'credentials' && profile && (
                <section className="space-y-5">
                  {creds.map((c) => {
                    const b = credentialBadge(c);
                    return (
                      <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
                        <div>
                          <p className="font-medium text-text-primary">{c.name} <span className="text-xs text-text-secondary">({c.kind})</span></p>
                          <p className="text-sm text-text-secondary">{[c.issuing_authority, c.region, c.expires_on ? `expires ${c.expires_on}` : null].filter(Boolean).join(' · ')}</p>
                          <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs ${toneClass[b.tone]}`}>{b.label}</span>
                        </div>
                        <div className="flex gap-2">
                          {c.document_path && <Button variant="secondary" onClick={() => void openDoc(c.document_path!)}><FileText size={14} className="mr-1.5" />View</Button>}
                          <Button variant="secondary" aria-label={`Delete ${c.name}`} onClick={() => void run(() => deleteCredential(c), 'Credential removed.')}><Trash2 size={14} /></Button>
                        </div>
                      </div>
                    );
                  })}
                  <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5">
                    <h2 className="flex items-center gap-2 font-semibold text-text-primary"><Plus size={16} aria-hidden="true" />Add a license or certification</h2>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="tc-kind" className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
                        <select id="tc-kind" className={selectClass} value={cred.kind} onChange={(e) => setCred({ ...cred, kind: e.target.value as CredentialInput['kind'] })}>
                          <option value="license">Trade license</option><option value="certification">Certification</option>
                        </select>
                      </div>
                      <Input label="Name" required value={cred.name} onChange={(e) => setCred({ ...cred, name: e.target.value })} placeholder="Journeyman Electrician" maxLength={120} />
                      <Input label="Issued by" value={cred.issuing_authority} onChange={(e) => setCred({ ...cred, issuing_authority: e.target.value })} maxLength={120} />
                      <Input label="License / certificate number" value={cred.credential_number} onChange={(e) => setCred({ ...cred, credential_number: e.target.value })} maxLength={60} />
                      <Input label="State" value={cred.region} onChange={(e) => setCred({ ...cred, region: e.target.value })} maxLength={40} placeholder="TX" />
                      <div />
                      <Input label="Issued" type="date" value={cred.issued_on} onChange={(e) => setCred({ ...cred, issued_on: e.target.value })} />
                      <Input label="Expires" type="date" value={cred.expires_on} onChange={(e) => setCred({ ...cred, expires_on: e.target.value })} />
                    </div>
                    <div>
                      <label htmlFor="tc-file" className="mb-1.5 block text-sm font-medium text-text-primary">Photo or PDF of the document (optional, private)</label>
                      <input id="tc-file" type="file" accept="application/pdf,image/*" onChange={(e) => setCredFile(e.target.files?.[0] ?? null)} className="text-sm text-text-secondary" />
                    </div>
                    {credError && <p role="alert" className="text-sm text-red-500">{credError}</p>}
                    <Button onClick={() => void addCredential()}>Add credential</Button>
                    <p className="flex items-center gap-2 text-xs text-text-secondary"><ShieldCheck size={14} aria-hidden="true" />Employers verify credentials against the issuer. Editing a credential resets its verification.</p>
                  </div>
                </section>
              )}

              {tab === 'references' && profile && (
                <section className="space-y-5">
                  {refs.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
                      <div>
                        <p className="font-medium text-text-primary">{r.referee_name} <span className="text-xs text-text-secondary">({RELATIONSHIPS[r.relationship]})</span></p>
                        <p className="text-sm text-text-secondary">{r.referee_email} · {r.status === 'received' ? 'Received' : r.status === 'requested' ? 'Requested' : r.status === 'expired' ? 'Expired' : 'Not requested yet'}</p>
                      </div>
                      <div className="flex gap-2">
                        {r.status !== 'received' && <Button variant="secondary" onClick={() => void run(() => requestReference(r.id), 'Request sent.')}>{r.status === 'requested' ? 'Resend' : 'Request'}</Button>}
                        <Button variant="secondary" aria-label={`Remove ${r.referee_name}`} onClick={() => void run(() => deleteReference(r.id), 'Reference removed.')}><Trash2 size={14} /></Button>
                      </div>
                    </div>
                  ))}
                  <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5">
                    <h2 className="font-semibold text-text-primary">Add a reference (up to 6)</h2>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Input label="Name" required value={ref.referee_name} onChange={(e) => setRef({ ...ref, referee_name: e.target.value })} maxLength={120} />
                      <Input label="Email" required type="email" value={ref.referee_email} onChange={(e) => setRef({ ...ref, referee_email: e.target.value })} maxLength={254} />
                      <div>
                        <label htmlFor="tr-rel" className="mb-1.5 block text-sm font-medium text-text-primary">How you know them</label>
                        <select id="tr-rel" className={selectClass} value={ref.relationship} onChange={(e) => setRef({ ...ref, relationship: e.target.value })}>
                          {Object.entries(RELATIONSHIPS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <Input label="Company" value={ref.company} onChange={(e) => setRef({ ...ref, company: e.target.value })} maxLength={120} />
                    </div>
                    {refError && <p role="alert" className="text-sm text-red-500">{refError}</p>}
                    <Button onClick={() => void addRef()}>Add reference</Button>
                    <p className="text-xs text-text-secondary">References answer through a private link. You can’t see their answers; employers you apply to can.</p>
                  </div>
                </section>
              )}

              {tab === 'applications' && (
                <section className="space-y-3">
                  {apps.length === 0 && <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">No applications yet. <Link className="text-accent underline" to="/talent">Find a job</Link></p>}
                  {apps.map((a) => (
                    <div key={a.application_id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-text-primary">{a.posting_title}</p>
                          <p className="text-sm text-text-secondary">{a.company_name} · {locationLabel(a)} · applied {new Date(a.applied_at).toLocaleDateString()}</p>
                        </div>
                        <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent">{APPLICATION_STATUS_LABEL[a.status]}</span>
                      </div>
                      {a.decision_reason && a.decision_reason !== 'see_notice' && <p className="mt-2 text-xs text-text-secondary">Reason: {REJECTION_REASONS[a.decision_reason] ?? 'Other'}</p>}
                      {a.decision_reason === 'see_notice' && <p className="mt-2 text-xs text-text-secondary">Check your email for the notices the employer is required to send you.</p>}
                      {a.background_check_url && ['invited', 'pending_provider'].includes(a.background_check_status ?? '') && (
                        <p className="mt-2 text-sm text-text-primary">The employer started a background check. <a className="inline-flex items-center gap-1 text-accent underline" href={a.background_check_url} target="_blank" rel="noopener noreferrer">Complete it with the screening provider<ExternalLink size={12} aria-hidden="true" /></a></p>
                      )}
                      {['submitted', 'reviewing', 'interview', 'offer'].includes(a.status) && (
                        <Button className="mt-3" variant="secondary" onClick={() => void run(() => withdrawApplication(a.application_id), 'Application withdrawn.')}>Withdraw</Button>
                      )}
                    </div>
                  ))}
                </section>
              )}

              {tab === 'work' && (
                <section className="space-y-3">
                  {rep && rep.count > 0 && <p className="text-sm text-text-secondary">Your rating: <span className="font-medium text-text-primary">{ratingDisplay(rep.avg, rep.count)}</span>{rep.tags.length > 0 && ` · ${rep.tags.slice(0, 3).map((t) => WORKER_TAGS[t.tag] ?? t.tag).join(', ')}`}</p>}
                  {work.length === 0 && <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">No engagements yet.</p>}
                  {work.map((w) => (
                    <div key={w.engagement_id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                      <p className="font-medium text-text-primary">{w.posting_title} <span className="text-xs text-text-secondary">· {w.company_name}</span></p>
                      <p className="text-sm text-text-secondary">{formatDateRange(w.starts_on, w.ends_on)} · {w.status} · {w.engagement_type === '1099' ? '1099 contractor' : 'W-2 employee'}</p>
                      {(w.status === 'completed' || w.status === 'terminated') && (
                        rateOpen === w.engagement_id
                          ? <div className="mt-3"><RatingForm engagementId={w.engagement_id} tags={BUSINESS_TAGS} theirTags={WORKER_TAGS} onDone={() => void reload()} /></div>
                          : <Button className="mt-3" variant="secondary" onClick={() => setRateOpen(w.engagement_id)}>{w.my_rating_submitted ? 'View ratings' : 'Rate this business'}</Button>
                      )}
                    </div>
                  ))}
                </section>
              )}

              {tab === 'privacy' && (
                <section className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">
                  <p>Your profile is private. A business sees it only after you apply to one of its postings. Reference answers are confidential. Background-check reports stay with the screening provider; Vireek stores only the status.</p>
                  <div className="flex flex-wrap gap-3">
                    <Button variant="secondary" onClick={() => void download()}><Download size={14} className="mr-2" />Download my data</Button>
                    <Button variant="secondary" onClick={() => setConfirmDelete(true)}><Trash2 size={14} className="mr-2" />Delete my profile</Button>
                  </div>
                  <p className="text-xs">Businesses keep their own hiring records for legal retention periods after you delete your profile.</p>
                </section>
              )}
            </div>
          )}
        </div>
      </main>
      <Footer />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete your talent profile?"
        description="This removes your profile, credentials, documents and references and withdraws open applications. It cannot be undone."
        confirmLabel="Delete profile"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          if (!user) return;
          try {
            await deleteMyProfile(user.id, creds.map((c) => c.document_path).filter((p): p is string => Boolean(p)));
            setProfile(null); setCreds([]); setRefs([]); setApps([]); setWork([]); setForm(toInput(null)); setTab('profile');
            toast('Your profile was deleted.', 'success');
          } catch (e) {
            toast(e instanceof Error ? e.message : 'Could not delete your profile.', 'error');
          }
        }}
      />
    </>
  );
}

export default TalentWorkerPage;
