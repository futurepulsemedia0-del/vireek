import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Camera, CloudSun, Lock, Plus, Sparkles, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { signPaths } from '@/lib/galleryApi';
import {
  DELAY_OPTIONS,
  LIMITS,
  WEATHER_OPTIONS,
  blankCrew,
  blankDelay,
  blankVisitor,
  emptyForm,
  formFromDetail,
  formatHours,
  formatLogDate,
  formatMinutes,
  isDelayCause,
  isWeatherCode,
  totalCrewHours,
  totalDelayMinutes,
  validateForm,
  type CrewEntry,
  type DelayEntry,
  type LogForm,
  type VisitorEntry,
} from '@/lib/dailyLogs';
import {
  addAmendment,
  attachPhotos,
  detachPhoto,
  discardDraft,
  fetchEmployees,
  fetchLogDetail,
  fetchLogPhotos,
  fetchTimesheetHours,
  requestSummary,
  requestWeather,
  saveLog,
  submitLog,
  type EmployeeOption,
  type LogDetail,
  type LogPhoto,
} from '@/lib/dailyLogsApi';
import { Pill, SectionHeader, compactInput, panelClass, selectClass, useConfirm } from './projectUi';

const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const numStr = (n: number | null) => (n === null ? '' : String(n));

interface Props {
  ownerId: string;
  projectId: string;
  date: string;
  today: string;
  onClose: () => void;
  onChanged: () => void;
}

export function DailyLogEditor({ ownerId, projectId, date, today, onClose, onChanged }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  const { ask, dialog } = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [form, setForm] = useState<LogForm>(emptyForm);
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyForm()));
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [amendNote, setAmendNote] = useState('');

  const locked = detail?.log?.status === 'submitted';
  const check = useMemo(() => validateForm(form), [form]);
  const hasErrors = Object.keys(check.errors).length > 0;
  const dirty = JSON.stringify(form) !== baseline;
  const hours = totalCrewHours(form.crew);
  const delayMinutes = totalDelayMinutes(form.delays);
  const photoCount = detail?.photos.length ?? 0;
  // The forecast only covers today and tomorrow; past days are entered by hand.
  const canAutoWeather = Math.abs(Date.parse(`${date}T12:00:00`) - Date.parse(`${today}T12:00:00`)) <= 36 * 3600 * 1000;

  const loadUrls = useCallback(async (photos: LogPhoto[]) => {
    try {
      setUrls(photos.length ? await signPaths(photos.map((p) => p.thumb_path ?? p.storage_path)) : new Map());
    } catch {
      /* thumbnails are optional */
    }
  }, []);

  const load = useCallback(
    async (resetForm: boolean) => {
      try {
        const d = await fetchLogDetail(ownerId, projectId, date);
        setDetail(d);
        if (resetForm) {
          const f = formFromDetail(d);
          setForm(f);
          setBaseline(JSON.stringify(f));
        }
        setState('ready');
        void loadUrls(d.photos);
      } catch (e) {
        setState((s) => (s === 'ready' ? s : 'error'));
        toast(messageOf(e, 'Could not load this log.'), 'error');
      }
    },
    [ownerId, projectId, date, loadUrls, toast],
  );

  useEffect(() => {
    setState('loading');
    void load(true);
  }, [load]);

  useEffect(() => {
    void fetchEmployees(ownerId).then(setEmployees);
  }, [ownerId]);

  const act = useCallback(
    async (key: string, fn: () => Promise<void>): Promise<boolean> => {
      setBusy(key);
      try {
        await fn();
        return true;
      } catch (e) {
        toast(messageOf(e, 'Something went wrong. Please try again.'), 'error');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  /** Saves the form (atomic on the server) and refreshes ids. Returns the log id. */
  const persist = async (): Promise<string> => {
    if (hasErrors) throw new Error('Fix the highlighted fields first.');
    const snapshot = form;
    const id = await saveLog(projectId, date, snapshot);
    setDetail(await fetchLogDetail(ownerId, projectId, date));
    setBaseline(JSON.stringify(snapshot));
    onChanged();
    return id;
  };

  const requestClose = () => {
    if (dirty && !locked) {
      ask({ title: 'Discard unsaved changes?', description: 'Changes you have not saved will be lost.', label: 'Discard changes', onConfirm: onClose });
    } else {
      onClose();
    }
  };

  const onSave = () => void act('save', async () => { await persist(); toast('Draft saved.', 'success'); });

  const onSubmit = () => {
    if (hasErrors) { toast('Fix the highlighted fields first.', 'error'); return; }
    if (check.submitBlockers.length > 0) { toast(check.submitBlockers.join(' '), 'error'); return; }
    ask({
      title: 'Submit and lock this log?',
      description: 'Once submitted it cannot be edited or deleted. You can still add dated amendments.',
      label: 'Submit and lock',
      onConfirm: () =>
        act('submit', async () => {
          const id = await persist();
          await submitLog(id);
          await load(true);
          onChanged();
          toast('Log submitted and locked.', 'success');
        }),
    });
  };

  const onDiscard = () =>
    ask({
      title: 'Discard this draft?',
      description: 'The draft log and its rows are deleted. Photos stay in the Gallery.',
      label: 'Discard draft',
      onConfirm: async () => {
        const id = detail?.log?.id;
        if (!id) { onClose(); return; }
        const ok = await act('discard', async () => { await discardDraft(id); onChanged(); });
        if (ok) onClose();
      },
    });

  const onWeather = () =>
    void act('weather', async () => {
      const w = await requestWeather(projectId, date);
      setForm((f) => ({ ...f, weather_code: w.weather_code, temp_high_f: numStr(w.temp_high_f), temp_low_f: numStr(w.temp_low_f), wind_mph: numStr(w.wind_mph) }));
      toast('Weather filled in. Check it, then save.', 'success');
    });

  const onImportHours = () =>
    void act('import', async () => {
      const rows = await fetchTimesheetHours(projectId, date);
      if (rows.length === 0) { toast('No timesheet hours found for jobs linked to this project on this date.', 'info'); return; }
      const ids = new Set(rows.map((r) => r.employee_id));
      setForm((f) => {
        const roles = new Map(f.crew.filter((c) => c.employee_id).map((c): [string, string] => [c.employee_id as string, c.role]));
        const kept = f.crew.filter((c) => c.source === 'manual' && !(c.employee_id && ids.has(c.employee_id)));
        const imported: CrewEntry[] = rows.map((r) => ({ employee_id: r.employee_id, name: r.full_name, role: roles.get(r.employee_id) ?? '', hours: String(r.hours), source: 'timesheet' }));
        return { ...f, crew: [...imported, ...kept] };
      });
      toast(`Imported hours for ${rows.length} ${rows.length === 1 ? 'person' : 'people'}.`, 'success');
    });

  const onGenerate = () => {
    if (!form.work_performed.trim() && hours === 0 && photoCount === 0) {
      toast('Add crew hours, work performed or photos first so there is something to summarize.', 'info');
      return;
    }
    const run = () =>
      act('ai', async () => {
        const id = await persist();
        const summary = await requestSummary(id);
        setForm((f) => ({ ...f, ai_summary: summary, ai_generated_at: new Date().toISOString(), ai_edited: false }));
        toast('AI draft added. Review and edit it, then save.', 'success');
      });
    if (form.ai_summary.trim()) {
      ask({ title: 'Replace the current summary?', description: 'The new AI draft will overwrite the text in the summary box.', label: 'Replace', onConfirm: run });
    } else {
      void run();
    }
  };

  const onFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    if (fileRef.current) fileRef.current.value = '';
    if (!user) { toast('Your session expired. Sign in again.', 'error'); return; }
    if (photoCount + list.length > LIMITS.photos) { toast(`A log can have at most ${LIMITS.photos} photos.`, 'error'); return; }
    void act('photos', async () => {
      const id = detail?.log?.id ?? (await persist());
      const r = await attachPhotos({ ownerId, userId: user.id, logId: id, files: list, startOrder: photoCount });
      const photos = await fetchLogPhotos(id);
      setDetail((d) => (d ? { ...d, photos } : d));
      void loadUrls(photos);
      onChanged();
      if (r.added > 0) toast(`${r.added} photo${r.added === 1 ? '' : 's'} added.`, 'success');
      if (r.failed.length > 0) toast(`Could not upload: ${r.failed.join(', ')}`, 'error');
    });
  };

  const onRemovePhoto = (p: LogPhoto) =>
    void act(`rm-${p.link_id}`, async () => {
      await detachPhoto(p.link_id);
      setDetail((d) => (d ? { ...d, photos: d.photos.filter((x) => x.link_id !== p.link_id) } : d));
      onChanged();
    });

  const onAmend = () => {
    const id = detail?.log?.id;
    if (!id || !amendNote.trim()) return;
    void act('amend', async () => {
      await addAmendment(ownerId, id, amendNote);
      setAmendNote('');
      await load(false);
      toast('Amendment added.', 'success');
    });
  };

  const patch = (p: Partial<LogForm>) => setForm((f) => ({ ...f, ...p }));
  const setCrewAt = (i: number, p: Partial<CrewEntry>) => setForm((f) => ({ ...f, crew: f.crew.map((r, k) => (k === i ? { ...r, ...p } : r)) }));
  const setDelayAt = (i: number, p: Partial<DelayEntry>) => setForm((f) => ({ ...f, delays: f.delays.map((r, k) => (k === i ? { ...r, ...p } : r)) }));
  const setVisitorAt = (i: number, p: Partial<VisitorEntry>) => setForm((f) => ({ ...f, visitors: f.visitors.map((r, k) => (k === i ? { ...r, ...p } : r)) }));
  const onCrewName = (i: number, name: string) => {
    const match = employees.find((e) => e.full_name.trim().toLowerCase() === name.trim().toLowerCase());
    setCrewAt(i, { name, employee_id: match?.id ?? null, source: 'manual' });
  };

  const removeBtn = (label: string, onClick: () => void) => (
    <button type="button" aria-label={label} onClick={onClick} className="focus-ring justify-self-start rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500">
      <Trash2 size={16} aria-hidden="true" />
    </button>
  );

  if (state === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading daily log">
        <Skeleton className="h-8 w-56" />
        <SkeletonCard rows={3} />
        <SkeletonCard rows={3} />
      </div>
    );
  }
  if (state === 'error') {
    return <EmptyStateError icon={Camera} title="Could not load this log" onRetry={() => { setState('loading'); void load(true); }} />;
  }

  const saved = detail?.log ?? null;

  return (
    <div className="space-y-6">
      <div>
        <button type="button" onClick={requestClose} className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft size={14} aria-hidden="true" /> All daily logs
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold text-text-primary sm:text-xl">{formatLogDate(date)}</h2>
          <Pill tone={locked ? 'success' : 'warning'}>{locked ? 'Submitted' : saved ? 'Draft' : 'New log'}</Pill>
          {dirty && !locked && <Pill tone="info">Unsaved changes</Pill>}
        </div>
      </div>

      {locked && (
        <div role="status" className={`${panelClass} flex items-start gap-3`}>
          <Lock size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
          <p className="text-sm text-text-secondary">This log is submitted and locked. It cannot be edited; add a dated amendment below to correct or add information.</p>
        </div>
      )}

      <fieldset disabled={locked || busy !== null} className="min-w-0 space-y-6 border-0 p-0">
        <section className={`${panelClass} space-y-4`}>
          <SectionHeader
            title="Weather"
            description="Required to submit."
            action={canAutoWeather ? <Button size="sm" variant="secondary" onClick={onWeather} type="button"><CloudSun size={14} aria-hidden="true" /> Auto-fill</Button> : undefined}
          />
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <label htmlFor="dl-weather" className="mb-1.5 block text-sm font-medium text-text-primary">Conditions<span className="ml-0.5 text-danger">*</span></label>
              <select id="dl-weather" className={selectClass} value={form.weather_code} onChange={(e) => patch({ weather_code: isWeatherCode(e.target.value) ? e.target.value : '' })}>
                <option value="">Choose…</option>
                {WEATHER_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </select>
            </div>
            <Input label="High (°F)" inputMode="numeric" value={form.temp_high_f} error={check.errors.temp_high_f} className={compactInput} onChange={(e) => patch({ temp_high_f: e.target.value })} />
            <Input label="Low (°F)" inputMode="numeric" value={form.temp_low_f} error={check.errors.temp_low_f} className={compactInput} onChange={(e) => patch({ temp_low_f: e.target.value })} />
            <Input label="Wind (mph)" inputMode="numeric" value={form.wind_mph} error={check.errors.wind_mph} className={compactInput} onChange={(e) => patch({ wind_mph: e.target.value })} />
            <div className="sm:col-span-3">
              <Input label="Weather notes" value={form.weather_notes} error={check.errors.weather_notes} className={compactInput} onChange={(e) => patch({ weather_notes: e.target.value })} />
            </div>
          </div>
        </section>

        <section className={`${panelClass} space-y-3`}>
          <SectionHeader
            title="Crew and hours"
            description={`${form.crew.length} on site · ${formatHours(hours)} total`}
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" type="button" onClick={onImportHours}>Import from timesheets</Button>
                <Button size="sm" variant="secondary" type="button" disabled={form.crew.length >= LIMITS.crew} onClick={() => patch({ crew: [...form.crew, blankCrew()] })}><Plus size={14} aria-hidden="true" /> Add</Button>
              </div>
            }
          />
          <datalist id="dl-crew-employees">{employees.map((e) => <option key={e.id} value={e.full_name} />)}</datalist>
          {form.crew.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary"><Users size={16} aria-hidden="true" /> No crew recorded. Import from timesheets or add people manually.</p>
          ) : (
            <ul className="space-y-3">
              {form.crew.map((c, i) => (
                <li key={i} className="grid gap-2 sm:grid-cols-[2fr_1.5fr_1fr_auto] sm:items-start">
                  <Input aria-label="Crew member" placeholder="Name" list="dl-crew-employees" value={c.name} error={check.errors[`crew-${i}-name`]} className={compactInput} onChange={(e) => onCrewName(i, e.target.value)} />
                  <Input aria-label="Role" placeholder="Role (optional)" value={c.role} error={check.errors[`crew-${i}-role`]} className={compactInput} onChange={(e) => setCrewAt(i, { role: e.target.value })} />
                  <Input aria-label="Hours" placeholder="Hours" inputMode="decimal" value={c.hours} error={check.errors[`crew-${i}-hours`]} helperText={c.source === 'timesheet' ? 'From timesheet' : undefined} className={compactInput} onChange={(e) => setCrewAt(i, { hours: e.target.value, source: 'manual' })} />
                  {removeBtn(`Remove crew member ${i + 1}`, () => patch({ crew: form.crew.filter((_, k) => k !== i) }))}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${panelClass} space-y-3`}>
          <SectionHeader title="Work performed" description="Required to submit. What was done today, by area or phase." />
          <Textarea aria-label="Work performed" rows={6} value={form.work_performed} error={check.errors.work_performed} helperText={`${form.work_performed.length}/${LIMITS.work}`} onChange={(e) => patch({ work_performed: e.target.value })} />
        </section>

        <section className={`${panelClass} space-y-3`}>
          <SectionHeader
            title="Delays"
            description={form.delays.length ? `${formatMinutes(delayMinutes)} lost in total` : 'Anything that slowed or stopped work.'}
            action={<Button size="sm" variant="secondary" type="button" disabled={form.delays.length >= LIMITS.delays} onClick={() => patch({ delays: [...form.delays, blankDelay()] })}><Plus size={14} aria-hidden="true" /> Add delay</Button>}
          />
          <ul className="space-y-3">
            {form.delays.map((d, i) => (
              <li key={i} className="grid gap-2 sm:grid-cols-[1.4fr_0.8fr_2fr_auto] sm:items-start">
                <select aria-label="Delay cause" className={selectClass} value={d.cause} onChange={(e) => { if (isDelayCause(e.target.value)) setDelayAt(i, { cause: e.target.value }); }}>
                  {DELAY_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                </select>
                <Input aria-label="Minutes lost" placeholder="Minutes" inputMode="numeric" value={d.minutes} error={check.errors[`delay-${i}-minutes`]} className={compactInput} onChange={(e) => setDelayAt(i, { minutes: e.target.value })} />
                <Input aria-label="Delay details" placeholder="What happened (optional)" value={d.description} error={check.errors[`delay-${i}-description`]} className={compactInput} onChange={(e) => setDelayAt(i, { description: e.target.value })} />
                {removeBtn(`Remove delay ${i + 1}`, () => patch({ delays: form.delays.filter((_, k) => k !== i) }))}
              </li>
            ))}
          </ul>
        </section>

        <section className={`${panelClass} space-y-3`}>
          <SectionHeader
            title="Visitors"
            description={form.visitors.length ? undefined : 'Inspectors, the customer, suppliers, other trades.'}
            action={<Button size="sm" variant="secondary" type="button" disabled={form.visitors.length >= LIMITS.visitors} onClick={() => patch({ visitors: [...form.visitors, blankVisitor()] })}><Plus size={14} aria-hidden="true" /> Add visitor</Button>}
          />
          <ul className="space-y-3">
            {form.visitors.map((v, i) => (
              <li key={i} className="grid gap-2 sm:grid-cols-[1.4fr_1.4fr_2fr_auto] sm:items-start">
                <Input aria-label="Visitor name" placeholder="Name" value={v.name} error={check.errors[`visitor-${i}-name`]} className={compactInput} onChange={(e) => setVisitorAt(i, { name: e.target.value })} />
                <Input aria-label="Company" placeholder="Company / agency" value={v.company} error={check.errors[`visitor-${i}-company`]} className={compactInput} onChange={(e) => setVisitorAt(i, { company: e.target.value })} />
                <Input aria-label="Purpose" placeholder="Purpose" value={v.purpose} error={check.errors[`visitor-${i}-purpose`]} className={compactInput} onChange={(e) => setVisitorAt(i, { purpose: e.target.value })} />
                {removeBtn(`Remove visitor ${i + 1}`, () => patch({ visitors: form.visitors.filter((_, k) => k !== i) }))}
              </li>
            ))}
          </ul>
        </section>

        <section className={`${panelClass} space-y-3`}>
          <SectionHeader
            title="Photos"
            description={`${photoCount} of ${LIMITS.photos} · also saved to the Gallery`}
            action={
              <>
                <input ref={fileRef} type="file" accept="image/*" multiple className="sr-only" aria-label="Add photos" tabIndex={-1} onChange={(e) => onFiles(e.target.files)} />
                <Button size="sm" variant="secondary" type="button" disabled={photoCount >= LIMITS.photos} onClick={() => fileRef.current?.click()}><Camera size={14} aria-hidden="true" /> Add photos</Button>
              </>
            }
          />
          {photoCount > 0 && (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {detail?.photos.map((p) => {
                const src = urls.get(p.thumb_path ?? p.storage_path);
                return (
                  <li key={p.link_id} className="relative aspect-square overflow-hidden rounded-xl bg-bg-tertiary">
                    {src ? <img src={src} alt={p.caption || p.file_name} loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-text-secondary">Loading…</div>}
                    {!locked && (
                      <button type="button" aria-label={`Remove ${p.file_name}`} onClick={() => onRemovePhoto(p)} className="focus-ring absolute right-1 top-1 rounded-lg bg-bg-primary/90 p-1.5 text-text-secondary hover:text-danger-500">
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={`${panelClass} space-y-3`}>
          <SectionHeader
            title="Summary"
            description="Optional. An AI draft is built from crew hours, delays, visitors, photo captions and your work notes."
            action={<Button size="sm" variant="secondary" type="button" onClick={onGenerate}><Sparkles size={14} aria-hidden="true" /> Draft with AI</Button>}
          />
          {form.ai_generated_at && form.ai_summary.trim() && (
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="info">{locked ? 'AI-assisted draft' : form.ai_edited ? 'AI draft · edited' : 'AI draft'}</Pill>
              {!locked && <span className="text-xs text-text-secondary">Review and edit before you submit.</span>}
            </div>
          )}
          <Textarea aria-label="Summary" rows={4} value={form.ai_summary} error={check.errors.ai_summary} helperText={`${form.ai_summary.length}/${LIMITS.summary}`} onChange={(e) => patch({ ai_summary: e.target.value, ai_edited: form.ai_generated_at ? true : form.ai_edited })} />
        </section>

        {!locked && (
          <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-bg-primary/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border">
            <Button size="sm" type="button" onClick={onSave} disabled={!dirty && saved !== null}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Button>
            <Button size="sm" variant="secondary" type="button" onClick={onSubmit}>Submit and lock</Button>
            {saved && <Button size="sm" variant="ghost" type="button" onClick={onDiscard}>Discard draft</Button>}
            {check.submitBlockers.length > 0 && <span className="text-xs text-text-secondary">To submit: {check.submitBlockers.join(' ').toLowerCase()}</span>}
          </div>
        )}
      </fieldset>

      {locked && saved && (
        <section className={`${panelClass} space-y-3`} aria-label="Amendments">
          <SectionHeader title="Amendments" description="Append-only. Each note is dated and cannot be changed." />
          {detail && detail.amendments.length > 0 && (
            <ul className="space-y-2">
              {detail.amendments.map((a) => (
                <li key={a.id} className="rounded-xl bg-bg-tertiary p-3">
                  <p className="whitespace-pre-wrap text-sm text-text-primary">{a.note}</p>
                  <p className="mt-1 text-xs text-text-secondary">{new Date(a.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                </li>
              ))}
            </ul>
          )}
          <Textarea aria-label="New amendment" rows={3} value={amendNote} helperText={`${amendNote.length}/${LIMITS.amendment}`} error={amendNote.length > LIMITS.amendment ? `Keep it under ${LIMITS.amendment} characters.` : undefined} onChange={(e) => setAmendNote(e.target.value)} />
          <Button size="sm" type="button" onClick={onAmend} disabled={busy !== null || !amendNote.trim() || amendNote.length > LIMITS.amendment}>{busy === 'amend' ? 'Adding…' : 'Add amendment'}</Button>
        </section>
      )}
      {dialog}
    </div>
  );
}
