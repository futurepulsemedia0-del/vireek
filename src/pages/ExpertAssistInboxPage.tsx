import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { fetchOpenRequests, ExpertAssistRequest } from '@/lib/expertAssist';
import { DashboardLayout } from '@/components/DashboardLayout';

export function ExpertAssistInboxPage() {
  const [requests, setRequests] = useState<ExpertAssistRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchOpenRequests().then(setRequests).finally(() => setLoading(false));
  }, []);

  return (
    <DashboardLayout activeLabel="Expert Assist">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="mb-1 text-xl font-semibold text-text-primary">Remote Expert Assist</h1>
        <p className="mb-6 text-sm text-text-secondary">Technicians asking for help in the field, live.</p>

        {loading && <p className="text-text-secondary">Loading…</p>}
        {!loading && requests.length === 0 && <p className="text-text-secondary">No open requests right now.</p>}

        <ul className="space-y-2">
          {requests.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => navigate(`/dashboard/expert-assist/${r.id}`)}
                className="flex w-full items-center justify-between rounded-lg border border-border bg-bg-secondary p-4 text-left"
              >
                <div>
                  <p className="font-medium text-text-primary">{r.error_code || 'Field question'}</p>
                  <p className="text-xs text-text-secondary">{new Date(r.created_at).toLocaleString()}</p>
                </div>
                <span className={`flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${r.status === 'open' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent'}`}>
                  {r.status === 'open' && <AlertCircle className="h-3 w-3" />} {r.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </DashboardLayout>
  );
}
