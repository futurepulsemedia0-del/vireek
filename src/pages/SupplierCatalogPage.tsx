import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, KeyRound, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import { readImportFile, type ParsedTable } from '@/lib/importFile';
import {
  createFeedKey,
  importSupplierPrices,
  listFeedKeys,
  listImportRuns,
  listSuppliers,
  revokeFeedKey,
  type FeedKey,
  type ImportRun,
  type SupplierOption,
} from '@/lib/partsOrderingApi';
import {
  IMPORT_FIELDS,
  autoMapColumns,
  buildImportItems,
  type ColumnMapping,
  type ImportFieldKey,
  type ImportResult,
} from '@/lib/partsOrdering';

const FEED_URL = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://YOUR-PROJECT.supabase.co'}/functions/v1/supplier-price-feed`;
const select = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';

export function SupplierCatalogPage() {
  const { toast } = useToast();
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [runs, setRuns] = useState<ImportRun[]>([]);

  const reloadRuns = useCallback(() => {
    listImportRuns().then(setRuns).catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    listSuppliers()
      .then((s) => {
        setSuppliers(s);
        setVendorId((cur) => cur || s[0]?.id || '');
      })
      .catch(() => setLoadError(true));
    reloadRuns();
  }, [reloadRuns]);

  const vendorName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier';

  return (
    <DashboardLayout activeLabel="Supplier Catalog">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Supplier catalog</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            Keep each supplier’s prices, stock and lead times current so technicians can search and order parts straight from a job. Import a price
            list, or let a supplier push updates through the API.
          </p>
        </div>

        {loadError ? (
          <div role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">Could not load suppliers. Refresh to try again.</div>
        ) : suppliers.length === 0 ? (
          <div className={card}>
            <p className="text-sm text-text-secondary">
              Add a supplier first (Parts &amp; Inventory → Suppliers), then come back to import its price list.
            </p>
          </div>
        ) : (
          <>
            <div className={card}>
              <label htmlFor="sc-vendor" className="mb-1.5 block text-sm font-medium text-text-primary">Supplier</label>
              <select id="sc-vendor" className={select} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            {vendorId && <ImportCard vendorId={vendorId} onImported={reloadRuns} toast={toast} />}
            {vendorId && <FeedKeysCard key={vendorId} vendorId={vendorId} toast={toast} />}
            <div className={card}>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Import history</h2>
              {runs.length === 0 ? (
                <p className="text-sm text-text-secondary">No imports yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <caption className="sr-only">Recent supplier price imports</caption>
                    <thead className="text-xs text-text-secondary">
                      <tr>
                        <th scope="col" className="py-1 pr-3 font-medium">When</th>
                        <th scope="col" className="py-1 pr-3 font-medium">Supplier</th>
                        <th scope="col" className="py-1 pr-3 font-medium">Source</th>
                        <th scope="col" className="py-1 pr-3 font-medium">New</th>
                        <th scope="col" className="py-1 pr-3 font-medium">Updated</th>
                        <th scope="col" className="py-1 pr-3 font-medium">Price ▲/▼</th>
                        <th scope="col" className="py-1 font-medium">Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.id} className="border-t border-border text-text-primary">
                          <td className="py-2 pr-3">{new Date(r.created_at).toLocaleString()}</td>
                          <td className="py-2 pr-3">{vendorName(r.vendor_id)}</td>
                          <td className="py-2 pr-3">{r.source === 'api' ? 'API' : r.file_name ?? 'CSV'}</td>
                          <td className="py-2 pr-3">{r.inserted_count}</td>
                          <td className="py-2 pr-3">{r.updated_count}</td>
                          <td className="py-2 pr-3">{r.price_up_count} / {r.price_down_count}</td>
                          <td className={`py-2 ${r.error_count ? 'text-danger' : ''}`}>{r.error_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

type ToastFn = ReturnType<typeof useToast>['toast'];

function ImportCard({ vendorId, onImported, toast }: { vendorId: string; onImported: () => void; toast: ToastFn }) {
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [priceOnly, setPriceOnly] = useState(false);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'check' | 'import'>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);

  // Switching supplier invalidates any prepared file.
  useEffect(() => {
    setTable(null);
    setMapping({});
    setPreview(null);
    setDone(null);
    setFileError(null);
  }, [vendorId]);

  const built = useMemo(() => (table ? buildImportItems(table.rows, mapping, { priceOnly }) : null), [table, mapping, priceOnly]);
  const missingRequired = IMPORT_FIELDS.filter((f) => f.required && mapping[f.key] === undefined);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setReading(true);
    setFileError(null);
    setPreview(null);
    setDone(null);
    try {
      const t = await readImportFile(file);
      setTable(t);
      setMapping(autoMapColumns(t.headers));
    } catch (e) {
      setTable(null);
      setFileError(e instanceof Error ? e.message : 'Could not read this file.');
    } finally {
      setReading(false);
    }
  }

  async function submit(dryRun: boolean) {
    if (!table || !built || built.items.length === 0 || missingRequired.length > 0) return;
    setBusy(dryRun ? 'check' : 'import');
    setProgress([0, built.items.length]);
    try {
      const res = await importSupplierPrices({
        vendorId, items: built.items, fileName: table.fileName, dryRun,
        onProgress: (d, t) => setProgress([d, t]),
      });
      if (dryRun) {
        setPreview(res);
      } else {
        setDone(res);
        setPreview(null);
        setTable(null);
        onImported();
        toast(`Import finished: ${res.inserted} new, ${res.updated} updated`, res.errors ? 'info' : 'success');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Import failed.', 'error');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  return (
    <div className={card}>
      <h2 className="mb-1 text-sm font-semibold text-text-primary">Import a price list</h2>
      <p className="mb-3 text-xs text-text-secondary">CSV or Excel (.xlsx), up to 5,000 rows per batch. Existing SKUs are updated; nothing is deleted.</p>

      <label className="focus-within:ring-2 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40">
        {reading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
        Choose file
        <input type="file" accept=".csv,.tsv,.xlsx,text/csv" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      {fileError && <p role="alert" className="mt-2 text-sm text-danger">{fileError}</p>}

      {table && built && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-text-primary">
            <strong>{table.fileName}</strong> · {table.rows.length} rows
          </p>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">Match your columns</legend>
            {IMPORT_FIELDS.map((f) => (
              <div key={f.key}>
                <label htmlFor={`map-${f.key}`} className="mb-1 block text-xs font-medium text-text-secondary">
                  {f.label}{f.required ? ' *' : ''}
                </label>
                <select
                  id={`map-${f.key}`}
                  className={select}
                  value={mapping[f.key] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMapping((m) => {
                      const next = { ...m } as ColumnMapping;
                      if (v === '') delete next[f.key as ImportFieldKey];
                      else next[f.key as ImportFieldKey] = Number(v);
                      return next;
                    });
                    setPreview(null);
                  }}
                >
                  <option value="">— not in file —</option>
                  {table.headers.map((h, i) => (
                    <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                  ))}
                </select>
              </div>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={priceOnly} onChange={(e) => { setPriceOnly(e.target.checked); setPreview(null); }} />
            Only update prices (ignore every other column)
          </label>

          {missingRequired.length > 0 && (
            <p role="alert" className="text-sm text-danger">Match the required column{missingRequired.length > 1 ? 's' : ''}: {missingRequired.map((f) => f.label).join(', ')}.</p>
          )}
          {built.issues.length > 0 && (
            <details className="text-sm text-warning-500">
              <summary className="cursor-pointer">{built.issues.length} row{built.issues.length === 1 ? '' : 's'} will be skipped</summary>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-text-secondary">
                {built.issues.slice(0, 50).map((i) => <li key={i.row}>Row {i.row}: {i.message}</li>)}
              </ul>
            </details>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy !== null || missingRequired.length > 0 || built.items.length === 0} onClick={() => void submit(true)}>
              {busy === 'check' ? 'Checking…' : 'Check without saving'}
            </Button>
            <Button disabled={busy !== null || missingRequired.length > 0 || built.items.length === 0} onClick={() => void submit(false)}>
              {busy === 'import' ? 'Importing…' : `Import ${built.items.length} item${built.items.length === 1 ? '' : 's'}`}
            </Button>
          </div>
          {progress && <p role="status" className="text-xs text-text-secondary">{progress[0]} / {progress[1]} rows processed…</p>}
          {preview && <ResultSummary result={preview} title="Check result — nothing was saved" />}
        </div>
      )}
      {done && <div className="mt-4"><ResultSummary result={done} title="Import finished" /></div>}
    </div>
  );
}

function ResultSummary({ result, title }: { result: ImportResult; title: string }) {
  return (
    <div role="status" className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
      <p className="font-semibold text-text-primary">{title}</p>
      <p className="mt-1 text-text-secondary">
        {result.inserted} new · {result.updated} updated · {result.unchanged} unchanged · {result.price_up} price increases · {result.price_down} decreases ·{' '}
        <span className={result.errors ? 'text-danger' : ''}>{result.errors} errors</span>
      </p>
      {result.error_rows.length > 0 && (
        <ul className="mt-2 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-text-secondary">
          {result.error_rows.slice(0, 50).map((e, i) => <li key={i}>Row {e.row}{e.sku ? ` (${e.sku})` : ''}: {e.message}</li>)}
        </ul>
      )}
    </div>
  );
}

function FeedKeysCard({ vendorId, toast }: { vendorId: string; toast: ToastFn }) {
  const [keys, setKeys] = useState<FeedKey[] | null>(null);
  const [error, setError] = useState(false);
  const [name, setName] = useState('');
  const [shipments, setShipments] = useState(false);
  const [creating, setCreating] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);

  const load = useCallback(() => {
    listFeedKeys(vendorId).then((k) => { setKeys(k); setError(false); }).catch(() => setError(true));
  }, [vendorId]);
  useEffect(load, [load]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      setRaw(await createFeedKey(vendorId, name.trim(), shipments ? ['prices:write', 'shipments:write'] : ['prices:write']));
      setName('');
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the key.', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('Copy failed — select the text and copy it manually', 'error');
    }
  }

  const active = (keys ?? []).filter((k) => !k.revoked_at);
  return (
    <div className={card}>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary"><KeyRound size={15} aria-hidden="true" /> Supplier API access</h2>
      <p className="mb-3 text-xs text-text-secondary">
        Give this supplier (or your own integration) a key that can only update <em>their</em> prices{shipments ? ' and order delivery status' : ''}. Keys are shown once.
      </p>

      {raw && (
        <div role="status" className="mb-4 rounded-xl border border-accent/40 bg-bg-primary p-3">
          <p className="text-sm font-semibold text-text-primary">Copy your key now — you won’t see it again</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-bg-secondary px-2 py-1.5 text-xs text-text-primary">{raw}</code>
            <Button variant="secondary" size="sm" onClick={() => void copy(raw)} aria-label="Copy API key"><Copy size={14} aria-hidden="true" /></Button>
          </div>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-secondary p-2 text-xs text-text-secondary">{`curl -X POST ${FEED_URL} \\
  -H "Authorization: Bearer ${raw.slice(0, 13)}…" \\
  -H "Content-Type: application/json" \\
  -d '{"items":[{"sku":"CAP-45","name":"45/5 capacitor","unit_cost":"12.50","stock_status":"in_stock"}]}'`}</pre>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setRaw(null)}>I’ve saved it</Button>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-danger">Could not load keys.</p>
      ) : (
        <ul className="mb-4 space-y-2">
          {active.length === 0 && keys !== null && <li className="text-sm text-text-secondary">No active keys.</li>}
          {active.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3 text-sm">
              <div>
                <p className="font-medium text-text-primary">{k.name} <span className="font-mono text-xs text-text-secondary">{k.key_prefix}…</span></p>
                <p className="text-xs text-text-secondary">
                  {k.scopes.includes('shipments:write') ? 'Prices + shipments' : 'Prices'} · {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString()}` : 'never used'}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void revokeFeedKey(k.id).then(load).catch(() => toast('Could not revoke the key.', 'error'))}>Revoke</Button>
            </li>
          ))}
        </ul>
      )}

      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="min-w-[180px] flex-1">
          <label htmlFor="fk-name" className="mb-1 block text-xs font-medium text-text-secondary">Key name</label>
          <input id="fk-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme nightly feed" className={select} />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-text-primary">
          <input type="checkbox" checked={shipments} onChange={(e) => setShipments(e.target.checked)} /> Allow delivery updates
        </label>
        <Button type="submit" disabled={creating || !name.trim()}>{creating ? 'Creating…' : 'Create key'}</Button>
      </form>
    </div>
  );
}
