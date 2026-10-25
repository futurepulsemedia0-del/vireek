import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { CheckCircle2, MapPin, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { Skeleton } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useSEO } from '@/lib/seo';
import { setPostAuthPath } from '@/lib/inviteRedirect';
import { applyToPosting, fetchMyProfile, formatDateRange, formatPay, getOpenPosting, locationLabel, ratingDisplay, tradeLabel, type PostingDetail, type TalentProfile } from '@/lib/talentNetwork';

export function TalentJobPage() {
  const { slug = '' } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const [posting, setPosting] = useState<PostingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<TalentProfile | null>(null);
  const [cover, setCover] = useState('');
  const [rate, setRate] = useState('');
  const [avail, setAvail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useSEO({
    title: posting ? `${posting.title} — ${posting.company_name}` : 'Job — Vireek Talent Network',
    description: posting?.summary ?? 'Trade job on the Vireek Talent Network.',
    canonical: `https://vireek.com/talent/jobs/${slug}`,
  });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getOpenPosting(slug)
      .then((p) => alive && setPosting(p))
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Could not load this job.'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    if (!user) { setProfile(null); return; }
    fetchMyProfile().then(setProfile).catch(() => setProfile(null));
  }, [user]);

  async function submit() {
    if (!posting) return;
    setBusy(true);
    setApplyError(null);
    try {
      await applyToPosting(posting.id, { coverNote: cover.trim(), expectedRate: rate, availabilityNote: avail.trim() });
      setDone(true);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Could not submit your application.');
    } finally {
      setBusy(false);
    }
  }

  const here = `/talent/jobs/${slug}`;
  const ready = Boolean(profile && profile.terms_accepted_at && profile.status === 'active');

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-24 pt-28">
        <div className="mx-auto max-w-3xl">
          <BackButton fallback="/talent" label="All jobs" />
          {loading && <Skeleton className="mt-6 h-64 w-full rounded-2xl" />}
          {!loading && (error || !posting) && (
            <div role="alert" className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 text-text-primary">
              {error ?? 'This job is no longer open.'} <Link className="text-accent underline" to="/talent">See open jobs</Link>
            </div>
          )}
          {posting && (
            <>
              <h1 className="mt-6 text-3xl font-bold text-text-primary">{posting.title}</h1>
              <p className="mt-2 text-text-secondary">{posting.company_name} · {tradeLabel(posting.trade)} · Rating {ratingDisplay(posting.company_rating_avg, posting.company_rating_count)}</p>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-text-secondary">
                <span className="inline-flex items-center gap-1.5"><MapPin size={14} aria-hidden="true" />{locationLabel(posting)}</span>
                <span className="font-medium text-text-primary">{formatPay(posting)}</span>
                {posting.kind === 'gig' && <span>{formatDateRange(posting.starts_on, posting.ends_on)}</span>}
                <span>{posting.engagement_type === '1099' ? 'Independent contractor (1099)' : 'Employee (W-2)'}</span>
                <span>{posting.headcount} opening{posting.headcount > 1 ? 's' : ''}</span>
              </div>
              <div className="mt-8 whitespace-pre-wrap text-text-primary">{posting.description}</div>
              {posting.requirements.length > 0 && (
                <ul className="mt-6 list-disc space-y-1 pl-5 text-text-primary">
                  {posting.requirements.map((r) => <li key={r}>{r}</li>)}
                </ul>
              )}
              {(posting.requires_license || posting.requires_background_check || posting.min_references > 0) && (
                <div className="mt-8 rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-text-secondary">
                  <p className="flex items-center gap-2 font-medium text-text-primary"><ShieldCheck size={16} aria-hidden="true" />Before you can start</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {posting.requires_license && <li>A current trade license (the employer verifies it).</li>}
                    {posting.min_references > 0 && <li>{posting.min_references} professional reference(s).</li>}
                    {posting.requires_background_check && <li>A background check, only after a conditional offer, run by a screening provider with your written authorization.</li>}
                  </ul>
                </div>
              )}

              <section className="mt-10 rounded-2xl border border-border bg-bg-secondary p-6" aria-labelledby="apply-h">
                <h2 id="apply-h" className="text-xl font-semibold text-text-primary">Apply</h2>
                {done ? (
                  <p className="mt-4 flex items-center gap-2 text-text-primary"><CheckCircle2 size={18} className="text-accent" aria-hidden="true" />Application sent. Track it in <Link className="text-accent underline" to="/talent/me">your profile</Link>.</p>
                ) : !user ? (
                  <div className="mt-4 space-y-3 text-sm text-text-secondary">
                    <p>Create a free account to apply. Your profile is shared only with businesses you apply to.</p>
                    <div className="flex gap-3">
                      <Link to="/signup" onClick={() => setPostAuthPath(here)}><Button>Create account</Button></Link>
                      <Link to="/login" state={{ from: location.pathname }}><Button variant="secondary">Sign in</Button></Link>
                    </div>
                  </div>
                ) : !ready ? (
                  <p className="mt-4 text-sm text-text-secondary">Complete your talent profile and accept the terms first. <Link className="text-accent underline" to="/talent/me" onClick={() => setPostAuthPath(here)}>Set up profile</Link></p>
                ) : (
                  <div className="mt-4 space-y-4">
                    <p className="text-sm text-text-secondary">Applying shares your profile (name, trades, location, credentials list) with {posting.company_name}.</p>
                    <Textarea label="Note to the employer (optional)" value={cover} onChange={(e) => setCover(e.target.value)} maxLength={1500} rows={4} />
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Input label="Expected hourly rate (optional)" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="38.50" inputMode="decimal" />
                      <Input label="Availability (optional)" value={avail} onChange={(e) => setAvail(e.target.value)} maxLength={500} placeholder="Can start in 2 weeks" />
                    </div>
                    {applyError && <p role="alert" className="flex items-center gap-2 text-sm text-red-500"><TriangleAlert size={14} aria-hidden="true" />{applyError}</p>}
                    <Button onClick={() => void submit()} disabled={busy}>{busy ? 'Sending…' : 'Submit application'}</Button>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

export default TalentJobPage;
