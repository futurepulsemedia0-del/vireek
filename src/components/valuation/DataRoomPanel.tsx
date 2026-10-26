import { useMemo, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { ScoreBar } from '@/components/valuation/ValuationUi';
import {
  DATA_ROOM_CATEGORIES,
  DATA_ROOM_ITEMS,
  DATA_ROOM_NOTE_MAX,
  DATA_ROOM_STATUSES,
  indexItems,
  scoreDataRoom,
  type DataRoomRow,
  type DataRoomStatus,
} from '@/lib/valuation';

interface Props {
  rows: DataRoomRow[];
  busyKey: string | null;
  onSave: (itemKey: string, status: DataRoomStatus, note: string | null) => Promise<boolean>;
}

export function DataRoomPanel({ rows, busyKey, onSave }: Props) {
  const [openOnly, setOpenOnly] = useState(false);
  const [noteKey, setNoteKey] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const byKey = useMemo(() => indexItems(rows), [rows]);
  const result = useMemo(() => scoreDataRoom(rows), [rows]);

  const startNote = (key: string) => {
    setNoteKey(key);
    setNoteDraft(byKey[key]?.note ?? '');
  };

  const saveNote = async (key: string) => {
    const ok = await onSave(key, byKey[key]?.status ?? 'not_started', noteDraft);
    if (ok) setNoteKey(null);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <ScoreBar
          label="Data room completeness"
          score={result.score}
          detail={`${result.ready} ready · ${result.inProgress} in progress · ${result.notStarted} not started · ${result.notApplicable} not applicable`}
        />
        <button
          type="button"
          aria-pressed={openOnly}
          onClick={() => setOpenOnly((v) => !v)}
          className={`focus-ring mt-3 inline-flex min-h-[40px] items-center rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${openOnly ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'}`}
        >
          Show open items only
        </button>
      </div>

      {DATA_ROOM_CATEGORIES.map((cat) => {
        const defs = DATA_ROOM_ITEMS.filter((i) => i.category === cat.key).filter((i) => {
          if (!openOnly) return true;
          const s = byKey[i.key]?.status ?? 'not_started';
          return s !== 'ready' && s !== 'not_applicable';
        });
        if (defs.length === 0) return null;
        return (
          <section key={cat.key} aria-labelledby={`room-${cat.key}`} className="rounded-2xl border border-border bg-bg-secondary p-4">
            <h2 id={`room-${cat.key}`} className="mb-3 text-base font-bold text-text-primary">{cat.label}</h2>
            <ul className="divide-y divide-border">
              {defs.map((item) => {
                const row = byKey[item.key];
                const status = row?.status ?? 'not_started';
                const busy = busyKey === item.key;
                const editing = noteKey === item.key;
                return (
                  <li key={item.key} className="py-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                          {item.title}
                          {item.weight === 3 && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-semibold text-warning-500">Buyers ask first</span>}
                        </p>
                        <p className="mt-0.5 text-xs text-text-secondary">{item.hint}</p>
                        {row?.note && !editing && <p className="mt-1 whitespace-pre-line text-xs text-text-primary">Note: {row.note}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <select
                          aria-label={`Status for ${item.title}`}
                          value={status}
                          disabled={busy}
                          onChange={(e) => void onSave(item.key, e.target.value as DataRoomStatus, row?.note ?? null)}
                          className="focus-ring min-h-[44px] flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary sm:flex-none"
                        >
                          {DATA_ROOM_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                        <button
                          type="button"
                          aria-label={`${row?.note ? 'Edit' : 'Add'} note for ${item.title}`}
                          title={row?.note ? 'Edit note' : 'Add note'}
                          disabled={busy}
                          onClick={() => startNote(item.key)}
                          className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40"
                        >
                          <MessageSquare size={18} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {editing && (
                      <div className="mt-3 space-y-2">
                        <Textarea
                          label="Note"
                          rows={3}
                          maxLength={DATA_ROOM_NOTE_MAX}
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          helperText={`Where the file lives, who owns it, what is missing. ${noteDraft.length}/${DATA_ROOM_NOTE_MAX}`}
                        />
                        <div className="flex justify-end gap-2">
                          <Button type="button" variant="ghost" size="sm" onClick={() => setNoteKey(null)} disabled={busy}>Cancel</Button>
                          <Button type="button" size="sm" onClick={() => void saveNote(item.key)} disabled={busy}>{busy ? 'Saving…' : 'Save note'}</Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
