import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarCheck, CheckCircle2, ChevronDown, Phone, RefreshCw, Siren, Tv } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { LoadingBoundary, SkeletonBlock } from '@/components/loading';
import { LiveIndicator } from '@/components/LiveIndicator';
import { SarahOrb } from '@/components/sarah/SarahOrb';
import { RecoveredHero } from './RecoveredHero';
import { useToday } from './useToday';
import type { AttentionItem } from '@/lib/todayHome.logic';
import type { TodayData } from '@/lib/todayHomeApi';

const CARD = 'rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark';
const SEVERITY_LABEL: Record<AttentionItem['severity'], string> = { critical: 'Urgent', high: 'Soon', normal: 'When you can' };
const SEVERITY_CLASS: Record<AttentionItem['severity'], string> = {
  critical: 'bg-danger/10 text-danger',
  high: 'bg-warning-500/10 text-warning-500',
  normal: 'bg-bg-tertiary text-text-secondary',
};

function ago(ms: number | null, nowMs = Date.now()): string {
  if (ms === null) return 'never';
  const mins = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function TodaySkeleton() {
  return (
    <div className="space-y-4" data-testid="today-skeleton">
      <SkeletonBlock className="h-[212px] w-full rounded-2xl" />
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[0, 1, 2].map((i) => (
          <SkeletonBlock key={i} className="h-[104px] rounded-2xl" index={i} />
        ))}
      </div>
      <SkeletonBlock className="h-[300px] w-full rounded-2xl" />
    </div>
  );
}

function Tile({ icon: Icon, label, value, to, tv, alert }: { icon: typeof Phone; label: string; value: number; to?: string; tv: boolean; alert?: boolean }) {
  const body = (
    <div className={`${CARD} h-full ${tv ? 'p-8' : 'p-3 sm:p-5'}`}>
      <Icon size={tv ? 32 : 18} aria-hidden="true" className={alert ? 'text-danger' : 'text-text-secondary'} />
      <p className={`mt-2 font-display font-semibold tabular-nums text-text-primary ${tv ? 'text-7xl' : 'text-3xl sm:text-4xl'}`}>{value.toLocaleString()}</p>
      <p className={`text-text-secondary ${tv ? 'mt-1 text-2xl' : 'mt-0.5 text-xs sm:text-sm'}`}>{label}</p>
    </div>
  );
  return to && !tv ? (
    <Link to={to} className="focus-ring block min-h-[44px] rounded-2xl transition-transform hover:-translate-y-0.5">
      {body}
    </Link>
  ) : (
    body
  );
}

function AttentionList({ data, tv, nowMs }: { data: TodayData['attention']; tv: boolean; nowMs: number }) {
  return (
    <section aria-labelledby="today-attention" className={`${CARD} ${tv ? 'p-10' : 'p-5'}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="today-attention" className={`font-semibold text-text-primary ${tv ? 'text-3xl' : 'text-sm'}`}>
          Attention needed
        </h3>
        {data.total > data.items.length && !tv && (
          <Link to="/dashboard/calls" className="focus-ring rounded px-1 text-xs font-medium text-accent hover:underline">
            +{data.total - data.items.length} more
          </Link>
        )}
      </div>
      {data.items.length === 0 ? (
        <p className={`mt-4 flex items-center gap-2 rounded-xl bg-bg-tertiary/60 px-4 py-3 text-text-secondary ${tv ? 'text-2xl' : 'text-sm'}`}>
          <CheckCircle2 size={tv ? 28 : 16} className="text-success-500" aria-hidden="true" />
          Nothing needs you right now.
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {data.items.map((it) => {
            const inner = (
              <>
                <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 font-semibold ${SEVERITY_CLASS[it.severity]} ${tv ? 'text-lg' : 'text-xs'}`}>{SEVERITY_LABEL[it.severity]}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block font-medium text-text-primary ${tv ? 'text-2xl' : 'text-sm'}`}>{it.title}</span>
                  <span className={`block text-text-secondary ${tv ? 'text-xl' : 'text-xs sm:text-sm'}`}>{it.detail}</span>
                </span>
                <span className={`shrink-0 text-text-secondary/80 ${tv ? 'text-lg' : 'text-xs'}`}>{ago(Date.parse(it.at), nowMs)}</span>
              </>
            );
            return (
              <li key={it.key}>
                {tv ? (
                  <div className="flex items-start gap-4 rounded-xl bg-bg-tertiary/50 p-4">{inner}</div>
                ) : (
                  <Link to={it.href} className="focus-ring flex min-h-[44px] items-start gap-3 rounded-xl bg-bg-tertiary/50 p-3 hover:bg-bg-tertiary">
                    {inner}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function EmptyCard({ kind }: { kind: 'no_number_yet' | 'no_calls_yet' }) {
  const noNumber = kind === 'no_number_yet';
  return (
    <section aria-labelledby="today-empty" className={`${CARD} flex flex-col items-center px-6 py-12 text-center`}>
      <SarahOrb state={noNumber ? 'offline' : 'idle'} size={72} decorative />
      <h3 id="today-empty" className="mt-5 text-lg font-semibold text-text-primary">
        {noNumber ? 'Sarah is ready to meet her first caller' : 'Your number is live. Sarah is waiting.'}
      </h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-text-secondary">
        {noNumber
          ? 'Hear exactly what your customers will hear. It takes about a minute, and nothing is counted as business until a real customer calls.'
          : 'Calls, emergencies and bookings will appear here the moment your first real customer calls. Your test calls are never counted.'}
      </p>
      <Link to="/onboarding/first-call" className="focus-ring mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:brightness-110">
        <Phone size={16} aria-hidden="true" /> {noNumber ? 'Call Sarah now' : 'Try a test call'}
      </Link>
    </section>
  );
}

function Counting({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls="today-counting" onClick={() => setOpen((o) => !o)} className="focus-ring -ml-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent/10">
        How these are counted <ChevronDown size={16} aria-hidden="true" className={open ? 'rotate-180' : ''} />
      </button>
      <div id="today-counting" hidden={!open} className="space-y-1.5 rounded-xl bg-bg-tertiary/60 p-4 text-sm leading-relaxed text-text-secondary">
        {children}
      </div>
    </div>
  );
}

export function TodayHome({ variant = 'app' }: { variant?: 'app' | 'tv' }) {
  const tv = variant === 'tv';
  const { profile, isOwner, teamMember } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const { data, status, stale, lastOkAt, realtime, refresh } = useToday(ownerId, profile?.invoice_currency || 'USD');
  const nowMs = Date.now();

  return (
    <div className={tv ? 'space-y-8' : 'space-y-4'} data-testid="today-home" data-variant={variant}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className={`font-display font-semibold text-text-primary ${tv ? 'text-5xl' : 'text-xl'}`}>Today</h2>
          {data && <p className={`text-text-secondary ${tv ? 'text-2xl' : 'text-sm'}`}>{data.window.date} · {data.window.timezone}</p>}
        </div>
        <div className="flex items-center gap-2">
          {!stale && status === 'ready' && <LiveIndicator status={realtime} />}
          {!tv && (
            <Link to="/dashboard/today/tv" className="focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-bg-tertiary">
              <Tv size={16} aria-hidden="true" /> TV view
            </Link>
          )}
        </div>
      </header>

      {stale && (
        <div role="status" data-testid="today-stale" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          <span className="flex items-center gap-2">
            <AlertTriangle size={16} aria-hidden="true" className="text-warning-500" />
            Couldn't refresh. These numbers are from {ago(lastOkAt, nowMs)}.
          </span>
          <button type="button" onClick={refresh} className="focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 font-medium text-accent hover:bg-accent/10">
            <RefreshCw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      )}

      <LoadingBoundary isLoading={status === 'loading'} error={status === 'error'} onRetry={refresh} skeleton={<TodaySkeleton />} label="Loading today">
        {data &&
          (data.empty ? (
            <EmptyCard kind={data.empty} />
          ) : (
            <>
              <RecoveredHero hero={data.hero} tv={tv} />
              <div className={`grid grid-cols-3 ${tv ? 'gap-6' : 'gap-2 sm:gap-4'}`}>
                <Tile icon={Phone} label="Calls handled" value={data.tiles.callsHandled} to="/dashboard/calls" tv={tv} />
                <Tile icon={Siren} label="Emergencies" value={data.tiles.emergencies} to="/dashboard/calls" tv={tv} alert={data.tiles.emergencies > 0} />
                <Tile icon={CalendarCheck} label="Jobs booked" value={data.tiles.jobsBooked} to="/dashboard/jobs" tv={tv} />
              </div>
              {!tv && (
                <Counting>
                  <p><strong>Calls handled:</strong> calls Sarah answered since midnight in {data.window.timezone}. Missed calls, spam and voicemail drops are not included.</p>
                  <p><strong>Emergencies:</strong> handled calls flagged as an emergency.</p>
                  <p><strong>Jobs booked:</strong> jobs created today from a call, excluding cancelled ones.</p>
                  {data.tiles.practiceExcluded > 0 && <p>{data.tiles.practiceExcluded} practice call{data.tiles.practiceExcluded === 1 ? '' : 's'} (your own test calls) left out of every number.</p>}
                </Counting>
              )}
              <AttentionList data={data.attention} tv={tv} nowMs={nowMs} />
              {data.truncated && <p className="text-xs text-text-secondary">Showing the first 1,000 rows of a busy day. Real totals may be higher.</p>}
              {data.liveUnavailable && !tv && <p className="text-xs text-text-secondary">Live hand-off alerts need the “manage numbers” permission, so they are not shown for your role.</p>}
            </>
          ))}
      </LoadingBoundary>
    </div>
  );
}
