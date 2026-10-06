import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Phone, Navigation, AlertTriangle, ShieldAlert, PackageX, Wrench } from 'lucide-react';
import {
  fetchJobBrief, advanceJobStatus, setSafetyFlag, addJobNote,
  nextStatus, mapsLink, telLink, STATUS_LABELS, JobBrief, JobStatus,
} from '@/lib/technicianOS';
import { createExpertAssistRequest, snapshotFromBrief } from '@/lib/expertAssist';
import { useComplianceStartGuard } from '@/components/jobs/ComplianceStartGuard';
import { PermitCompliancePanel } from '@/components/jobs/PermitCompliancePanel';
import { JobUnknownsPanel } from '@/components/jobs/JobUnknownsPanel';

export function TechnicianJobBriefPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [brief, setBrief] = useState<JobBrief | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate2 = useNavigate();
  const { guardStart, complianceDialog } = useComplianceStartGuard();

  const load = () => {
    if (!jobId) return;
    fetchJobBrief(jobId).then(setBrief);
  };

  useEffect(load, [jobId]);

  if (!brief) return <div className="p-6 text-center text-text-secondary">Loading…</div>;
  if (brief.error) return <div className="p-6 text-center text-danger">Job not available.</div>;

  const { job, customer, equipment, previous_notes, warranty_claims, likely_diagnosis, customer_preferences, parts_check } = brief;
  const upcoming = nextStatus(job.job_status);
  const shortages = parts_check.filter((p) => p.shortage > 0);

  async function handleAdvance(status: JobStatus) {
    if (!jobId) return;
    if ((status === 'en_route' || status === 'in_progress') && !(await guardStart(jobId))) return;
    setBusy(true);
    try {
      await advanceJobStatus(jobId, status);
      load();
    } finally {
      setBusy(false);
    }
  }

  async function handleSafetyToggle() {
    if (!jobId) return;
    const flag = !job.safety_flag;
    await setSafetyFlag(jobId, flag, flag ? note || 'Flagged from field' : null);
    load();
  }

  async function handleAddNote() {
    if (!jobId || !note.trim()) return;
    await addJobNote(jobId, note.trim());
    setNote('');
    load();
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
    {complianceDialog}
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <button onClick={() => navigate('/tech/today')}><ArrowLeft className="h-5 w-5" /></button>
        <div>
          <h1 className="font-semibold text-text-primary">{job.customer_name}</h1>
          <p className="text-xs text-text-secondary">{STATUS_LABELS[job.job_status]} · {job.service_type || '—'}</p>
        </div>
      </header>

      <main className="mx-auto max-w-lg space-y-4 px-4 py-4">
        {job.safety_flag && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{job.safety_flag_note || 'Marked unsafe by a technician.'}</span>
          </div>
        )}

        <div className="flex gap-2">
          <a href={telLink(customer?.phone ?? null)} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-bg-secondary py-3 text-sm font-medium text-text-primary">
            <Phone className="h-4 w-4" /> Call
          </a>
          <a href={mapsLink(job.address)} target="_blank" rel="noreferrer" className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-bg-secondary py-3 text-sm font-medium text-text-primary">
            <Navigation className="h-4 w-4" /> Navigate
          </a>
        </div>
        <button
          onClick={async () => {
            const requestId = await createExpertAssistRequest(
              jobId ?? null,
              null,
              snapshotFromBrief(brief),
              `Stuck on ${job.customer_name} — ${job.service_type || 'job'}`,
            );
            navigate(`/dashboard/expert-assist/${requestId}`);
          }}
          className="w-full rounded-lg border border-accent bg-accent/10 py-3 text-sm font-semibold text-accent"
        >
          🆘 Ask Vireek Expert
        </button>

        <PermitCompliancePanel job={job} />
        <JobUnknownsPanel job={job} />
        <Link to={`/dashboard/live-copilot?job=${jobId}`} className="focus-ring rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">Open Live Copilot</Link>
        {customer_preferences.length > 0 && (
          <section className="rounded-lg border border-border bg-bg-secondary p-3">
            <h2 className="mb-2 text-sm font-semibold text-text-primary">Customer notes</h2>
            <ul className="space-y-1 text-sm text-text-secondary">
              {customer_preferences.map((p, i) => <li key={i}>• [{p.category}] {p.fact}</li>)}
            </ul>
          </section>
        )}

        {equipment.length > 0 && (
          <section className="rounded-lg border border-border bg-bg-secondary p-3">
            <h2 className="mb-2 text-sm font-semibold text-text-primary">Equipment on site</h2>
            {equipment.map((e) => (
              <div key={e.id} className="mb-2 text-sm text-text-secondary last:mb-0">
                <p className="text-text-primary">{e.make} {e.model} ({e.equipment_type})</p>
                {e.warranty_expires_at && <p>Warranty until {e.warranty_expires_at}</p>}
                {e.notes && <p className="italic">{e.notes}</p>}
              </div>
            ))}
          </section>
        )}

        {likely_diagnosis && (
          <section className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <h2 className="mb-1 flex items-center gap-1 text-sm font-semibold text-text-primary">
              <Wrench className="h-4 w-4" /> Likely diagnosis (severity: {likely_diagnosis.severity})
            </h2>
            <pre className="whitespace-pre-wrap text-xs text-text-secondary">
              {JSON.stringify(likely_diagnosis.ai_result, null, 2)}
            </pre>
          </section>
        )}

        {shortages.length > 0 && (
          <section className="rounded-lg border border-warning-500/30 bg-warning-500/10 p-3">
            <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold text-warning-500">
              <PackageX className="h-4 w-4" /> Parts shortage on your van
            </h2>
            {shortages.map((p, i) => (
              <p key={i} className="text-sm text-text-secondary">{p.part_name}: need {p.required_qty}, have {p.on_hand_qty}</p>
            ))}
          </section>
        )}

        {warranty_claims.length > 0 && (
          <section className="rounded-lg border border-border bg-bg-secondary p-3">
            <h2 className="mb-2 text-sm font-semibold text-text-primary">Warranty claims</h2>
            {warranty_claims.map((w) => (
              <p key={w.id} className="text-sm text-text-secondary">{w.manufacturer} {w.model_number} — {w.status}</p>
            ))}
          </section>
        )}

        {previous_notes.length > 0 && (
          <section className="rounded-lg border border-border bg-bg-secondary p-3">
            <h2 className="mb-2 text-sm font-semibold text-text-primary">Previous visits</h2>
            {previous_notes.map((n) => (
              <p key={n.job_id} className="mb-1 text-sm text-text-secondary last:mb-0">{n.notes}</p>
            ))}
          </section>
        )}

        <section className="rounded-lg border border-border bg-bg-secondary p-3">
          <h2 className="mb-2 text-sm font-semibold text-text-primary">Add note from the field</h2>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-bg-primary p-2 text-sm text-text-primary"
            placeholder="What did you find / do?"
          />
          <div className="mt-2 flex gap-2">
            <button onClick={handleAddNote} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">Save note</button>
            <button onClick={handleSafetyToggle} className="flex items-center gap-1 rounded-md border border-danger/40 px-3 py-2 text-sm font-medium text-danger">
              <ShieldAlert className="h-4 w-4" /> {job.safety_flag ? 'Clear safety flag' : 'Flag unsafe'}
            </button>
          </div>
        </section>
      </main>

      {upcoming && (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-bg-primary p-4">
          <button
            disabled={busy}
            onClick={() => handleAdvance(upcoming)}
            className="w-full rounded-lg bg-accent py-3 text-center font-semibold text-white disabled:opacity-50"
          >
            Mark as {STATUS_LABELS[upcoming]}
          </button>
        </div>
      )}
    </div>
  );
}
