import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BellRing, Laptop, LogOut, MonitorSmartphone, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonTable } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { listTrustedDevices, revokeTrustedDevice, type TrustedDeviceRow } from '@/lib/deviceTrust';
import { describeUserAgent, getCurrentSessionId, listOwnSessions, revokeOwnSession, type OwnSessionRow } from '@/lib/sessions';
import {
  acknowledgeLoginEvents,
  errorMessage,
  fetchLoginAlertPreference,
  fetchLoginEvents,
  setLoginAlertPreference,
  signOutEverywhere,
  type LoginEvent,
} from '@/lib/loginSecurity';
import { eventFlags, formatExpiry, formatRelativeTime, lastActiveIso, otherSessions, pendingAlerts, sortSessions } from '@/lib/sessionInsights';
import { supabase } from '@/lib/supabase';

/** Loads `fn` on mount/when deps change; reload() refreshes quietly without flashing the skeleton. */
function useResource<T>(fn: () => Promise<T>, deps: (string | null | undefined)[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const hasData = useRef(false);
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    let cancelled = false;
    if (!hasData.current) setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (cancelled) return;
        hasData.current = true;
        setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, 'Could not load this section.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, tick]);

  return { data, loading, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

function Section({ icon, title, subtitle, action, children }: { icon: ReactNode; title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5 hover:translate-y-0 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">{icon}</span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <p className="text-xs text-text-secondary">{subtitle}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-danger">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'info' | 'success' | 'warning'; children: ReactNode }) {
  const cls = { info: 'bg-accent/10 text-accent', success: 'bg-success-500/10 text-success-500', warning: 'bg-warning-500/10 text-warning-500' }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

function Row({ children }: { children: ReactNode }) {
  return <li className="flex flex-col gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">{children}</li>;
}

export function SessionsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const userId = user?.id ?? null;

  const sessions = useResource(async () => {
    const [rows, currentId] = await Promise.all([listOwnSessions(), getCurrentSessionId()]);
    return { rows, currentId };
  }, [userId]);
  const devices = useResource<TrustedDeviceRow[]>(() => listTrustedDevices(), [userId]);
  const events = useResource<LoginEvent[]>(() => (userId ? fetchLoginEvents(userId) : Promise.resolve([])), [userId]);
  const pref = useResource<boolean>(() => (userId ? fetchLoginAlertPreference(userId) : Promise.resolve(true)), [userId]);

  const [sessionTarget, setSessionTarget] = useState<OwnSessionRow | null>(null);
  const [deviceTarget, setDeviceTarget] = useState<TrustedDeviceRow | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [everywhereOpen, setEverywhereOpen] = useState(false);
  const [forgetDevices, setForgetDevices] = useState(true);
  const [prefSaving, setPrefSaving] = useState(false);
  const [prefOverride, setPrefOverride] = useState<boolean | null>(null);
  const [ackBusy, setAckBusy] = useState(false);

  const currentId = sessions.data?.currentId ?? null;
  const sessionRows = sessions.data ? sortSessions(sessions.data.rows, currentId) : [];
  const alerts = pendingAlerts(events.data ?? []);
  const alertsOn = prefOverride ?? pref.data ?? true;

  const revokeSession = async () => {
    if (!sessionTarget) return;
    try {
      await revokeOwnSession(sessionTarget.id);
      toast('That session has been signed out.', 'success');
      sessions.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not sign out that session.'), 'error');
    } finally {
      setSessionTarget(null);
    }
  };

  const revokeDevice = async () => {
    if (!deviceTarget) return;
    try {
      await revokeTrustedDevice(deviceTarget.id);
      toast(deviceTarget.is_current ? 'This device is no longer trusted. You will be asked for a code next time you sign in.' : 'That device is no longer trusted.', 'success');
      devices.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not remove that device.'), 'error');
    } finally {
      setDeviceTarget(null);
    }
  };

  const signOutOthers = async () => {
    try {
      const { error } = await supabase.auth.signOut({ scope: 'others' });
      if (error) throw error;
      toast('Every other session has been signed out.', 'success');
      sessions.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not sign out other sessions.'), 'error');
    } finally {
      setOthersOpen(false);
    }
  };

  const everywhere = async () => {
    try {
      const { deviceStep } = await signOutEverywhere(forgetDevices);
      if (deviceStep === 'partial' || deviceStep === 'failed') {
        toast('Signed out everywhere, but some trusted devices could not be removed. Review them after signing in.', 'info');
      }
      window.location.assign('/login');
    } catch (e) {
      toast(errorMessage(e, 'Could not sign out everywhere.'), 'error');
      setEverywhereOpen(false);
    }
  };

  const togglePref = async () => {
    if (!userId || prefSaving) return;
    const next = !alertsOn;
    setPrefOverride(next);
    setPrefSaving(true);
    try {
      await setLoginAlertPreference(userId, next);
      toast(next ? 'Login alerts are on.' : 'Login alerts are off.', 'success');
      pref.reload();
    } catch (e) {
      setPrefOverride(null);
      toast(errorMessage(e, 'Could not update login alerts.'), 'error');
    } finally {
      setPrefSaving(false);
    }
  };

  const acknowledge = async () => {
    setAckBusy(true);
    try {
      await acknowledgeLoginEvents();
      events.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not dismiss the alert.'), 'error');
    } finally {
      setAckBusy(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Sessions & devices">
      <BackButton fallback="/dashboard/settings" label="Back to Settings" />
      <div className="mb-6 mt-3 flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <MonitorSmartphone size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Sessions &amp; devices</h1>
          <p className="mt-1 text-sm text-text-secondary">See where you are signed in, remove devices you do not recognise, and get alerted to new sign-ins.</p>
        </div>
      </div>

      <div className="space-y-4">
        {alerts.length > 0 && (
          <div role="alert" className="rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <TriangleAlert size={20} className="mt-0.5 shrink-0 text-warning-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text-primary">
                  {alerts.length === 1 ? 'New sign-in from a device we have not seen before' : `${alerts.length} sign-ins from devices we have not seen before`}
                </p>
                <ul className="mt-1 space-y-0.5 text-sm text-text-secondary">
                  {alerts.slice(0, 3).map((a) => (
                    <li key={a.id}>{a.device_label}{a.ip ? ` · ${a.ip}` : ''} · {formatRelativeTime(a.created_at)}</li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button variant="secondary" size="sm" disabled={ackBusy} onClick={() => void acknowledge()}>This was me</Button>
                  <Button size="sm" onClick={() => setEverywhereOpen(true)}>Not me: sign out everywhere</Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <Section
          icon={<Laptop size={18} />}
          title="Active sessions"
          subtitle="Every browser or device currently signed in to your account."
          action={
            otherSessions(sessionRows, currentId).length > 0 ? (
              <Button variant="secondary" size="sm" onClick={() => setOthersOpen(true)}><LogOut size={14} /> Sign out other sessions</Button>
            ) : undefined
          }
        >
          {sessions.error ? (
            <SectionError message={sessions.error} onRetry={sessions.reload} />
          ) : sessions.loading ? (
            <SkeletonTable rows={3} columns={3} />
          ) : sessionRows.length === 0 ? (
            <EmptyState icon={Laptop} title="No active sessions" description="Sessions you are signed in on will be listed here." />
          ) : (
            <ul>
              {sessionRows.map((s) => {
                const isCurrent = s.id === currentId;
                return (
                  <Row key={s.id}>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                        {describeUserAgent(s.user_agent)}
                        {isCurrent && <Pill tone="success">This device</Pill>}
                      </p>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {s.ip ?? 'Unknown network'} · Signed in {formatRelativeTime(s.created_at)} · Active {formatRelativeTime(lastActiveIso(s))}
                      </p>
                    </div>
                    {!isCurrent && (
                      <Button variant="secondary" size="sm" onClick={() => setSessionTarget(s)} className="w-full sm:w-auto">Sign out</Button>
                    )}
                  </Row>
                );
              })}
            </ul>
          )}
        </Section>

        <Section icon={<ShieldCheck size={18} />} title="Trusted devices" subtitle="Browsers that can skip the one-time code at sign-in. Remove any you no longer use.">
          {devices.error ? (
            <SectionError message={devices.error} onRetry={devices.reload} />
          ) : devices.loading ? (
            <SkeletonTable rows={2} columns={3} />
          ) : (devices.data ?? []).length === 0 ? (
            <EmptyState icon={ShieldCheck} title="No trusted devices" description="When you choose to trust a browser at sign-in, it will appear here." />
          ) : (
            <ul>
              {(devices.data ?? []).map((d) => (
                <Row key={d.id}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                      {d.device_name ?? 'Unknown device'}
                      {d.is_current && <Pill tone="success">This device</Pill>}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      Added {formatRelativeTime(d.created_at)} · Last used {formatRelativeTime(d.last_used_at)} · {formatExpiry(d.expires_at)}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setDeviceTarget(d)} className="w-full sm:w-auto">Remove</Button>
                </Row>
              ))}
            </ul>
          )}
        </Section>

        <Section
          icon={<BellRing size={18} />}
          title="Login alerts"
          subtitle="Be told when your account is signed into from a browser or device it has not been used from before."
          action={
            pref.loading && pref.data === null ? undefined : (
              <button
                type="button"
                role="switch"
                aria-checked={alertsOn}
                aria-label="Login alerts"
                disabled={prefSaving || pref.error !== null}
                onClick={() => void togglePref()}
                className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${alertsOn ? 'bg-accent' : 'bg-bg-tertiary'}`}
              >
                <span className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${alertsOn ? 'translate-x-5' : ''}`} />
              </button>
            )
          }
        >
          {pref.error && <div className="mb-4"><SectionError message={pref.error} onRetry={pref.reload} /></div>}
          <p className="mb-4 text-xs text-text-secondary">Alerts show on this page and, for account owners, in the notification bell. Email alerts are not part of this release.</p>
          {events.error ? (
            <SectionError message={events.error} onRetry={events.reload} />
          ) : events.loading ? (
            <SkeletonTable rows={3} columns={3} />
          ) : (events.data ?? []).length === 0 ? (
            <EmptyState icon={ShieldAlert} title="No sign-ins recorded" description="Each new sign-in is recorded here, starting from your next one." />
          ) : (
            <ul>
              {(events.data ?? []).map((e) => (
                <Row key={e.id}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                      {e.device_label}
                      {eventFlags(e).map((f) => <Pill key={f} tone="warning">{f}</Pill>)}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">{e.ip ?? 'Unknown network'}</p>
                  </div>
                  <p className="text-xs text-text-secondary" title={new Date(e.created_at).toLocaleString()}>{formatRelativeTime(e.created_at)}</p>
                </Row>
              ))}
            </ul>
          )}
        </Section>

        <Card className="border-danger/30 p-5 hover:translate-y-0 sm:p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger"><LogOut size={18} /></span>
            <div>
              <h2 className="text-base font-semibold text-text-primary">Sign out everywhere</h2>
              <p className="text-xs text-text-secondary">Ends every session on every device, including this one. Use it if you think someone else has access.</p>
            </div>
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" className="mt-0.5" checked={forgetDevices} onChange={(e) => setForgetDevices(e.target.checked)} />
            Also remove all trusted devices, so every sign-in needs a fresh code
          </label>
          <Button variant="secondary" size="sm" className="mt-4 w-full border-danger/40 text-danger sm:w-auto" onClick={() => setEverywhereOpen(true)}>Sign out everywhere</Button>
        </Card>
      </div>

      <ConfirmDialog
        open={sessionTarget !== null}
        title="Sign out this session?"
        description="That browser or device is signed out immediately and will need to sign in again."
        confirmLabel="Yes, sign out"
        onConfirm={revokeSession}
        onCancel={() => setSessionTarget(null)}
      />
      <ConfirmDialog
        open={deviceTarget !== null}
        title="Remove this trusted device?"
        description={deviceTarget?.is_current ? 'This is the device you are using now. You will need a fresh code the next time you sign in from it.' : `The next sign-in from "${deviceTarget?.device_name ?? 'this device'}" will need a code again.`}
        confirmLabel="Yes, remove device"
        onConfirm={revokeDevice}
        onCancel={() => setDeviceTarget(null)}
      />
      <ConfirmDialog
        open={othersOpen}
        title="Sign out all other sessions?"
        description="Every device except this one is signed out immediately."
        confirmLabel="Yes, sign them out"
        onConfirm={signOutOthers}
        onCancel={() => setOthersOpen(false)}
      />
      <ConfirmDialog
        open={everywhereOpen}
        title="Sign out everywhere?"
        description={`Every session, including this one, ends now and you will be taken to the sign-in page.${forgetDevices ? ' All trusted devices are removed too.' : ''}`}
        confirmLabel="Yes, sign out everywhere"
        onConfirm={everywhere}
        onCancel={() => setEverywhereOpen(false)}
      />
    </DashboardLayout>
  );
}
