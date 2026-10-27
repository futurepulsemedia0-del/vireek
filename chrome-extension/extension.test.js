import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG, isConfigured } from './lib/config.js';

const dir = join(process.cwd(), 'chrome-extension');
const read = (p) => readFileSync(join(dir, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const locales = ['en', 'fa', 'es'].map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]);

describe('manifest', () => {
  it('is MV3 with minimal permissions and no remote code', () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'contextMenus', 'storage']);
    expect(manifest.host_permissions).toEqual(['https://*.supabase.co/*']);
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'self'",
    );
    expect(manifest.content_scripts[0].all_frames).toBe(false);
  });
  it('references files that exist', () => {
    const files = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...manifest.content_scripts[0].js,
      ...Object.values(manifest.icons),
      ...manifest.web_accessible_resources.flatMap((r) => r.resources),
    ];
    for (const f of files) expect(existsSync(join(dir, f)), f).toBe(true);
  });
});

describe('locales', () => {
  const keys = (m) => Object.keys(m).sort();
  it('have identical keys and placeholders in every language', () => {
    const [, en] = locales[0];
    for (const [lang, m] of locales) {
      expect(keys(m), lang).toEqual(keys(en));
      for (const k of keys(en))
        expect(Boolean(m[k].placeholders), `${lang}.${k}`).toBe(Boolean(en[k].placeholders));
    }
  });
  it('define every key the code uses', () => {
    const [, en] = locales[0];
    const src = ['popup.js', 'content.js', 'background.js', 'popup.html'].map(read).join('\n');
    const used = new Set([...src.matchAll(/\b(?:t|getMessage)\('([A-Za-z_]+)'/g)].map((m) => m[1]));
    for (const m of src.matchAll(/data-i18n="([A-Za-z_]+)"/g)) used.add(m[1]);
    for (const k of used) expect(en[k], k).toBeDefined();
    for (const c of [
      'dnc_suppressed',
      'quiet_hours',
      'rate_limited',
      'no_agent_phone',
      'mfa_required',
    ])
      expect(en[`err_${c}`], c).toBeDefined();
    for (const s of ['ringing', 'answered', 'completed', 'busy', 'no_answer', 'failed', 'canceled'])
      expect(en[`st_${s}`], s).toBeDefined();
    expect(manifest.name).toBe('__MSG_extName__');
  });
});

describe('popup', () => {
  it('every id used by popup.js exists in popup.html', () => {
    const html = read('popup.html');
    const js = read('popup.js');
    for (const m of js.matchAll(/\$\('([a-z0-9-]+)'\)/g))
      expect(html, m[1]).toContain(`id="${m[1]}"`);
  });
  it('writes text with textContent only (no innerHTML)', () => {
    expect(read('popup.js')).not.toMatch(/innerHTML/);
  });
});

describe('config', () => {
  it('ships unconfigured placeholders and validates real values', () => {
    expect(isConfigured(CONFIG)).toBe(false);
    expect(
      isConfigured({
        SUPABASE_URL: 'https://abcd.supabase.co',
        SUPABASE_ANON_KEY: 'e'.repeat(120),
        APP_URL: 'https://a.com',
      }),
    ).toBe(true);
    expect(
      isConfigured({
        SUPABASE_URL: 'http://abcd.supabase.co',
        SUPABASE_ANON_KEY: 'e'.repeat(120),
        APP_URL: '',
      }),
    ).toBe(false);
  });
});
