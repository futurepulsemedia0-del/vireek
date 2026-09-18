import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export function AckEscalationPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');

  useEffect(() => {
    if (!token) { setStatus('error'); return; }
    (async () => {
      const { data, error } = await supabase.rpc('acknowledge_escalation', { p_token: token });
      setStatus(!error && data ? 'ok' : 'error');
    })();
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary px-4">
      <div className="max-w-sm rounded-2xl border border-border bg-bg-secondary p-8 text-center">
        {status === 'loading' && <p className="text-text-secondary">Checking…</p>}
        {status === 'ok' && (
          <>
            <CheckCircle2 className="mx-auto mb-3 text-success-500" size={40} />
            <h1 className="text-lg font-semibold text-text-primary">You're on it</h1>
            <p className="mt-1 text-sm text-text-secondary">This escalation has been acknowledged. No further alerts will go out.</p>
          </>
        )}
        {status === 'error' && (
          <>
            <AlertCircle className="mx-auto mb-3 text-error-500" size={40} />
            <h1 className="text-lg font-semibold text-text-primary">Link no longer valid</h1>
            <p className="mt-1 text-sm text-text-secondary">This escalation was already acknowledged or has expired.</p>
          </>
        )}
      </div>
    </div>
  );
}
