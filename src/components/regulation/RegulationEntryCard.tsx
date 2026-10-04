import { BadgeCheck, ExternalLink, GitBranch } from 'lucide-react';
import {
  KIND_LABELS,
  SEVERITY_LABELS,
  SOURCE_TYPE_LABELS,
  STATUS_META,
  formatIsoDate,
  shortHash,
  type ResolvedEntry,
  type RequirementSeverity,
} from '@/lib/temporalRegulation';

const SEVERITY_CLASS: Record<RequirementSeverity, string> = {
  blocker: 'bg-danger/10 text-danger',
  warning: 'bg-warning-500/10 text-warning-500',
  info: 'bg-bg-tertiary text-text-secondary',
};

/** One resolved regulation as it stood on the chosen date. Shared by the page and the job panel. */
export function RegulationEntryCard({ entry, compact = false }: { entry: ResolvedEntry; compact?: boolean }) {
  const status = STATUS_META[entry.status];
  const ended = entry.status !== 'in_force';
  const safeUrl = entry.source_url && /^https?:\/\//i.test(entry.source_url) ? entry.source_url : null;

  return (
    <li className={`rounded-lg border border-border/70 bg-bg-primary p-3 ${ended ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
          {KIND_LABELS[entry.kind]}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}>{status.label}</span>
        {entry.verification_status === 'verified' ? (
          <span className="flex items-center gap-1 rounded-full bg-success-500/10 px-2 py-0.5 text-[11px] font-medium text-success-500">
            <BadgeCheck size={11} /> Verified
          </span>
        ) : (
          <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-medium text-warning-500">
            Unverified
          </span>
        )}
        {entry.inherited && (
          <span className="flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
            <GitBranch size={11} /> From {entry.jurisdiction_name}
          </span>
        )}
      </div>

      <p className="mt-1.5 text-sm font-semibold text-text-primary">{entry.title}</p>
      <p className="mt-0.5 text-xs text-text-secondary">
        v{entry.version_no}
        {entry.label ? ` · ${entry.label}` : ''} · effective {formatIsoDate(entry.effective_from)}
        {entry.expires_on ? ` · until ${formatIsoDate(entry.expires_on)}` : ''}
        {entry.authority ? ` · ${entry.authority}` : ''}
      </p>

      {!compact && entry.summary && <p className="mt-2 text-xs leading-relaxed text-text-primary">{entry.summary}</p>}

      {!compact && entry.requirements.length > 0 && (
        <ul className="mt-2 space-y-1">
          {entry.requirements.map((r, i) => (
            <li key={`${entry.version_id}-${i}`} className="flex items-start gap-2 text-xs text-text-primary">
              <span className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_CLASS[r.severity]}`}>
                {SEVERITY_LABELS[r.severity]}
              </span>
              <span>
                {r.title}
                {r.detail ? <span className="text-text-secondary"> — {r.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
        <span>{SOURCE_TYPE_LABELS[entry.source_type]}</span>
        {entry.citation && <span>{entry.citation}</span>}
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex items-center gap-1 text-accent hover:underline"
          >
            Source <ExternalLink size={10} />
          </a>
        )}
        <span className="font-mono" title="Content fingerprint (SHA-256)">
          #{shortHash(entry.content_hash, 8)}
        </span>
      </p>
    </li>
  );
}
