import { createWriteStream, type WriteStream } from 'node:fs';
import { access, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { csvRecord } from './csv.js';
import { CliError, EXIT } from './errors.js';
import { paginate, type ApiClient, type PaginateOptions } from './http.js';

export const EXPORT_FORMATS = ['csv', 'json', 'ndjson'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface Sink {
  write(chunk: string): Promise<void>;
  /** Flush and publish the output (renames the temp file into place). */
  commit(): Promise<void>;
  /** Discard partial output. Safe to call more than once. */
  abort(): Promise<void>;
}

export function inferFormat(outPath: string | undefined): ExportFormat {
  const ext = outPath?.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (ext === 'csv') return 'csv';
  if (ext === 'json') return 'json';
  return 'ndjson';
}

async function writeChunk(stream: { write(chunk: string): unknown }, chunk: string): Promise<void> {
  // Only an explicit `false` signals backpressure (test doubles return undefined).
  if (stream.write(chunk) === false) await once(stream as Writable, 'drain');
}

export function createStreamSink(stream: { write(chunk: string): unknown }): Sink {
  return { write: (chunk) => writeChunk(stream, chunk), commit: async () => undefined, abort: async () => undefined };
}

/**
 * Writes to `<target>.partial` and renames on commit, so an interrupted or
 * failed export never leaves a truncated file at the final path.
 */
export async function createFileSink(target: string, force: boolean): Promise<Sink> {
  if (!force) {
    const exists = await access(target).then(() => true, () => false);
    if (exists) {
      throw new CliError(`${target} already exists.`, { hint: 'Pass --force to overwrite it.' });
    }
  }
  const partial = `${target}.partial`;
  const stream: WriteStream = createWriteStream(partial, { encoding: 'utf8' });
  let failure: Error | undefined;
  stream.on('error', (error) => {
    failure = error;
  });
  await once(stream, 'open');

  const check = () => {
    if (failure) throw new CliError(`Cannot write ${partial}: ${failure.message}`, { cause: failure });
  };
  return {
    async write(chunk) {
      check();
      await writeChunk(stream, chunk);
    },
    async commit() {
      check();
      stream.end();
      await once(stream, 'close');
      check();
      await rename(partial, target);
    },
    async abort() {
      stream.destroy();
      await rm(partial, { force: true });
    },
  };
}

export interface ExportOptions extends PaginateOptions {
  format: ExportFormat;
  csvGuard?: boolean;
  bom?: boolean;
  signal?: AbortSignal;
  onProgress?: (rows: number) => void;
}

export interface ExportResult {
  rows: number;
  /** CSV only: keys that appeared after the header was fixed and were not written. */
  ignoredColumns: string[];
}

export async function runExport(
  client: ApiClient,
  resource: string,
  sink: Sink,
  options: ExportOptions,
): Promise<ExportResult> {
  const { format, csvGuard = true, bom = false, signal, onProgress, ...pageOptions } = options;
  let rows = 0;
  let columns: string[] | undefined;
  const ignored = new Set<string>();

  for await (const page of paginate(client, resource, pageOptions)) {
    if (signal?.aborted) throw new CliError('Interrupted.', { exitCode: EXIT.INTERRUPTED });
    let chunk = '';
    for (const row of page) {
      if (format === 'ndjson') {
        chunk += `${JSON.stringify(row)}\n`;
      } else if (format === 'json') {
        chunk += `${rows === 0 && chunk === '' ? '[\n' : ',\n'}${JSON.stringify(row)}`;
      } else {
        if (!columns) {
          columns = Object.keys(row);
          chunk += (bom ? '\uFEFF' : '') + csvRecord(columns, false);
        }
        for (const key of Object.keys(row)) if (!columns.includes(key)) ignored.add(key);
        chunk += csvRecord(columns.map((column) => row[column]), csvGuard);
      }
      rows += 1;
    }
    await sink.write(chunk);
    onProgress?.(rows);
  }

  if (format === 'json') await sink.write(rows === 0 ? '[]\n' : '\n]\n');
  return { rows, ignoredColumns: [...ignored] };
}
