import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { useTtvT } from '@/i18n/ttvNamespace';
import { ackTtvAlert, fetchTtvOverview, setTtvThreshold, setTtvWatchDays } from '@/lib/ttvApi';
import {
  TTV_WINDOWS,
  humanizeSeconds,
  parseStallHours,
  parseWatchDays,
  reachedPercent,
  type TtvMilestone,
  type TtvOverview,
} from '@/lib/ttv';

interface TtvCardProps {
  /** Opens the account in the existing staff account detail (audited there). */
  onOpen: (accountId: string) => void;
}

type LoadState = 'loading' | 'forbidden' | 'error' | 'ready';
const FIELD = 'focus-ring w-24 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

/** Staff-only onboarding time-to-value card: milestone funnel + durations, stalled accounts, alert thresholds. */
export function TtvCard({ onOpen }: TtvCardProps) {
  const { t, language } = useTtvT();
  const [days, setDays] = useState<number>(30);
  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<TtvOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const [editing, setEditing] = useState(false);

  const nf = useMemo(() => new Intl.NumberFormat(language), [language]);

  const latest = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++latest.current;
    const r = await fetchTtvOverview(days);
    if (ticket !== latest.current) return; // a newer request (window change / refresh) superseded this one
    if (r.ok) {
      setData(r.overview);
      setState('ready');
    } else {
      setState(r.reason === 'forbidden' ? 'forbidden' : 'error');
    }
  }, [days]);

  // Initial state is 'loading'. Later reloads (window change, after an action) keep the current card on screen.
  useEffect(() => {
    void load();
  }, [load]);

  const duration = (seconds: number | null) => {
    const h = humanizeSeconds(seconds);
    return h ? t(`duration.${h.unit}`, { value: nf.format(h.value) }) : t('table.unknown');
  };

  const ack = async (id: string) => {
    setBusy(id);
    setActionError(false);
    try {
      await ackTtvAlert(id);
      await load();
    } catch {
      setActionError(true);
    } finally {
      setBusy(null);
    }
  };

  if (state === 'loading') {
    return (
      <Card interactive={false} padding="sm" aria-busy="true" className="space-y-3">
        <p className="sr-only" role="status">{t('loading')}</p>
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (state === 'forbidden') {
    return <Card interactive={false} padding="sm"><p role="alert" className="text-sm text-text-secondary">{t('forbidden')}</p></Card>;
  }
  if (state === 'error' || !data) {
    return (
      <Card interactive={false} padding="sm" className="flex items-center justify-between gap-3">
        <p role="alert" className="text-sm text-text-secondary">{t('loadError')}</p>
        <Button type="button" size="sm" variant="secondary" onClick={() => { setState('loading'); void load(); }}>{t('retry')}</Button>
      </Card>
    );
  }

  return (
    <Card interactive={false} padding="sm" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text-primary">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-text-secondary">{t('subtitle')}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          {t('window')}
          <select
            className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {TTV_WINDOWS.map((d) => <option key={d} value={d}>{t('windowDays', { count: d })}</option>)}
          </select>
        </label>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        {([['stats.signups', data.signups], ['stats.stalled', data.stalledNow], ['stats.openAlerts', data.openAlertCount]] as [string, number][]).map(([k, v]) => (
          <div key={k} className="rounded-xl border border-border bg-bg-secondary p-3">
            <dt className="text-[11px] text-text-secondary">{t(k)}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-text-primary">{nf.format(v)}</dd>
          </div>
        ))}
      </dl>
      {data.truncated && <p role="status" className="text-xs text-text-secondary">{t('truncated')}</p>}

      {data.signups === 0 ? (
        <p className="text-sm text-text-secondary">{t('emptyCohort')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('table.caption')}</caption>
            <thead>
              <tr className="text-start text-[11px] text-text-secondary">
                <th scope="col" className="py-1.5 pe-3 text-start font-medium">{t('table.milestone')}</th>
                <th scope="col" className="px-3 py-1.5 text-start font-medium">{t('table.reached')}</th>
                <th scope="col" className="px-3 py-1.5 text-start font-medium">{t('table.median')}</th>
                <th scope="col" className="ps-3 py-1.5 text-start font-medium">{t('table.p90')}</th>
              </tr>
            </thead>
            <tbody>
              {data.milestones.map((m) => {
                const pct = reachedPercent(m.reached, data.signups);
                return (
                  <tr key={m.milestone} className="border-t border-border">
                    <th scope="row" className="py-2 pe-3 text-start font-medium text-text-primary">{t(`milestone.${m.milestone}`)}</th>
                    <td className="px-3 py-2 tabular-nums text-text-primary">{nf.format(m.reached)}{pct === null ? '' : ` · ${nf.format(pct)}%`}</td>
                    <td className="px-3 py-2 tabular-nums text-text-primary">{duration(m.p50Seconds)}</td>
                    <td className="ps-3 py-2 tabular-nums text-text-primary">{duration(m.p90Seconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section aria-labelledby="ttv-alerts-h" className="space-y-2">
        <h3 id="ttv-alerts-h" className="text-sm font-semibold text-text-primary">{t('alerts.title')} · {nf.format(data.openAlertCount)}</h3>
        {actionError && <p role="alert" className="text-xs text-danger">{t('alerts.ackError')}</p>}
        {data.alerts.length === 0 ? (
          <p className="text-xs text-text-secondary">{t('alerts.none')}</p>
        ) : (
          <ul className="space-y-2">
            {data.alerts.map((a) => (
              <li key={a.id} className="rounded-xl border border-border bg-bg-secondary p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-primary">{a.companyName ?? t('alerts.unnamed')}</span>
                    <span className="block text-[11px] text-text-secondary">
                      {t('alerts.stalledAt', { milestone: t(`milestone.${a.milestone}`) })} · {t('alerts.overdue', { hours: nf.format(Math.round(a.stalledHours)), limit: nf.format(a.thresholdHours) })}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => onOpen(a.accountId)}>{t('alerts.open')}</Button>
                    {a.acknowledged ? (
                      <span className="text-[11px] text-text-secondary">{t('alerts.acknowledged')}</span>
                    ) : (
                      <Button type="button" size="sm" variant="secondary" loading={busy === a.id} onClick={() => void ack(a.id)}>{t('alerts.acknowledge')}</Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ttv-config-h" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="ttv-config-h" className="text-sm font-semibold text-text-primary">{t('config.title')}</h3>
          <Button type="button" size="sm" variant="ghost" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>{t('config.toggle')}</Button>
        </div>
        {editing && <ConfigEditor data={data} onSaved={load} />}
      </section>
    </Card>
  );
}

function ConfigEditor({ data, onSaved }: { data: TtvOverview; onSaved: () => Promise<void> }) {
  const { t } = useTtvT();
  const [hours, setHours] = useState<Record<string, string>>(() => Object.fromEntries(data.config.map((c) => [c.milestone, String(c.stallHours)])));
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(data.config.map((c) => [c.milestone, c.alertEnabled])));
  const [watch, setWatch] = useState(String(data.watchDays));
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; key: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setMsg(null);
    const parsed = data.config.map((c) => ({ c, h: parseStallHours(hours[c.milestone] ?? '') }));
    if (parsed.some((p) => p.h === null)) return setMsg({ kind: 'err', key: 'config.invalidHours' });
    const wd = parseWatchDays(watch);
    if (wd === null) return setMsg({ kind: 'err', key: 'config.invalidDays' });
    setSaving(true);
    try {
      for (const p of parsed) {
        if (p.h !== p.c.stallHours || enabled[p.c.milestone] !== p.c.alertEnabled) {
          await setTtvThreshold(p.c.milestone as TtvMilestone, p.h as number, enabled[p.c.milestone] === true);
        }
      }
      if (wd !== data.watchDays) await setTtvWatchDays(wd);
      await onSaved();
      setMsg({ kind: 'ok', key: 'config.saved' });
    } catch {
      setMsg({ kind: 'err', key: 'config.saveError' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-3">
      <ul className="space-y-2">
        {data.config.map((c) => (
          <li key={c.milestone} className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-text-primary">{t(`milestone.${c.milestone}`)}</span>
            <span className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="sr-only">{t('config.hours')} — {t(`milestone.${c.milestone}`)}</span>
                <input className={FIELD} inputMode="numeric" value={hours[c.milestone] ?? ''} aria-label={`${t('config.hours')} — ${t(`milestone.${c.milestone}`)}`}
                  onChange={(e) => setHours((h) => ({ ...h, [c.milestone]: e.target.value }))} />
                <span aria-hidden="true">{t('config.hours')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input type="checkbox" checked={enabled[c.milestone] === true} onChange={(e) => setEnabled((s) => ({ ...s, [c.milestone]: e.target.checked }))} />
                {t('config.enabled')}
              </label>
            </span>
          </li>
        ))}
      </ul>
      <label className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        {t('config.watchDays')}
        <input className={FIELD} inputMode="numeric" value={watch} onChange={(e) => setWatch(e.target.value)} />
      </label>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" loading={saving} onClick={() => void save()}>{t('config.save')}</Button>
        {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={`text-xs ${msg.kind === 'err' ? 'text-danger' : 'text-text-secondary'}`}>{t(msg.key)}</p>}
      </div>
    </div>
  );
}
