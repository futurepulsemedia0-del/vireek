import { useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { fetchUnitEconomics } from '@/lib/unitEconomicsApi';
import { buildReconciliation, buildReportHtml, type ReportModel, type ReportReconciliation } from '@/lib/unitEconomicsReportHtml';
import { Field, INPUT, Section } from './shared';

function monthWindow(month: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}

export function ReportPanel({ model }: { model: ReportModel }) {
  const { toast } = useToast();
  const [month, setMonth] = useState('');
  const [provider, setProvider] = useState('vapi');
  const [busy, setBusy] = useState(false);

  const make = async (): Promise<string | null> => {
    let reconciliation: ReportReconciliation | null = null;
    if (month.trim()) {
      const w = monthWindow(month.trim());
      if (!w) { toast('Reconciliation month must look like 2026-10.', 'error'); return null; }
      try {
        const ue = await fetchUnitEconomics(w.start, w.end);
        const key = `${month.trim()}-01`;
        const inv = ue.invoices.find((i) => i.period_month === key && i.provider.toLowerCase() === provider.trim().toLowerCase()) ?? null;
        reconciliation = buildReconciliation({ month: month.trim(), provider: provider.trim(), reportedUsd: ue.reported_voice_total_usd, invoicedUsd: inv ? inv.invoiced_usd : null, thresholdPct: 5 });
      } catch {
        toast('Could not load reconciliation data; the report was not created.', 'error');
        return null;
      }
    }
    return buildReportHtml({ ...model, reconciliation });
  };

  const download = async () => {
    setBusy(true);
    try {
      const html = await make();
      if (!html) return;
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `vireek-unit-economics-${new Date().toISOString().slice(0, 10)}.html`;
      a.click();
      URL.revokeObjectURL(url);
    } finally { setBusy(false); }
  };

  const print = async () => {
    setBusy(true);
    try {
      const html = await make();
      if (!html) return;
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
      frame.srcdoc = html;
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        setTimeout(() => frame.remove(), 60_000);
      };
      document.body.appendChild(frame);
    } finally { setBusy(false); }
  };

  return (
    <Section title="Monthly unit-economics report">
      <p className="text-sm text-text-secondary">Board-ready HTML with every assumption listed and estimates labelled separately from measured values. Use “Print / Save as PDF” and choose “Save as PDF” in the browser dialog. The report covers the period selected at the top of the page.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Reconciliation month (optional)" hint="Format 2026-10. Needs a provider invoice entered under Inputs."><input value={month} onChange={(e) => setMonth(e.target.value)} placeholder="2026-10" className={INPUT} /></Field>
        <Field label="Invoice provider"><input value={provider} onChange={(e) => setProvider(e.target.value)} className={INPUT} /></Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => void download()} disabled={busy}><Download size={15} aria-hidden="true" /> Download HTML</Button>
        <Button size="sm" onClick={() => void print()} disabled={busy}><Printer size={15} aria-hidden="true" /> Print / Save as PDF</Button>
      </div>
    </Section>
  );
}
