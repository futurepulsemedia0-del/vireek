import { useState } from 'react';
import { ChevronDown, GitCommitHorizontal, Quote, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import {
  availableActions,
  CONFIDENCE_TIER_LABELS,
  CONFIDENCE_TIER_STYLES,
  confidenceTier,
  equipmentLabel,
  explainConfidence,
  formatDate,
  outcomeRate,
  parseSymptoms,
  SOURCE_LABELS,
  STATUS_LABELS,
  STATUS_STYLES,
  type AvailableAction,
  type KceEvidence,
  type KceRule,
  type KceVersion,
  type ReviewContext,
} from '@/lib/knowledgeCapture';
import { fetchRuleDetail, type RuleEdits } from '@/lib/knowledgeCaptureApi';

interface RuleCardProps {
  rule: KceRule;
  ctx: ReviewContext;
  busy: boolean;
  onAction: (
    rule: KceRule,
    action: AvailableAction['action'],
    note: string,
    edits?: RuleEdits,
  ) => Promise<boolean>;
}

export function RuleCard({ rule, ctx, busy, onAction }: RuleCardProps) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ evidence: KceEvidence[]; versions: KceVersion[] } | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [pending, setPending] = useState<AvailableAction | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RuleEdits & { symptomsText: string }>({ symptomsText: '' });

  const tier = confidenceTier(rule.confidence_score);
  const actions = availableActions(rule, ctx);
  const rate = outcomeRate(rule);
  const parts = explainConfidence(rule.confidence_breakdown);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail && !detailLoading) {
      setDetailLoading(true);
      setDetailError(false);
      try {
        setDetail(await fetchRuleDetail(rule.id));
      } catch {
        setDetailError(true);
      } finally {
        setDetailLoading(false);
      }
    }
  };

  const startEdit = () => {
    setDraft({
      title: rule.title,
      equipment_make: rule.equipment_make ?? '',
      equipment_model: rule.equipment_model ?? '',
      condition_summary: rule.condition_summary,
      likely_cause: rule.likely_cause,
      recommended_action: rule.recommended_action,
      caveats: rule.caveats ?? '',
      symptomsText: rule.symptoms.join('\n'),
    });
    setEditing(true);
    setOpen(true);
  };

  const run = async (a: AvailableAction) => {
    if (a.needsNote || a.action === 'revise') {
      if (a.action === 'revise') startEdit();
      else {
        setPending(a);
        setNote('');
      }
      return;
    }
    const ok = await onAction(rule, a.action, '');
    if (ok) setDetail(null);
  };

  const confirmPending = async () => {
    if (!pending || !note.trim()) return;
    const ok = await onAction(rule, pending.action, note.trim());
    if (ok) {
      setPending(null);
      setNote('');
      setDetail(null);
    }
  };

  const saveRevision = async () => {
    const { symptomsText, ...fields } = draft;
    const edits: RuleEdits = { ...fields, symptoms: parseSymptoms(symptomsText) };
    const ok = await onAction(rule, 'revise', note.trim() || 'Revised by reviewer', edits);
    if (ok) {
      setEditing(false);
      setNote('');
      setDetail(null);
    }
  };

  return (
    <article
      className="rounded-2xl border border-border/80 bg-bg-secondary p-5 shadow-sm"
      aria-label={rule.title}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{rule.title}</h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            {equipmentLabel(rule)}
            {rule.trade ? ` · ${rule.trade}` : ''} · v{rule.current_version}
            {rule.deployed_version !== null && rule.deployed_version !== rule.current_version
              ? ` (live: v${rule.deployed_version})`
              : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {rule.needs_revalidation && (
            <span className="flex items-center gap-1 rounded-full border border-warning-500/25 bg-warning-500/10 px-2.5 py-1 text-xs font-semibold text-warning-500">
              <TriangleAlert size={12} aria-hidden="true" /> Needs revalidation
            </span>
          )}
          <span
            className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[rule.status]}`}
          >
            {STATUS_LABELS[rule.status]}
          </span>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            When
          </dt>
          <dd className="mt-1 text-text-primary">{rule.condition_summary}</dd>
          <dd className="mt-2 flex flex-wrap gap-1.5">
            {rule.symptoms.map((s) => (
              <span
                key={s}
                className="rounded-lg bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary"
              >
                {s}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            Usually
          </dt>
          <dd className="mt-1 text-text-primary">{rule.likely_cause}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            Do this
          </dt>
          <dd className="mt-1 text-text-primary">{rule.recommended_action}</dd>
        </div>
      </dl>

      {rule.caveats && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-500/10 px-3 py-2 text-xs text-text-primary">
          <TriangleAlert
            size={14}
            className="mt-0.5 shrink-0 text-warning-500"
            aria-hidden="true"
          />
          <span>{rule.caveats}</span>
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border/60 pt-3 text-xs text-text-secondary">
        <span className={`font-semibold ${CONFIDENCE_TIER_STYLES[tier]}`}>
          {rule.confidence_score}% · {CONFIDENCE_TIER_LABELS[tier]}
        </span>
        <span>
          {rule.evidence_count} case{rule.evidence_count === 1 ? '' : 's'} ·{' '}
          {rule.contributor_count} contributor{rule.contributor_count === 1 ? '' : 's'}
        </span>
        <span>
          {rate === null
            ? 'No field results yet'
            : `${rate}% fixed it (${rule.success_count}/${rule.applied_count})`}
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="focus-ring ml-auto flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-accent hover:bg-accent/10"
        >
          Why this score &amp; evidence{' '}
          <ChevronDown
            size={14}
            className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
            aria-hidden="true"
          />
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-4 rounded-xl bg-bg-primary p-4">
          <div>
            <p className="mb-2 text-xs font-semibold text-text-primary">Confidence breakdown</p>
            <ul className="space-y-1.5">
              {parts.map((p) => (
                <li key={p.key} className="flex items-center gap-3 text-xs text-text-secondary">
                  <span className="w-44 shrink-0">
                    {p.label} <span className="text-text-secondary/60">({p.weight}%)</span>
                  </span>
                  <span
                    className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary"
                    role="img"
                    aria-label={`${p.score} out of 100`}
                  >
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${p.score}%` }}
                    />
                  </span>
                  <span className="w-8 text-right tabular-nums">{p.score}</span>
                </li>
              ))}
            </ul>
          </div>

          {detailLoading && <Skeleton className="h-16 w-full" />}
          {detailError && (
            <p className="text-xs text-danger">
              Could not load evidence. Close and reopen to retry.
            </p>
          )}

          {detail && (
            <>
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                  <Quote size={12} aria-hidden="true" /> Evidence
                </p>
                <ul className="space-y-2">
                  {detail.evidence.map((e) => (
                    <li
                      key={e.id}
                      className="rounded-lg border border-border/60 px-3 py-2 text-xs text-text-secondary"
                    >
                      <span className="font-medium text-text-primary">
                        {e.capture ? SOURCE_LABELS[e.capture.source_type] : 'Source'}
                      </span>
                      <span>
                        {' '}
                        · specificity {e.specificity} · {formatDate(e.created_at)}
                      </span>
                      <p className="mt-1 italic">“{e.excerpt}”</p>
                    </li>
                  ))}
                </ul>
              </div>
              {detail.versions.length > 0 && (
                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                    <GitCommitHorizontal size={12} aria-hidden="true" /> Version history
                  </p>
                  <ul className="space-y-1 text-xs text-text-secondary">
                    {detail.versions.map((v) => (
                      <li key={v.id}>
                        <span className="font-medium text-text-primary">v{v.version}</span> ·{' '}
                        {formatDate(v.created_at)} · {v.change_note ?? '—'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {rule.review_note && (
            <p className="text-xs text-text-secondary">
              <ShieldCheck size={12} className="mr-1 inline" aria-hidden="true" />
              Reviewer note: {rule.review_note}
            </p>
          )}
          {rule.retired_reason && (
            <p className="text-xs text-text-secondary">Retired: {rule.retired_reason}</p>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-3 space-y-3 rounded-xl border border-accent/30 bg-bg-primary p-4">
          <p className="text-xs font-semibold text-text-primary">
            Revise this rule — saving creates v{rule.current_version + 1} and sends it back through
            review.
          </p>
          <Input
            label="Title"
            value={draft.title ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Make"
              value={draft.equipment_make ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, equipment_make: e.target.value }))}
            />
            <Input
              label="Model"
              value={draft.equipment_model ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, equipment_model: e.target.value }))}
            />
          </div>
          <Textarea
            label="Symptoms (one per line)"
            rows={3}
            value={draft.symptomsText}
            onChange={(e) => setDraft((d) => ({ ...d, symptomsText: e.target.value }))}
          />
          <Textarea
            label="When (summary)"
            rows={2}
            value={draft.condition_summary ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, condition_summary: e.target.value }))}
          />
          <Textarea
            label="Usually caused by"
            rows={2}
            value={draft.likely_cause ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, likely_cause: e.target.value }))}
          />
          <Textarea
            label="Do this"
            rows={3}
            value={draft.recommended_action ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, recommended_action: e.target.value }))}
          />
          <Textarea
            label="Caveats / safety"
            rows={2}
            value={draft.caveats ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, caveats: e.target.value }))}
          />
          <Input
            label="What changed? (version note)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={saveRevision}>
              Save new version
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {pending && (
        <div className="mt-3 space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          <Textarea
            label={
              pending.action === 'reject'
                ? 'Why is this rule being rejected?'
                : 'Why is this rule being retired?'
            }
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !note.trim()} onClick={confirmPending}>
              Confirm {pending.label.toLowerCase()}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {actions.length > 0 && !editing && !pending && (
        <div className="mt-4 flex flex-wrap gap-2">
          {actions.map((a) => (
            <div key={a.action} className="flex flex-col">
              <Button
                size="sm"
                variant={a.tone === 'primary' ? 'primary' : 'secondary'}
                disabled={busy || !a.enabled}
                onClick={() => run(a)}
                title={a.disabledReason}
              >
                {a.label}
              </Button>
            </div>
          ))}
          {actions.some((a) => !a.enabled && a.disabledReason) && (
            <p className="w-full text-xs text-text-secondary">
              {actions.find((a) => !a.enabled && a.disabledReason)?.disabledReason}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
