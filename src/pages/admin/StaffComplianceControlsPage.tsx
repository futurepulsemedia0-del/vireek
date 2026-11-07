// /staff/compliance-controls — internal SOC 2 READINESS dashboard (Vireek staff only; wrapped in <StaffRoute>).
// Data: view compliance_control_status + table compliance_evidence (both staff-only via RLS).
// Not an attestation. Declared status comes from docs/compliance/soc2/controls.json (code-reviewed);
// evidence state is computed in SQL.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonTable } from '@/components/Skeleton';
import { useComplianceT } from '@/i18n/complianceNamespace';
import { useSEO } from '@/lib/seo';
import { fetchControls, fetchEvidenceIndex } from '@/lib/compliance/api';
import {
  buildAuditorBundle,
  buildControlsCsv,
  buildEvidenceIndexCsv,
  needsAttention,
  sortControls,
  summarize,
  type ControlRow,
  type EvidenceState,
} from '@/lib/compliance/controlStatus';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; rows: ControlRow[] };
type Filter = 'all' | 'attention';

const STATE_STYLE: Record<EvidenceState, string> = {
  fresh: 'bg-success-500/10 text-success-500',
  overdue: 'bg-warning-500/10 text-warning-500',
  failing: 'bg-danger/10 text-danger',
  incomplete: 'bg-warning-500/10 text-warning-500',
  never: 'bg-bg-tertiary text-text-secondary',
  not_applicable: 'bg-bg-tertiary text-text-secondary',
};

function download(filename: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function StaffComplianceControlsPage() {
  const { t, language } = useComplianceT();
  useSEO({ title: `${t('dashboard.title')} | Vireek`, description: t('dashboard.subtitle') });
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [exportError, setExportError] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', rows: sortControls(await fetchControls()) });
    } catch {
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = state.status === 'ready' ? state.rows : [];
  const summary = useMemo(() => summarize(rows), [rows]);
  const visible = useMemo(() => (filter === 'attention' ? rows.filter(needsAttention) : rows), [rows, filter]);
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' }) : t('dashboard.date.none'));
  const stamp = new Date().toISOString().slice(0, 10);

  async function exportWith(kind: 'controls' | 'evidence' | 'bundle') {
    setExportError(false);
    try {
      if (kind === 'controls') download(`vireek-soc2-controls-${stamp}.csv`, 'text/csv', buildControlsCsv(rows));
      else {
        const evidence = await fetchEvidenceIndex();
        if (kind === 'evidence') download(`vireek-soc2-evidence-index-${stamp}.csv`, 'text/csv', buildEvidenceIndexCsv(evidence));
        else download(`vireek-soc2-auditor-bundle-${stamp}.json`, 'application/json', buildAuditorBundle(rows, evidence, new Date()));
      }
    } catch {
      setExportError(true);
    }
  }

  return (
    <>
      <Header />
      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{t('dashboard.title')}</h1>
            <p className="mt-1 text-sm text-text-secondary">{t('dashboard.subtitle')}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()} loading={state.status === 'loading'}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('dashboard.refresh')}
          </Button>
        </div>

        <p role="note" className="mt-4 flex gap-2 rounded-xl border border-border bg-bg-tertiary p-3 text-sm text-text-secondary">
          <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('dashboard.notice')}
        </p>

        {state.status === 'loading' && (
          <div className="mt-6" role="status" aria-label={t('dashboard.loading')}>
            <SkeletonTable rows={8} columns={6} />
          </div>
        )}

        {state.status === 'error' && (
          <div className="mt-6">
            <EmptyState icon={ShieldAlert} variant="load-failed" title={t('dashboard.error.title')} description={t('dashboard.error.body')} onRetry={() => void load()} />
          </div>
        )}

        {state.status === 'ready' && rows.length === 0 && (
          <div className="mt-6">
            <EmptyState icon={ShieldQuestion} title={t('dashboard.empty.title')} description={t('dashboard.empty.body')} />
          </div>
        )}

        {state.status === 'ready' && rows.length > 0 && (
          <>
            <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {(
                [
                  ['total', summary.total],
                  ['met', summary.byStatus.met],
                  ['partial', summary.byStatus.partial],
                  ['missing', summary.byStatus.missing],
                  ['attention', summary.needingAttention],
                  ['unassigned', summary.unassignedOwners],
                ] as const
              ).map(([k, v]) => (
                <Card key={k} interactive={false} className="!p-4">
                  <dt className="text-xs text-text-secondary">{t(`dashboard.summary.${k}`)}</dt>
                  <dd className="mt-1 text-2xl font-bold text-text-primary">{v}</dd>
                </Card>
              ))}
            </dl>

            <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
              <label className="text-sm text-text-secondary">
                <span className="mr-2">{t('dashboard.filter.label')}</span>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as Filter)}
                  className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                >
                  <option value="all">{t('dashboard.filter.all')}</option>
                  <option value="attention">{t('dashboard.filter.attention')}</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                {(['controls', 'evidence', 'bundle'] as const).map((k) => (
                  <Button key={k} variant="secondary" size="sm" onClick={() => void exportWith(k)}>
                    <Download className="h-4 w-4" aria-hidden="true" />
                    {t(`dashboard.export.${k}`)}
                  </Button>
                ))}
              </div>
            </div>
            {exportError && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {t('dashboard.export.failed')}
              </p>
            )}

            {visible.length === 0 ? (
              <p className="mt-6 text-sm text-text-secondary">{t('dashboard.noMatch')}</p>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
                <table className="w-full min-w-[56rem] text-start text-sm">
                  <caption className="sr-only">{t('dashboard.table.caption')}</caption>
                  <thead className="bg-bg-tertiary text-xs text-text-secondary">
                    <tr>
                      {(['control', 'criteria', 'status', 'evidence', 'owner', 'lastEvidence', 'nextDue'] as const).map((h) => (
                        <th key={h} scope="col" className="px-3 py-2 text-start font-semibold">
                          {t(`dashboard.table.${h}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((c) => (
                      <Fragment key={c.id}>
                        <tr className="border-t border-border align-top">
                          <th scope="row" className="px-3 py-2 text-start font-normal">
                            <button
                              type="button"
                              aria-expanded={open === c.id}
                              aria-controls={`detail-${c.id}`}
                              onClick={() => setOpen(open === c.id ? null : c.id)}
                              className="focus-ring rounded text-start text-text-primary underline-offset-2 hover:underline"
                            >
                              <span className="font-mono text-xs text-text-secondary">{c.id}</span> {c.title}
                            </button>
                          </th>
                          <td className="px-3 py-2 text-xs text-text-secondary">{c.criteria.join(', ')}</td>
                          <td className="px-3 py-2">{t(`dashboard.status.${c.status}`)}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_STYLE[c.evidence_state]}`}>{t(`dashboard.state.${c.evidence_state}`)}</span>
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {c.owner ?? (
                              <>
                                <span className="font-semibold text-text-primary">{t('dashboard.owner.unassigned')}</span>
                                <br />
                                <span className="text-text-secondary">{t('dashboard.owner.proposed', { role: c.owner_role })}</span>
                              </>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">{date(c.last_evidence_at)}</td>
                          <td className="px-3 py-2 text-xs">{date(c.next_due_at)}</td>
                        </tr>
                        {open === c.id && (
                          <tr id={`detail-${c.id}`} className="bg-bg-secondary">
                            <td colSpan={7} className="px-3 py-3 text-xs text-text-secondary">
                              <p>
                                <span className="font-semibold text-text-primary">{t('dashboard.detail.gap')}: </span>
                                {c.gap}
                              </p>
                              <p className="mt-1">
                                <span className="font-semibold text-text-primary">{t('dashboard.detail.collectors')}: </span>
                                {c.collectors.length ? c.collectors.join(', ') : t('dashboard.detail.none')}
                              </p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
