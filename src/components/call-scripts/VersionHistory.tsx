import { useState } from 'react';
import { History, Rocket, Pencil, GitCompare, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { diffLines, type CallScript, type CallScriptVersion } from '@/lib/callScripts';

interface VersionHistoryProps {
  script: CallScript | null;
  versions: CallScriptVersion[];
  /** Id of the version currently being published, if any. */
  publishingId: string | null;
  onEditFrom: (version: CallScriptVersion) => void;
  onPublish: (version: CallScriptVersion) => Promise<void> | void;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function asComparable(v: CallScriptVersion): string {
  return `Opening line: ${v.opening_line || '(none)'}\n\n${v.body}`;
}

export function VersionHistory({ script, versions, publishingId, onEditFrom, onPublish }: VersionHistoryProps) {
  const [diffOpen, setDiffOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<CallScriptVersion | null>(null);

  if (versions.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No saved versions"
        description="Every time you save, a numbered version is kept here so you can compare changes and roll back."
      />
    );
  }

  return (
    <>
      <ul className="space-y-3">
        {versions.map((v, index) => {
          const previous = versions[index + 1] ?? null;
          const isLive = script?.active_version_id === v.id;
          const isChallenger = script?.challenger_version_id === v.id;
          const open = diffOpen === v.id;
          return (
            <li key={v.id} className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">Version {v.version_number}</span>
                    {isLive && <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-xs font-medium text-success-500">Live</span>}
                    {isChallenger && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Challenger</span>}
                    <span className="text-xs text-text-secondary">{formatWhen(v.created_at)}</span>
                  </div>
                  {v.change_note && <p className="mt-1 text-sm text-text-secondary">{v.change_note}</p>}
                  <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{v.body}</p>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  {previous && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setDiffOpen(open ? null : v.id)} aria-expanded={open}>
                      <GitCompare size={15} />
                      {open ? 'Hide changes' : 'Show changes'}
                    </Button>
                  )}
                  <Button type="button" variant="secondary" size="sm" onClick={() => onEditFrom(v)}>
                    <Pencil size={15} />
                    Edit from this
                  </Button>
                  {!isLive && (
                    <Button type="button" size="sm" onClick={() => setConfirm(v)} disabled={publishingId !== null}>
                      {publishingId === v.id ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
                      Make live
                    </Button>
                  )}
                </div>
              </div>

              {open && previous && (
                <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-bg-primary p-3 font-mono text-xs leading-relaxed">
                  <p className="mb-2 font-sans text-xs text-text-secondary">
                    Changes from version {previous.version_number} to version {v.version_number}
                  </p>
                  {diffLines(asComparable(previous), asComparable(v)).map((line, i) => (
                    <div
                      key={i}
                      className={`whitespace-pre-wrap px-2 py-0.5 ${
                        line.type === 'add'
                          ? 'bg-success-500/10 text-success-500'
                          : line.type === 'del'
                            ? 'bg-danger/10 text-danger'
                            : 'text-text-secondary'
                      }`}
                    >
                      <span aria-hidden="true">{line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}</span>
                      <span className="sr-only">{line.type === 'add' ? 'Added: ' : line.type === 'del' ? 'Removed: ' : 'Unchanged: '}</span>
                      {line.text || ' '}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? `Make version ${confirm.version_number} live?` : 'Make this version live?'}
        description="New calls will start using this version immediately. Calls already in progress are not affected."
        confirmLabel="Make live"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const target = confirm;
          setConfirm(null);
          if (target) await onPublish(target);
        }}
      />
    </>
  );
}
