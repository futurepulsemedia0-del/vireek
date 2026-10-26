import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Camera, Info, Landmark, Lock, RefreshCw, TrendingUp } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { AssessmentPanel } from '@/components/valuation/AssessmentPanel';
import { DataRoomPanel } from '@/components/valuation/DataRoomPanel';
import { HistoryPanel } from '@/components/valuation/HistoryPanel';
import { NumbersPanel } from '@/components/valuation/NumbersPanel';
import { BandBadge, ConfidenceBadge, ScoreBar, ScoreRing, StatCard } from '@/components/valuation/ValuationUi';
import {
  answersEqual,
  buildRecommendations,
  describeValuationError,
  estimateValue,
  fetchValuationBundle,
  formatMoney,
  overallReadiness,
  profileInputs,
  profileToForm,
  saveAnswers,
  saveDataRoomItem,
  saveNumbers,
  saveSnapshot,
  scoreAssessment,
  scoreDataRoom,
  validateNumbers,
  TARGET_READINESS,
  type AnswerValue,
  type Answers,
  type DataRoomRow,
  type DataRoomStatus,
  type NumbersErrors,
  type NumbersForm,
  type ValuationBundle,
} from '@/lib/valuation';

type TabKey = 'overview' | 'numbers' | 'assessment' | 'dataroom' | 'history';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'numbers', label: 'Numbers' },
  { key: 'assessment', label: 'Readiness' },
  { key: 'dataroom', label: 'Data room' },
  { key: 'history', label: 'History' },
];

export function ValuationPage() {
  const { isOwner, profile } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id : undefined;

  const [bundle, setBundle] = useState<ValuationBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');

  const [form, setForm] = useState<NumbersForm>(() => profileToForm(null));
  const [formErrors, setFormErrors] = useState<NumbersErrors>({});
  const [savingNumbers, setSavingNumbers] = useState(false);
  const [draft, setDraft] = useState<Answers>({});
  const [savingAnswers, setSavingAnswers] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [savingSnapshot, setSavingSnapshot] = useState(false);

  const load = useCallback(async () => {
    if (!accountOwnerId) { setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchValuationBundle(accountOwnerId);
      setBundle(next);
      setForm(profileToForm(next.profile));
      setDraft(next.profile?.answers ?? {});
      setFormErrors({});
    } catch (err) {
      setLoadError(describeValuationError(err, 'Could not load your valuation.'));
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => { void load(); }, [load]);

  const profileRow = bundle?.profile ?? null;
  const items = useMemo(() => bundle?.items ?? [], [bundle]);
  const savedAnswers = useMemo(() => profileRow?.answers ?? {}, [profileRow]);

  const assessment = useMemo(() => scoreAssessment(savedAnswers), [savedAnswers]);
  const dataRoom = useMemo(() => scoreDataRoom(items), [items]);
  const readiness = useMemo(() => overallReadiness(assessment, dataRoom), [assessment, dataRoom]);
  const inputs = useMemo(() => profileInputs(profileRow), [profileRow]);
  const estimate = useMemo(() => estimateValue(inputs, readiness, assessment.answered), [inputs, readiness, assessment.answered]);
  const recommendations = useMemo(() => buildRecommendations(savedAnswers, items), [savedAnswers, items]);

  const numbersDirty = useMemo(() => {
    const saved = profileToForm(profileRow);
    return (Object.keys(saved) as Array<keyof NumbersForm>).some((k) => saved[k] !== form[k]);
  }, [profileRow, form]);
  const answersDirty = !answersEqual(draft, savedAnswers);
  const hasAnyData = profileRow !== null || items.length > 0 || (bundle?.snapshots.length ?? 0) > 0;

  const handleSaveNumbers = async () => {
    if (!accountOwnerId) return;
    const errors = validateNumbers(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) { toast('Fix the highlighted fields first.', 'error'); return; }
    setSavingNumbers(true);
    try {
      const saved = await saveNumbers(accountOwnerId, form);
      setBundle((b) => (b ? { ...b, profile: saved } : b));
      setForm(profileToForm(saved));
      toast('Numbers saved.', 'success');
    } catch (err) {
      toast(describeValuationError(err, 'Could not save your numbers.'), 'error');
    } finally {
      setSavingNumbers(false);
    }
  };

  const handleSaveAnswers = async () => {
    if (!accountOwnerId) return;
    setSavingAnswers(true);
    try {
      const saved = await saveAnswers(accountOwnerId, draft);
      setBundle((b) => (b ? { ...b, profile: saved } : b));
      setDraft(saved.answers);
      toast('Answers saved.', 'success');
    } catch (err) {
      toast(describeValuationError(err, 'Could not save your answers.'), 'error');
    } finally {
      setSavingAnswers(false);
    }
  };

  const handleSaveItem = async (itemKey: string, status: DataRoomStatus, note: string | null): Promise<boolean> => {
    if (!accountOwnerId) return false;
    setBusyKey(itemKey);
    try {
      const row = await saveDataRoomItem(accountOwnerId, itemKey, status, note);
      setBundle((b) => {
        if (!b) return b;
        const rest = b.items.filter((r: DataRoomRow) => r.item_key !== itemKey);
        return { ...b, items: [...rest, row] };
      });
      return true;
    } catch (err) {
      toast(describeValuationError(err, 'Could not update the checklist.'), 'error');
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const handleSnapshot = async () => {
    if (!accountOwnerId) return;
    setSavingSnapshot(true);
    try {
      const snap = await saveSnapshot(accountOwnerId, { label: snapshotLabel, readiness, assessment, dataRoom, estimate, inputs });
      setBundle((b) => (b ? { ...b, snapshots: [snap, ...b.snapshots] } : b));
      setSnapshotLabel('');
      toast('Snapshot saved to your history.', 'success');
    } catch (err) {
      toast(describeValuationError(err, 'Could not save the snapshot.'), 'error');
    } finally {
      setSavingSnapshot(false);
    }
  };

  const header = (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><Landmark size={22} aria-hidden="true" /></span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Valuation and exit readiness</h1>
        <p className="text-sm text-text-secondary">See what your business could be worth, how ready it is for a buyer, and what to fix first.</p>
      </div>
    </div>
  );

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel="Valuation">
        {header}
        <EmptyState icon={Lock} title="Owner access only" description="Valuation uses the most sensitive financial numbers in the business, so only the account owner can see it." />
      </DashboardLayout>
    );
  }

  const dirtyFor = (key: TabKey) => (key === 'numbers' && numbersDirty) || (key === 'assessment' && answersDirty);
  const remaining = assessment.total - assessment.answered;

  return (
    <DashboardLayout activeLabel="Valuation">
      {header}

      {loading ? (
        <div role="status" aria-label="Loading valuation"><SkeletonCardList count={3} rows={3} /></div>
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-8 text-center">
          <AlertCircle className="text-danger" />
          <p className="text-sm text-text-primary">{loadError}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}><RefreshCw size={16} /> Try again</Button>
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Valuation sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                id={`val-tab-${t.key}`}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                aria-controls={`val-panel-${t.key}`}
                onClick={() => setTab(t.key)}
                className={`focus-ring min-h-[40px] whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {t.label}
                {dirtyFor(t.key) && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-warning-500 align-middle"><span className="sr-only">Unsaved changes</span></span>}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`val-panel-${tab}`} aria-labelledby={`val-tab-${tab}`}>
            {tab === 'overview' && (
              !hasAnyData ? (
                <EmptyState
                  icon={TrendingUp}
                  title="Find out what your business is worth"
                  description="Enter your owner earnings, answer 18 short questions and work through the data-room checklist. You get a value range, a readiness score and a prioritised to-do list."
                  action={{ label: 'Enter your numbers', onClick: () => setTab('numbers') }}
                  secondaryAction={{ label: 'Start the questionnaire', onClick: () => setTab('assessment') }}
                />
              ) : (
                <div className="space-y-6">
                  <div className="grid gap-4 lg:grid-cols-3">
                    <section aria-label="Exit-readiness score" className="flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                      <ScoreRing score={readiness} label="Exit-readiness score" />
                      <div className="min-w-0 space-y-2">
                        <h2 className="text-base font-bold text-text-primary">Exit readiness</h2>
                        <BandBadge score={readiness} />
                        <p className="text-xs text-text-secondary">
                          {readiness == null
                            ? 'Answer at least one readiness question to get a score.'
                            : `Questionnaire ${assessment.score ?? 0} · Data room ${dataRoom.score}`}
                        </p>
                      </div>
                    </section>

                    <section aria-label="Estimated value" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5 lg:col-span-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-base font-bold text-text-primary">Estimated business value</h2>
                        {estimate.canCompute && <ConfidenceBadge confidence={estimate.confidence} />}
                      </div>
                      {estimate.canCompute ? (
                        <>
                          <p className="mt-2 break-words text-3xl font-bold text-text-primary">
                            {formatMoney(estimate.valueLow, { compact: true })} – {formatMoney(estimate.valueHigh, { compact: true })}
                          </p>
                          <p className="mt-1 text-sm text-text-secondary">
                            Midpoint {formatMoney(estimate.valueMid, { compact: true })} at about {estimate.multipleMid.toFixed(2)}x owner earnings
                            {estimate.impliedRevenueMultiple != null && ` (${estimate.impliedRevenueMultiple.toFixed(2)}x revenue)`}.
                          </p>
                          <div className="mt-4 grid grid-cols-2 gap-3">
                            <StatCard
                              label="Est. after cash and debt"
                              value={formatMoney(estimate.equityMid, { compact: true })}
                              hint={estimate.debtExceedsValue ? 'Debt is larger than the midpoint value.' : undefined}
                              tone={estimate.debtExceedsValue ? 'text-danger' : 'text-text-primary'}
                            />
                            <StatCard
                              label={`Worth at readiness ${TARGET_READINESS}`}
                              value={estimate.readinessUplift > 0 ? `+${formatMoney(estimate.readinessUplift, { compact: true })}` : '—'}
                              hint={estimate.readinessUplift > 0 ? 'Extra value from finishing the to-do list.' : readiness != null ? 'You are already at the target.' : 'Needs a readiness score.'}
                              tone={estimate.readinessUplift > 0 ? 'text-success' : 'text-text-primary'}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="mt-3 space-y-3">
                          <p className="text-sm text-text-secondary">{estimate.reason}</p>
                          <Button type="button" variant="secondary" size="sm" onClick={() => setTab('numbers')}>Enter your numbers</Button>
                        </div>
                      )}
                    </section>
                  </div>

                  <section aria-label="Score by area" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                    <h2 className="mb-4 text-base font-bold text-text-primary">Where you stand</h2>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {assessment.dimensions.map((d) => (
                        <ScoreBar key={d.key} label={d.label} score={d.score} detail={`${d.answered} of ${d.total} answered`} />
                      ))}
                    </div>
                  </section>

                  <section aria-label="What to do next" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                    <h2 className="mb-1 text-base font-bold text-text-primary">What to do next</h2>
                    <p className="mb-3 text-xs text-text-secondary">Ranked by how many readiness points each step is worth.</p>
                    {remaining > 0 && (
                      <p className="mb-3 rounded-xl bg-bg-tertiary px-3 py-2 text-sm text-text-primary">
                        {remaining} readiness question{remaining === 1 ? '' : 's'} left.{' '}
                        <button type="button" className="focus-ring rounded font-semibold text-accent underline" onClick={() => setTab('assessment')}>Answer them</button> for a sharper plan.
                      </p>
                    )}
                    {recommendations.length === 0 ? (
                      <p className="text-sm text-text-secondary">Nothing urgent. Keep answers and the data room up to date and save a snapshot each quarter.</p>
                    ) : (
                      <ol className="space-y-3">
                        {recommendations.map((r, i) => (
                          <li key={r.id} className="flex gap-3">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">{i + 1}</span>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-text-primary">{r.title}</p>
                              <p className="text-xs text-text-secondary">{r.detail} Worth about +{r.impact.toFixed(1)} points.</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

                  <section aria-label="Save a snapshot" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                    <h2 className="mb-1 text-base font-bold text-text-primary">Save a snapshot</h2>
                    <p className="mb-3 text-xs text-text-secondary">
                      Records today’s score and estimate so you can show progress. {(numbersDirty || answersDirty) && 'Unsaved changes are not included.'}
                    </p>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <div className="flex-1">
                        <Input label="Name (optional)" value={snapshotLabel} maxLength={120} onChange={(e) => setSnapshotLabel(e.target.value)} placeholder="Q4 2026 baseline" />
                      </div>
                      <Button type="button" size="sm" onClick={() => void handleSnapshot()} disabled={savingSnapshot || (readiness == null && !estimate.canCompute)}>
                        <Camera size={16} aria-hidden="true" /> {savingSnapshot ? 'Saving…' : 'Save snapshot'}
                      </Button>
                    </div>
                  </section>

                  <p className="flex gap-2 rounded-2xl border border-border bg-bg-secondary p-4 text-xs text-text-secondary">
                    <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>
                      This is a planning estimate based on the numbers you enter and the multiple band you choose. It is not an appraisal, an offer or financial advice.
                      Real prices depend on the buyer, deal terms and due diligence, so talk to a business broker and your accountant before you act on it.
                    </span>
                  </p>
                </div>
              )
            )}

            {tab === 'numbers' && (
              <NumbersPanel
                form={form}
                errors={formErrors}
                dirty={numbersDirty}
                saving={savingNumbers}
                onChange={(field, value) => { setForm((f) => ({ ...f, [field]: value })); setFormErrors((e) => ({ ...e, [field]: undefined })); }}
                onSave={() => void handleSaveNumbers()}
                onReset={() => { setForm(profileToForm(profileRow)); setFormErrors({}); }}
              />
            )}

            {tab === 'assessment' && (
              <AssessmentPanel
                draft={draft}
                dirty={answersDirty}
                saving={savingAnswers}
                onChange={(key: string, value: AnswerValue) => setDraft((d) => ({ ...d, [key]: value }))}
                onSave={() => void handleSaveAnswers()}
                onReset={() => setDraft(savedAnswers)}
              />
            )}

            {tab === 'dataroom' && <DataRoomPanel rows={items} busyKey={busyKey} onSave={handleSaveItem} />}

            {tab === 'history' && <HistoryPanel snapshots={bundle?.snapshots ?? []} onGoOverview={() => setTab('overview')} />}
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
