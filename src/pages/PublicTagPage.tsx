/**
 * Public Vireek Tag page — /t/:token (the URL inside every QR / NFC sticker).
 * No login needed. Signed-in technicians with access to the machine get the full history + quick tools.
 * Anything sensitive stays server-side: serial masked, no customer data, retired tags reveal nothing.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { AlertCircle, BookOpen, CheckCircle2, FileText, Flag, ShieldCheck, Wrench } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { EquipmentPassportView } from '@/components/passport/EquipmentPassportView';
import { TagMemberPanel } from '@/components/tags/TagMemberPanel';
import { equipmentTitle, formatPassportCode, warrantyState } from '@/lib/equipmentPassport';
import {
  detectSource, formatTagToken, isValidTagToken, normalizeTagToken, recordTagAction, resolveTag, submitTagServiceRequest,
  tagErrorMessage, validateServiceRequest, type TagBusiness, type TagDocument, type TagResolve, type Urgency,
} from '@/lib/vireekTag';

type Active = Extract<TagResolve, { state: 'active' }>;
const card = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark';
const field = 'w-full rounded-md border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';
const primary = 'focus-ring inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50';

const day = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

function Notice({ icon, title, body, children }: { icon?: 'alert' | 'info'; title: string; body: string; children?: React.ReactNode }) {
  return (
    <div role="alert" className={`${card} text-center`}>
      <AlertCircle className={`mx-auto ${icon === 'info' ? 'text-accent' : 'text-danger-500'}`} size={32} aria-hidden="true" />
      <h1 className="mt-3 text-lg font-semibold text-text-primary">{title}</h1>
      <p className="mt-1 text-sm text-text-secondary">{body}</p>
      {children}
    </div>
  );
}

function BookLink({ business }: { business: TagBusiness }) {
  return business.booking_slug ? (
    <Link to={`/book/${business.booking_slug}`} className={`${primary} mt-4`}>Book online with {business.name}</Link>
  ) : null;
}

function ServiceRequestForm({ token, business, onDone }: { token: string; business: TagBusiness; onDone: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', email: '', issue: '', urgency: 'soon' as Urgency, website: '' });
  const [errors, setErrors] = useState<ReturnType<typeof validateServiceRequest>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ref, setRef] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateServiceRequest(f);
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBusy(true); setError(null);
    try {
      const r = await submitTagServiceRequest({ token, ...f });
      setRef(r.reference ?? 'sent');
      onDone();
    } catch (err) {
      setError(tagErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (ref) {
    return (
      <div role="status" className="rounded-xl bg-success-500/10 p-4 text-sm text-text-primary">
        <p className="flex items-center gap-2 font-semibold"><CheckCircle2 size={16} className="text-success-500" aria-hidden="true" /> Request sent to {business.name}</p>
        <p className="mt-1 text-text-secondary">They will contact you shortly.{ref !== 'sent' && <> Reference <span className="font-mono">{ref}</span>.</>}</p>
      </div>
    );
  }

  const err = (k: keyof typeof errors) => (errors[k] ? <p role="alert" className="mt-1 text-xs text-danger-500">{errors[k]}</p> : null);
  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>Website<input tabIndex={-1} autoComplete="off" name="website" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></label>
      </div>
      <label className="block text-xs font-medium text-text-secondary">Your name
        <input className={`${field} mt-1`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" maxLength={120} required />{err('name')}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-text-secondary">Phone
          <input className={`${field} mt-1`} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" />{err('phone')}
        </label>
        <label className="block text-xs font-medium text-text-secondary">Email
          <input className={`${field} mt-1`} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />{err('email')}
        </label>
      </div>
      {err('contact')}
      <label className="block text-xs font-medium text-text-secondary">How urgent is it?
        <select className={`${field} mt-1`} value={f.urgency} onChange={(e) => setF({ ...f, urgency: e.target.value as Urgency })}>
          <option value="urgent">Urgent — no heat/cooling or a safety concern</option>
          <option value="soon">Soon — within a few days</option>
          <option value="routine">Routine — any time</option>
        </select>
      </label>
      <label className="block text-xs font-medium text-text-secondary">What’s going on? (optional)
        <textarea className={`${field} mt-1 min-h-[88px]`} value={f.issue} onChange={(e) => setF({ ...f, issue: e.target.value })} maxLength={1000} />{err('issue')}
      </label>
      {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
      <button type="submit" disabled={busy} className={`${primary} w-full`}>{busy ? 'Sending…' : 'Send request'}</button>
      <p className="text-[11px] text-text-secondary">Your details go only to {business.name}. For emergencies such as gas smells, call your local emergency number.</p>
    </form>
  );
}

function Documents({ docs, token }: { docs: TagDocument[]; token: string }) {
  const safe = docs.filter((d) => d.url.startsWith('https://'));
  return (
    <section className={card} aria-labelledby="tag-docs">
      <h2 id="tag-docs" className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary"><BookOpen size={15} className="text-accent" aria-hidden="true" /> Manual & documents</h2>
      {safe.length === 0 ? <p className="text-sm text-text-secondary">No manual is on file for this model yet.</p> : (
        <ul className="space-y-1.5">
          {safe.map((d) => (
            <li key={d.url}>
              <a href={d.url} target="_blank" rel="noopener noreferrer" onClick={() => void recordTagAction(token, 'manual_click')} className="focus-ring flex items-center gap-2 rounded-lg border border-border p-2.5 text-sm text-text-primary hover:border-accent/40">
                <FileText size={14} className="shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                <span className="text-[11px] uppercase text-text-secondary">{d.doc_type.replace(/_/g, ' ')}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActiveView({ data, token }: { data: Active; token: string }) {
  const p = data.passport.passport;
  const [open, setOpen] = useState(false);
  const [reported, setReported] = useState(false);
  const isMember = data.viewer === 'member';
  const w = p ? warrantyState(p.warranty_expires_at) : { state: 'unknown' as const, daysLeft: null };
  const warrantyText =
    w.state === 'active' ? `Covered until ${day(p?.warranty_expires_at)}`
    : w.state === 'expiring' ? `Expires in ${w.daysLeft} day${w.daysLeft === 1 ? '' : 's'} (${day(p?.warranty_expires_at)})`
    : w.state === 'expired' ? `Warranty period ended ${day(p?.warranty_expires_at)}`
    : 'Warranty end date is not on file.';

  const report = () => { setReported(true); void recordTagAction(token, 'tamper_report'); };

  return (
    <>
      <section className={`${card} flex items-start gap-3`}>
        <ShieldCheck className="mt-0.5 shrink-0 text-success-500" size={20} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">Verified Vireek Tag · {data.business.name}</p>
          <p className="text-xs text-text-secondary">Check that the make, model and serial below match the label on your unit. If they don’t, this sticker may be on the wrong machine.</p>
          <button type="button" onClick={report} disabled={reported} className="focus-ring mt-2 inline-flex items-center gap-1.5 text-xs text-text-secondary underline hover:text-text-primary disabled:no-underline">
            <Flag size={12} aria-hidden="true" /> {reported ? 'Thanks — the company has been alerted' : 'This tag looks wrong or damaged'}
          </button>
        </div>
      </section>

      {isMember && p && (
        <TagMemberPanel
          token={token} tagId={data.tag.id} passportCode={p.code} equipmentId={data.equipment_id}
          equipmentCaption={equipmentTitle(p)} businessName={data.business.name}
        />
      )}

      {!isMember && (
        <section className={card} aria-labelledby="tag-request">
          <h2 id="tag-request" className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary"><Wrench size={15} className="text-accent" aria-hidden="true" /> Need service?</h2>
          {!open ? (
            <>
              <p className="mb-3 text-sm text-text-secondary">Tell {data.business.name} what’s wrong — they already know which machine this is.</p>
              <button type="button" className={primary} onClick={() => { setOpen(true); void recordTagAction(token, 'request_click'); }}>Request service</button>
              <BookLink business={data.business} />
            </>
          ) : (
            <ServiceRequestForm token={token} business={data.business} onDone={() => undefined} />
          )}
        </section>
      )}

      <EquipmentPassportView data={data.passport} />

      <Documents docs={data.documents} token={token} />

      {!isMember && (
        <section className={card} aria-labelledby="tag-warranty">
          <h2 id="tag-warranty" className="mb-1 text-sm font-semibold text-text-primary">Warranty & registration</h2>
          <p className="text-sm text-text-secondary">{warrantyText}</p>
          {data.warranty_registered ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-text-primary"><CheckCircle2 size={15} className="text-success-500" aria-hidden="true" /> This unit has a warranty registration on file.</p>
          ) : (
            <Link
              to={`/warranty/register?code=${encodeURIComponent(p ? formatPassportCode(p.code) : '')}`}
              onClick={() => void recordTagAction(token, 'register_click')}
              className={`${primary} mt-3`}
            >Register your warranty</Link>
          )}
        </section>
      )}
    </>
  );
}

export function PublicTagPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { search } = useLocation();
  const normalized = normalizeTagToken(token);
  const source = detectSource(search);
  const [data, setData] = useState<TagResolve | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (!isValidTagToken(normalized)) { setData({ found: false, state: 'unknown' }); setLoading(false); return; }
    setLoading(true);
    resolveTag(normalized, source)
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [normalized, source, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-10">
        <div className="mx-auto w-full max-w-3xl space-y-5">
          {loading && <div className="h-72 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" />}

          {!loading && failed && (
            <Notice title="Could not load this tag" body="Check your connection and try again.">
              <button type="button" onClick={retry} className={`${primary} mt-4`}>Try again</button>
            </Notice>
          )}

          {!loading && !failed && data && !data.found && (
            <Notice title="Tag not recognised" body="This code was not issued by Vireek, or it was mistyped. Do not rely on it." />
          )}

          {!loading && !failed && data?.found && data.state === 'unassigned' && (
            <Notice icon="info" title="This tag isn’t activated yet" body={`It hasn’t been attached to a machine. Tag ${formatTagToken(normalized).slice(-9)}.`}>
              {data.can_assign && <Link to={`/dashboard/tags?assign=${normalized}`} className={`${primary} mt-4`}>Attach it to a machine</Link>}
            </Notice>
          )}

          {!loading && !failed && data?.found && data.state === 'rotated' && (
            <Notice icon="info" title="This sticker has been replaced" body={`For security, ${data.business.name} retired this tag. Look for the newer sticker on the unit, or contact the company directly.`}>
              <BookLink business={data.business} />
            </Notice>
          )}

          {!loading && !failed && data?.found && data.state === 'revoked' && (
            <Notice icon="info" title="This tag was deactivated" body={`${data.business.name} switched this tag off. Contact them directly for service.`}>
              <BookLink business={data.business} />
            </Notice>
          )}

          {!loading && !failed && data?.found && data.state === 'active' && <ActiveView data={data} token={normalized} />}

          {!loading && data?.found && data.state === 'active' && (
            <p className="text-center text-[11px] text-text-secondary">Personal details, addresses and prices are never shown on a public tag.</p>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
