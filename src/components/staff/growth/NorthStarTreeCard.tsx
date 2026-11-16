import { useMemo } from 'react';
import { Card } from '@/components/ui/Card';
import { useGrowthT } from '@/i18n/growthNamespace';
import { fetchNorthStar } from '@/lib/growth/growthApi';
import { buildNorthStarTree, isPartialWeek, NORTH_STAR_WINDOW_WEEKS, type NorthStarRaw } from '@/lib/growth/northStar';
import { AsyncBoundary, DataTable, MetricTile, SectionTitle, useAsync, useFormatters } from '@/components/staff/growth/growthShared';

const WEEKS_LOADED = 12;

/**
 * Staff-only (rendered inside the /staff/growth page, which is wrapped in <StaffRoute>; the RPC re-checks
 * is_vireek_staff). Shows the North Star and its input tree. Definitions: docs/analytics/north-star.md.
 */
export function NorthStarTreeCard() {
  const state = useAsync<NorthStarRaw>(() => fetchNorthStar(WEEKS_LOADED), 'north-star');
  return (
    <section aria-labelledby="north-star-title" className="space-y-4">
      <AsyncBoundary state={state}>{(raw) => <Body raw={raw} />}</AsyncBoundary>
    </section>
  );
}

function Body({ raw }: { raw: NorthStarRaw }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const now = useMemo(() => new Date(), []);
  const tree = useMemo(() => buildNorthStarTree(raw.weeks, now), [raw, now]);
  const dq = raw.dataQuality;
  const first = tree.windowWeeks[tree.windowWeeks.length - 1];
  const last = tree.windowWeeks[0];

  return (
    <>
      <Card interactive={false} className="space-y-2 p-4">
        <SectionTitle id="north-star-title" hint={t('northStar.subtitle', { weeks: NORTH_STAR_WINDOW_WEEKS })}>
          {t('northStar.title')}
        </SectionTitle>
        {tree.windowWeeks.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('northStar.noWindow')}</p>
        ) : (
          <>
            <p className="text-3xl font-bold text-text-primary" aria-live="polite">{f.num(tree.keptN, 0)}</p>
            <p className="text-xs text-text-secondary">{t('northStar.window', { from: first, to: last })}</p>
            {tree.pendingN > 0 && (
              <p role="note" className="rounded-lg bg-warning-500/10 px-2 py-1 text-xs text-text-primary">
                {t('northStar.pending', { n: f.num(tree.pendingN, 0) })}
              </p>
            )}
          </>
        )}
        <p className="text-[11px] text-text-secondary">{t('northStar.identity')}</p>
      </Card>

      {tree.windowWeeks.length > 0 && (
        <div role="group" aria-label={t('northStar.treeLabel')} className="border-s-2 border-border ps-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('northStar.inputs')}</h3>
          <ul className="grid gap-3 md:grid-cols-2">
            <li>
              <Card interactive={false} className="space-y-1 p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{t('northStar.calls')}</p>
                <p className="text-2xl font-bold text-text-primary">{f.num(tree.callsN, 0)}</p>
                <p className="text-[11px] text-text-secondary">
                  <span className="font-semibold">{t('common.formula')}:</span> {t('northStar.callsFormula')}
                </p>
              </Card>
            </li>
            <li>
              <MetricTile label={t('northStar.booking')} formula={t('northStar.bookingFormula')} metric={tree.bookingRate} format={(v) => f.pct(v)} />
            </li>
            <li>
              <MetricTile label={t('northStar.keep')} formula={t('northStar.keepFormula')} metric={tree.keepRate} format={(v) => f.pct(v)} />
            </li>
            {tree.breadth && (
              <li>
                <MetricTile
                  label={t('northStar.breadth', { week: tree.breadth.weekStart })}
                  formula={t('northStar.breadthFormula')}
                  metric={tree.breadth.reach}
                  format={(v) => f.pct(v)}
                />
              </li>
            )}
          </ul>
          <div className="mt-3 rounded-xl bg-bg-secondary p-3 text-xs text-text-primary">
            <p className="font-semibold">{t('northStar.companion')}</p>
            <p>
              {t('northStar.paid')}: {f.money(tree.paidCents, 'USD')}
            </p>
            <p className="text-text-secondary">{t('northStar.paidNote')}</p>
          </div>
        </div>
      )}

      <Card interactive={false} className="space-y-2 p-4">
        <h3 className="text-sm font-semibold text-text-primary">{t('northStar.gapsTitle')}</h3>
        <ul className="list-disc space-y-1 ps-5 text-xs text-text-primary">
          <li>{t('northStar.gapAnswer', { n: f.num(dq.callsWithAnswerMs90d, 0), total: f.num(dq.callsQualifying90d, 0) })}</li>
          <li>{t('northStar.gapMissed')}</li>
        </ul>
        <h3 className="pt-2 text-sm font-semibold text-text-primary">{t('northStar.dqTitle')}</h3>
        <ul className="list-disc space-y-1 ps-5 text-xs text-text-primary">
          <li>{t('northStar.dqSources', { q: f.num(dq.callsQualifying90d, 0), all: f.num(dq.callsAllSources90d, 0) })}</li>
          <li>{t('northStar.dqVoiceKey', { k: f.num(dq.jobsLinkedWithVoiceKey90d, 0), j: f.num(dq.jobsLinked90d, 0) })}</li>
          <li>{t('northStar.dqBookedNoJob', { n: f.num(dq.callsBookedStatusNoJob90d, 0) })}</li>
        </ul>
      </Card>

      <div className="space-y-2">
        <SectionTitle id="north-star-weekly">{t('northStar.weekly')}</SectionTitle>
        <DataTable
          caption={t('northStar.weeklyCaption')}
          head={[t('northStar.colWeek'), t('northStar.colCalls'), t('northStar.colBooked'), t('northStar.colKept'), t('northStar.colPending'), t('northStar.colAccounts')]}
        >
          {raw.weeks.map((w) => {
            const partial = isPartialWeek(w.weekStart, now);
            return (
              <tr key={w.weekStart}>
                <th scope="row" className="px-3 py-2 text-start font-normal">
                  {w.weekStart}
                  {partial && <span className="ms-2 text-xs text-text-secondary">({t('northStar.partial')})</span>}
                </th>
                <td className="px-3 py-2">{f.num(w.callsN, 0)}</td>
                <td className="px-3 py-2">{f.num(w.bookedCallsN, 0)}</td>
                <td className="px-3 py-2">{f.num(w.keptN, 0)}</td>
                <td className="px-3 py-2">
                  {f.num(w.pendingN, 0)}
                  {!partial && w.pendingN > 0 && <span className="ms-2 text-xs text-text-secondary">({t('northStar.maturing')})</span>}
                </td>
                <td className="px-3 py-2">{f.num(w.activeAccountsN, 0)}</td>
              </tr>
            );
          })}
        </DataTable>
      </div>
    </>
  );
}
