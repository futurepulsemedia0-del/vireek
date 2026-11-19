import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from './pin-actions.mjs';

const sha = 'a'.repeat(40);
test('scan finds pinned, unpinned and ignores local/docker uses', () => {
  const r = scan([
    `  - uses: actions/checkout@${sha} # v4.2.2`,
    '  - uses: actions/setup-node@v4',
    '  - uses: actions/attest-build-provenance@PIN-ME # v2.4.0',
    '  - uses: ./local-action',
    '  - uses: docker://alpine:3',
    '    run: echo uses: nothing',
  ].join('\n'));
  assert.equal(r.length, 3);
  assert.equal(r[0].tag, 'v4.2.2');
  assert.equal(r[1].tag, 'v4');
  assert.equal(r[2].tag, 'v2.4.0');
});
