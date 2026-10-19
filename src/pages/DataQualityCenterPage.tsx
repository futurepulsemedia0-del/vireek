/**
 * Data Quality Center — /dashboard/data-quality
 *
 * Finds missing contact details, unmatched equipment, completed jobs with no
 * cost and customers with no consent record, then offers one-click fixes that
 * only copy data the account already holds. Consent is never auto-granted: the
 * fix sends the customer their own preference link. Logic: src/lib/dataQuality.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, ChevronDown, Copy, DatabaseZap, ExternalLink, Loader2, RefreshCw, Wand2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { applyBulkFixes, applyFix, buildDataHealth } from '@/lib/dataQualityApi';
import { gradeTone } from '@/lib/dataQualityUi';
import { GRADE_LABELS, mergeFixes, type DataHealth, type DqCheck, type DqFix, type DqIssue } from '@/lib/dataQuality';
import { SEVERITY_COLORS, SEVERITY_LABELS } from '@/lib/businessReality';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function IssueRow({ issue, busy, onFix }: { issue: DqIssue; busy: boolean; onFix: (issue: DqIssue) => void }) {
  const fix = issue.fix;
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-border/60 py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-primary">{issue.label}</p>
        {issue.detail && <p className="truncate text-[11px] text-text-secondary">{issue.detail}</p>}
      </div>
      {fix?.type === 'open' ? (
        <Link to={fix.href} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
          {fix.label} <ExternalLink size={11} />
        </Link>
      ) : fix ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onFix(issue)}
          className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {fix.type === 'consent_link' ? <Copy size={11} /> : <Wand2 size={11} />}
          {fix.type === 'consent_link' ? 'Copy preference link' : fix.type === 'link_equipment' ? 'Link to latest job' : 'Fix'}
        </button>
      ) : null}
    </li>
  );
}

function CheckCard({ check, busy, onFix, onFixAll }: { check: DqCheck; busy: boolean; onFix: (issue: DqIssue) => void; onFixAll: (check: DqCheck) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-text-primary">{check.title}</p>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SEVERITY_COLORS[check.severity]}`}>{SEVERITY_LABELS[check.severity]}</span>
        <span className="ml-auto text-xs text-text-secondary">{check.count} affected</span>
      </div>
      <p className="mt-1 text-xs text-text-secondary">{check.why}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {check.fixable > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onFixAll(check)}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            <Wand2 size={12} /> Fix {check.fixable} automatically
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="focus-ring flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          {open ? 'Hide' : 'Review'} records <ChevronDown size={12} className={open ? 'rotate-180' : ''} />
        </button>
      </div>
      {open && (
        <ul className="mt-3">
          {check.issues.map((i) => <IssueRow key={i.id} issue={i} busy={busy} onFix={onFix} />)}
          {check.count > check.issues.length && (
            <li className="pt-2 text-[11px] text-text-secondary">Showing {check.issues.length} of {check.count}. Fix these, then re-scan for the rest.</li>
          )}
        </ul>
      )}
    </motion.div>
  );
}

export function DataQualityCenterPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canView = isOwner || permissions.can_view_billing;
  const [health, setHealth] = useState<DataHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setFailed(false);
    try {
      const next = await buildDataHealth();
      if (id === requestId.current) setHealth(next);
    } catch {
      if (id === requestId.current) setFailed(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) void load();
    else setLoading(false);
  }, [canView, load]);

  const reportBulk = useCallback(async (fixes: DqFix[]) => {
    setBusy(true);
    try {
      const s = await applyBulkFixes(fixes);
      const parts = [`Fixed ${s.applied}`];
      if (s.duplicates > 0) parts.push(`${s.duplicates} skipped (value already belongs to another customer)`);
      if (s.failed > 0) parts.push(`${s.failed} failed`);
      toast(`${parts.join(' · ')}.`, s.failed > 0 ? 'error' : s.applied > 0 ? 'success' : 'info');
    } finally {
      setBusy(false);
      await load();
    }
  }, [load, toast]);

  const onFixOne = useCallback(async (issue: DqIssue) => {
    if (!issue.fix || issue.fix.type === 'open') return;
    setBusy(true);
    try {
      const r = await applyFix(issue.fix);
      if (!r.ok) {
        toast(r.reason === 'duplicate' ? 'That value already belongs to another customer.' : 'Could not apply that fix. Please try again.', 'error');
      } else if (issue.fix.type === 'consent_link') {
        const copied = r.link ? await copyText(r.link) : false;
        toast(copied ? 'Preference link copied — send it to the customer.' : (r.link ?? 'Link ready.'), copied ? 'success' : 'info');
      } else {
        toast('Fixed.', 'success');
        await load();
      }
    } finally {
      setBusy(false);
    }
  }, [load, toast]);

  const onFixAll = useCallback((check: DqCheck) => { void reportBulk(check.bulkFixes); }, [reportBulk]);
  const onFixEverything = useCallback(() => {
    if (health) void reportBulk(mergeFixes(health.checks.flatMap((c) => c.bulkFixes)));
  }, [health, reportBulk]);

  const totalFixable = health ? mergeFixes(health.checks.flatMap((c) => c.bulkFixes)).length : 0;

  return (
    <DashboardLayout activeLabel="Data Quality">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><DatabaseZap size={18} /> Data Quality Center</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Missing contact details, unlinked equipment, jobs with no cost and customers with no consent record — with one-click fixes that only reuse data you already have.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || busy || !canView}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Re-scan
          </button>
        </div>

        {!canView ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
            You don't have access to data quality. Ask the account owner for billing access.
          </div>
        ) : loading && !health ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
        ) : failed || !health ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
            Couldn't scan your data just now.{' '}
            <button type="button" onClick={() => void load()} className="font-medium text-accent underline">Try again</button>
          </div>
        ) : (
          <>
            <div className="mb-5 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex items-center gap-4">
                <div className={`text-4xl font-bold ${gradeTone(health.grade)}`}>{health.score}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">Data health · {GRADE_LABELS[health.grade]}</p>
                  <p className="text-xs text-text-secondary">Weighted average of the five areas below. Areas with nothing to judge are left out, not counted as perfect.</p>
                </div>
                {totalFixable > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onFixEverything}
                    className="focus-ring hidden shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 sm:flex"
                  >
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Fix {totalFixable} automatically
                  </button>
                )}
              </div>
              {totalFixable > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onFixEverything}
                  className="focus-ring mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 sm:hidden"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Fix {totalFixable} automatically
                </button>
              )}
              <ul className="mt-4 space-y-2">
                {health.dimensions.map((d) => (
                  <li key={d.dimension}>
                    <div className="flex justify-between text-[11px] text-text-secondary">
                      <span>{d.label} <span className="opacity-60">· weight {d.weight}</span></span>
                      <span>{d.pct === null ? 'Nothing to judge yet' : `${d.pct}%`}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={d.pct ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={d.label}>
                      <div className="h-full rounded-full bg-accent" style={{ width: `${d.pct ?? 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-text-secondary">
                Operational reality is the <Link to="/dashboard/reality" className="underline">Business Reality</Link> score, reused as-is.
              </p>
            </div>

            {health.truncated && (
              <p className="mb-4 rounded-xl border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
                Large account: the scan covers your most recent records. Fix these and re-scan to work through the rest.
              </p>
            )}

            {health.checks.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-success-500" />
                <p className="text-sm text-text-secondary">No data-quality issues found. Nice and clean.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {health.checks.map((c) => <CheckCard key={c.kind} check={c} busy={busy} onFix={(i) => void onFixOne(i)} onFixAll={onFixAll} />)}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
