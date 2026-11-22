// /staff/breach — read-only breach scoping + draft notices (Vireek employees only). Nothing is sent from this page.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import { useBreachT } from '@/i18n/breachNamespace';
import {
  BreachAdminError, fetchRegistry, renderNotices, runScan,
  type BreachRegistry, type IncidentText, type RenderResult, type ScanMode, type ScanResult,
} from '@/lib/breachAdminApi';

const field = 'focus-ring mt-1 w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-text-primary';

function SEO() {
  useSEO({ title: 'Breach scoping — Staff', description: 'Internal: breach scoping tool.', canonical: 'https://vireek.com/staff/breach' });
  return null;
}

/** <input type="datetime-local"> value (no zone) -> explicit UTC ISO string. */
const toUtcIso = (v: string) => (v ? `${v.length === 16 ? `${v}:00` : v}Z` : '');

export function StaffBreachPage() {
  const { t } = useBreachT();
  const { toast } = useToast();
  const [registry, setRegistry] = useState<BreachRegistry | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [mode, setMode] = useState<ScanMode>('existing_at_end');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<'scan' | 'render' | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [inc, setInc] = useState<IncidentText>({ reference: '', title: '', discovered_at: '', what_happened: '', containment: '', consequences: '', contact_name: '', contact_email: '' });

  useEffect(() => {
    fetchRegistry()
      .then((r) => { setRegistry(r); setState('ready'); })
      .catch((e) => setState(e instanceof BreachAdminError && e.status === 403 ? 'forbidden' : 'error'));
  }, []);

  const params = useMemo(() => ({ from: toUtcIso(from), to: toUtcIso(to), tables: selected, mode }), [from, to, selected, mode]);
  const valid = Boolean(params.from && params.to && selected.length > 0);
  const labelOf = useCallback((table: string) => registry?.tables.find((x) => x.table === table)?.label ?? table, [registry]);
  const categoryLabel = useCallback((id: string) => registry?.categories.find((c) => c.id === id)?.label ?? id, [registry]);

  const doScan = async () => {
    if (!valid) { toast(t('scan.invalid'), 'error'); return; }
    setBusy('scan'); setRendered(null);
    try { setScan(await runScan(params)); } catch { toast(t('scan.failed'), 'error'); setScan(null); } finally { setBusy(null); }
  };
  const doRender = async () => {
    setBusy('render');
    try { setRendered(await renderNotices(params, { ...inc, discovered_at: toUtcIso(inc.discovered_at) })); } catch { toast(t('notices.failed'), 'error'); } finally { setBusy(null); }
  };
  const copy = (text: string) => { navigator.clipboard.writeText(text).then(() => toast(t('notices.copied'), 'success')); };
  const setI = (k: keyof IncidentText) => (e: { target: { value: string } }) => setInc((p) => ({ ...p, [k]: e.target.value }));

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-center gap-2">
            <ShieldAlert className="text-accent" size={22} aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">{t('title')}</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">{t('subtitle')}</p>
          <p role="note" className="mt-3 rounded-xl border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-warning">{t('caveat')}</p>

          <div aria-live="polite" className="mt-4">
            {state === 'loading' && <p className="text-text-secondary">…</p>}
            {state === 'forbidden' && <p role="alert" className="text-danger">{t('forbidden')}</p>}
            {state === 'error' && <p role="alert" className="text-danger">{t('loadError')}</p>}
          </div>

          {state === 'ready' && registry && (
            <>
              <section aria-labelledby="inc-h" className="mt-6">
                <h2 id="inc-h" className="text-lg font-semibold text-text-primary">{t('incident.title')}</h2>
                <div className="mt-3 grid max-w-4xl gap-4 sm:grid-cols-2">
                  <label className="text-sm font-medium text-text-secondary">{t('incident.reference')}<input className={field} value={inc.reference} maxLength={60} onChange={setI('reference')} dir="ltr" /></label>
                  <label className="text-sm font-medium text-text-secondary">{t('incident.name')}<input className={field} value={inc.title} maxLength={160} onChange={setI('title')} /></label>
                  <label className="text-sm font-medium text-text-secondary">{t('incident.from')}<input type="datetime-local" className={field} value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" /></label>
                  <label className="text-sm font-medium text-text-secondary">{t('incident.to')}<input type="datetime-local" className={field} value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></label>
                  <label className="text-sm font-medium text-text-secondary">{t('incident.discovered')}<input type="datetime-local" className={field} value={inc.discovered_at} onChange={setI('discovered_at')} dir="ltr" /></label>
                  <label className="text-sm font-medium text-text-secondary">{t('incident.mode')}
                    <select className={field} value={mode} onChange={(e) => setMode(e.target.value === 'created_in_window' ? 'created_in_window' : 'existing_at_end')}>
                      <option value="existing_at_end">{t('incident.modeExisting')}</option>
                      <option value="created_in_window">{t('incident.modeCreated')}</option>
                    </select>
                  </label>
                </div>
              </section>

              <section aria-labelledby="tab-h" className="mt-8">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 id="tab-h" className="text-lg font-semibold text-text-primary">{t('tables.title')}</h2>
                  <Button variant="secondary" size="sm" onClick={() => setSelected(registry.tables.map((x) => x.table))}>{t('tables.all')}</Button>
                  <Button variant="secondary" size="sm" onClick={() => setSelected([])}>{t('tables.none')}</Button>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {registry.tables.map((x) => (
                    <label key={x.table} className="flex items-start gap-2 text-sm text-text-primary">
                      <input type="checkbox" className="mt-1" checked={selected.includes(x.table)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, x.table] : s.filter((v) => v !== x.table)))} />
                      <span>{x.label}<span className="block text-xs text-text-secondary">{x.categories.map(categoryLabel).join(', ')}</span></span>
                    </label>
                  ))}
                </div>
                <Button className="mt-4" variant="primary" size="sm" disabled={busy !== null} onClick={() => void doScan()}>{busy === 'scan' ? t('scan.running') : t('scan.run')}</Button>
              </section>

              {scan && (
                <section aria-labelledby="res-h" className="mt-10">
                  <h2 id="res-h" className="text-lg font-semibold text-text-primary">{t('result.title')}</h2>
                  <p role={scan.complete ? 'status' : 'alert'} className={`mt-2 text-sm ${scan.complete ? 'text-success' : 'font-semibold text-danger'}`}>{scan.complete ? t('result.complete') : t('result.incomplete')}</p>
                  <p className="mt-2 text-sm text-text-primary">{t('result.tenants')}: <strong>{scan.tenantTotal}</strong></p>
                  {scan.tenantTotal > scan.tenants.length && <p className="text-xs text-text-secondary">{t('result.shown', { shown: scan.tenants.length, total: scan.tenantTotal })}</p>}

                  <div className="mt-4 grid gap-6 lg:grid-cols-2">
                    <Card interactive={false} className="p-4">
                      <h3 className="text-sm font-semibold text-text-primary">{t('result.categories')}</h3>
                      <ul className="mt-2 space-y-1 text-sm">{Object.entries(scan.categoryTenantCounts).sort((a, b) => b[1] - a[1]).map(([id, n]) => <li key={id} className="flex justify-between gap-4"><span>{categoryLabel(id)}</span><span className="tabular-nums">{n}</span></li>)}</ul>
                    </Card>
                    <Card interactive={false} className="p-4">
                      <h3 className="text-sm font-semibold text-text-primary">{t('result.tableStatus')}</h3>
                      <ul className="mt-2 space-y-1 text-sm">{scan.tableResults.map((r) => (
                        <li key={r.table} className="flex justify-between gap-4"><span>{labelOf(r.table)}</span>
                          <span className={r.error || r.truncated ? 'text-danger' : 'text-text-secondary'}>{r.error ? `${t('result.error')}: ${r.error}` : r.truncated ? t('result.truncated') : `${r.tenants} · ${r.rows}`}</span></li>
                      ))}</ul>
                    </Card>
                  </div>

                  {scan.tenants.length === 0 ? <p className="mt-4 text-sm text-text-secondary">{t('result.empty')}</p> : (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-start text-sm">
                        <thead><tr className="text-text-secondary"><th className="py-2 pe-4 text-start font-medium">{t('result.tenant')}</th><th className="py-2 pe-4 text-start font-medium">{t('result.categories')}</th><th className="py-2 text-start font-medium">{t('result.rows')}</th></tr></thead>
                        <tbody>{scan.tenants.slice(0, 200).map((x) => (
                          <tr key={x.tenantId} className="border-t border-border align-top">
                            <td className="py-2 pe-4"><span dir="auto">{x.companyName ?? x.fullName ?? '—'}</span><span className="block break-all text-xs text-text-secondary" dir="ltr">{x.tenantId}</span></td>
                            <td className="py-2 pe-4">{x.categories.map(categoryLabel).join(', ')}</td>
                            <td className="py-2 tabular-nums">{x.totalRows}</td>
                          </tr>))}</tbody>
                      </table>
                    </div>
                  )}

                  <h2 className="mt-10 text-lg font-semibold text-text-primary">{t('notices.title')}</h2>
                  <p className="text-sm text-text-secondary">{t('notices.notSent')}</p>
                  <div className="mt-3 grid max-w-4xl gap-4 sm:grid-cols-2">
                    <label className="text-sm font-medium text-text-secondary sm:col-span-2">{t('notices.content')}<textarea className={field} rows={3} maxLength={2000} value={inc.what_happened} onChange={setI('what_happened')} /></label>
                    <label className="text-sm font-medium text-text-secondary sm:col-span-2">{t('notices.containment')}<textarea className={field} rows={3} maxLength={2000} value={inc.containment} onChange={setI('containment')} /></label>
                    <label className="text-sm font-medium text-text-secondary sm:col-span-2">{t('notices.consequences')}<textarea className={field} rows={3} maxLength={2000} value={inc.consequences} onChange={setI('consequences')} /></label>
                    <label className="text-sm font-medium text-text-secondary">{t('notices.contactName')}<input className={field} maxLength={120} value={inc.contact_name} onChange={setI('contact_name')} /></label>
                    <label className="text-sm font-medium text-text-secondary">{t('notices.contactEmail')}<input className={field} maxLength={200} dir="ltr" value={inc.contact_email} onChange={setI('contact_email')} /></label>
                  </div>
                  <Button className="mt-4" variant="primary" size="sm" disabled={busy !== null || scan.tenantTotal === 0} onClick={() => void doRender()}>{busy === 'render' ? t('notices.rendering') : t('notices.render')}</Button>

                  {rendered && (
                    <div className="mt-6 space-y-4">
                      <Card interactive={false} className="p-4">
                        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-text-primary">{t('notices.summary')}</h3><Button variant="secondary" size="sm" onClick={() => copy(rendered.internalSummary)}>{t('notices.copy')}</Button></div>
                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-text-secondary" dir="auto">{rendered.internalSummary}</pre>
                      </Card>
                      {rendered.drafts.map((d) => (
                        <Card key={d.tenantId} interactive={false} className="p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm text-text-primary">{t('notices.to')}: <span dir="ltr">{d.to ?? t('notices.noRecipient')}</span></p>
                            <Button variant="secondary" size="sm" onClick={() => copy(`${d.subject}\n\n${d.body}`)}>{t('notices.copy')}</Button>
                          </div>
                          <p className={`mt-1 text-xs ${d.complete ? 'text-success' : 'text-danger'}`}>{d.placeholders.length > 0 ? t('notices.placeholders', { count: d.placeholders.length }) : t('notices.ready')}</p>
                          <p className="mt-2 text-sm font-semibold text-text-primary" dir="auto">{d.subject}</p>
                          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-text-secondary" dir="auto">{d.body}</pre>
                        </Card>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
