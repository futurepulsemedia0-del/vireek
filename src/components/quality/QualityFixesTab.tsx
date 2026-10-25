import { useState } from 'react';
import { BookOpenCheck, Loader2, ScrollText } from 'lucide-react';
import { SCENARIOS, mergeScriptAddition, scenarioLabel, type QualityFinding, type QualityFix } from '@/lib/callQuality';
import { KindBadge, SeverityBadge, btnGhost, btnPrimary, inputCls } from './qualityUi';

interface Props {
  fixes: QualityFix[];
  findings: QualityFinding[];
  busyId: string | null;
  onApply: (fix: QualityFix, overrides: { answer?: string; title?: string; addition?: string; scenario?: string }) => void;
  onReject: (fix: QualityFix) => void;
}

function FixCard({ fix, finding, busy, onApply, onReject }: { fix: QualityFix; finding: QualityFinding | undefined; busy: boolean; onApply: Props['onApply']; onReject: Props['onReject'] }) {
  const p = fix.proposal;
  const isKb = fix.fix_type === 'kb_article';
  const [answer, setAnswer] = useState('');
  const [title, setTitle] = useState(p.title ?? '');
  const [addition, setAddition] = useState(p.addition ?? '');
  const [scenario, setScenario] = useState(p.scenario ?? fix.scenario ?? 'new_inquiry');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (isKb) {
      if (answer.trim().length < 10) { setError('Write the correct answer first (at least 10 characters).'); return; }
      setError(null);
      onApply(fix, { answer, title });
      return;
    }
    const check = mergeScriptAddition('', addition);
    if (!check.ok) { setError(check.error); return; }
    setError(null);
    onApply(fix, { addition, scenario });
  };

  return (
    <li className="rounded-xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">{isKb ? <BookOpenCheck size={16} /> : <ScrollText size={16} />}</span>
        <h3 className="text-sm font-semibold text-text-primary">{isKb ? 'Add to Knowledge Base' : `Update “${scenarioLabel(scenario)}” script`}</h3>
        {fix.evidence_count > 1 && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">seen on {fix.evidence_count} calls</span>}
      </div>

      {finding && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <KindBadge kind={finding.kind} /><SeverityBadge severity={finding.severity} /><span className="text-text-primary">{finding.title}</span>
        </div>
      )}
      {finding?.evidence_quote && <blockquote className="mt-2 border-l-2 border-accent/50 pl-3 text-sm italic text-text-secondary">“{finding.evidence_quote}”</blockquote>}
      {fix.rationale && <p className="mt-2 text-sm text-text-secondary">{fix.rationale}</p>}

      {isKb ? (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-text-secondary">Article title
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className={`${inputCls} mt-1`} />
          </label>
          <label className="block text-xs font-medium text-text-secondary">{p.question ? `Correct answer to: “${p.question}”` : 'Correct answer'}
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} maxLength={1200} placeholder="Type the exact answer the assistant should give. Only you know the real price or policy — the AI never invents it." className={`${inputCls} mt-1`} />
          </label>
          <p className="text-xs text-text-secondary">Publishes immediately to the assistant and chat. Edits are versioned, so you can roll back in Knowledge Base.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-text-secondary">Script
            <select value={scenario} onChange={(e) => setScenario(e.target.value)} className={`${inputCls} mt-1`}>
              {SCENARIOS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-text-secondary">Instruction added to the end of the live script
            <textarea value={addition} onChange={(e) => setAddition(e.target.value)} rows={3} maxLength={400} className={`${inputCls} mt-1`} />
          </label>
          <p className="text-xs text-text-secondary">Saved as a new script version. If an A/B test is running for this script, the version is saved but not made live.</p>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={submit} disabled={busy} className={btnPrimary}>{busy && <Loader2 size={16} className="animate-spin" />}{isKb ? 'Publish answer' : 'Apply to script'}</button>
        <button onClick={() => onReject(fix)} disabled={busy} className={btnGhost}>Dismiss</button>
      </div>
    </li>
  );
}

export function QualityFixesTab({ fixes, findings, busyId, onApply, onReject }: Props) {
  const byId = new Map(findings.map((f) => [f.id, f]));
  if (fixes.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-14 text-center">
        <p className="text-base font-semibold text-text-primary">No fixes waiting</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">When a review finds a problem the Knowledge Base or a script can solve, a one-click fix appears here — grouped, so one root cause across many calls is one fix.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {fixes.map((fx) => (
        <FixCard key={fx.id} fix={fx} finding={fx.finding_id ? byId.get(fx.finding_id) : undefined} busy={busyId === fx.id} onApply={onApply} onReject={onReject} />
      ))}
    </ul>
  );
}
