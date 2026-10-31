import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { gatewayBase, readOnlyGrantSql, type WarehouseTool } from '@/lib/biConnectors';
import { CodeBlock, Field, SELECT } from '@/components/data-platform/ui';

const TOOLS = [
  { id: 'powerbi', label: 'Power BI / Excel' },
  { id: 'tableau', label: 'Tableau' },
  { id: 'metabase', label: 'Metabase' },
  { id: 'looker', label: 'Looker / Looker Studio' },
  { id: 'sheets', label: 'Google Sheets' },
  { id: 'api', label: 'Airbyte / scripts' },
] as const;
type ToolId = (typeof TOOLS)[number]['id'];

function Steps({ items }: { items: string[] }) {
  return <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-text-primary">{items.map((s) => <li key={s}>{s}</li>)}</ol>;
}

export function GuidesTab() {
  const [tool, setTool] = useState<ToolId>('powerbi');
  const [wh, setWh] = useState<WarehouseTool>('bigquery');
  const base = gatewayBase();

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="BI tools" className="flex flex-wrap gap-2">
        {TOOLS.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tool === t.id} onClick={() => setTool(t.id)}
            className={`focus-ring rounded-full border px-3.5 py-1.5 text-sm font-semibold ${tool === t.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
        ))}
      </div>

      <Card className="space-y-4 p-5 sm:p-6">
        {tool === 'powerbi' && (
          <>
            <h2 className="text-lg font-semibold text-text-primary">Power BI and Excel (live OData feed)</h2>
            <Steps items={[
              'Create a token in “Live access”. Copy it.',
              'Power BI Desktop → Get data → OData feed. Excel → Data → Get Data → From Other Sources → From OData Feed.',
              'Paste the feed URL below and click OK.',
              'Choose “Basic”. User name: vireek (anything). Password: your token (vbi_…).',
              'Pick the tables you need and Load. For incremental refresh, filter updated_at with RangeStart / RangeEnd: the filter is pushed to Vireek.',
            ]} />
            <CodeBlock code={`${base}/odata/`} />
          </>
        )}
        {tool === 'tableau' && (
          <>
            <h2 className="text-lg font-semibold text-text-primary">Tableau</h2>
            <Steps items={['Connect → To a Server → OData.', 'Server URL: the feed below. Authentication: Username and Password; username vireek, password = your token.', 'Drag the tables you need onto the canvas. For very large accounts, use a warehouse export instead (see Metabase / Looker).']} />
            <CodeBlock code={`${base}/odata/`} />
          </>
        )}
        {(tool === 'metabase' || tool === 'looker') && (
          <>
            <h2 className="text-lg font-semibold text-text-primary">{tool === 'metabase' ? 'Metabase' : 'Looker and Looker Studio'}: read-only through your warehouse</h2>
            <p className="text-sm leading-relaxed text-text-secondary">
              {tool === 'metabase' ? 'Metabase connects to databases, not web APIs. ' : 'Looker connects to databases; Looker Studio has a native BigQuery connector. '}
              Sync Vireek into BigQuery, Snowflake or Postgres from the Data Platform → Warehouse tab, then give your BI tool a read-only account on that dataset. Hashed ids match the BI feed, so joins line up.
            </p>
            <Field label="Your warehouse">
              <select className={SELECT} value={wh} onChange={(e) => setWh(e.target.value as WarehouseTool)}>
                <option value="bigquery">BigQuery</option><option value="snowflake">Snowflake</option><option value="postgres">Postgres replica</option>
              </select>
            </Field>
            <CodeBlock code={readOnlyGrantSql(wh, { dataset: 'vireek' })} />
            <Steps items={[tool === 'metabase' ? 'Metabase → Admin → Databases → Add database → choose your warehouse, and enter the read-only credentials.' : 'In Looker, create a connection to the warehouse with the read-only account; in Looker Studio add the BigQuery data source.', 'Use the metrics_daily table for official KPIs: it matches the dashboard exactly.']} />
          </>
        )}
        {tool === 'sheets' && (
          <>
            <h2 className="text-lg font-semibold text-text-primary">Google Sheets</h2>
            <p className="text-sm leading-relaxed text-text-secondary">Sheets cannot send an authorization header, and tokens in URLs are unsafe, so Vireek never accepts them. Use the built-in sync instead: Data Platform → Reverse ETL → Google Sheets keeps a tab refreshed on a schedule, with no token to leak.</p>
          </>
        )}
        {tool === 'api' && (
          <>
            <h2 className="text-lg font-semibold text-text-primary">REST for Airbyte, dbt, Python and friends</h2>
            <p className="text-sm text-text-secondary">Cursor-paged JSON or CSV. Send the token as a Bearer header. Pass <code>updated_since</code> for incremental pulls; follow <code>next_cursor</code> until <code>has_more</code> is false.</p>
            <CodeBlock code={`curl -H "Authorization: Bearer vbi_…" \\\n  "${base}/v1/jobs?limit=1000&updated_since=2027-01-01T00:00:00Z"\n\n# Data dictionary\ncurl -H "Authorization: Bearer vbi_…" "${base}/v1/schema"`} />
          </>
        )}
      </Card>

      <Card className="space-y-3 p-5 sm:p-6">
        <h2 className="text-base font-semibold text-text-primary">Reading exported files</h2>
        <p className="text-sm text-text-secondary">Incremental files hold changed rows; keep the newest version of each <code>id</code>. Only trust runs whose manifest says <code>"complete": true</code>.</p>
        <CodeBlock code={`-- BigQuery / Snowflake / DuckDB: latest version of each row\nSELECT * EXCEPT (rn) FROM (\n  SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC) AS rn\n  FROM jobs_raw\n) WHERE rn = 1;`} />
      </Card>
    </div>
  );
}
