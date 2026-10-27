// @vitest-environment node
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configFilePath,
  emptyConfig,
  maskKey,
  normalizeBaseUrl,
  readConfig,
  resolveCredentials,
  validateApiKey,
  writeConfig,
} from '../src/config.js';
import { BASE, KEY } from './helpers.js';

describe('configFilePath', () => {
  it('honours VIREEK_CONFIG_DIR, XDG and Windows APPDATA', () => {
    expect(configFilePath({ VIREEK_CONFIG_DIR: '/x' }, 'linux', '/home/u')).toBe(path.join('/x', 'config.json'));
    expect(configFilePath({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/u')).toBe(path.join('/xdg', 'vireek', 'config.json'));
    expect(configFilePath({}, 'linux', '/home/u')).toBe(path.join('/home/u', '.config', 'vireek', 'config.json'));
    expect(configFilePath({ APPDATA: '/app' }, 'win32', '/home/u')).toBe(path.join('/app', 'vireek', 'config.json'));
  });
});

describe('validation', () => {
  it('accepts vrk_ keys and rejects everything else', () => {
    expect(validateApiKey(`  ${KEY}\n`)).toBe(KEY);
    expect(() => validateApiKey('sk_live_abc')).toThrow(/does not look like/);
    expect(() => validateApiKey('vrk_live_short')).toThrow(/does not look like/);
  });

  it('normalises base URLs and blocks insecure or dirty ones', () => {
    expect(normalizeBaseUrl(`${BASE}/`)).toBe(BASE);
    expect(normalizeBaseUrl('http://localhost:54321/functions/v1/api-v1')).toBe('http://localhost:54321/functions/v1/api-v1');
    expect(() => normalizeBaseUrl('http://example.com/api-v1')).toThrow(/https/);
    expect(() => normalizeBaseUrl('https://u:p@example.com/api-v1')).toThrow(/credentials/);
    expect(() => normalizeBaseUrl('https://example.com/api-v1?x=1')).toThrow(/query string/);
    expect(() => normalizeBaseUrl('not a url')).toThrow(/Invalid API base URL/);
  });

  it('masks keys', () => {
    expect(maskKey(KEY)).toBe(`${KEY.slice(0, 14)}…`);
  });
});

describe('resolveCredentials', () => {
  const config = { ...emptyConfig(), profiles: { default: { apiKey: KEY, baseUrl: BASE } } };

  it('uses the saved profile by default', () => {
    expect(resolveCredentials({ flags: {}, env: {}, config })).toMatchObject({ profile: 'default', apiKey: KEY, baseUrl: BASE, source: 'profile' });
  });

  it('prefers env over profile, and flags over env', () => {
    const envKey = `vrk_live_${'f'.repeat(48)}`;
    const flagKey = `vrk_live_${'e'.repeat(48)}`;
    expect(resolveCredentials({ flags: {}, env: { VIREEK_API_KEY: envKey }, config })).toMatchObject({ apiKey: envKey, source: 'env' });
    expect(resolveCredentials({ flags: { apiKey: flagKey }, env: { VIREEK_API_KEY: envKey }, config })).toMatchObject({ apiKey: flagKey, source: 'flags' });
  });

  it('fails with an auth exit code and a hint when nothing is configured', () => {
    expect(() => resolveCredentials({ flags: {}, env: {}, config: emptyConfig() })).toThrow(/No API key configured/);
    try {
      resolveCredentials({ flags: {}, env: {}, config: emptyConfig() });
    } catch (error) {
      expect(error).toMatchObject({ exitCode: 3 });
    }
  });
});

describe('config file', () => {
  it('round-trips with owner-only permissions and tolerates a missing file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vireek-cfg-'));
    const file = path.join(dir, 'nested', 'config.json');
    expect(await readConfig(file)).toEqual(emptyConfig());

    const config = { ...emptyConfig(), profiles: { work: { apiKey: KEY, baseUrl: BASE } }, defaultProfile: 'work' };
    await writeConfig(file, config);
    expect(await readConfig(file)).toEqual(config);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toContain('"work"');
  });

  it('reports corrupt JSON with a recovery hint', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vireek-cfg-'));
    const file = path.join(dir, 'config.json');
    await writeConfig(file, emptyConfig());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{oops');
    await expect(readConfig(file)).rejects.toThrow(/not valid JSON/);
  });
});
