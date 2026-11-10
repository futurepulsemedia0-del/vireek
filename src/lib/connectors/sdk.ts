// Connector SDK — the contract every Vireek integration connector implements.
// Pure TypeScript: no network, no React, no Supabase. A connector receives rows the caller has
// ALREADY fetched with tenant scoping (API key / RLS) and returns a result; it never reads the
// database or holds credentials itself. Credentialed third parties go behind an adapter that the
// host injects and that always has a mock implementation.

export type ConnectorDirection = 'export' | 'import' | 'two_way';

export interface ConnectorManifest {
  /** Stable id, lowercase kebab-case, e.g. "accounting-csv". */
  id: string;
  name: string;
  /** Semver, e.g. "1.0.0". */
  version: string;
  direction: ConnectorDirection;
  /** API scopes the host must hold on the key before running this connector, e.g. "jobs:read". */
  requiredScopes: readonly string[];
  /** Resource fields the connector may read. Anything else is stripped before run(). */
  readableFields: Readonly<Record<string, readonly string[]>>;
}

export interface ConnectorContext {
  /** Account owner the data belongs to. Informational: connectors never query by it. */
  accountOwnerId: string;
  now: Date;
}

export interface SkippedRecord {
  id: string;
  reason: string;
}

export interface ConnectorResult<TOutput> {
  output: TOutput;
  processed: number;
  skipped: SkippedRecord[];
}

export interface Connector<TInput, TOutput> {
  readonly manifest: ConnectorManifest;
  run(input: TInput, ctx: ConnectorContext): ConnectorResult<TOutput>;
}

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SCOPE_RE = /^[a-z_]+:(read|write)$/;

export type ConnectorErrorCode = 'invalid_manifest' | 'duplicate_connector' | 'unknown_connector' | 'missing_scope';

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;

  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

export function validateManifest(m: ConnectorManifest): string[] {
  const problems: string[] = [];
  if (!ID_RE.test(m.id) || m.id.length > 48) problems.push('id must be lowercase kebab-case, max 48 chars');
  if (!m.name.trim() || m.name.length > 80) problems.push('name must be 1-80 chars');
  if (!SEMVER_RE.test(m.version)) problems.push('version must be semver (x.y.z)');
  if (!['export', 'import', 'two_way'].includes(m.direction)) problems.push('direction is invalid');
  for (const s of m.requiredScopes) if (!SCOPE_RE.test(s)) problems.push(`scope "${s}" is malformed`);
  if (m.direction === 'export' && !m.requiredScopes.some((s) => s.endsWith(':read'))) {
    problems.push('export connectors must declare at least one :read scope');
  }
  return problems;
}

/** Validates the manifest and returns the connector unchanged. Throws ConnectorError on a bad manifest. */
export function defineConnector<TInput, TOutput>(c: Connector<TInput, TOutput>): Connector<TInput, TOutput> {
  const problems = validateManifest(c.manifest);
  if (problems.length) throw new ConnectorError('invalid_manifest', `${c.manifest.id}: ${problems.join('; ')}`);
  return c;
}

/** Keeps only the allowlisted fields of a row — the field-level PII guard applied before run(). */
export function pickFields(row: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
  return out;
}

export class ConnectorRegistry {
  private readonly items = new Map<string, Connector<never, unknown>>();

  register<I, O>(c: Connector<I, O>): void {
    defineConnector(c);
    if (this.items.has(c.manifest.id)) throw new ConnectorError('duplicate_connector', `Connector "${c.manifest.id}" is already registered`);
    this.items.set(c.manifest.id, c as unknown as Connector<never, unknown>);
  }

  get(id: string): Connector<never, unknown> {
    const c = this.items.get(id);
    if (!c) throw new ConnectorError('unknown_connector', `Unknown connector "${id}"`);
    return c;
  }

  list(): ConnectorManifest[] {
    return [...this.items.values()].map((c) => c.manifest).sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** Host-side guard: refuse to run a connector when the key's scopes don't cover its manifest. */
export function assertScopes(manifest: ConnectorManifest, granted: readonly string[]): void {
  const missing = manifest.requiredScopes.filter((s) => !granted.includes(s));
  if (missing.length) throw new ConnectorError('missing_scope', `Missing scope(s): ${missing.join(', ')}`);
}
