import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, Download, Lock, RefreshCw, Target, Zap } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { exportToCsv } from '@/lib/csvExport';
import {
  MARKETPLACES,
  SLA_SECONDS,
  buildEmailAlias,
  buildWebhookUrl,
  dollarsToCents,
  fetchCostReport,
  fetchRecentEvents,
  fetchSources,
  formatCents,
  formatSeconds,
  generateToken,
  percent,
  providerLabel,
  summarizeReport,
  upsertSource,
  type CostReportRow,
  type MarketplaceEvent,
  type MarketplaceProvider,
  type SourceConfig,
} from '@/lib/leadMarketplace';

type RangePreset = '30d' | '90d' | '365d';

function getRange(preset: RangePreset) {
  const end = new Date();
  const days = preset === '30d' ? 30 : preset === '90d' ? 90 : 365;
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start, end: new Date(end.getTime() + 60_000) };
}

function statusClasses(status: string): string {
  if (status === 'sent' || status === 'lead_created') return 'bg-success-500/10 text-success-500';
  if (status === 'failed' || status === 'parse_failed' || status === 'error') return 'bg-danger/10 text-danger';
  return 'bg-bg-tertiary text-text-secondary';
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="!p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1.5 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

// ------------------------------------------------------------------
// One provider's configuration card (owner only)
// ------------------------------------------------------------------
function SourceCard({
  provider,
  label,
  config,
  userId,
  inboundToken,
  onSaved,
}: {
  provider: MarketplaceProvider;
  label: string;
  config: SourceConfig | null;
  userId: string;
  inboundToken: string | null;
  onSaved: (c: SourceConfig) => void;
}) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [autoRespond, setAutoRespond] = useState(config?.auto_respond_enabled ?? true);
  const [quiet, setQuiet] = useState(config?.sms_quiet_hours ?? true);
  const [cost, setCost] = useState(config?.default_cost_cents != null ? String(config.default_cost_cents / 100) : '');
  const [booking, setBooking] = useState(config?.booking_url ?? '');
  const [timezone, setTimezone] = useState(config?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'America/New_York');
  const [saving, setSaving] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const webhookUrl = config ? buildWebhookUrl(import.meta.env.VITE_SUPABASE_URL as string | undefined, config.webhook_token) : null;
  const alias = buildEmailAlias(inboundToken, import.meta.env.VITE_INBOUND_EMAIL_DOMAIN as string | undefined, provider);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`, 'success');
    } catch {
      toast('Copy failed — select and copy manually', 'error');
    }
  };

  const save = async (extra: { webhook_token?: string } = {}) => {
    const cents = dollarsToCents(cost);
    if (cents === undefined) return toast('Default lead cost must be a dollar amount like 45 or 45.50', 'error');
    if (booking.trim() && !/^https:\/\//i.test(booking.trim())) return toast('Booking link must start with https://', 'error');
    setSaving(true);
    try {
      const saved = await upsertSource(userId, provider, {
        enabled,
        auto_respond_enabled: autoRespond,
        sms_quiet_hours: quiet,
        default_cost_cents: cents,
        booking_url: booking.trim() || null,
        timezone: timezone.trim() || 'America/New_York',
        ...extra,
      });
      onSaved(saved);
      toast(`${label} settings saved`, 'success');
    } catch {
      toast('Could not save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const checkbox = (id: string, checked: boolean, set: (v: boolean) => void, text: string) => (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-text-primary">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} className="h-4 w-4 accent-[var(--accent,#2563eb)]" />
      {text}
    </label>
  );

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-text-primary">{label}</h3>
        {checkbox(`en-${provider}`, enabled, setEnabled, 'Enabled')}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Input id={`cost-${provider}`} label="Default cost per lead ($)" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="e.g. 45" helperText="Used only when the lead notification carries no price." />
        <Input id={`book-${provider}`} label="Booking link (optional)" value={booking} onChange={(e) => setBooking(e.target.value)} placeholder="https://" helperText="Included in the first reply." />
        <Input id={`tz-${provider}`} label="Business time zone" value={timezone} onChange={(e) => setTimezone(e.target.value)} helperText="IANA name, e.g. America/Chicago." />
        <div className="flex flex-col justify-center gap-3">
          {checkbox(`ar-${provider}`, autoRespond, setAutoRespond, `Auto-reply within ${SLA_SECONDS} seconds`)}
          {checkbox(`qh-${provider}`, quiet, setQuiet, 'No texts 9pm–8am (email only)')}
        </div>
      </div>

      {config && webhookUrl && (
        <div className="mt-5 space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Webhook URL (keep secret)</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-xs text-text-primary">{webhookUrl}</code>
              <Button type="button" variant="ghost" size="sm" onClick={() => copy(webhookUrl, 'Webhook URL')} aria-label="Copy webhook URL">
                <Copy size={14} />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRotate(true)} aria-label="Regenerate webhook token">
                <RefreshCw size={14} />
              </Button>
            </div>
          </div>
          {alias && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Forward notification emails to</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs text-text-primary">{alias}</code>
                <Button type="button" variant="ghost" size="sm" onClick={() => copy(alias, 'Email address')} aria-label="Copy email address">
                  <Copy size={14} />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Button type="button" size="sm" onClick={() => save()} disabled={saving}>
          {config ? 'Save changes' : `Set up ${label}`}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRotate}
        title="Regenerate webhook token?"
        description={`The current ${label} webhook URL stops working immediately. You will need to paste the new URL into ${label}.`}
        confirmLabel="Regenerate"
        onCancel={() => setConfirmRotate(false)}
        onConfirm={async () => {
          setConfirmRotate(false);
          await save({ webhook_token: generateToken() });
        }}
      />
    </Card>
  );
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------
export function LeadMarketplacesPage() {
  const navigate = useNavigate();
  const { user, profile, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;

  const [preset, setPreset] = useState<RangePreset>('90d');
  const [report, setReport] = useState<CostReportRow[]>([]);
  const [sources, setSources] = useState<SourceConfig[]>([]);
  const [events, setEvents] = useState<MarketplaceEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user || !canAccess) return;
    setLoading(true);
    const { start, end } = getRange(preset);
    try {
      const [r, e, s] = await Promise.all([fetchCostReport(start, end), fetchRecentEvents(25), isOwner ? fetchSources() : Promise.resolve([] as SourceConfig[])]);
      setReport(r);
      setEvents(e);
      setSources(s);
    } catch {
      toast('Could not load lead marketplace data', 'error');
    } finally {
      setLoading(false);
    }
  }, [user, canAccess, preset, isOwner, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => summarizeReport(report), [report]);
  const failedParses = events.filter((e) => e.status === 'parse_failed').length;

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Lead Marketplaces">
        <EmptyState icon={Lock} title="You don't have access to this page" description='Lead marketplace costs are restricted. Ask your account owner for the "View Billing" permission.' />
      </DashboardLayout>
    );
  }

  const exportReport = () =>
    exportToCsv(
      report,
      [
        { header: 'Marketplace', accessor: (r) => providerLabel(r.provider) },
        { header: 'Leads', accessor: (r) => r.leads },
        { header: 'Spend ($)', accessor: (r) => r.spend_cents / 100 },
        { header: 'Booked leads', accessor: (r) => r.booked_leads },
        { header: 'Booked jobs', accessor: (r) => r.booked_jobs },
        { header: 'Cost per lead ($)', accessor: (r) => (r.cost_per_lead_cents ?? 0) / 100 },
        { header: 'Cost per booked job ($)', accessor: (r) => (r.cost_per_booked_job_cents ?? 0) / 100 },
        { header: 'Paid revenue ($)', accessor: (r) => r.revenue_cents / 100 },
        { header: 'Median response (s)', accessor: (r) => r.median_response_seconds },
        { header: `Answered within ${SLA_SECONDS}s (%)`, accessor: (r) => percent(r.within_sla_leads, r.responded_leads) },
      ],
      `lead-marketplaces-${preset}.csv`,
    );

  return (
    <DashboardLayout activeLabel="Lead Marketplaces">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary" aria-label="Back to dashboard">
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Target size={22} className="text-accent" />
              Lead Marketplaces
            </h1>
            <p className="text-sm text-text-secondary">Angi, HomeAdvisor, Thumbtack, Nextdoor and Google LSA leads: what they cost, how fast you answer, and what they book.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-border bg-bg-secondary p-1">
            {(['30d', '90d', '365d'] as RangePreset[]).map((p) => (
              <button key={p} type="button" onClick={() => setPreset(p)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${preset === p ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                {p === '30d' ? '30 days' : p === '90d' ? '90 days' : '1 year'}
              </button>
            ))}
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={exportReport} disabled={!report.length}>
            <Download size={14} /> CSV
          </Button>
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={4} />
      ) : (
        <FadeIn>
          {report.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No marketplace leads yet"
              description={isOwner ? 'Turn on a marketplace below and point its lead notifications at the webhook URL or email address shown on its card.' : 'Your account owner has not connected a lead marketplace yet.'}
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <StatCard label="Leads" value={String(totals.leads)} hint={`${totals.bookedLeads} booked`} />
                <StatCard label="Spend" value={formatCents(totals.spendCents)} hint={totals.leadsUnknownCost ? `${totals.leadsUnknownCost} leads have no cost — spend is understated` : undefined} />
                <StatCard label="Cost per lead" value={formatCents(totals.costPerLeadCents)} />
                <StatCard label="Cost per booked job" value={formatCents(totals.costPerBookedJobCents)} hint={totals.bookingRatePct !== null ? `${totals.bookingRatePct}% of leads book` : undefined} />
                <StatCard label="Paid revenue" value={formatCents(totals.revenueCents)} />
                <StatCard label={`Answered < ${SLA_SECONDS}s`} value={totals.withinSlaPct === null ? '—' : `${totals.withinSlaPct}%`} hint={`${totals.respondedLeads} auto-replies sent`} />
              </div>

              <Card className="mt-6 overflow-x-auto !p-0">
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                      {['Marketplace', 'Leads', 'Spend', 'Cost / lead', 'Booked', 'Cost / booked job', 'Paid revenue', 'Median reply', `< ${SLA_SECONDS}s`].map((h) => (
                        <th key={h} className="px-4 py-3 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.map((r) => (
                      <tr key={r.provider} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-3 font-semibold text-text-primary">{providerLabel(r.provider)}</td>
                        <td className="px-4 py-3">{r.leads}</td>
                        <td className="px-4 py-3">{formatCents(r.spend_cents)}{r.leads_unknown_cost ? ' *' : ''}</td>
                        <td className="px-4 py-3">{formatCents(r.cost_per_lead_cents)}</td>
                        <td className="px-4 py-3">{r.booked_leads}{r.booked_jobs > r.booked_leads ? ` (${r.booked_jobs} jobs)` : ''}</td>
                        <td className="px-4 py-3 font-semibold text-text-primary">{formatCents(r.cost_per_booked_job_cents)}</td>
                        <td className="px-4 py-3">{formatCents(r.revenue_cents)}</td>
                        <td className="px-4 py-3">{formatSeconds(r.median_response_seconds)}</td>
                        <td className="px-4 py-3">{percent(r.within_sla_leads, r.responded_leads) ?? '—'}{r.responded_leads ? '%' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <p className="mt-2 text-xs text-text-secondary">
                * includes leads with no known cost. A lead counts as booked when it has a non-cancelled job (linked, or matched by phone). Leads that book after the selected period are not counted.
              </p>
            </>
          )}

          {isOwner && user && (
            <section className="mt-10">
              <h2 className="text-lg font-bold text-text-primary">Connect marketplaces</h2>
              <p className="mb-4 text-sm text-text-secondary">Each marketplace gets its own secret webhook URL and email address, so leads are always attributed to the right source.</p>
              <div className="grid gap-4 lg:grid-cols-2">
                {MARKETPLACES.map((m) => (
                  <SourceCard
                    key={`${m.id}-${sources.find((s) => s.provider === m.id)?.webhook_token ?? 'new'}`}
                    provider={m.id}
                    label={m.label}
                    config={sources.find((s) => s.provider === m.id) ?? null}
                    userId={user.id}
                    inboundToken={profile?.inbound_email_token ?? null}
                    onSaved={(saved) => setSources((prev) => [...prev.filter((s) => s.provider !== saved.provider), saved])}
                  />
                ))}
              </div>
            </section>
          )}

          {events.length > 0 && (
            <section className="mt-10">
              <h2 className="text-lg font-bold text-text-primary">Recent activity</h2>
              {failedParses > 0 && (
                <p className="mb-3 text-sm text-warning-500">
                  {failedParses} recent notification{failedParses > 1 ? 's' : ''} could not be parsed. The email still reached your inbox; the raw sample is stored for tuning (see the setup guide).
                </p>
              )}
              <Card className="overflow-x-auto !p-0">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                      {['Received', 'Marketplace', 'Via', 'Lead', 'Cost', 'Auto-reply', 'Reply time'].map((h) => (
                        <th key={h} className="px-4 py-3 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-3 whitespace-nowrap">{new Date(e.received_at).toLocaleString()}</td>
                        <td className="px-4 py-3">{providerLabel(e.provider)}</td>
                        <td className="px-4 py-3">{e.received_via}</td>
                        <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClasses(e.status)}`} title={e.parse_error ?? undefined}>{e.status.replace('_', ' ')}</span></td>
                        <td className="px-4 py-3">{formatCents(e.cost_cents)}{e.cost_source === 'default' ? ' (default)' : ''}</td>
                        <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClasses(e.auto_respond_status)}`}>{e.auto_respond_status.replace(/_/g, ' ')}</span>{e.auto_respond_channel ? ` · ${e.auto_respond_channel}` : ''}{e.auto_respond_ai ? ' · AI' : ''}</td>
                        <td className="px-4 py-3">{e.response_ms === null ? '—' : formatSeconds(e.response_ms / 1000)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </section>
          )}
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
