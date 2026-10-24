// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_FEATURE_CATALOG,
  AI_TRANSPARENCY_NOTICE_VERSION,
  JURISDICTION_DISCLAIMER,
  VOICE_EMOTION_ACKNOWLEDGEMENTS,
  buildProvenanceManifest,
  buildVoiceEmotionNotice,
  canEmbedProvenance,
  decideGate,
  embedId3Provenance,
  findCatalogEntry,
  readId3Provenance,
  registryToCsv,
  sha256Hex,
  summarizeRegistry,
  validateCatalogEntry,
  type RegistryRow,
} from '../../supabase/functions/_shared/ai-transparency/engine';

const MIGRATION = resolve(process.cwd(), 'supabase/migrations/20271120000000_ai_transparency_compliance.sql');

describe('catalog', () => {
  it('has unique, valid entries', () => {
    const keys = AI_FEATURE_CATALOG.map((e) => e.feature_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of AI_FEATURE_CATALOG) expect(validateCatalogEntry(e), e.feature_key).toEqual([]);
  });

  it('covers all three transparency categories and both emotion bases', () => {
    const cats = new Set(AI_FEATURE_CATALOG.flatMap((e) => e.categories));
    expect(cats.has('interactive_ai')).toBe(true);
    expect(cats.has('synthetic_audio')).toBe(true);
    expect(cats.has('emotion_recognition')).toBe(true);
    const bases = new Set(AI_FEATURE_CATALOG.map((e) => e.emotion_basis).filter(Boolean));
    expect(bases).toEqual(new Set(['text', 'voice_audio']));
  });

  it('every voice-audio emotion feature is notice-gated and defaults off', () => {
    const voice = AI_FEATURE_CATALOG.filter((e) => e.emotion_basis === 'voice_audio');
    expect(voice.length).toBeGreaterThan(0);
    for (const e of voice) {
      expect(e.requires_notice).toBe(true);
      expect(e.default_enabled).toBe(false);
    }
  });

  it('rejects inconsistent entries', () => {
    const base = findCatalogEntry('ai_voice_emotion_signals')!;
    expect(validateCatalogEntry({ ...base, requires_notice: false })).not.toEqual([]);
    expect(validateCatalogEntry({ ...base, default_enabled: true })).not.toEqual([]);
    expect(validateCatalogEntry({ ...base, emotion_basis: null })).not.toEqual([]);
    expect(validateCatalogEntry({ ...base, categories: [] })).not.toEqual([]);
  });

  it('matches the SQL seed exactly (no drift)', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const rows = [...sql.matchAll(/^\s*\('([a-z0-9_]+)',.*?ARRAY\[([^\]]*)\],\s*(NULL|'[a-z_]+'),\s*'([a-z_]+)',.*?,\s*(true|false),\s*(true|false),\s*(\d+),\s*'(runtime|registry)',\s*(true|false),\s*(\d+)\)[,\n]/gm)];
    expect(rows.length).toBe(AI_FEATURE_CATALOG.length);
    for (const m of rows) {
      const e = findCatalogEntry(m[1]);
      expect(e, m[1]).not.toBeNull();
      expect(m[2].split(',').map((s) => s.trim().replace(/'/g, '')), m[1]).toEqual(e!.categories);
      expect(m[3] === 'NULL' ? null : m[3].replace(/'/g, ''), m[1]).toBe(e!.emotion_basis);
      expect(m[4], m[1]).toBe(e!.modality);
      expect(m[5] === 'true', m[1]).toBe(e!.default_enabled);
      expect(m[6] === 'true', m[1]).toBe(e!.requires_notice);
      expect(Number(m[7]), m[1]).toBe(e!.notice_version);
      expect(m[8], m[1]).toBe(e!.enforcement);
      expect(m[9] === 'true', m[1]).toBe(e!.shipped);
      expect(Number(m[10]), m[1]).toBe(e!.sort_order);
    }
  });
});

describe('decideGate', () => {
  const plain = findCatalogEntry('ai_call_sentiment_text')!;
  const voice = findCatalogEntry('ai_voice_emotion_signals')!;

  it('unknown feature is never allowed', () => {
    expect(decideGate(null, null).allowed).toBe(false);
  });
  it('honours the switch', () => {
    expect(decideGate(plain, { enabled: true, notice_ok: true }).allowed).toBe(true);
    expect(decideGate(plain, { enabled: false, notice_ok: true })).toEqual({ allowed: false, reason: 'disabled' });
  });
  it('voice emotion needs the notice even when switched on', () => {
    expect(decideGate(voice, { enabled: true, notice_ok: false })).toEqual({ allowed: false, reason: 'notice_required' });
    expect(decideGate(voice, { enabled: true, notice_ok: true }).allowed).toBe(true);
  });
  it('uses catalog defaults when no row exists', () => {
    expect(decideGate(plain, null).allowed).toBe(true);
    expect(decideGate(voice, null).allowed).toBe(false);
  });
  it('fails open only for default-on, notice-free features when the lookup fails', () => {
    expect(decideGate(plain, null, true)).toEqual({ allowed: true, reason: 'fallback_open' });
    expect(decideGate(voice, null, true)).toEqual({ allowed: false, reason: 'fallback_closed' });
  });
});

describe('notices', () => {
  it('names the company and offers an objection route', () => {
    const t = buildVoiceEmotionNotice('Acme HVAC');
    expect(t).toContain('Acme HVAC');
    expect(t).toMatch(/object/i);
    expect(buildVoiceEmotionNotice('  ')).toContain('This business');
  });
  it('requires several explicit acknowledgements and a jurisdiction caveat', () => {
    expect(VOICE_EMOTION_ACKNOWLEDGEMENTS.length).toBeGreaterThanOrEqual(3);
    expect(JURISDICTION_DISCLAIMER).toMatch(/jurisdiction|country|state/i);
    expect(JURISDICTION_DISCLAIMER).toMatch(/legal/i);
    expect(AI_TRANSPARENCY_NOTICE_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('provenance', () => {
  const manifest = buildProvenanceManifest({
    subjectType: 'generated_audio', featureKey: 'ai_voicemail_drops_ai_voice', provider: 'Uploaded audio',
    aiGeneratedAudio: true, aiProcessed: true, generatedAt: '2027-01-01T00:00:00.000Z',
  });
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5]);

  it('embeds and reads back ID3v2.4 provenance without touching audio bytes', () => {
    const r = embedId3Provenance(mp3, manifest);
    expect(r.embedded).toBe(true);
    expect(r.method).toBe('id3v2.4');
    expect(Array.from(r.bytes.slice(-mp3.length))).toEqual(Array.from(mp3));
    const back = readId3Provenance(r.bytes)!;
    expect(back.VIREEK_AI_GENERATED_AUDIO).toBe('true');
    expect(back.VIREEK_AI_PROCESSED).toBe('true');
    expect(JSON.parse(back.VIREEK_PROVENANCE)).toEqual(manifest);
  });
  it('round-trips non-ASCII values (UTF-8)', () => {
    const m = { ...manifest, provider: 'Prövider — 声音' };
    expect(JSON.parse(readId3Provenance(embedId3Provenance(mp3, m).bytes)!.VIREEK_PROVENANCE).provider).toBe(m.provider);
  });
  it('never overwrites an existing ID3 tag', () => {
    const tagged = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 9]);
    const r = embedId3Provenance(tagged, manifest);
    expect(r.embedded).toBe(false);
    expect(r.bytes).toBe(tagged);
  });
  it('only claims embedding support for MP3', () => {
    expect(canEmbedProvenance('audio/mpeg')).toBe(true);
    expect(canEmbedProvenance('audio/mp3; charset=x')).toBe(true);
    expect(canEmbedProvenance('audio/webm')).toBe(false);
    expect(canEmbedProvenance('audio/wav')).toBe(false);
  });
  it('hashes content with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('readId3Provenance returns null for non-tagged audio', () => {
    expect(readId3Provenance(mp3)).toBeNull();
  });
});

describe('registry export', () => {
  const row = (o: Partial<RegistryRow>): RegistryRow => ({
    feature_key: 'k', label: 'L', categories: ['interactive_ai'], emotion_basis: null, modality: 'text', provider: 'P', surface: 'S',
    enabled: true, allowed: true, notice_ok: true, requires_notice: false, notice_version_ack: null, notice_ack_at: null,
    legal_review_status: 'not_reviewed', legal_reviewed_at: null, enforcement: 'registry', shipped: true, ...o,
  });

  it('writes RFC 4180 CSV and neutralises formula injection', () => {
    const csv = registryToCsv([row({ label: 'He said "hi", ok', provider: '=HYPERLINK("x")' })]);
    const [head, line] = csv.split('\r\n');
    expect(head.startsWith('feature_key,label,categories')).toBe(true);
    expect(line).toContain('"He said ""hi"", ok"');
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it('summarises active, voice-emotion and unreviewed counts', () => {
    const s = summarizeRegistry([
      row({}),
      row({ feature_key: 'v', emotion_basis: 'voice_audio', categories: ['emotion_recognition'], requires_notice: true, enabled: true, notice_ok: false, allowed: false }),
      row({ feature_key: 'r', legal_review_status: 'reviewed' }),
    ]);
    expect(s).toEqual({ total: 3, active: 2, voiceEmotionActive: 0, awaitingLegalReview: 1, noticePending: 1 });
  });
});
