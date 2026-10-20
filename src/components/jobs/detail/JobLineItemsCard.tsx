import { useEffect, useState } from 'react';
import { PackagePlus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/quotes';
import { JobSection } from '@/components/jobs/detail/JobSection';

interface JobLineItemRow {
  id: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  part_id: string | null;
  source: 'quote_addon' | 'manual';
}

export function JobLineItemsCard({ jobId, canSeeBilling }: { jobId: string; canSeeBilling: boolean }) {
  const [rows, setRows] = useState<JobLineItemRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('job_line_items')
          .select('id, description, quantity, unit_price_cents, part_id, source')
          .eq('job_id', jobId)
          .order('created_at', { ascending: true });
        if (!cancelled) setRows((data as JobLineItemRow[] | null) ?? []);
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (rows.length === 0) return null;

  const total = rows.reduce((sum, r) => sum + r.quantity * r.unit_price_cents, 0);

  return (
    <JobSection title="Customer add-ons" icon={PackagePlus}>
      <ul className="divide-y divide-border/60 rounded-xl border border-border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 text-text-primary">
              {r.description}
              {r.quantity > 1 && <span className="text-text-secondary"> × {r.quantity}</span>}
              {r.part_id && <span className="ml-2 text-xs text-text-secondary">· added to required parts</span>}
            </span>
            {canSeeBilling && <span className="shrink-0 text-text-secondary">{formatCents(r.quantity * r.unit_price_cents)}</span>}
          </li>
        ))}
      </ul>
      {canSeeBilling && (
        <p className="mt-2 text-right text-xs text-text-secondary">
          Add-ons before tax: <span className="font-semibold text-text-primary">{formatCents(total)}</span>
        </p>
      )}
    </JobSection>
  );
}
