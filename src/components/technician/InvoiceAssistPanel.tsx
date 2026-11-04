// Invoice assist (phase D): flags unbilled parts/time and below-book prices for REVIEW.
// It never edits the invoice. Inputs: approved voice logs, telematics on-site time, price book.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { fetchJobVisit } from '@/lib/telematics';
import { formatCents } from '@/lib/priceBook';
import { useVoiceLogT } from '@/i18n/voiceLogNamespace';
import { fetchApprovedExtractions } from '@/lib/voiceLog/service';
import { reconcileInvoice, type AssistFlag, type BookItem, type InvLine } from '@/lib/voiceLog/invoiceAssist';

type TFn = (key: string, opts?: Record<string, unknown>) => string;
type State = { k: 'loading' } | { k: 'error' } | { k: 'none' } | { k: 'ready'; flags: AssistFlag[]; lines: InvLine[] };

function flagText(f: AssistFlag, t: TFn): string {
  const d = f.data;
  switch (f.kind) {
    case 'part_not_billed': return t('flagPartNotBilled', d);
    case 'part_qty_low': return t('flagPartQtyLow', d);
    case 'labor_under_billed': return t('flagLabor', { work: d.workMin, billed: d.billedMin });
    case 'price_below_book': return t('flagPriceBelow', { item: d.item, billed: formatCents(Number(d.billed)), book: formatCents(Number(d.book)) });
  }
}

export function InvoiceAssistPanel({ jobId }: { jobId: string }) {
  const { t } = useVoiceLogT();
  const tt = t as unknown as TFn;
  const [state, setState] = useState<State>({ k: 'loading' });

  const load = useCallback(async () => {
    setState({ k: 'loading' });
    try {
      const inv = await supabase.from('invoices').select('id, line_items').eq('job_id', jobId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (inv.error) throw inv.error;
      if (!inv.data) { setState({ k: 'none' }); return; }
      const lines = ((inv.data as { line_items: InvLine[] | null }).line_items ?? []).filter((l) => l && typeof l.description === 'string');
      const [logs, book, visit] = await Promise.all([
        fetchApprovedExtractions(jobId),
        supabase.from('price_book_items').select('id, service_name, keywords, price_cents, pricing_model, active').eq('active', true).limit(500),
        fetchJobVisit(jobId).catch(() => ({ visit: null })),
      ]);
      if (book.error) throw book.error;
      const minutes = logs.reduce((n, l) => n + (l.time_minutes ?? 0), 0);
      const flags = reconcileInvoice({
        invoiceLines: lines,
        loggedParts: logs.flatMap((l) => l.parts.map((p) => ({ name: p.name, quantity: p.quantity }))),
        loggedMinutes: minutes > 0 ? minutes : null,
        onsiteMinutes: visit.visit?.onsite_seconds ? Math.round(visit.visit.onsite_seconds / 60) : null,
        priceBook: (book.data ?? []) as BookItem[],
      });
      setState({ k: 'ready', flags, lines });
    } catch { setState({ k: 'error' }); }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-2 rounded-lg border border-border bg-bg-secondary p-3" aria-labelledby="invoice-assist-title">
      <h2 id="invoice-assist-title" className="text-base font-semibold text-text-primary">{tt('invoiceAssistTitle')}</h2>
      <div role="status" aria-live="polite" className="space-y-2 text-sm">
        {state.k === 'loading' && <p className="flex items-center gap-2 text-text-secondary"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{tt('invoiceAssistLoading')}</p>}
        {state.k === 'none' && <p className="text-text-secondary">{tt('invoiceAssistNoInvoice')}</p>}
        {state.k === 'error' && (
          <p className="flex items-center gap-2 font-medium text-danger"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{tt('invoiceAssistFailed')}
            <button type="button" className="min-h-[48px] rounded-md border border-border px-3 text-text-primary" onClick={() => void load()}>{tt('retry')}</button></p>
        )}
        {state.k === 'ready' && (state.flags.length === 0
          ? <p className="flex items-center gap-2 text-success-500"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{tt('invoiceAssistNone')}</p>
          : (
            <>
              <p className="text-text-secondary">{tt('invoiceAssistIntro')}</p>
              <ul className="space-y-2">
                {state.flags.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-md border border-warning-500/40 bg-warning-500/10 p-2 text-base text-text-primary">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning-500" aria-hidden="true" />{flagText(f, tt)}
                  </li>
                ))}
              </ul>
            </>
          ))}
      </div>
    </section>
  );
}
