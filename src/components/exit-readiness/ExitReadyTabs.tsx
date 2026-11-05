import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useExitT } from '@/i18n/exitReadyNamespace';
import { captureError } from '@/lib/sentry';
import { buildValuationSummary, type AddBack, type Evaluation, type ModelInput, type SnapshotLite } from '@/lib/exitReadiness';
import {
  buildReadinessChecklist, evidenceScore, movedDrivers, scoreSignals,
  type EffectiveMultiples, type LineageRun, type MultipleRow,
} from '@/lib/exitLineage';
import { buildExportSheets, downloadBytes, exportFileName, writePdf, writeXlsx } from '@/lib/exitExport';
import * as api from '@/lib/exitReadyApi';
import { EvidencePanel } from './EvidencePanel';
import { MultiplesPanel } from './MultiplesPanel';
import { StagedRoomPanel } from './StagedRoomPanel';

export type ExitReadyTab = 'evidence' | 'multiples' | 'sharing';

interface Props {
  tab: ExitReadyTab;
  ownerId: string;
  model: ModelInput;
  evaluation: Evaluation;
  effective: EffectiveMultiples;
  addBacks: AddBack[];
  snapshots: SnapshotLite[];
  multiples: { rows: MultipleRow[]; unavailable: boolean };
  onMultiplesChange: (rows: MultipleRow[]) => void;
  companyName: string | null;
}

interface EvidenceState {
  run: LineageRun | null;
  previousRun: LineageRun | null;
  evidenceRows: api.EvidenceRow[];
  documents: api.OwnerDocument[];
  unavailable: boolean;
}

interface SharingState {
  links: api.StagedLink[];
  shared: api.SharedDocument[];
  questions: api.QaEntry[];
  docLogs: api.DocAccessEntry[];
  audit: api.AuditEntry[];
  unavailable: boolean;
}

export function ExitReadyTabs(p: Props) {
  const { t } = useExitT();
  const { toast } = useToast();
  const [evidence, setEvidence] = useState<EvidenceState | null>(null);
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null);
  const [savingMultiple, setSavingMultiple] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<api.StagedLink | null>(null);

  const fail = useCallback((e: unknown, fallback: string) => {
    captureError(e, { page: 'exit-readiness-evidence' });
    toast(e instanceof Error ? e.message : fallback, 'error');
  }, [toast]);

  const loadEvidence = useCallback(async () => {
    try {
      const [run, previousRun, evidenceRows, documents] = await Promise.all([
        api.fetchLatestRun(p.ownerId), api.fetchPreviousRun(p.ownerId), api.fetchAddbackEvidence(p.ownerId), api.fetchOwnerDocuments(p.ownerId),
      ]);
      setEvidence({ run, previousRun, evidenceRows, documents, unavailable: false });
    } catch (e) {
      captureError(e, { page: 'exit-readiness-evidence' });
      setEvidence({ run: null, previousRun: null, evidenceRows: [], documents: [], unavailable: true });
    }
  }, [p.ownerId]);

  const loadSharing = useCallback(async () => {
    try {
      const [links, shared, questions, docLogs, audit, documents] = await Promise.all([
        api.fetchStagedLinks(p.ownerId), api.fetchSharedDocuments(p.ownerId), api.fetchQuestions(p.ownerId),
        api.fetchDocAccessLogs(p.ownerId), api.fetchAudit(p.ownerId), api.fetchOwnerDocuments(p.ownerId),
      ]);
      setSharing({ links, shared, questions, docLogs, audit, unavailable: false });
      setEvidence((e) => (e ? { ...e, documents } : e));
    } catch (e) {
      captureError(e, { page: 'exit-readiness-sharing' });
      setSharing({ links: [], shared: [], questions: [], docLogs: [], audit: [], unavailable: true });
    }
  }, [p.ownerId]);

  // Lazy: load only what the open tab needs. The staged-room form also needs the latest run (evidence).
  useEffect(() => {
    if ((p.tab === 'evidence' || p.tab === 'sharing') && evidence === null) void loadEvidence();
    if (p.tab === 'sharing' && sharing === null) void loadSharing();
  }, [p.tab, evidence, sharing, loadEvidence, loadSharing]);

  const checklist = useMemo(() => buildReadinessChecklist(evidence?.run ?? null, p.model.metrics), [evidence, p.model.metrics]);
  const score = useMemo(() => evidenceScore(checklist), [checklist]);
  const signals = useMemo(() => scoreSignals(evidence?.run ?? null), [evidence]);
  const moved = useMemo(() => movedDrivers(p.snapshots), [p.snapshots]);

  const onRun = async () => {
    setRunning(true);
    try {
      await api.runLineage();
      await loadEvidence();
    } catch (e) {
      fail(e, t('evidence.verifyError'));
    } finally {
      setRunning(false);
    }
  };

  const onExport = async (kind: 'xlsx' | 'pdf') => {
    if (!evidence?.run) {
      toast(t('evidence.exportNeedRun'), 'error');
      return;
    }
    setExporting(kind);
    try {
      const evMap: Record<string, string[]> = {};
      for (const r of evidence.evidenceRows) (evMap[r.addbackId] ??= []).push(r.title);
      const generatedAt = new Date().toISOString();
      const sheets = buildExportSheets({
        companyName: p.companyName, generatedAt, run: evidence.run, previousRun: evidence.previousRun, evaluation: p.evaluation, model: p.model,
        multiples: p.effective, addBacks: p.addBacks, evidence: evMap, checklist, evidenceScore: score, signals,
      });
      const meta = { generatedAt, company: p.companyName };
      if (kind === 'xlsx') downloadBytes(exportFileName('xlsx', generatedAt), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await writeXlsx(sheets, meta));
      else downloadBytes(exportFileName('pdf', generatedAt), 'application/pdf', await writePdf(sheets, meta));
    } catch (e) {
      fail(e, t('evidence.exportError'));
    } finally {
      setExporting(null);
    }
  };

  const guarded = async (id: string | null, fn: () => Promise<void>, failText: string) => {
    if (id) setBusyId(id);
    try {
      await fn();
    } catch (e) {
      fail(e, failText);
    } finally {
      if (id) setBusyId(null);
    }
  };

  if ((p.tab === 'evidence' && evidence === null) || (p.tab === 'sharing' && (sharing === null || evidence === null))) {
    return <div aria-busy="true" aria-live="polite"><span className="sr-only">{t('common.loading')}</span><SkeletonCardList count={2} /></div>;
  }

  return (
    <>
      {p.tab === 'evidence' && evidence && (
        <EvidencePanel
          unavailable={evidence.unavailable} run={evidence.run} previousRun={evidence.previousRun} checklist={checklist} evidenceScore={score}
          signals={signals} moved={moved} hasTwoSnapshots={p.snapshots.length >= 2} running={running} onRun={() => void onRun()}
          onVerify={api.verifyFact} exporting={exporting} onExport={(k) => void onExport(k)}
          addBacks={p.addBacks} evidenceRows={evidence.evidenceRows} documents={evidence.documents}
          onAttach={(a, d) => guarded(a, async () => { await api.attachEvidence(p.ownerId, a, d); await loadEvidence(); }, t('evidence.verifyError'))}
          onDetach={(id) => guarded(id, async () => { await api.detachEvidence(id); await loadEvidence(); }, t('evidence.verifyError'))}
        />
      )}
      {p.tab === 'multiples' && (
        <MultiplesPanel
          unavailable={p.multiples.unavailable} rows={p.multiples.rows} effective={p.effective} industryKey={p.model.settings.industryKey} saving={savingMultiple}
          onSave={async (row) => {
            setSavingMultiple(true);
            try {
              await api.saveMultipleRow(p.ownerId, row);
              p.onMultiplesChange(await api.fetchMultipleRows(p.ownerId));
              toast(t('multiples.addRow'), 'success');
            } catch (e) { fail(e, t('multiples.addRow')); } finally { setSavingMultiple(false); }
          }}
          onDelete={async (row) => {
            if (!row.id) return;
            setSavingMultiple(true);
            try {
              await api.deleteMultipleRow(row.id);
              p.onMultiplesChange(await api.fetchMultipleRows(p.ownerId));
            } catch (e) { fail(e, t('multiples.delete')); } finally { setSavingMultiple(false); }
          }}
        />
      )}
      {p.tab === 'sharing' && sharing && evidence && (
        <StagedRoomPanel
          unavailable={sharing.unavailable || evidence.unavailable} hasRun={evidence.run !== null} links={sharing.links} documents={evidence.documents}
          shared={sharing.shared} questions={sharing.questions} docLogs={sharing.docLogs} audit={sharing.audit}
          creating={creating} busyId={busyId} createdUrl={createdUrl} onDismissUrl={() => setCreatedUrl(null)}
          onCreate={async (input) => {
            setCreating(true);
            try {
              const created = await api.createStagedRoom({ ...input, valuation: buildValuationSummary(p.model, p.evaluation) });
              setCreatedUrl(created.url);
              await loadSharing();
            } catch (e) { fail(e, t('sharing.create')); } finally { setCreating(false); }
          }}
          onSetStage={(l, c, pii, sections) => guarded(l.id, async () => { await api.setStage(l.id, c, pii, sections); await loadSharing(); }, t('sharing.approveDetailed'))}
          onRevoke={setRevokeTarget}
          onShare={(l, d, s) => guarded(l, async () => { await api.shareDocument(l, d, s); await loadSharing(); }, t('sharing.docShare'))}
          onUnshare={(l, d) => guarded(l, async () => { await api.unshareDocument(l, d); await loadSharing(); }, t('sharing.docUnshare'))}
          onAnswer={(q, a) => guarded(q, async () => { await api.answerQuestion(q, a); await loadSharing(); }, t('sharing.qaSend'))}
        />
      )}
      <ConfirmDialog
        open={revokeTarget !== null} title={t('sharing.revokeTitle')} description={t('sharing.revokeBody')} confirmLabel={t('sharing.revokeConfirm')}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          const l = revokeTarget;
          setRevokeTarget(null);
          if (l) void guarded(l.id, async () => { await api.revokeStagedLink(l.id); await loadSharing(); }, t('sharing.revoke'));
        }}
      />
    </>
  );
}
