// @vitest-environment node
//
// Coverage registry for customer-driven outbound senders and gated feature entry points.
//
// FAILS CI when:
//  - a file under supabase/functions that calls the Twilio host, POSTs api.vapi.ai/call, sends through another SMS
//    provider, or clones a voice is neither registered nor exempt (a new, unreviewed sender);
//  - a registered sender with no gap marker does not call guardOutbound()/guardDestination();
//  - a sender marked as a known gap has started calling the guard (remove the marker: gaps may only shrink);
//  - an exemption has no real reason.
//
// To add a sender: put the file in SENDER_REGISTRY (src/test/planEnforcement/registry.ts) and call guardOutbound()
// before it sends, or add it to EXEMPT_SENDERS with a reason a reviewer can challenge.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXEMPT_SENDERS, KNOWN_GAPS, MIN_REASON_LENGTH, SENDER_REGISTRY, type RegisteredSender } from '../test/planEnforcement/registry';
import { detectSenderKinds, discoverSenders, functionFileReferencesGuard, readSource, referencesGuard, stripComments } from '../test/planEnforcement/scan';

const registered = new Set(SENDER_REGISTRY.map((s) => s.file));
const exempt = new Set(EXEMPT_SENDERS.map((s) => s.file));
const known = new Set([...registered, ...exempt]);

/** Files that look like senders but are in neither list. */
function unregistered(root?: string): string[] {
  return [...discoverSenders(root).keys()].filter((f) => !known.has(f)).sort();
}

describe('sender discovery covers every provider call site', () => {
  it('no file under supabase/functions that can send is missing from the registry or the exempt list', () => {
    const missing = unregistered();
    expect(missing, `Unregistered sender(s): ${missing.join(', ')}.\nAdd to SENDER_REGISTRY (and call guardOutbound() before sending) or to EXEMPT_SENDERS with a reason, in src/test/planEnforcement/registry.ts.`).toEqual([]);
  });

  it('every registered or exempt file still exists and is still detected as a sender (no stale entries)', () => {
    const found = discoverSenders();
    for (const f of known) {
      expect(() => readSource(`supabase/functions/${f}`), f).not.toThrow();
      expect(found.has(f), `${f} is listed but no longer matches any sender pattern: remove it from the registry`).toBe(true);
    }
  });

  it('a file cannot be both registered and exempt, and nothing is listed twice', () => {
    expect(SENDER_REGISTRY.length + EXEMPT_SENDERS.length).toBe(known.size);
    for (const f of registered) expect(exempt.has(f), f).toBe(false);
  });

  it('every exemption carries a real reason', () => {
    for (const e of EXEMPT_SENDERS) expect(e.reason.trim().length, e.file).toBeGreaterThanOrEqual(MIN_REASON_LENGTH);
  });

  it('a brand-new unguarded sender dropped into supabase/functions is caught (simulated in a temp tree)', () => {
    const root = mkdtempSync(join(tmpdir(), 'vireek-sender-'));
    try {
      const mk = (rel: string, body: string) => {
        mkdirSync(join(root, 'supabase/functions', rel, '..'), { recursive: true });
        writeFileSync(join(root, 'supabase/functions', rel), body);
      };
      mk('new-sms-blast/index.ts', 'await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: "POST" });');
      mk('new-caller/index.ts', 'await fetch("https://api.vapi.ai/call", { method: "POST" });');
      mk('new-helper-caller/index.ts', 'await twilioApi("Calls.json", { form });');
      mk('new-cloner/index.ts', 'await fetch("https://api.elevenlabs.io/v1/voices/add", {});');
      mk('harmless/index.ts', 'export const x = 1;');
      expect(unregistered(root)).toEqual(['new-caller/index.ts', 'new-cloner/index.ts', 'new-helper-caller/index.ts', 'new-sms-blast/index.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('guard wiring ratchet', () => {
  it.each(SENDER_REGISTRY.map((s) => [s.file, s] as const))('%s', (file: string, s: RegisteredSender) => {
    const guarded = functionFileReferencesGuard(file);
    if (s.gap === null) {
      expect(guarded, `${file} sends customer traffic but never calls guardOutbound()/guardDestination()`).toBe(true);
    } else {
      expect(KNOWN_GAPS[s.gap], `${file}: unknown gap ${s.gap}`).toBeDefined();
      expect(guarded, `${file} now calls the guard: set gap to null in SENDER_REGISTRY, then regenerate docs/plan-enforcement-matrix.md`).toBe(false);
    }
  });

  it('the guard module itself exports the functions the detector looks for', () => {
    const src = readSource('supabase/functions/_shared/fraud/guard.ts');
    expect(src).toMatch(/export async function guardOutbound\(/);
    expect(src).toMatch(/export async function guardDestination\(/);
  });
});

describe('detector self-tests', () => {
  it('detects provider send call sites', () => {
    expect(detectSenderKinds('fetch(`https://api.twilio.com/2010-04-01/Accounts/${s}/Messages.json`)')).toContain('twilio-host');
    expect(detectSenderKinds('fetch("https://api.vapi.ai/call", {method:"POST"})')).toContain('vapi-call');
    expect(detectSenderKinds('const VAPI_CALL_URL = x; fetch(VAPI_CALL_URL)')).toContain('vapi-call');
    expect(detectSenderKinds('await twilioApi("Calls.json", {})')).toContain('twilio-helper-create');
    expect(detectSenderKinds('await twilioApi(`Messages.json`, {})')).toContain('twilio-helper-create');
    expect(detectSenderKinds('import { VapiEngine } from "../_shared/voice-engine/vapiEngine.ts";')).toContain('voice-engine');
    expect(detectSenderKinds('fetch("https://api.telnyx.com/v2/messages")')).toContain('telnyx-sms');
    expect(detectSenderKinds('fetch("https://eu.conversation.api.sinch.com/v1/projects")')).toContain('sinch-send');
    expect(detectSenderKinds('fetch("https://api.elevenlabs.io/v1/voices/add")')).toContain('voice-clone');
  });

  it('does not flag read-only Vapi lookups or unrelated code', () => {
    expect(detectSenderKinds('fetch(`https://api.vapi.ai/call/${id}`)')).not.toContain('vapi-call');
    expect(detectSenderKinds('fetch("https://api.vapi.ai/assistant")')).not.toContain('vapi-call');
    expect(detectSenderKinds('const a = 1;')).toEqual([]);
  });

  it('only a real call counts as guard wiring (comments, imports and strings do not)', () => {
    expect(referencesGuard('const g = await guardOutbound(db, req);')).toBe(true);
    expect(referencesGuard('const g = await guardDestination(db, u, to);')).toBe(true);
    expect(referencesGuard('// must call guardOutbound(db, req) first')).toBe(false);
    expect(referencesGuard('/* guardOutbound(db) */ send();')).toBe(false);
    expect(referencesGuard('import { guardOutbound } from "../fraud/guard.ts";')).toBe(false);
  });

  it('comment stripping keeps URLs inside strings and templates intact', () => {
    const out = stripComments('const u = "https://api.twilio.com/x"; // note\nconst t = `https://api.vapi.ai/call`; /* c */ x();');
    expect(out).toContain('https://api.twilio.com/x');
    expect(out).toContain('https://api.vapi.ai/call');
    expect(out).not.toContain('note');
  });
});
