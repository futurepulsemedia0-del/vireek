import { useState } from 'react';
import { Download } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';

/** Self-serve whole-account export (open formats: tar + NDJSON + manifest). Owner/admin only — enforced server-side. */
export function FullExportButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
      const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
      if (!session || !base || !anon) throw new Error('not_ready');
      const res = await fetch(`${base.replace(/\/$/, '')}/functions/v1/tenant-export`, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: anon },
      });
      if (res.status === 403) { setError('Only the account owner or an admin can export all data.'); return; }
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vireek-export-${new Date().toISOString().slice(0, 10)}.tar`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError('The export failed. Please try again in a minute.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <h2 className="text-base font-semibold text-text-primary">Download all my data</h2>
      <p className="mt-1 text-sm text-text-secondary">
        One archive with your customers, jobs, invoices, price book, calls and audit log in open formats (JSON lines + a manifest with checksums).
      </p>
      <div className="mt-3">
        <Button type="button" onClick={() => void run()} disabled={busy}><Download className="mr-2 h-4 w-4" aria-hidden="true" />{busy ? 'Preparing…' : 'Download archive'}</Button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
