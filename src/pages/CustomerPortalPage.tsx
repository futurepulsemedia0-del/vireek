import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertCircle,
  Briefcase,
  FileText,
  Award,
  Send,
  User,
  CheckCircle2,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import {
  fetchPortalBundle,
  submitServiceRequest,
  updateContactInfo,
  JOB_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  formatAmount,
  formatCents,
  formatPortalDate,
  type PortalBundle,
} from '@/lib/customerPortal';

type Tab = 'jobs' | 'quotes' | 'request' | 'profile';

function JobStatusBadge({ status }: { status: PortalBundle['jobs'][number]['job_status'] }) {
  const colors: Record<typeof status, string> = {
    scheduled: 'bg-accent/10 text-accent',
    en_route: 'bg-warning-500/10 text-warning-500',
    in_progress: 'bg-warning-500/10 text-warning-500',
    completed: 'bg-success-500/10 text-success',
    cancelled: 'bg-bg-tertiary text-text-secondary',
  };
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${colors[status]}`}>
      {JOB_STATUS_LABELS[status]}
    </span>
  );
}

function QuoteStatusBadge({ status }: { status: PortalBundle['quotes'][number]['status'] }) {
  const colors: Record<typeof status, string> = {
    draft: 'bg-bg-tertiary text-text-secondary',
    sent: 'bg-accent/10 text-accent',
    accepted: 'bg-success-500/10 text-success',
    declined: 'bg-bg-tertiary text-text-secondary',
    expired: 'bg-danger/10 text-danger',
  };
  const labels: Record<typeof status, string> = {
    draft: 'Draft',
    sent: 'Awaiting your response',
    accepted: 'Accepted',
    declined: 'Declined',
    expired: 'Expired',
  };
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${colors[status]}`}>
      {labels[status]}
    </span>
  );
}

export function CustomerPortalPage() {
  const { token } = useParams<{ token: string }>();
  const [bundle, setBundle] = useState<PortalBundle | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('jobs');

  // Service request form
  const [reqServiceType, setReqServiceType] = useState('');
  const [reqMessage, setReqMessage] = useState('');
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqDone, setReqDone] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);

  // Contact info form
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const data = await fetchPortalBundle(token);
      setBundle(data);
      if (data) {
        setPhone(data.customer.phone ?? '');
        setEmail(data.customer.email ?? '');
      }
    })();
  }, [token]);

  const upcomingJobs = useMemo(
    () => (bundle?.jobs ?? []).filter((j) => j.job_status !== 'completed' && j.job_status !== 'cancelled'),
    [bundle],
  );
  const pastJobs = useMemo(
    () => (bundle?.jobs ?? []).filter((j) => j.job_status === 'completed' || j.job_status === 'cancelled'),
    [bundle],
  );

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (!reqServiceType.trim() && !reqMessage.trim()) {
      setReqError('Tell us a bit about what you need.');
      return;
    }
    setReqSubmitting(true);
    setReqError(null);
    const ok = await submitServiceRequest(token, reqServiceType, reqMessage);
    if (ok) {
      setReqDone(true);
      setReqServiceType('');
      setReqMessage('');
    } else {
      setReqError("Couldn't submit your request — please call us directly.");
    }
    setReqSubmitting(false);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setProfileSaving(true);
    setProfileError(null);
    setProfileSaved(false);
    const ok = await updateContactInfo(token, phone, email);
    if (ok) {
      setProfileSaved(true);
    } else {
      setProfileError("Couldn't save your changes — please call us directly.");
    }
    setProfileSaving(false);
  };

  const TABS: { key: Tab; label: string; icon: typeof Briefcase }[] = [
    { key: 'jobs', label: 'My Appointments', icon: Briefcase },
    { key: 'quotes', label: 'Quotes', icon: FileText },
    { key: 'request', label: 'Request Service', icon: Send },
    { key: 'profile', label: 'My Info', icon: User },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-3xl">
          {bundle === undefined && (
            <p className="py-20 text-center text-sm text-text-secondary">Loading your account…</p>
          )}

          {bundle === null && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Portal not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                This link isn't valid, or the self-service portal isn't turned on for this business yet.
                Please call the business directly for help.
              </p>
            </div>
          )}

          {bundle && (
            <>
              <div className="mb-6">
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">Hi {bundle.customer.name.split(' ')[0]},</h1>
                <p className="mt-1 text-sm text-text-secondary">
                  Your account with {bundle.business_name ?? 'us'}
                </p>
              </div>

              {bundle.membership && (
                <div className="mb-6 flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
                    <Award size={18} />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      {bundle.membership.plan_name ?? 'Membership'} — {bundle.membership.status === 'active' ? 'Active' : bundle.membership.status === 'offered' ? 'Offered' : 'Cancelled'}
                    </p>
                    {bundle.membership.benefits && bundle.membership.benefits.length > 0 && (
                      <p className="text-xs text-text-secondary">{bundle.membership.benefits.join(' · ')}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
                  >
                    <t.icon size={13} />
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Appointments */}
              {tab === 'jobs' && (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                    <h2 className="text-sm font-semibold text-text-primary">Upcoming</h2>
                    {upcomingJobs.length === 0 ? (
                      <p className="mt-3 text-sm text-text-secondary">No upcoming appointments.</p>
                    ) : (
                      <div className="mt-4 space-y-3">
                        {upcomingJobs.map((j) => (
                          <div key={j.id} className="rounded-xl border border-border/60 p-3.5">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-medium text-text-primary">{j.service_type ?? 'Service visit'}</p>
                                <p className="mt-0.5 flex items-center gap-1 text-xs text-text-secondary">
                                  <Clock size={11} /> {formatPortalDate(j.scheduled_datetime)}
                                </p>
                              </div>
                              <JobStatusBadge status={j.job_status} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                    <h2 className="text-sm font-semibold text-text-primary">Past Service</h2>
                    {pastJobs.length === 0 ? (
                      <p className="mt-3 text-sm text-text-secondary">No past service on file yet.</p>
                    ) : (
                      <div className="mt-4 space-y-3">
                        {pastJobs.map((j) => (
                          <div key={j.id} className="rounded-xl border border-border/60 p-3.5">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-medium text-text-primary">{j.service_type ?? 'Service visit'}</p>
                                <p className="mt-0.5 flex items-center gap-1 text-xs text-text-secondary">
                                  <Clock size={11} /> {formatPortalDate(j.scheduled_datetime ?? j.created_at)}
                                </p>
                              </div>
                              <JobStatusBadge status={j.job_status} />
                            </div>
                            {j.invoice_amount !== null && (
                              <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2 text-xs">
                                <span className="text-text-secondary">{INVOICE_STATUS_LABELS[j.invoice_status]}</span>
                                <span className="font-semibold text-text-primary">{formatAmount(j.invoice_amount)}</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Quotes */}
              {tab === 'quotes' && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                  <h2 className="text-sm font-semibold text-text-primary">Quotes</h2>
                  {bundle.quotes.length === 0 ? (
                    <p className="mt-3 text-sm text-text-secondary">No quotes on file yet.</p>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {bundle.quotes.map((q) => (
                        <a
                          key={q.id}
                          href={`/quote/${q.quote_token}`}
                          className="focus-ring flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3.5 transition-colors hover:bg-bg-tertiary"
                        >
                          <div>
                            <p className="text-sm font-medium text-text-primary">
                              {q.accepted_total_cents !== null ? formatCents(q.accepted_total_cents) : 'Quote'}
                            </p>
                            <p className="mt-0.5 text-xs text-text-secondary">
                              {q.sent_at ? `Sent ${formatPortalDate(q.sent_at)}` : formatPortalDate(q.created_at)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <QuoteStatusBadge status={q.status} />
                            <ExternalLink size={13} className="text-text-secondary" />
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Request service */}
              {tab === 'request' && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                  <h2 className="text-sm font-semibold text-text-primary">Request Service</h2>
                  <p className="mt-1 text-xs text-text-secondary">We'll reach out to get this scheduled.</p>

                  {reqDone ? (
                    <div className="mt-5 flex items-center gap-3 rounded-xl border border-success-500/30 bg-success/5 p-4">
                      <CheckCircle2 size={20} className="shrink-0 text-success" />
                      <p className="text-sm text-text-primary">Thanks — your request has been sent. We'll be in touch soon.</p>
                    </div>
                  ) : (
                    <form onSubmit={handleSubmitRequest} className="mt-5 space-y-4">
                      <div>
                        <label htmlFor="portal-service-type" className="mb-1.5 block text-xs font-medium text-text-secondary">
                          What do you need?
                        </label>
                        <input
                          id="portal-service-type"
                          type="text"
                          value={reqServiceType}
                          onChange={(e) => setReqServiceType(e.target.value)}
                          placeholder="e.g. AC repair, leak, annual tune-up…"
                          className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary"
                        />
                      </div>
                      <div>
                        <label htmlFor="portal-message" className="mb-1.5 block text-xs font-medium text-text-secondary">
                          Anything else we should know? (optional)
                        </label>
                        <textarea
                          id="portal-message"
                          value={reqMessage}
                          onChange={(e) => setReqMessage(e.target.value)}
                          rows={4}
                          className="focus-ring w-full resize-none rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary"
                        />
                      </div>
                      {reqError && <p className="text-xs text-danger">{reqError}</p>}
                      <button
                        type="submit"
                        disabled={reqSubmitting}
                        className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                      >
                        <Send size={15} />
                        {reqSubmitting ? 'Sending…' : 'Send request'}
                      </button>
                    </form>
                  )}
                </div>
              )}

              {/* Profile */}
              {tab === 'profile' && (
                <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                  <h2 className="text-sm font-semibold text-text-primary">My Info</h2>
                  <p className="mt-1 text-xs text-text-secondary">Keep your contact info up to date.</p>

                  <form onSubmit={handleSaveProfile} className="mt-5 space-y-4">
                    <div>
                      <label htmlFor="portal-phone" className="mb-1.5 block text-xs font-medium text-text-secondary">Phone</label>
                      <input
                        id="portal-phone"
                        type="tel"
                        value={phone}
                        onChange={(e) => { setPhone(e.target.value); setProfileSaved(false); }}
                        className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                      />
                    </div>
                    <div>
                      <label htmlFor="portal-email" className="mb-1.5 block text-xs font-medium text-text-secondary">Email</label>
                      <input
                        id="portal-email"
                        type="email"
                        value={email}
                        onChange={(e) => { setEmail(e.target.value); setProfileSaved(false); }}
                        className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
                      />
                    </div>
                    {bundle.customer.address && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-text-secondary">Address on file</p>
                        <p className="text-sm text-text-primary">{bundle.customer.address}</p>
                        <p className="mt-1 text-[11px] text-text-secondary">Call us to update your address.</p>
                      </div>
                    )}
                    {profileError && <p className="text-xs text-danger">{profileError}</p>}
                    {profileSaved && <p className="text-xs text-success">Saved.</p>}
                    <button
                      type="submit"
                      disabled={profileSaving}
                      className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                    >
                      {profileSaving ? 'Saving…' : 'Save changes'}
                    </button>
                  </form>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
