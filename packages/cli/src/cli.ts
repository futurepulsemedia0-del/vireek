import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import readline from 'node:readline';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  maskKey,
  normalizeBaseUrl,
  readConfig,
  resolveCredentials,
  validateApiKey,
  validateProfileName,
  writeConfig,
  configFilePath,
} from './config.js';
import { ApiError, CliError, EXIT, usageError } from './errors.js';
import {
  EXPORT_FORMATS,
  createFileSink,
  createStreamSink,
  inferFormat,
  runExport,
  type ExportFormat,
} from './export.js';
import { renderTable } from './format.js';
import { HELP } from './help.js';
import { ApiClient, type Page } from './http.js';
import { DEFAULT_COLUMNS, RESOURCES, isResource, type Resource } from './resources.js';
import { parseTimestamp } from './time.js';
import {
  KNOWN_EVENTS,
  createWebhookListener,
  isKnownEvent,
  requireSecret,
  sampleData,
  sendTestDelivery,
  signPayload,
  SIGNATURE_HEADER,
  validateEventName,
  validateTargetUrl,
  verifySignature,
  type ReceivedDelivery,
} from './webhooks.js';

type Input = AsyncIterable<Buffer | string> & { isTTY?: boolean };
type Output = { write(chunk: string): unknown; isTTY?: boolean };

export interface Io {
  stdout: Output;
  stderr: Output;
  stdin: Input;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  configFile: string;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
export const VERSION = pkg.version;

const GLOBAL_OPTIONS = {
  profile: { type: 'string' },
  'base-url': { type: 'string' },
  'api-key': { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
} as const;

type OptionSpec = NonNullable<ParseArgsConfig['options']>;

function parse<T extends OptionSpec>(args: string[], extra: T) {
  try {
    return parseArgs({ args, options: { ...GLOBAL_OPTIONS, ...extra }, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError((error as Error).message.split(/\.\s/)[0] as string, 'Run "vireek help" for usage.');
  }
}

const out = (io: Io, text: string) => void io.stdout.write(`${text}\n`);
const info = (io: Io, quiet: boolean | undefined, text: string) => {
  if (!quiet) io.stderr.write(`${text}\n`);
};

export function createIo(overrides: Partial<Io> = {}): Io {
  const env = overrides.env ?? process.env;
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env,
    fetchImpl: fetch,
    configFile: configFilePath(env),
    ...overrides,
  };
}

/** Runs the CLI and returns the process exit code. Never throws. */
export async function main(argv: string[], overrides: Partial<Io> = {}): Promise<number> {
  const io = createIo(overrides);
  try {
    await dispatch(argv, io);
    return EXIT.OK;
  } catch (error) {
    return reportError(error, io);
  }
}

function reportError(error: unknown, io: Io): number {
  const debug = Boolean(io.env.VIREEK_DEBUG);
  if (error instanceof CliError) {
    io.stderr.write(`error: ${error.message}\n`);
    if (error.hint) io.stderr.write(`hint: ${error.hint}\n`);
    if (debug && error.cause) io.stderr.write(`cause: ${String(error.cause)}\n`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr.write(`error: unexpected failure: ${message}\n`);
  if (debug && error instanceof Error && error.stack) io.stderr.write(`${error.stack}\n`);
  return EXIT.ERROR;
}

async function dispatch(argv: string[], io: Io): Promise<void> {
  const [command, ...rest] = argv;
  if (!command) return out(io, HELP.main as string);
  if (command === '--version' || command === '-v' || command === 'version') return out(io, VERSION);
  if (command === 'help' || command === '--help' || command === '-h') return help(rest[0], io);

  const group = isResource(command) ? 'resource' : command;
  if (rest.includes('--help') || rest.includes('-h')) return help(group, io);

  switch (command) {
    case 'auth':
      return authCommand(rest, io);
    case 'calls':
    case 'leads':
    case 'jobs':
      return resourceCommand(command, rest, io);
    case 'api':
      return apiCommand(rest, io);
    case 'export':
      return exportCommand(rest, io);
    case 'webhooks':
      return webhooksCommand(rest, io);
    default:
      throw usageError(`Unknown command "${command}".`, 'Run "vireek help" to see available commands.');
  }
}

function help(topic: string | undefined, io: Io): void {
  const key = topic && isResource(topic) ? 'resource' : topic;
  out(io, (key && HELP[key]) || (HELP.main as string));
}

/* ------------------------------ shared helpers ----------------------------- */

async function readAll(stream: Input): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

function promptLine(io: Io, question: string): Promise<string> {
  if (!io.stdin.isTTY) throw usageError(`Cannot prompt for "${question.trim()}" without a terminal.`, 'Pass it as a flag or environment variable.');
  const rl = readline.createInterface({ input: io.stdin as NodeJS.ReadStream, output: io.stderr as NodeJS.WriteStream });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer.trim()))));
}

/** Reads a secret from the TTY without echoing it. */
function promptSecret(io: Io, question: string): Promise<string> {
  if (!io.stdin.isTTY) throw usageError('Cannot prompt for the API key without a terminal.', 'Use --with-key (stdin) or VIREEK_API_KEY.');
  const stdin = io.stdin as NodeJS.ReadStream;
  io.stderr.write(question);
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (fn: () => void) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      io.stderr.write('\n');
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish(() => resolve(buffer.trim()));
        if (char === '\u0003') return finish(() => reject(new CliError('Cancelled.', { exitCode: EXIT.INTERRUPTED })));
        if (char === '\u007f' || char === '\b') buffer = buffer.slice(0, -1);
        else buffer += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

type CommonValues = { profile?: string; 'base-url'?: string; 'api-key'?: string; quiet?: boolean };

async function getClient(values: CommonValues, io: Io): Promise<ApiClient> {
  const config = await readConfig(io.configFile);
  const credentials = resolveCredentials({
    flags: { profile: values.profile, apiKey: values['api-key'], baseUrl: values['base-url'] },
    env: io.env,
    config,
  });
  return new ApiClient({
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey,
    userAgent: `vireek-cli/${VERSION} node/${process.version}`,
    fetchImpl: io.fetchImpl,
    signal: io.signal,
    sleep: io.sleep,
    onRetry: ({ attempt, delayMs, reason }) =>
      info(io, values.quiet, `  ${reason}; retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt})…`),
  });
}

function intOption(label: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usageError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/* ----------------------------------- auth ---------------------------------- */

async function authCommand(args: string[], io: Io): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'login') return authLogin(rest, io);
  if (sub === 'status') return authStatus(rest, io);
  if (sub === 'logout') return authLogout(rest, io);
  throw usageError('Usage: vireek auth <login|status|logout>');
}

/** Any authenticated answer proves the key works; 403 only means this key lacks the calls scope. */
async function verifyKey(client: ApiClient): Promise<{ scopeNote?: string }> {
  try {
    await client.get('/calls', { limit: 1 });
    return {};
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return { scopeNote: error.message };
    throw error;
  }
}

async function authLogin(args: string[], io: Io): Promise<void> {
  const { values } = parse(args, {
    'with-key': { type: 'boolean' },
    'no-verify': { type: 'boolean' },
    default: { type: 'boolean' },
  });
  const config = await readConfig(io.configFile);
  const profile = validateProfileName(values.profile ?? io.env.VIREEK_PROFILE ?? 'default');

  const rawUrl =
    values['base-url'] ??
    io.env.VIREEK_API_URL ??
    config.profiles[profile]?.baseUrl ??
    (await promptLine(io, 'API base URL (…/functions/v1/api-v1): '));
  const rawKey =
    values['api-key'] ??
    (values['with-key'] ? ((await readAll(io.stdin)).toString('utf8').split(/\r?\n/)[0] as string) : io.env.VIREEK_API_KEY) ??
    (await promptSecret(io, 'API key (input hidden): '));

  const baseUrl = normalizeBaseUrl(rawUrl);
  const apiKey = validateApiKey(rawKey);

  let scopeNote: string | undefined;
  if (!values['no-verify']) {
    const client = new ApiClient({ baseUrl, apiKey, fetchImpl: io.fetchImpl, signal: io.signal, sleep: io.sleep, userAgent: `vireek-cli/${VERSION}` });
    ({ scopeNote } = await verifyKey(client));
  }

  const isFirst = Object.keys(config.profiles).length === 0;
  config.profiles[profile] = { apiKey, baseUrl };
  if (isFirst || values.default) config.defaultProfile = profile;
  await writeConfig(io.configFile, config);

  info(io, values.quiet, `Logged in to profile "${profile}" (${maskKey(apiKey)}).`);
  if (scopeNote) info(io, values.quiet, `note: key is valid, but ${scopeNote.charAt(0).toLowerCase()}${scopeNote.slice(1)}`);
}

async function authStatus(args: string[], io: Io): Promise<void> {
  const { values } = parse(args, { verify: { type: 'boolean' } });
  const config = await readConfig(io.configFile);
  const credentials = resolveCredentials({
    flags: { profile: values.profile, apiKey: values['api-key'], baseUrl: values['base-url'] },
    env: io.env,
    config,
  });
  let verified: boolean | undefined;
  if (values.verify) {
    await verifyKey(await getClient(values, io));
    verified = true;
  }
  if (values.json) {
    return out(io, JSON.stringify({ profile: credentials.profile, baseUrl: credentials.baseUrl, key: maskKey(credentials.apiKey), source: credentials.source, verified }, null, 2));
  }
  out(io, `Profile:  ${credentials.profile} (${credentials.source})`);
  out(io, `Base URL: ${credentials.baseUrl}`);
  out(io, `API key:  ${maskKey(credentials.apiKey)}`);
  if (verified) out(io, 'Status:   key accepted by the API');
}

async function authLogout(args: string[], io: Io): Promise<void> {
  const { values } = parse(args, {});
  const config = await readConfig(io.configFile);
  const profile = validateProfileName(values.profile ?? io.env.VIREEK_PROFILE ?? config.defaultProfile);
  if (!config.profiles[profile]) {
    throw new CliError(`No saved credentials for profile "${profile}".`);
  }
  delete config.profiles[profile];
  const remaining = Object.keys(config.profiles);
  if (remaining.length === 0) await rm(io.configFile, { force: true });
  else {
    if (config.defaultProfile === profile) config.defaultProfile = remaining[0] as string;
    await writeConfig(io.configFile, config);
  }
  info(io, values.quiet, `Removed credentials for profile "${profile}".`);
}

/* ------------------------------- resources / api ---------------------------- */

async function resourceCommand(resource: Resource, args: string[], io: Io): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const { values } = parse(rest, { limit: { type: 'string' }, before: { type: 'string' }, columns: { type: 'string' } });
    const limit = intOption('--limit', values.limit, 1, 100) ?? 25;
    const before = values.before ? parseTimestamp('--before', values.before) : undefined;
    const client = await getClient(values, io);
    const page = await client.get<Page>(`/${resource}`, { limit, before });
    if (values.json || !io.stdout.isTTY) return out(io, JSON.stringify(page, null, 2));
    const columns = values.columns ? values.columns.split(',').map((c) => c.trim()).filter(Boolean) : DEFAULT_COLUMNS[resource];
    out(io, renderTable(page.data, columns));
    if (page.has_more && page.next_before) out(io, `\nMore results: --before ${page.next_before}`);
    return;
  }
  if (sub === 'get') {
    const { values, positionals } = parse(rest, {});
    const id = positionals[0];
    if (!id) throw usageError(`Usage: vireek ${resource} get <id>`);
    const client = await getClient(values, io);
    return out(io, JSON.stringify(await client.get(`/${resource}/${encodeURIComponent(id)}`), null, 2));
  }
  throw usageError(`Usage: vireek ${resource} <list|get>`);
}

async function apiCommand(args: string[], io: Io): Promise<void> {
  const { values, positionals } = parse(args, { param: { type: 'string', multiple: true } });
  const target = positionals[0];
  if (!target) throw usageError('Usage: vireek api <path> [--param key=value ...]');
  const query: Record<string, string> = {};
  for (const pair of values.param ?? []) {
    const index = pair.indexOf('=');
    if (index < 1) throw usageError(`Invalid --param "${pair}".`, 'Use key=value.');
    query[pair.slice(0, index)] = pair.slice(index + 1);
  }
  const client = await getClient(values, io);
  out(io, JSON.stringify(await client.get(target, query), null, 2));
}

/* ----------------------------------- export -------------------------------- */

async function exportCommand(args: string[], io: Io): Promise<void> {
  const { values, positionals } = parse(args, {
    format: { type: 'string', short: 'f' },
    out: { type: 'string', short: 'o' },
    force: { type: 'boolean' },
    since: { type: 'string' },
    until: { type: 'string' },
    max: { type: 'string' },
    'page-size': { type: 'string' },
    'no-csv-guard': { type: 'boolean' },
    bom: { type: 'boolean' },
  });
  const resource = positionals[0];
  if (!resource || !isResource(resource)) {
    throw usageError(`Usage: vireek export <${RESOURCES.join('|')}> [options]`);
  }
  const target = values.out && values.out !== '-' ? values.out : undefined;
  const format = (values.format ?? inferFormat(target)) as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) throw usageError(`Unknown format "${values.format}".`, `Use one of: ${EXPORT_FORMATS.join(', ')}.`);

  const since = values.since ? parseTimestamp('--since', values.since) : undefined;
  const before = values.until ? parseTimestamp('--until', values.until) : undefined;
  const max = intOption('--max', values.max, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = intOption('--page-size', values['page-size'], 1, 100);
  if (since && before && Date.parse(since) >= Date.parse(before)) throw usageError('--since must be earlier than --until.');

  const client = await getClient(values, io);
  const sink = target ? await createFileSink(target, Boolean(values.force)) : createStreamSink(io.stdout);
  const started = Date.now();
  const showProgress = Boolean(io.stderr.isTTY) && !values.quiet;

  try {
    const result = await runExport(client, resource, sink, {
      format,
      since,
      before,
      max,
      pageSize,
      csvGuard: !values['no-csv-guard'],
      bom: values.bom,
      signal: io.signal,
      onProgress: (rows) => showProgress && io.stderr.write(`\rExported ${rows.toLocaleString('en-US')} rows…`),
    });
    await sink.commit();
    if (showProgress) io.stderr.write('\r\u001b[K');
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    info(io, values.quiet, `Exported ${result.rows.toLocaleString('en-US')} ${resource} ${target ? `→ ${target} ` : ''}(${seconds}s).`);
    if (result.ignoredColumns.length > 0) {
      info(io, values.quiet, `warning: columns not in the first page were skipped: ${result.ignoredColumns.join(', ')}`);
    }
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

/* ---------------------------------- webhooks ------------------------------- */

async function webhooksCommand(args: string[], io: Io): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'events':
      return out(io, KNOWN_EVENTS.join('\n'));
    case 'trigger':
      return webhookTrigger(rest, io);
    case 'listen':
      return webhookListen(rest, io);
    case 'verify':
    case 'sign':
      return webhookVerifyOrSign(sub, rest, io);
    default:
      throw usageError('Usage: vireek webhooks <events|trigger|listen|verify|sign>');
  }
}

const SECRET_OPTION = { secret: { type: 'string' } } as const;
const secretFrom = (flag: string | undefined, io: Io) => requireSecret(flag ?? io.env.VIREEK_WEBHOOK_SECRET);

async function readJsonInput(source: string, io: Io): Promise<unknown> {
  const raw = source === '-' ? await readAll(io.stdin) : await readFile(source).catch((error: unknown) => {
    throw new CliError(`Cannot read ${source}.`, { cause: error });
  });
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw usageError(`${source === '-' ? 'stdin' : source} is not valid JSON.`, (error as Error).message);
  }
}

async function webhookTrigger(args: string[], io: Io): Promise<void> {
  const { values, positionals } = parse(args, {
    ...SECRET_OPTION,
    url: { type: 'string' },
    data: { type: 'string' },
    'allow-insecure': { type: 'boolean' },
  });
  const event = validateEventName(positionals[0] ?? '');
  if (!values.url) throw usageError('Missing --url.', 'Example: --url https://example.com/hooks/vireek');
  const url = validateTargetUrl(values.url, values['allow-insecure']);
  const secret = secretFrom(values.secret, io);

  let data: unknown;
  if (values.data) data = await readJsonInput(values.data, io);
  else if (isKnownEvent(event)) {
    data = sampleData(event);
    info(io, values.quiet || values.json, 'note: sending an illustrative sample record; use --data to send your own.');
  } else throw usageError(`"${event}" has no built-in sample.`, 'Provide the record with --data <file|->.');

  const result = await sendTestDelivery({ url, secret, event, data, fetchImpl: io.fetchImpl, signal: io.signal });
  if (values.json) out(io, JSON.stringify(result, null, 2));
  else {
    out(io, `→ POST ${result.url}`);
    out(io, `  event=${result.event} delivery=${result.deliveryId}`);
    out(io, `  ${SIGNATURE_HEADER}: ${result.signature}`);
    if (result.error) out(io, `← failed after ${result.latencyMs} ms: ${result.error}`);
    else out(io, `← ${result.status} in ${result.latencyMs} ms${result.responseSnippet ? `\n  ${result.responseSnippet}` : ''}`);
  }
  if (!result.ok) throw new CliError('Delivery was not acknowledged with a 2xx response.', { hint: 'Production retries once on network errors and 5xx; 4xx is final.' });
}

async function webhookListen(args: string[], io: Io): Promise<void> {
  const { values } = parse(args, {
    ...SECRET_OPTION,
    port: { type: 'string' },
    host: { type: 'string' },
    'show-body': { type: 'boolean' },
  });
  const port = intOption('--port', values.port, 0, 65_535) ?? 4242;
  const host = values.host ?? '127.0.0.1';
  const secret = values.secret ?? io.env.VIREEK_WEBHOOK_SECRET;

  const server = createWebhookListener({
    secret,
    onDelivery: (d: ReceivedDelivery) => {
      const mark = d.status === 200 ? '✓' : '✗';
      const dup = d.duplicate ? ' DUPLICATE' : '';
      out(io, `${mark} ${d.at.toISOString()} ${d.event ?? '(no event)'} id=${d.deliveryId ?? '-'} signature=${d.signature} ${d.bytes}B → ${d.status}${dup}`);
      if (values['show-body']) out(io, d.body);
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(new CliError(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : `Cannot listen: ${error.message}`, { hint: 'Try --port <other>.' })),
    );
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  info(io, values.quiet, `Listening on http://${host}:${actual}  (Ctrl+C to stop)`);
  if (!secret) info(io, values.quiet, 'warning: no secret set — signatures are NOT verified.');

  await new Promise<void>((resolve) => {
    if (io.signal?.aborted) return resolve();
    io.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  throw new CliError('Stopped.', { exitCode: EXIT.INTERRUPTED });
}

async function webhookVerifyOrSign(kind: 'verify' | 'sign', args: string[], io: Io): Promise<void> {
  const { values } = parse(args, {
    ...SECRET_OPTION,
    signature: { type: 'string' },
    'body-file': { type: 'string' },
    body: { type: 'string' },
  });
  const secret = secretFrom(values.secret, io);
  let body: Buffer;
  if (values['body-file']) {
    body = values['body-file'] === '-' ? await readAll(io.stdin) : await readFile(values['body-file']).catch((error: unknown) => {
      throw new CliError(`Cannot read ${values['body-file']}.`, { cause: error });
    });
  } else if (values.body !== undefined) body = Buffer.from(values.body, 'utf8');
  else throw usageError('Provide the raw request body with --body-file <file|-> or --body <text>.');

  if (kind === 'sign') return out(io, signPayload(secret, body));
  if (!values.signature) throw usageError('Missing --signature.');
  if (!verifySignature(secret, body, values.signature)) {
    throw new CliError('Signature is INVALID.', { hint: 'Verify against the exact raw bytes received, not re-serialized JSON, and use the endpoint\'s own secret.' });
  }
  out(io, 'Signature is valid.');
}
