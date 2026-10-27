import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Download, Wand2, Trash2, ShieldCheck, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { RiskBadge, deadlineText } from '@/components/closeout/CloseoutBoard';
import {
  ELIGIBILITY_LABELS, EVIDENCE_KINDS, EVIDENCE_LABELS, PRE_APPROVAL_LABELS, RULES_DISCLAIMER, STATUS_LABELS, STEP_LABELS,
  addEvidence, allowedTransitions, attachProgram, autocollectEvidence, deadlineRisk, fetchCaseEvents, fetchCaseEvidence,
  fetchCloseoutPrograms, fetchCaseSteps, fetchDocuments, fetchJobPhotos, fetchRebateApplications, fetchTeamMembers,
  linkRebate, logPacketGenerated, missingEvidence, programFreshness, removeEvidence, safeHttpUrl, setPreApproval,
  transitionBlockers, transitionCloseoutStep, updateCloseoutStep, formatCents,
  type CloseoutEvent, type CloseoutEvidence, type CloseoutProgram, type CloseoutSettings, type CloseoutStep,
  type CloseoutStepStatus, type EvidenceKind, type TeamMemberLite,
} from '@/lib/installCloseout';
import { downloadEvidencePacket, loadPhotoThumbnails } from '@/lib/installCloseoutPdf';

const field =
  'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

interface Props {
  caseId: string;
  focusStepId?: string | null;
  customerName: string;
  address: string | null;
  installDate: string | null;
  today: string;
  settings: CloseoutSettings;
  onClose: () => void;
  onChanged: () => void;
}

export function CloseoutCaseDrawer({ caseId, focusStepId, customerName, address, installDate, today, settings, onClose, onChanged }: Props) {
  const { toast } = useToast();
  const [steps, setSteps] = useState<CloseoutStep[]>([]);
  const [evidence, setEvidence] = useState<CloseoutEvidence[]>([]);
  const [events, setEvents] = useState<CloseoutEvent[]>([]);
  const [programs, setPrograms] = useState<CloseoutProgram[]>([]);
  const [team, setTeam] = useState<TeamMemberLite[]>([]);
  const [photos, setPhotos] = useState<{ id: string; file_name: string; storage_path: string; kind: string }[]>([]);
  const [docs, setDocs] = useState<{ id: string; title: string; category: string }[]>([]);
  const [rebates, setRebates] = useState<{ id: string; program_name: string; estimated_cents: number; status: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(focusStepId ?? null);

  const load = useCallback(async () => {
    try {
      const mine = await fetchCaseSteps(caseId);
      const [ev, evt, progs, tm] = await Promise.all([
        fetchCaseEvidence(caseId), fetchCaseEvents(caseId), fetchCloseoutPrograms(), fetchTeamMembers(),
      ]);
      setSteps(mine); setEvidence(ev); setEvents(evt); setPrograms(progs); setTeam(tm);
      const jobId = mine[0]?.job_id;
      if (jobId) {
        const [p, d, r] = await Promise.all([fetchJobPhotos(jobId), fetchDocuments(), fetchRebateApplications()]);
        setPhotos(p); setDocs(d); setRebates(r);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load this closeout.', 'error');
    } finally {
      setLoading(false);
    }
  }, [caseId, toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (focusStepId) setOpenId(focusStepId); }, [focusStepId]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await load();
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const ordered = useMemo(
    () => [...steps].sort((a, b) => ['permit', 'inspection', 'warranty', 'rebate', 'customer_docs'].indexOf(a.step_key) - ['permit', 'inspection', 'warranty', 'rebate', 'customer_docs'].indexOf(b.step_key)),
    [steps],
  );

  const exportPacket = async (step: CloseoutStep) => {
    setBusy(`pdf-${step.id}`);
    try {
      const ev = evidence.filter((e) => e.step_id === step.id);
      const photoIds = new Set(ev.map((e) => e.job_photo_id).filter(Boolean) as string[]);
      const used = photos.filter((p) => photoIds.has(p.id));
      const images = await loadPhotoThumbnails(used);
      downloadEvidencePacket({
        step, program: step.closeout_programs ?? null, evidence: ev, customerName, address, installDate,
        photoNames: Object.fromEntries(photos.map((p) => [p.id, p.file_name])),
        documentTitles: Object.fromEntries(docs.map((d) => [d.id, d.title])),
        photoImages: images,
      }, `closeout-${STEP_LABELS[step.step_key]}-${customerName}.pdf`);
      await logPacketGenerated(step.id);
      toast('Evidence packet downloaded. Review it, then file it yourself.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not build the packet.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label={`Closeout checklist for ${customerName}`}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-bg-primary p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{customerName}</h2>
            <p className="text-xs text-text-secondary">{address ?? 'No address'} · Install {installDate ?? 'date not set'}</p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary" aria-label="Close"><X size={18} /></button>
        </div>

        <p className="mb-4 rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">{RULES_DISCLAIMER}</p>

        {loading ? <SkeletonCardList count={3} /> : (
          <div className="space-y-3">
            {ordered.map((s) => {
              const ev = evidence.filter((e) => e.step_id === s.id);
              const program = s.closeout_programs ?? null;
              const missing = missingEvidence(program?.required_evidence ?? [], ev);
              const risk = deadlineRisk(s, today, settings);
              const open = openId === s.id;
              const fresh = program ? programFreshness(program, today) : 'unverified';
              const locked = ['submitted', 'completed', 'not_applicable'].includes(s.status);
              const siblings = steps;
              return (
                <section key={s.id} className="rounded-2xl border border-border bg-bg-secondary">
                  <button type="button" onClick={() => setOpenId(open ? null : s.id)} className="focus-ring flex w-full items-center justify-between gap-3 rounded-2xl p-3 text-left" aria-expanded={open}>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{STEP_LABELS[s.step_key]}{program ? ` · ${program.name}` : ''}</p>
                      <p className="text-xs text-text-secondary">{STATUS_LABELS[s.status]} · {deadlineText(s.deadline_on, today)}{missing.length ? ` · ${missing.length} missing` : ''}</p>
                    </div>
                    <RiskBadge risk={risk} />
                  </button>

                  {open && (
                    <div className="space-y-4 border-t border-border p-3">
                      {!program && (
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor={`prog-${s.id}`}>Attach a rule (program)</label>
                          <select id={`prog-${s.id}`} className={field} defaultValue="" disabled={busy !== null}
                            onChange={(e) => e.target.value && run(`att-${s.id}`, () => attachProgram(caseId, e.target.value), 'Rule attached.')}>
                            <option value="">Choose an active program…</option>
                            {programs.filter((p) => p.step_key === s.step_key && p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <p className="mt-1 text-xs text-text-secondary">Without a rule there is no deadline and no required-documents list.</p>
                        </div>
                      )}

                      {program && (
                        <div className="space-y-1 text-xs text-text-secondary">
                          <p>Administrator: {program.administrator ?? '—'} · Deadline rule: {program.deadline_days ?? '—'} days</p>
                          <p>
                            Source: {safeHttpUrl(program.source_url)
                              ? <a className="inline-flex items-center gap-1 text-accent underline" href={safeHttpUrl(program.source_url)!} target="_blank" rel="noopener noreferrer">open <ExternalLink size={11} /></a>
                              : 'none'} · Last verified {program.last_verified_on ?? 'never'}
                            {fresh !== 'fresh' && <span className="ml-1 font-semibold text-warning-500">({fresh === 'stale' ? 're-verify this rule' : 'unverified rule'})</span>}
                          </p>
                          {program.enrollment_requirements.length > 0 && <p>Enrollment: {program.enrollment_requirements.join(' · ')}</p>}
                        </div>
                      )}

                      {s.step_key === 'rebate' && (
                        <div className="space-y-2 rounded-xl bg-bg-primary p-3 text-xs">
                          <label className="block font-medium text-text-secondary" htmlFor={`el-${s.id}`}>Eligibility (your assessment — always verify)</label>
                          <select id={`el-${s.id}`} className={field} value={s.eligibility} disabled={locked || busy !== null}
                            onChange={(e) => run(`el-${s.id}`, () => updateCloseoutStep(s.id, { eligibility: e.target.value }))}>
                            {(Object.keys(ELIGIBILITY_LABELS) as (keyof typeof ELIGIBILITY_LABELS)[]).map((k) => <option key={k} value={k}>{ELIGIBILITY_LABELS[k]}</option>)}
                          </select>
                          <label className="block font-medium text-text-secondary" htmlFor={`rb-${s.id}`}>Link a rebate analysis (copies its estimate)</label>
                          <select id={`rb-${s.id}`} className={field} value={s.rebate_application_id ?? ''} disabled={locked || busy !== null}
                            onChange={(e) => e.target.value && run(`rb-${s.id}`, () => linkRebate(s.id, e.target.value), 'Linked.')}>
                            <option value="">Not linked</option>
                            {rebates.map((r) => <option key={r.id} value={r.id}>{r.program_name} — est. {formatCents(r.estimated_cents)}</option>)}
                          </select>
                        </div>
                      )}

                      {s.pre_approval_required && (
                        <PreApprovalBox step={s} busy={busy !== null} onSet={(status, ref) => run(`pa-${s.id}`, () => setPreApproval(s.id, status, ref), 'Recorded.')} />
                      )}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor={`own-${s.id}`}>Owner</label>
                          <select id={`own-${s.id}`} className={field} value={s.assignee_member_id ?? ''} disabled={locked || busy !== null}
                            onChange={(e) => run(`own-${s.id}`, () => updateCloseoutStep(s.id, { assignee_member_id: e.target.value || null }))}>
                            <option value="">Office (unassigned)</option>
                            {team.map((m) => <option key={m.id} value={m.id}>{m.member_name || m.member_email} ({m.role})</option>)}
                          </select>
                        </div>
                        <Input label="Deadline" type="date" value={s.deadline_on ?? ''} disabled={locked || busy !== null}
                          helperText={s.deadline_manual ? 'Set manually' : 'Calculated from the rule'}
                          onChange={(e) => run(`dl-${s.id}`, () => updateCloseoutStep(s.id, { deadline_on: e.target.value || null }))} />
                      </div>

                      <EvidenceSection
                        step={s} items={ev} missing={missing} locked={locked} busy={busy !== null}
                        photos={photos} docs={docs} kinds={EVIDENCE_KINDS}
                        onAuto={() => run(`auto-${s.id}`, async () => {
                          const n = await autocollectEvidence(s.id);
                          toast(n ? `Added ${n} item(s) from existing records.` : 'Nothing new found in existing records.', 'info');
                        })}
                        onAdd={(kind, opts) => run(`add-${s.id}`, () => addEvidence(s.id, kind, opts))}
                        onRemove={(id) => run(`rm-${id}`, () => removeEvidence(id))}
                      />

                      <StepActions
                        step={s} missing={missing} siblings={siblings} busy={busy}
                        onTransition={(to, o) => run(`tr-${s.id}`, () => transitionCloseoutStep(s.id, to, o), `${STATUS_LABELS[to]}.`)}
                      />

                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => exportPacket(s)}>
                          {busy === `pdf-${s.id}` ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Evidence packet (PDF)
                        </Button>
                        {s.estimated_value_cents != null && <span className="text-xs text-text-secondary">Est. value {formatCents(s.estimated_value_cents)} (estimate)</span>}
                      </div>
                    </div>
                  )}
                </section>
              );
            })}

            <section className="rounded-2xl border border-border bg-bg-secondary p-3">
              <h3 className="mb-2 text-sm font-semibold text-text-primary">Audit log</h3>
              {events.length === 0 ? <p className="text-xs text-text-secondary">Nothing recorded yet.</p> : (
                <ul className="max-h-64 space-y-1 overflow-y-auto text-xs text-text-secondary">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span className="text-text-primary">{new Date(e.created_at).toLocaleString()}</span> · {e.event_type.replace(/_/g, ' ')}
                      {e.from_status && e.to_status && e.from_status !== e.to_status ? ` (${e.from_status} → ${e.to_status})` : ''}
                      {e.actor_email ? ` · ${e.actor_email}` : ' · system'}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function PreApprovalBox({ step, busy, onSet }: { step: CloseoutStep; busy: boolean; onSet: (s: 'pending' | 'requested' | 'approved' | 'denied', ref?: string) => void }) {
  const [ref, setRef] = useState(step.pre_approval_reference ?? '');
  const approved = step.pre_approval_status === 'approved';
  return (
    <div className={`rounded-xl border p-3 text-xs ${approved ? 'border-success/40 bg-success/5' : 'border-danger/40 bg-danger/5'}`}>
      <p className="flex items-center gap-1.5 font-semibold text-text-primary"><ShieldCheck size={14} />Pre-approval: {PRE_APPROVAL_LABELS[step.pre_approval_status]}</p>
      {!approved && <p className="mt-1 text-danger">This job cannot be started until pre-approval is approved or this step is marked not applicable.</p>}
      <p className="mt-1 text-text-secondary">Get the approval from the program yourself, then record the number here. Vireek never files it for you.</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-[10rem] flex-1"><Input label="Approval / confirmation number" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} /></div>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onSet('requested')}>Mark requested</Button>
        <Button size="sm" disabled={busy || !ref.trim()} onClick={() => onSet('approved', ref)}>Record approval</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSet('denied', ref || undefined)}>Denied</Button>
      </div>
    </div>
  );
}

function EvidenceSection(props: {
  step: CloseoutStep; items: CloseoutEvidence[]; missing: string[]; locked: boolean; busy: boolean;
  photos: { id: string; file_name: string; kind: string }[]; docs: { id: string; title: string }[]; kinds: EvidenceKind[];
  onAuto: () => void; onAdd: (kind: EvidenceKind, o: { label?: string; value?: string; jobPhotoId?: string; documentId?: string }) => void; onRemove: (id: string) => void;
}) {
  const { items, missing, locked, busy, photos, docs, kinds } = props;
  const [kind, setKind] = useState<EvidenceKind>('serial_number');
  const [value, setValue] = useState('');
  const [photoId, setPhotoId] = useState('');
  const [docId, setDocId] = useState('');
  const submit = () => {
    props.onAdd(kind, { value: value.trim() || undefined, jobPhotoId: photoId || undefined, documentId: docId || undefined });
    setValue(''); setPhotoId(''); setDocId('');
  };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-text-primary">Evidence</h4>
        {!locked && <Button size="sm" variant="ghost" disabled={busy} onClick={props.onAuto}><Wand2 size={14} />Collect from job records</Button>}
      </div>
      {missing.length > 0 && (
        <p className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger" role="alert">
          Missing before you can file: {missing.map((k) => EVIDENCE_LABELS[k as EvidenceKind] ?? k).join(', ')}
        </p>
      )}
      <ul className="space-y-1">
        {items.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-2 rounded-lg bg-bg-primary px-3 py-1.5 text-xs">
            <span className="min-w-0 truncate text-text-primary">
              <strong>{EVIDENCE_LABELS[e.kind]}</strong>{' '}
              {e.value ?? (e.job_photo_id ? `photo: ${photos.find((p) => p.id === e.job_photo_id)?.file_name ?? 'linked'}` : e.document_id ? `document: ${docs.find((d) => d.id === e.document_id)?.title ?? 'linked'}` : <em className="text-danger">empty (source deleted)</em>)}
              {e.source === 'auto' && <span className="ml-1 text-text-secondary">(auto)</span>}
            </span>
            {!locked && <button type="button" className="focus-ring rounded p-1 text-text-secondary hover:text-danger" aria-label="Remove evidence" onClick={() => props.onRemove(e.id)}><Trash2 size={13} /></button>}
          </li>
        ))}
      </ul>
      {!locked && (
        <div className="mt-2 grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
          <select aria-label="Evidence type" className={field} value={kind} onChange={(e) => setKind(e.target.value as EvidenceKind)}>
            {kinds.map((k) => <option key={k} value={k}>{EVIDENCE_LABELS[k]}</option>)}
          </select>
          <div className="grid gap-2">
            <input aria-label="Value" className={field} placeholder="Value (serial, number, date…)" value={value} maxLength={500} onChange={(e) => setValue(e.target.value)} />
            <div className="grid gap-2 sm:grid-cols-2">
              <select aria-label="Job photo" className={field} value={photoId} onChange={(e) => setPhotoId(e.target.value)}>
                <option value="">or link a job photo…</option>
                {photos.map((p) => <option key={p.id} value={p.id}>{p.file_name} ({p.kind})</option>)}
              </select>
              <select aria-label="Document" className={field} value={docId} onChange={(e) => setDocId(e.target.value)}>
                <option value="">or link a document…</option>
                {docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
              </select>
            </div>
          </div>
          <Button size="sm" disabled={busy || (!value.trim() && !photoId && !docId)} onClick={submit}>Add</Button>
        </div>
      )}
    </div>
  );
}

function StepActions({ step, missing, siblings, busy, onTransition }: {
  step: CloseoutStep; missing: string[]; siblings: CloseoutStep[]; busy: string | null;
  onTransition: (to: CloseoutStepStatus, o: { note?: string; reference?: string; attest?: boolean }) => void;
}) {
  const [note, setNote] = useState('');
  const [reference, setReference] = useState(step.reference_number ?? '');
  const [attest, setAttest] = useState(false);
  const next = allowedTransitions(step.status);
  if (next.length === 0) return <p className="text-xs text-text-secondary">This step is complete. Evidence is locked.</p>;
  const needsSubmit = next.includes('submitted');
  return (
    <div className="space-y-2 rounded-xl bg-bg-primary p-3">
      {needsSubmit && (
        <>
          <p className="text-xs text-text-secondary">
            Review the packet, then file it with the program or authority <strong>yourself</strong>. Record the confirmation below —
            Vireek never submits anything for you.
          </p>
          <Input label="Confirmation / reference number" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
          <label className="flex items-start gap-2 text-xs text-text-primary">
            <input type="checkbox" className="mt-0.5" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
            I reviewed this packet and approve it. I submitted it myself outside Vireek.
          </label>
        </>
      )}
      <Textarea label="Note (required for rejected / not applicable)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
      <div className="flex flex-wrap gap-2">
        {next.map((to) => {
          const blockers = transitionBlockers({ step, to, siblings, missing, note, reference, attested: attest });
          return (
            <Button key={to} size="sm" variant={to === 'submitted' || to === 'completed' || to === 'ready_for_approval' ? 'primary' : 'secondary'}
              disabled={busy !== null || blockers.length > 0}
              title={blockers.map((b) => b.detail ?? b.code).join(' · ') || undefined}
              onClick={() => onTransition(to, { note: note || undefined, reference: reference || undefined, attest })}>
              {to === 'submitted' ? 'Record human submission' : STATUS_LABELS[to]}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
