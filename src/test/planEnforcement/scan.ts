// src/test/planEnforcement/scan.ts
//
// Static source scanning for the plan-enforcement coverage tests. Node-only (fs): runs under Vitest, never in the browser bundle.
//
// SAFE DIRECTION OF EVERY HEURISTIC
// - Provider detection runs on the RAW text (comments included), so it can only over-report: a file that merely
//   mentions a provider endpoint must be registered or exempted with a reason. It can never miss a real sender.
// - Guard detection runs on comment-stripped text, so a comment that says "must call guardOutbound" is NOT wiring.
//   If the stripper ever mis-parses a file it reports "unguarded", which fails loudly instead of passing silently.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file lives in src/test/planEnforcement/). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /\.(test|spec|live\.test)\.[cm]?[tj]sx?$/;

/** Every non-test TypeScript source under `relDir`, as sorted posix-style paths relative to `root`. */
export function listSourceFiles(relDir: string, root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(`${rel}/${entry.name}`);
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(`${rel}/${entry.name}`);
      }
    }
  };
  if (existsSync(join(root, relDir))) walk(relDir.replace(/\/+$/, ''));
  return out.sort();
}

/** All files with the given extension under `relDir` (used for SQL migrations). */
export function listFiles(relDir: string, ext: string, root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(`${rel}/${entry.name}`);
      } else if (entry.name.endsWith(ext)) out.push(`${rel}/${entry.name}`);
    }
  };
  if (existsSync(join(root, relDir))) walk(relDir.replace(/\/+$/, ''));
  return out.sort();
}

export function readSource(rel: string, root: string = REPO_ROOT): string {
  return readFileSync(join(root, rel), 'utf8');
}

/**
 * Removes // and block comments while leaving string / template contents (e.g. "https://...") intact.
 * Deliberately simple: a regex literal that contains a quote can confuse it. That only ever hides code,
 * which makes a guard look MISSING (fails loudly), never present.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = src[i];
        out += ch;
        i++;
        if (ch === '\\' && i < n) {
          out += src[i];
          i++;
        } else if (ch === quote) {
          break;
        } else if (quote !== '`' && ch === '\n') {
          break; // unterminated plain string: resync at the line break
        }
      }
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sender detection
// ---------------------------------------------------------------------------

export type SenderKind =
  | 'twilio-host' //       any use of api.twilio.com (Messages, Calls, or a generic helper around them)
  | 'twilio-helper-create' // twilioApi("Calls.json" | "Messages.json") — creates a call / message through the shared helper
  | 'vapi-call' //         POST https://api.vapi.ai/call (or the VAPI_CALL_URL constant)
  | 'voice-engine' //      imports the Vapi / OpenAI-realtime outbound engines
  | 'telnyx-sms' //        second SMS provider
  | 'sinch-send' //        rich messaging (RCS / Apple Messages) provider
  | 'voice-clone'; //      ElevenLabs voice cloning (plan-gated by allowVoiceClone)

const DETECTORS: ReadonlyArray<readonly [SenderKind, RegExp]> = [
  ['twilio-host', /api\.twilio\.com/],
  ['twilio-helper-create', /\btwilioApi\(\s*[`'"](?:Calls|Messages)\.json/],
  ['vapi-call', /api\.vapi\.ai\/call(?![/\w-])|\bVAPI_CALL_URL\b/],
  ['voice-engine', /from\s+["'][^"']*voice-engine\/(?:vapiEngine|openAiRealtimeEngine)(?:\.ts)?["']/],
  ['telnyx-sms', /api\.telnyx\.com/],
  ['sinch-send', /\.sinch\.com/],
  ['voice-clone', /api\.elevenlabs\.io\/v1\/voices\/add/],
];

export function detectSenderKinds(rawText: string): SenderKind[] {
  return DETECTORS.filter(([, re]) => re.test(rawText)).map(([kind]) => kind);
}

/** Files under supabase/functions that can place a call / send a message / clone a voice (or touch the provider host at all). */
export function discoverSenders(root: string = REPO_ROOT): Map<string, SenderKind[]> {
  const found = new Map<string, SenderKind[]>();
  for (const file of listSourceFiles('supabase/functions', root)) {
    const kinds = detectSenderKinds(readSource(file, root));
    if (kinds.length > 0) found.set(file.replace(/^supabase\/functions\//, ''), kinds);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Guard detection
// ---------------------------------------------------------------------------

/** A real CALL of the central gate. A comment, an import, or a string does not count. */
const GUARD_CALL = /\b(?:guardOutbound|guardDestination)\s*\(/;

export function referencesGuard(rawText: string): boolean {
  return GUARD_CALL.test(stripComments(rawText));
}

export function functionFileReferencesGuard(relToFunctions: string, root: string = REPO_ROOT): boolean {
  return referencesGuard(readSource(`supabase/functions/${relToFunctions}`, root));
}

/** True when the comment-stripped file matches `re` (used for narrow static assertions). */
export function codeMatches(rel: string, re: RegExp, root: string = REPO_ROOT): boolean {
  return re.test(stripComments(readSource(rel, root)));
}
