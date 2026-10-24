/**
 * AI Transparency — /dashboard/ai-transparency
 *
 * Registry of every AI feature, classified as interactive AI, synthetic audio, or emotion recognition
 * (sentiment from text vs emotion from voice audio), with a per-feature switch, a required notice flow
 * for voice-based emotion, legal-review tracking and an owner export.
 * NOT LEGAL ADVICE — rules vary by jurisdiction and need legal review.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AudioLines, Copy, Download, Mic, RefreshCw, Scale, ScanFace, ShieldAlert, ShieldCheck, Bot, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  downloadRegistryCsv,
  downloadRegistryJson,
  exportRegistry,
  fetchRegistry,
  setFeature,
  setLegalReview,
  type RegistryFeature,
} from '@/lib/aiTransparencyApi';
import {
  CATEGORY_LABELS,
  EMOTION_BASIS_LABELS,
  JURISDICTION_DISCLAIMER,
  LEGAL_REVIEW_STATUSES,
  VOICE_EMOTION_ACKNOWLEDGEMENTS,
  buildVoiceEmotionNotice,
  summarizeRegistry,
  type AiCategory,
  type LegalReviewStatus,
} from '../../supabase/functions/_shared/ai-transparency/engine';

const REVIEW_LABELS: Record<LegalReviewStatus, string> = {
  not_reviewed: 'Not reviewed',
  in_review: 'In review',
  reviewed: 'Reviewed by counsel',
};

const GROUPS: Array<{ key: AiCategory; icon: typeof Bot; blurb: string }> = [
  { key: 'interactive_ai', icon: Bot, blurb: 'People talk to an AI. They should be able to tell, and reach a human.' },
  { key: 'synthetic_audio', icon: AudioLines, blurb: 'Audio generated or cloned by AI. Label it and only use voices you have rights to.' },
  { key: 'emotion_recognition', icon: ScanFace, blurb: 'Inferring emotion. Sentiment from text is separated from emotion from voice audio, which needs a notice.' },
  { key: 'other_ai', icon: Mic, blurb: 'Other AI processing kept in the registry for completeness.' },
];

function primaryCategory(f: RegistryFeature): AiCategory {
  // Emotion recognition outranks the others so it is never hidden under a broader group.
  if (f.categories.includes('emotion_recognition')) return 'emotion_recognition';
  if (f.categories.includes('synthetic_audio')) return 'synthetic_audio';
  if (f.categories.includes('interactive_ai')) return 'interactive_ai';
  return 'other_ai';
}

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

function NoticeDialog({ feature, onCancel, onConfirm }: { feature: RegistryFeature; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const titleId = useId();
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onCancel);
  const [checks, setChecks] = useState<boolean[]>(() => VOICE_EMOTION_ACKNOWLEDGEMENTS.map(() => false));
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const notice = useMemo(() => buildVoiceEmotionNotice(''), []);
  const all = checks.every(Boolean);

  const confirm = async () => {
    if (!all || busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(notice);
      toast('Notice copied', 'success');
    } catch {
      toast('Could not copy. Select the text and copy it manually.', 'error');
    }
  };

  return (
    <AnimatePresence>
      <motion.div key="bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCancel} className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" />
      <motion.div
        key="dlg"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        className="fixed left-1/2 top-1/2 z-[120] max-h-[90vh] w-[94vw] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
            <ShieldAlert size={20} />
          </span>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <h2 id={titleId} className="mt-4 text-base font-semibold text-text-primary">
          Required notice: {feature.label}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
          This feature infers emotion from voice audio. It stays off until you confirm every point below. {JURISDICTION_DISCLAIMER}
        </p>

        <ul className="mt-4 space-y-3">
          {VOICE_EMOTION_ACKNOWLEDGEMENTS.map((text, i) => (
            <li key={text}>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={checks[i]}
                  onChange={() => setChecks((c) => c.map((v, j) => (j === i ? !v : v)))}
                  className="focus-ring mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                />
                <span>{text}</span>
              </label>
            </li>
          ))}
        </ul>

        <div className="mt-4 rounded-xl border border-border bg-bg-primary p-3">
          <p className="text-xs font-medium text-text-secondary">Notice to give people before analysis (replace “This business” with your name)</p>
          <p className="mt-1.5 text-sm text-text-primary">{notice}</p>
          <button type="button" onClick={copy} className="focus-ring mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent">
            <Copy size={12} /> Copy notice
          </button>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={confirm} disabled={!all || busy}>
            {busy ? 'Enabling…' : 'Acknowledge and enable'}
          </Button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function FeatureRow({ f, canManage, busy, onToggle, onReview }: {
  f: RegistryFeature;
  canManage: boolean;
  busy: boolean;
  onToggle: (f: RegistryFeature) => void;
  onReview: (f: RegistryFeature, s: LegalReviewStatus) => void;
}) {
  const pendingNotice = f.requires_notice && f.enabled && !f.notice_ok;
  return (
    <li className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{f.label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{f.description}</p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {f.categories.map((c) => (
              <span key={c} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">{CATEGORY_LABELS[c]}</span>
            ))}
            {f.emotion_basis && (
              <span className={`rounded-full px-2 py-0.5 ${f.emotion_basis === 'voice_audio' ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}`}>
                {EMOTION_BASIS_LABELS[f.emotion_basis]}
              </span>
            )}
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">{f.provider}</span>
            {!f.shipped && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">Not used by a shipped feature</span>}
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">
              {f.enforcement === 'runtime' ? 'Switch enforced at runtime' : 'Registry record (enforced by your provider settings)'}
            </span>
          </div>
        </div>
        <Switch
          checked={f.enabled}
          disabled={!canManage || busy}
          onChange={() => onToggle(f)}
          label={`${f.enabled ? 'Disable' : 'Enable'} ${f.label}`}
        />
      </div>

      {pendingNotice && (
        <p className="mt-3 rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-warning-500" role="status">
          Notice not acknowledged, so this feature will not run.
        </p>
      )}
      {f.requires_notice && f.notice_ok && f.notice_ack_at && (
        <p className="mt-3 text-xs text-text-secondary">Notice v{f.notice_version_ack} acknowledged {new Date(f.notice_ack_at).toLocaleDateString()}.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <Scale size={12} /> Legal review
          <select
            value={f.legal_review_status}
            disabled={!canManage || busy}
            onChange={(e) => onReview(f, e.target.value as LegalReviewStatus)}
            className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
            aria-label={`Legal review status for ${f.label}`}
          >
            {LEGAL_REVIEW_STATUSES.map((s) => <option key={s} value={s}>{REVIEW_LABELS[s]}</option>)}
          </select>
        </label>
        {f.allowed && f.legal_review_status !== 'reviewed' && (
          <span className="text-[11px] text-text-secondary">Running without recorded legal review.</span>
        )}
      </div>
    </li>
  );
}

export function AiTransparencyPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canManage = isOwner || Boolean(permissions?.can_manage_security);

  const [features, setFeatures] = useState<RegistryFeature[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [noticeFor, setNoticeFor] = useState<RegistryFeature | null>(null);

  const load = useCallback(async () => {
    try {
      setFeatures(await fetchRegistry());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizeRegistry(features ?? []), [features]);

  const apply = async (f: RegistryFeature, enabled: boolean, ack?: { noticeVersion: number }) => {
    setBusyKey(f.feature_key);
    try {
      await setFeature(f.feature_key, enabled, ack);
      await load();
      toast(enabled ? `${f.label} enabled` : `${f.label} disabled`, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change this setting.', 'error');
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const onToggle = (f: RegistryFeature) => {
    if (!f.enabled && f.requires_notice) { setNoticeFor(f); return; }
    void apply(f, !f.enabled);
  };

  const onReview = async (f: RegistryFeature, status: LegalReviewStatus) => {
    setBusyKey(f.feature_key);
    try {
      await setLegalReview(f.feature_key, status, f.legal_review_notes);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the legal review status.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const doExport = async (kind: 'json' | 'csv') => {
    setExporting(true);
    try {
      const bundle = await exportRegistry();
      if (kind === 'json') downloadRegistryJson(bundle); else downloadRegistryCsv(bundle);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export the registry.', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <DashboardLayout activeLabel="AI Transparency">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <ShieldCheck size={18} /> AI Transparency
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every AI feature, classified, switchable and exportable, with provenance recorded on AI-generated audio and stored recordings where the provider supports it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setLoading(true); void load(); }} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
            {canManage && (
              <>
                <Button size="sm" variant="secondary" onClick={() => doExport('json')} disabled={exporting || !features}>
                  <Download size={14} /> Export JSON
                </Button>
                <Button size="sm" variant="secondary" onClick={() => doExport('csv')} disabled={exporting || !features}>
                  <Download size={14} /> Export CSV
                </Button>
              </>
            )}
          </div>
        </div>

        <div role="note" className="mb-5 flex items-start gap-2.5 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3.5 text-sm text-text-primary">
          <Scale size={16} className="mt-0.5 shrink-0 text-warning-500" />
          <p><strong>Rules vary by jurisdiction and need legal review.</strong> {JURISDICTION_DISCLAIMER}</p>
        </div>

        {loading && !features ? (
          <SkeletonCardList count={3} />
        ) : failed || !features ? (
          <EmptyState
            icon={ShieldAlert}
            title="AI transparency registry unavailable"
            description="The registry could not be loaded. Make sure the latest database migration has been applied, then try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : (
          <>
            <dl className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['AI features', summary.total],
                ['Running', summary.active],
                ['Voice emotion running', summary.voiceEmotionActive],
                ['Running without legal review', summary.awaitingLegalReview],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-xl border border-border bg-bg-secondary p-3.5">
                  <dt className="text-xs text-text-secondary">{label}</dt>
                  <dd className="mt-1 text-xl font-semibold text-text-primary">{value}</dd>
                </div>
              ))}
            </dl>

            {!canManage && (
              <p className="mb-4 text-xs text-text-secondary">You can view the registry. Only owners and security managers can change it.</p>
            )}

            <div className="space-y-6">
              {GROUPS.map((g) => {
                const rows = features.filter((f) => primaryCategory(f) === g.key);
                if (rows.length === 0) return null;
                const Icon = g.icon;
                return (
                  <section key={g.key} aria-labelledby={`grp-${g.key}`}>
                    <h2 id={`grp-${g.key}`} className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                      <Icon size={15} /> {CATEGORY_LABELS[g.key]}
                    </h2>
                    <p className="mb-2.5 mt-0.5 text-xs text-text-secondary">{g.blurb}</p>
                    <ul className="space-y-2.5">
                      {rows.map((f) => (
                        <FeatureRow key={f.feature_key} f={f} canManage={canManage} busy={busyKey === f.feature_key} onToggle={onToggle} onReview={onReview} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>

      {noticeFor && (
        <NoticeDialog
          feature={noticeFor}
          onCancel={() => setNoticeFor(null)}
          onConfirm={async () => {
            const ok = await apply(noticeFor, true, { noticeVersion: noticeFor.notice_version });
            if (ok) setNoticeFor(null);
          }}
        />
      )}
    </DashboardLayout>
  );
}
