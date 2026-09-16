import { useMemo, useState } from 'react';
import { Copy, Check, Zap, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { buildSyntheticEvents, SyntheticEvent } from '@/lib/sandbox';

export function SyntheticEventsPanel() {
  const events = useMemo(() => buildSyntheticEvents(), []);
  const [active, setActive] = useState<SyntheticEvent>(events[0]);
  const [copied, setCopied] = useState(false);

  const copyPayload = async () => {
    await navigator.clipboard.writeText(JSON.stringify(active.payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <Card className="overflow-hidden border-border bg-bg-secondary/80 p-0">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Zap size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Synthetic events</h3>
          <p className="text-xs text-text-secondary">
            Realistic webhook payloads you can copy into your integration tests — zero risk to production.
          </p>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[220px_1fr]">
        <div className="flex flex-row gap-1 overflow-x-auto border-b border-border p-3 lg:flex-col lg:border-b-0 lg:border-r">
          {events.map((ev) => (
            <button
              key={ev.type}
              type="button"
              onClick={() => setActive(ev)}
              className={`rounded-lg px-3 py-2.5 text-left text-sm transition ${
                active.type === ev.type
                  ? 'bg-accent/10 font-semibold text-accent'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
              }`}
            >
              <span className="block font-mono text-[11px] opacity-80">{ev.type}</span>
              <span className="block">{ev.label}</span>
            </button>
          ))}
        </div>

        <div className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-text-primary">{active.label}</p>
              <p className="text-xs text-text-secondary">{active.description}</p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={copyPayload}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy payload'}
            </Button>
          </div>

          <pre className="max-h-[360px] overflow-auto rounded-xl border border-border bg-bg-primary p-4 font-mono text-[12px] leading-relaxed text-text-primary">
            {JSON.stringify(active.payload, null, 2)}
          </pre>

          <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-bg-primary/60 px-3 py-2.5 text-xs leading-relaxed text-text-secondary">
            <Webhook size={14} className="mt-0.5 shrink-0 text-accent" />
            <span>
              Point your webhook receiver at these shapes. When you go live, the same event names and
              fields are delivered from production. No synthetic data is written to your account from this panel.
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}
