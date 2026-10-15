import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { JobThread } from '@/components/messages/JobThread';
import { supabase } from '@/lib/supabase';

interface JobHead { customer_name: string; service_type: string | null }

export function TechnicianJobThreadPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<JobHead | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    supabase.from('jobs').select('customer_name, service_type').eq('id', jobId).maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setJob(data as JobHead); else setMissing(true);
      });
    return () => { cancelled = true; };
  }, [jobId]);

  if (!jobId || missing) {
    return (
      <div className="min-h-screen bg-bg-primary p-6">
        <EmptyState icon={MessageSquare} title="Conversation unavailable" description="This job doesn't exist or isn't assigned to you." action={{ label: 'Back to messages', onClick: () => navigate('/tech/messages') }} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[100dvh] max-w-lg flex-col bg-bg-primary">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button type="button" onClick={() => navigate('/tech/messages')} className="focus-ring rounded" aria-label="Back to messages"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold text-text-primary">{job?.customer_name ?? 'Messages'}</h1>
          <p className="truncate text-xs text-text-secondary">{job?.service_type || 'Office thread'}</p>
        </div>
        <button type="button" onClick={() => navigate(`/tech/job/${jobId}`)} className="focus-ring rounded text-sm font-medium text-accent">Job</button>
      </header>
      <div className="min-h-0 flex-1"><JobThread jobId={jobId} viewer="technician" /></div>
    </div>
  );
}
