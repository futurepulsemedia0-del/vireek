import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeDollarSign, Pencil, Plus, Scale, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { usePricePolicyT } from '@/i18n/pricePolicyNamespace';
import {
  EMPTY_POLICY_FORM,
  PRICE_MODES,
  PricePolicyFormError,
  TRADES,
  US_STATE_CODES,
  formToPayload,
  legalWarnings,
  previewPolicy,
  recordToForm,
  type PricePolicyForm,
  type PricePolicyRecord,
} from '@/lib/pricePolicy';
import {
  METRICS_WINDOW_DAYS,
  deletePolicy,
  fetchBookItems,
  fetchMetrics,
  fetchOwnerId,
  fetchPlaybookSettings,
  fetchPolicies,
  savePlaybookSettings,
  savePolicy,
  setPolicyActive,
  type BookItemOption,
  type MetricsResult,
} from '@/lib/pricePolicyApi';
import { DEFAULT_PLAYBOOK_SETTINGS, type PlaybookSettings } from '../../supabase/functions/_shared/price-playbook/engine';

type TFn = ReturnType<typeof usePricePolicyT>['t'];

function useFormatters(language: string) {
  return useMemo(() => {
    const money = new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const pct = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 });
    return { money: (c: number) => money.format(c / 100), pct: (n: number) => pct.format(n) };
  }, [language]);
}

function Metrics({ result, t, language }: { result: MetricsResult | null; t: TFn; language: string }) {
  const f = useFormatters(language);
  const m = result?.metrics;
  const none = t('page.metricsNone');
  const cells: { label: string; value: string }[] = [
    { label: t('page.metric.priceAskRate'), value: m?.price_ask_rate != null ? f.pct(m.price_ask_rate) : none },
    { label: t('page.metric.conversion'), value: m?.conversion_after_price != null ? f.pct(m.conversion_after_price) : none },
    { label: t('page.metric.abandon'), value: m?.abandon_rate != null ? f.pct(m.abandon_rate) : none },
    { label: t('page.metric.ticket'), value: m?.average_ticket_cents != null ? f.money(m.average_ticket_cents) : none },
  ];
  return (
    <section aria-labelledby="pp-metrics" className="mb-8">
      <h2 id="pp-metrics" className="mb-3 text-sm font-semibold text-text-secondary">{t('page.metricsTitle', { days: METRICS_WINDOW_DAYS })}</h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cells.map((c) => (
          <Card key={c.label} interactive={false} className="p-4">
            <dd className="text-xl font-bold text-text-primary">{c.value}</dd>
            <dt className="mt-1 text-xs text-text-secondary">{c.label}</dt>
          </Card>
        ))}
      </dl>
      {result?.truncated && <p className="mt-2 text-xs text-text-secondary">{t('page.metricsTruncated')}</p>}
    </section>
  );
}

function SettingsCard({ initial, onSave, t }: { initial: PlaybookSettings; onSave: (s: PlaybookSettings) => Promise<void>; t: TFn }) {
  const [s, setS] = useState(initial);
  const [warranty, setWarranty] = useState(initial.warranty_months ? String(initial.warranty_months) : '');
  const [fin, setFin] = useState(initial.financing_min_cents ? String(initial.financing_min_cents / 100) : '');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    const w = Number(warranty);
    const fm = Number(fin);
    try {
      await onSave({
        ...s,
        warranty_months: warranty.trim() && Number.isInteger(w) && w >= 1 && w <= 120 ? w : null,
        financing_min_cents: fin.trim() && Number.isFinite(fm) && fm > 0 ? Math.round(fm * 100) : null,
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card interactive={false} className="mb-8 p-5">
      <h2 className="text-base font-semibold text-text-primary">{t('settings.title')}</h2>
      <p className="mt-1 text-sm text-text-secondary">{t('settings.help')}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Checkbox label={t('settings.licensed')} checked={s.licensed_techs} onChange={(e) => setS({ ...s, licensed_techs: e.target.checked })} />
        <Checkbox label={t('settings.onTime')} checked={s.on_time_guarantee} onChange={(e) => setS({ ...s, on_time_guarantee: e.target.checked })} />
        <Checkbox label={t('settings.sameDay')} checked={s.same_day_diagnostic_enabled} onChange={(e) => setS({ ...s, same_day_diagnostic_enabled: e.target.checked })} />
        <Checkbox label={t('settings.callback')} checked={s.human_callback_enabled} onChange={(e) => setS({ ...s, human_callback_enabled: e.target.checked })} />
        <Input label={t('settings.warranty')} type="number" inputMode="numeric" min={1} max={120} value={warranty} onChange={(e) => setWarranty(e.target.value)} />
        <Input label={t('settings.financing')} helperText={t('settings.financingHelp')} type="number" inputMode="decimal" min={0} value={fin} onChange={(e) => setFin(e.target.value)} />
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={submit} loading={saving} loadingLabel={t('form.saving')}>{t('settings.save')}</Button>
      </div>
    </Card>
  );
}

interface EditorProps {
  initial: PricePolicyForm;
  editingId: string | null;
  bookItems: BookItemOption[];
  ownerId: string;
  onSaved: () => void;
  onCancel: () => void;
  t: TFn;
}

function PolicyEditor({ initial, editingId, bookItems, ownerId, onSaved, onCancel, t }: EditorProps) {
  const { toast } = useToast();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewState, setPreviewState] = useState('');
  const set = <K extends keyof PricePolicyForm>(k: K, v: PricePolicyForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const fromBook = form.source_kind === 'price_book';
  const showAmounts = !fromBook && (form.mode === 'exact_flat' || form.mode === 'starting_at' || form.mode === 'range');
  const showFee = form.mode === 'diagnostic_fee_only' || form.mode === 'exact_flat' || form.mode === 'range' || form.mode === 'starting_at';

  const preview = useMemo(() => {
    try {
      const now = new Date();
      const payload = formToPayload(form, ownerId, now.toISOString());
      const item = bookItems.find((b) => b.id === form.price_book_item_id) ?? null;
      return previewPolicy(payload, item, previewState || null, now, {
        licensed_techs: false,
        warranty_months: null,
        on_time_guarantee: false,
      });
    } catch {
      return null;
    }
  }, [form, ownerId, bookItems, previewState]);

  const submit = async () => {
    setError(null);
    let payload;
    try {
      payload = formToPayload(form, ownerId, new Date().toISOString());
    } catch (e) {
      setError(e instanceof PricePolicyFormError ? t(`errors.${e.code}`) : t('page.saveFailed'));
      return;
    }
    setSaving(true);
    try {
      await savePolicy(payload, editingId);
      toast(t('page.saved'), 'success');
      onSaved();
    } catch (e) {
      setError(e instanceof Error && e.message === 'duplicate_service' ? t('page.duplicate') : t('page.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card interactive={false} className="mb-8 p-5">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Input label={t('form.name')} value={form.display_name} maxLength={120} onChange={(e) => set('display_name', e.target.value)} required />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label={t('form.trade')} value={form.trade} onChange={(e) => set('trade', e.target.value as PricePolicyForm['trade'])}>
              {TRADES.map((x) => <option key={x} value={x}>{t(`trades.${x}`)}</option>)}
            </Select>
            <Select label={t('form.mode')} value={form.mode} onChange={(e) => set('mode', e.target.value as PricePolicyForm['mode'])}>
              {PRICE_MODES.map((x) => <option key={x} value={x}>{t(`modes.${x}`)}</option>)}
            </Select>
          </div>
          <Input label={t('form.keywords')} value={form.keywords} onChange={(e) => set('keywords', e.target.value)} />
          <Select label={t('form.source')} value={form.source_kind} onChange={(e) => set('source_kind', e.target.value as PricePolicyForm['source_kind'])}>
            <option value="owner_entered">{t('form.sourceOwner')}</option>
            <option value="price_book">{t('form.sourceBook')}</option>
          </Select>
          {fromBook && (
            <Select label={t('form.bookItem')} value={form.price_book_item_id} onChange={(e) => set('price_book_item_id', e.target.value)}>
              <option value="">{t('form.bookItemNone')}</option>
              {bookItems.map((b) => <option key={b.id} value={b.id}>{b.service_name}</option>)}
            </Select>
          )}
          {showAmounts && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label={form.mode === 'range' ? t('form.lowRange') : t('form.low')} type="number" inputMode="decimal" min={0} step="0.01" value={form.low} onChange={(e) => set('low', e.target.value)} />
              {form.mode === 'range' && <Input label={t('form.high')} type="number" inputMode="decimal" min={0} step="0.01" value={form.high} onChange={(e) => set('high', e.target.value)} />}
            </div>
          )}
          {showFee && (
            <>
              <Input label={t('form.fee')} type="number" inputMode="decimal" min={0} step="0.01" value={form.fee} onChange={(e) => set('fee', e.target.value)} />
              <Checkbox label={t('form.feeCredited')} checked={form.fee_credited_on_repair} onChange={(e) => set('fee_credited_on_repair', e.target.checked)} />
            </>
          )}
          <Checkbox label={t('form.writtenBefore')} checked={form.written_price_before_work} onChange={(e) => set('written_price_before_work', e.target.checked)} />
          <Textarea label={t('form.includes')} rows={3} value={form.includes} onChange={(e) => set('includes', e.target.value)} />
          <Textarea label={t('form.changes')} rows={3} value={form.changes_price} onChange={(e) => set('changes_price', e.target.value)} />
          <Input label={t('form.states')} value={form.approved_states} onChange={(e) => set('approved_states', e.target.value)} />
          <Checkbox label={t('form.reviewApproved')} checked={form.legal_review_status === 'approved'} onChange={(e) => set('legal_review_status', e.target.checked ? 'approved' : 'pending')} />
          <Checkbox label={t('form.active')} checked={form.active} onChange={(e) => set('active', e.target.checked)} />
        </div>

        <section aria-labelledby="pp-preview" className="space-y-3">
          <h2 id="pp-preview" className="text-base font-semibold text-text-primary">{t('page.preview')}</h2>
          <p className="text-sm text-text-secondary">{t('page.previewHelp')}</p>
          <Select label={t('page.previewState')} value={previewState} onChange={(e) => setPreviewState(e.target.value)}>
            <option value="">{t('page.previewStateUnknown')}</option>
            {US_STATE_CODES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          {preview ? (
            <div aria-live="polite" className="space-y-3">
              <p className="whitespace-pre-line rounded-xl border border-border bg-bg-tertiary p-4 text-sm text-text-primary">{preview.reply.text}</p>
              {preview.reply.answer.downgraded_reason && (
                <p className="text-sm text-warning-500">{t(`downgrade.${preview.reply.answer.downgraded_reason}`)}</p>
              )}
              {preview.sourceLabels.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-text-secondary">{t('page.sources')}</h3>
                  <ul className="mt-1 list-disc ps-5 text-xs text-text-secondary">
                    {preview.sourceLabels.map((l) => <li key={l}>{l}</li>)}
                  </ul>
                </div>
              )}
              <p className={`text-xs ${preview.violations.length ? 'text-danger' : 'text-success'}`}>
                <span className="font-semibold">{t('page.audit')}: </span>
                {preview.violations.length
                  ? t('page.auditFail', { list: preview.violations.map((v) => t(`violations.${v}`)).join(', ') })
                  : t('page.auditPass')}
              </p>
            </div>
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
        </section>
      </div>

      {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{t('form.cancel')}</Button>
        <Button onClick={submit} loading={saving} loadingLabel={t('form.saving')}>{t('form.save')}</Button>
      </div>
    </Card>
  );
}

export function PricePolicyPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const { t, language } = usePricePolicyT();
  const canAccess = isOwner || permissions?.can_view_billing === true;

  const [policies, setPolicies] = useState<PricePolicyRecord[]>([]);
  const [bookItems, setBookItems] = useState<BookItemOption[]>([]);
  const [settings, setSettings] = useState<PlaybookSettings>(DEFAULT_PLAYBOOK_SETTINGS);
  const [metrics, setMetrics] = useState<MetricsResult | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; form: PricePolicyForm } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [p, b, s, o] = await Promise.all([fetchPolicies(), fetchBookItems(), fetchPlaybookSettings(), fetchOwnerId()]);
      setPolicies(p);
      setBookItems(b);
      setSettings(s);
      setOwnerId(o);
      // Metrics are secondary: a failure here must not hide the policies.
      fetchMetrics().then(setMetrics).catch(() => setMetrics(null));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canAccess) void load();
    else setLoading(false);
  }, [canAccess, load]);

  const now = new Date();

  const body = () => {
    if (!canAccess) {
      return <EmptyState variant="no-permission" icon={Scale} title={t('page.noPermission')} />;
    }
    if (loading) return (<><SkeletonStatGrid count={4} /><Skeleton className="mt-6 h-32 w-full" /></>);
    if (failed || !ownerId) {
      return <EmptyState variant="load-failed" icon={Scale} title={t('page.loadFailed')} action={{ label: t('page.retry'), onClick: () => void load() }} />;
    }
    return (
      <>
        <p role="note" className="mb-6 rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">{t('page.legalBanner')}</p>
        <Metrics result={metrics} t={t} language={language} />
        <SettingsCard
          key={JSON.stringify(settings)}
          initial={settings}
          t={t}
          onSave={async (next) => {
            try {
              await savePlaybookSettings(ownerId, next);
              setSettings(next);
              toast(t('page.saved'), 'success');
            } catch {
              toast(t('page.saveFailed'), 'error');
            }
          }}
        />
        {editing && (
          <PolicyEditor
            key={editing.id ?? 'new'}
            initial={editing.form}
            editingId={editing.id}
            bookItems={bookItems}
            ownerId={ownerId}
            t={t}
            onCancel={() => setEditing(null)}
            onSaved={() => { setEditing(null); void load(); }}
          />
        )}
        {policies.length === 0 && !editing ? (
          <EmptyState icon={BadgeDollarSign} title={t('page.emptyTitle')} description={t('page.emptyBody')} action={{ label: t('page.newPolicy'), onClick: () => setEditing({ id: null, form: EMPTY_POLICY_FORM }) }} />
        ) : (
          <ul className="space-y-3">
            {policies.map((p) => {
              const warnings = legalWarnings(p, now);
              return (
                <li key={p.id}>
                  <Card interactive={false} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold text-text-primary">{p.display_name}</h3>
                        <p className="text-sm text-text-secondary">{t(`trades.${p.trade}`)} · {t(`modes.${p.mode}`)}</p>
                        <p className={`mt-1 text-xs font-medium ${p.active ? 'text-success' : 'text-text-secondary'}`}>{p.active ? t('page.live') : t('page.disabledBecause')}</p>
                        {warnings.map((w) => <p key={w} className="mt-1 text-xs text-warning-500">{t(`warnings.${w}`)}</p>)}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setEditing({ id: p.id, form: recordToForm(p) })}>
                          <Pencil size={14} aria-hidden="true" /> {t('form.edit')}
                        </Button>
                        {confirmId === p.id ? (
                          <>
                            <span className="text-xs text-text-secondary">{t('page.deleteConfirm')}</span>
                            <Button size="sm" variant="danger" onClick={async () => {
                              try { await deletePolicy(p.id); toast(t('page.deleted'), 'success'); setConfirmId(null); void load(); } catch { toast(t('page.saveFailed'), 'error'); }
                            }}>{t('form.delete')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>{t('form.cancel')}</Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setConfirmId(p.id)}>
                            <Trash2 size={14} aria-hidden="true" /> {t('form.delete')}
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-text-primary">{t('page.title')}</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('page.subtitle')}</p>
          </div>
          {canAccess && !loading && !failed && !editing && (
            <Button onClick={() => setEditing({ id: null, form: EMPTY_POLICY_FORM })}>
              <Plus size={16} aria-hidden="true" /> {t('page.newPolicy')}
            </Button>
          )}
        </div>
        {body()}
      </div>
    </DashboardLayout>
  );
}
