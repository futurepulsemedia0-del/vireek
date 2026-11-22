import { test, expect } from 'vitest';
import { scanSource } from './check-pii-logging.mjs';

const SAFE = 'import { safeConsole as console } from "../_shared/http/core.ts";\n';
test('flags raw console of a request payload', () => {
  expect(scanSource('console.log(JSON.stringify({ event: "x", requestId, payload }));').length).toBe(1);
  expect(scanSource('const b = await req.json();\nconsole.error("bad", body);').length).toBe(1);
  expect(scanSource('console.log(await req.text());').length).toBe(1);
});
test('flags a PII sample inside a logged body', () => {
  expect(scanSource('console.log("got", JSON.stringify(body)); // {"phone":"+14155550100","email":"a@b.com","address":"1 Main St"}').length).toBe(1);
});
test('ignores messages that only contain the words, and ids/errors', () => {
  expect(scanSource('console.error("[voice-security] transcript canary scan failed:", err);').length).toBe(0);
  expect(scanSource('console.error(JSON.stringify({ event: "failed", call_id: id, error: e.message }));').length).toBe(0);
});
test('a file importing safeConsole as console is compliant', () => {
  expect(scanSource(SAFE + 'console.log(JSON.stringify({ payload }));').length).toBe(0);
});
