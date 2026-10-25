import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  DATASETS,
  DATASET_KEYS,
  METRICS,
  METRIC_IDS,
  PII_MODES,
  PII_MODE_META,
  allColumns,
  downloadText,
  renderDataDictionaryMarkdown,
  type DatasetKey,
  type PiiMode,
} from '@/lib/dataPlatform';
import { Badge, Field, SELECT, STATUS_STYLE } from './ui';

export function SchemaTab() {
  const [active, setActive] = useState<DatasetKey>('customers');
  const [piiMode, setPiiMode] = useState<PiiMode>('hashed');
  const def = DATASETS[active];
  const columns = useMemo(() => allColumns(active), [active]);

  const download = () => {
    const md = renderDataDictionaryMarkdown({
      schemaName: 'vireek',
      piiMode,
      generatedAt: new Date().toISOString().slice(0, 10),
      metrics: METRIC_IDS.map((id) => ({ id, label: METRICS[id].label, unit: METRICS[id].unit, definition: METRICS[id].definition, version: METRICS[id].version })),
    });
    downloadText('vireek-data-dictionary.md', md);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">
          Every table, column and privacy class Vireek writes to your warehouse. Download the full dictionary, including the official metric definitions, for your analysts.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Personal data in the download">
            <select className={SELECT} value={piiMode} onChange={(e) => setPiiMode(e.target.value as PiiMode)}>
              {PII_MODES.map((m) => (
                <option key={m} value={m}>
                  {PII_MODE_META[m].label}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="secondary" onClick={download}>
            <Download size={16} />
            Download .md
          </Button>
        </div>
      </div>

      <div role="tablist" aria-label="Tables" className="flex flex-wrap gap-2">
        {DATASET_KEYS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={active === k}
            type="button"
            onClick={() => setActive(k)}
            className={`focus-ring rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${active === k ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
          >
            {k}
          </button>
        ))}
      </div>

      <Card className="p-5">
        <h3 className="text-base font-semibold text-text-primary">{def.label}</h3>
        <p className="mt-1 text-sm text-text-secondary">{def.description}</p>
        <p className="mt-1 text-xs text-text-secondary">
          Source <code>{def.source}</code> · incremental on <code>{def.cursor}</code> · primary key <code>id</code>
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-text-secondary">
                <th className="py-2 pr-4 font-semibold">Column</th>
                <th className="py-2 pr-4 font-semibold">Type</th>
                <th className="py-2 pr-4 font-semibold">Privacy</th>
                <th className="py-2 font-semibold">Description</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => (
                <tr key={c.name} className="border-t border-border/60 align-top">
                  <td className="py-2 pr-4 font-mono text-xs text-text-primary">{c.name}</td>
                  <td className="py-2 pr-4 text-text-secondary">{c.type}</td>
                  <td className="py-2 pr-4">
                    {c.pii ? <Badge cls={c.pii === 'sensitive' ? STATUS_STYLE.failed : STATUS_STYLE.partial}>{c.pii}</Badge> : <span className="text-text-secondary">—</span>}
                  </td>
                  <td className="py-2 text-text-secondary">{c.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
