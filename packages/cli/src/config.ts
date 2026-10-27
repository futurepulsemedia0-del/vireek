import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError, EXIT, usageError } from './errors.js';

export interface Profile {
  apiKey: string;
  baseUrl: string;
}

export interface ConfigFile {
  version: 1;
  defaultProfile: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedCredentials extends Profile {
  profile: string;
  source: 'flags' | 'env' | 'profile';
}

/** Keys are `vrk_live_` + 48 hex chars today; stay lenient for future key kinds. */
export const KEY_PATTERN = /^vrk_[a-z]+_[A-Za-z0-9]{16,}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export function configFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (env.VIREEK_CONFIG_DIR) return path.join(env.VIREEK_CONFIG_DIR, 'config.json');
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'vireek', 'config.json');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'vireek', 'config.json');
}

export function emptyConfig(): ConfigFile {
  return { version: 1, defaultProfile: 'default', profiles: {} };
}

export async function readConfig(file: string): Promise<ConfigFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw new CliError(`Cannot read config file ${file}.`, { cause: error });
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConfigFile>;
    const profiles: Record<string, Profile> = {};
    for (const [name, value] of Object.entries(parsed.profiles ?? {})) {
      if (value && typeof value.apiKey === 'string' && typeof value.baseUrl === 'string') {
        profiles[name] = { apiKey: value.apiKey, baseUrl: value.baseUrl };
      }
    }
    return { version: 1, defaultProfile: parsed.defaultProfile || 'default', profiles };
  } catch (error) {
    throw new CliError(`Config file ${file} is not valid JSON.`, {
      hint: `Fix it, or delete it and run "vireek auth login" again.`,
      cause: error,
    });
  }
}

/** Atomic write (tmp + rename) with owner-only permissions: the file holds an API key. */
export async function writeConfig(file: string, config: ConfigFile): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined); // no-op on Windows
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw new CliError(`Cannot write config file ${file}.`, { cause: error });
  }
}

export function validateProfileName(name: string): string {
  if (!PROFILE_PATTERN.test(name)) {
    throw usageError(`Invalid profile name "${name}".`, 'Use letters, digits, "-", "_" or "." (max 40 characters).');
  }
  return name;
}

export function validateApiKey(key: string): string {
  const trimmed = key.trim();
  if (!KEY_PATTERN.test(trimmed)) {
    throw usageError(
      'That does not look like a Vireek API key.',
      'Keys start with "vrk_live_". Create one under Dashboard → API Keys.',
    );
  }
  return trimmed;
}

/** Accepts https URLs (and http only for localhost); returns it without a trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw usageError(`Invalid API base URL "${raw}".`, 'Example: https://<project-ref>.supabase.co/functions/v1/api-v1');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw usageError('The API base URL must use https (http is only allowed for localhost).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw usageError('The API base URL must not contain credentials, a query string or a fragment.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function maskKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 14)}…` : '…';
}

export interface ResolveInput {
  flags: { profile?: string; apiKey?: string; baseUrl?: string };
  env: NodeJS.ProcessEnv;
  config: ConfigFile;
}

/** Precedence: command-line flags > environment variables > saved profile. */
export function resolveCredentials({ flags, env, config }: ResolveInput): ResolvedCredentials {
  const profile = validateProfileName(flags.profile || env.VIREEK_PROFILE || config.defaultProfile || 'default');
  const saved = config.profiles[profile];

  const apiKey = flags.apiKey ?? env.VIREEK_API_KEY ?? saved?.apiKey;
  const baseUrl = flags.baseUrl ?? env.VIREEK_API_URL ?? saved?.baseUrl;

  if (!apiKey) {
    throw new CliError('No API key configured.', {
      exitCode: EXIT.AUTH,
      hint: 'Run "vireek auth login" or set VIREEK_API_KEY.',
    });
  }
  if (!baseUrl) {
    throw new CliError('No API base URL configured.', {
      exitCode: EXIT.AUTH,
      hint: 'Run "vireek auth login" or set VIREEK_API_URL (…/functions/v1/api-v1).',
    });
  }
  const source = flags.apiKey || flags.baseUrl ? 'flags' : env.VIREEK_API_KEY || env.VIREEK_API_URL ? 'env' : 'profile';
  return { profile, apiKey: validateApiKey(apiKey), baseUrl: normalizeBaseUrl(baseUrl), source };
}
